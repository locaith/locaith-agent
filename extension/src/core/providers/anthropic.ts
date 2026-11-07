/**
 * Adapter Claude (Anthropic) — dùng SDK chính thức `@anthropic-ai/sdk` (`client.messages.stream`).
 *
 * Sự thật quan trọng (ngày 2026-10-29, theo skill claude-api):
 *  - TUYỆT ĐỐI không gửi temperature / top_p / top_k (mọi model đều trả 400 từ 2026-10-21).
 *  - Kiểu suy luận phụ thuộc model: xem `thinkingStyleOf`. Model lạ (chưa biết) → hành vi mới nhất (adaptive).
 *  - Khối thinking phải được phát lại nguyên vẹn (kèm chữ ký) trong cùng chuỗi tool; nếu lịch sử đã bị harness
 *    sửa (`historyEdited`) thì bỏ hết khối thinking cũ vì API sẽ từ chối.
 *  - Đối số tool dài được stream từng mảnh nhờ `eager_input_streaming`; khi đó API KHÔNG kiểm tra JSON giúp ta,
 *    nên mọi đối số đều được `JSON.parse` chặt ở `content_block_stop`; hỏng → `parseError` để engine báo lại cho model.
 *  - `maxRetries: 0` ở SDK; việc thử lại do `withRetries` đảm nhiệm để giao diện thấy được sự kiện `retry`.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderError,
  type ChatMessage,
  type CompleteRequest,
  type ContentBlock,
  type LLMProvider,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderRuntimeConfig,
  type StopReason,
  type StreamRequest,
  type Usage,
} from '../types';
import { wellFormedDeep } from '../textSafe';
import { COMPLETE_MIN_OUTPUT_TOKENS } from './common';
import { isBlank, makeToolUse, normalizeHistory } from './history';
import {
  abortedError,
  classifyHttpError,
  findOffendingParam,
  parseOutputLimit,
  rememberRemoval,
  rememberedOutputCap,
  rememberedRemovals,
  resolveRetryPolicy,
  retryAsync,
  toProviderError,
  withDegradation,
  withRetries,
} from './http';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const INTERLEAVED_BETA = 'interleaved-thinking-2025-05-14';

// ─────────────────────────────────────────────────────────────────────────────
// Kiểu suy luận theo model
// ─────────────────────────────────────────────────────────────────────────────

export type ThinkingStyle =
  /** Luôn bật (fable/mythos 5.x, opus-5-5): bỏ `thinking` hoặc `adaptive`; không bao giờ disabled/budget. */
  | 'always-on'
  /** sonnet-5-5: adaptive; muốn tắt dùng `between_tools`. */
  | 'sonnet-5-5'
  /** adaptive; cho phép `disabled` (ở effort ≤ high). */
  | 'adaptive'
  /** Cũ: `{type:'enabled', budget_tokens}`. */
  | 'budget';

export function thinkingStyleOf(modelId: string): ThinkingStyle {
  const id = modelId.toLowerCase();
  if (/^claude-(fable|mythos)-/.test(id)) return 'always-on';
  if (/^claude-opus-5-5(?:$|-)/.test(id)) return 'always-on';
  if (/^claude-sonnet-5-5(?:$|-)/.test(id)) return 'sonnet-5-5';
  if (/^claude-haiku-5-5(?:$|-)/.test(id)) return 'adaptive';
  if (/^claude-opus-5(?:-\d{8})?$/.test(id)) return 'adaptive';
  if (/^claude-sonnet-5(?:-\d{8})?$/.test(id)) return 'adaptive';
  if (/^claude-opus-4-[678](?:$|-)/.test(id)) return 'adaptive';
  if (/^claude-(?:opus|sonnet)-4-6(?:$|-)/.test(id)) return 'adaptive';
  // Dòng cũ: claude-3*, claude-(opus|sonnet|haiku)-4, -4-0, -4-1, -4-5 (kèm ngày tuỳ chọn).
  if (/^claude-3/.test(id)) return 'budget';
  if (/^claude-(?:opus|sonnet|haiku)-4(?:-[0-5])?(?:-\d{8})?$/.test(id)) return 'budget';
  // Id lạ/tương lai → hành vi mới nhất nhưng an toàn nhất (không bao giờ gửi disabled/budget).
  return 'always-on';
}

const BUDGET_BY_LEVEL: Record<string, number> = { low: 2048, medium: 8192, high: 24576, max: 32000 };

export interface ThinkingParams {
  thinking?: Record<string, unknown>;
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Cần header beta interleaved-thinking (chỉ dòng budget của Claude 4). */
  interleavedBeta: boolean;
}

export function buildThinkingParams(
  modelId: string,
  level: StreamRequest['thinking']['level'],
  summaries: boolean,
  maxTokens: number,
  overrides: { style?: ThinkingStyle | 'omit'; noDisplay?: boolean } = {},
): ThinkingParams {
  const style: ThinkingStyle | 'omit' = overrides.style ?? thinkingStyleOf(modelId);
  if (style === 'omit') return { interleavedBeta: false };

  if (level === 'off') {
    switch (style) {
      case 'always-on':
        return { effort: 'low', interleavedBeta: false };
      case 'sonnet-5-5':
        return { thinking: { type: 'between_tools' }, effort: 'low', interleavedBeta: false };
      case 'adaptive':
        return { thinking: { type: 'disabled' }, interleavedBeta: false };
      case 'budget':
        return { interleavedBeta: false };
    }
  }

  if (style === 'budget') {
    const wanted = BUDGET_BY_LEVEL[level] ?? BUDGET_BY_LEVEL.medium;
    const budget = Math.min(wanted, maxTokens - 1);
    if (budget < 1024) return { interleavedBeta: false }; // max_tokens quá nhỏ để bật suy luận
    return {
      thinking: { type: 'enabled', budget_tokens: budget },
      interleavedBeta: /^claude-(?:opus|sonnet|haiku)-4/.test(modelId.toLowerCase()),
    };
  }

  const thinking: Record<string, unknown> = { type: 'adaptive' };
  if (summaries && !overrides.noDisplay) thinking.display = 'summarized';
  return { thinking, effort: level === 'max' ? 'max' : level, interleavedBeta: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chuyển đổi lịch sử
// ─────────────────────────────────────────────────────────────────────────────

/** Anthropic chỉ nhận id tool khớp `^[a-zA-Z0-9_-]{1,64}$`. Id từ hãng khác có thể chứa ký tự lạ. */
function safeToolId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'call_0';
}

function toolResultContent(
  block: Extract<ContentBlock, { type: 'tool_result' }>,
): string | Array<Record<string, unknown>> {
  const text = isBlank(block.content) ? (block.isError ? '(lỗi, không có thông điệp)' : '(không có đầu ra)') : block.content;
  if (!block.images || block.images.length === 0) return text;
  return [
    { type: 'text', text },
    ...block.images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })),
  ];
}

export function toAnthropicMessages(
  history: readonly ChatMessage[],
  opts: {
    historyEdited?: boolean;
    /** Id của adapter này: chỉ phát lại suy luận do CHÍNH nó sinh ra (mặc định 'anthropic'). */
    providerId?: string;
    /**
     * Có khối chữ `volatile` ở cuối tin user (dòng ngân sách vòng lặp — đổi ở MỖI lần gọi): đặt điểm prompt-cache tường minh ở khối thật
     * ngay TRƯỚC nó. Điểm cache tự động (`cache_control` cấp yêu cầu) luôn rơi vào khối cuối cùng, tức chính khối volatile; nếu chỉ có
     * điểm đó thì bản ghi cache của lần gọi này chứa dòng ngân sách cũ, lần gọi sau không còn dòng đó nên KHÔNG BAO GIỜ trúng cache
     * (mỗi vòng trả giá ghi cache cho cả lịch sử mà không đọc lại được gì). Chỉ bật khi host chấp nhận `cache_control`.
     */
    cacheBeforeVolatile?: boolean;
  },
): Array<Record<string, unknown>> {
  const ownId = opts.providerId ?? 'anthropic';
  const out: Array<Record<string, unknown>> = [];
  for (const m of normalizeHistory(history)) {
    if (m.role === 'user') {
      const results: Array<Record<string, unknown>> = [];
      const rest: Array<Record<string, unknown>> = [];
      const tail: Array<Record<string, unknown>> = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const item: Record<string, unknown> = {
            type: 'tool_result',
            tool_use_id: safeToolId(b.toolUseId),
            content: toolResultContent(b),
          };
          if (b.isError) item.is_error = true;
          results.push(item);
        } else if (b.type === 'text') {
          if (!isBlank(b.text)) (b.volatile ? tail : rest).push({ type: 'text', text: b.text });
        } else if (b.type === 'image') {
          rest.push({ type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } });
        }
      }
      // tool_result PHẢI đứng trước mọi nội dung khác trong tin nhắn user; khối volatile (nếu có) luôn là khối CUỐI.
      const stable = [...results, ...rest];
      if (opts.cacheBeforeVolatile && tail.length > 0 && stable.length > 0) stable[stable.length - 1].cache_control = { type: 'ephemeral' };
      const content = [...stable, ...tail];
      if (content.length > 0) out.push({ role: 'user', content });
    } else {
      const content: Array<Record<string, unknown>> = [];
      for (const b of m.content) {
        if (b.type === 'thinking') {
          if (opts.historyEdited || b.provider !== ownId) continue;
          if (b.redactedData) content.push({ type: 'redacted_thinking', data: b.redactedData });
          else if (b.signature) content.push({ type: 'thinking', thinking: b.text, signature: b.signature });
        } else if (b.type === 'text') {
          if (!isBlank(b.text)) content.push({ type: 'text', text: b.text });
        } else if (b.type === 'tool_use') {
          content.push({ type: 'tool_use', id: safeToolId(b.id), name: b.name, input: b.input });
        }
      }
      if (content.length > 0) out.push({ role: 'assistant', content });
    }
  }
  // Prefill (tin nhắn assistant cuối) bị cấm ở các model mới → thêm lời nhắc tiếp tục.
  if (out.length > 0 && out[out.length - 1].role === 'assistant') {
    out.push({ role: 'user', content: [{ type: 'text', text: 'Hãy tiếp tục.' }] });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lỗi
// ─────────────────────────────────────────────────────────────────────────────

const ERROR_TYPE_TO_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 408,
  overloaded_error: 529,
};

export function mapAnthropicError(
  err: unknown,
  providerId: string,
  signal: AbortSignal | undefined,
  secrets: ReadonlyArray<string | undefined>,
): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) return abortedError(providerId);
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError('Hết thời gian chờ phản hồi từ máy chủ Anthropic.', {
      kind: 'timeout',
      providerId,
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return toProviderError((err as { cause?: unknown }).cause ?? err, providerId, signal, secrets);
  }
  if (err instanceof Anthropic.APIError) {
    const body = (err.error ?? {}) as { type?: string; error?: { type?: string; message?: string } };
    const innerType = body.error?.type ?? body.type;
    const status = err.status ?? (innerType ? ERROR_TYPE_TO_STATUS[innerType] : undefined);
    const text = JSON.stringify(body && Object.keys(body).length > 0 ? body : { error: { message: err.message } });
    return classifyHttpError(providerId, status, text, err.headers, secrets);
  }
  return toProviderError(err, providerId, signal, secrets);
}

// ─────────────────────────────────────────────────────────────────────────────
// Trạng thái hạ cấp (nhớ theo model)
// ─────────────────────────────────────────────────────────────────────────────

interface DegradeState {
  noEffort: boolean;
  noDisplay: boolean;
  noEager: boolean;
  noCache: boolean;
  noBeta: boolean;
  /**
   * Không phát lại khối thinking cũ trong LẦN GỌI NÀY (API báo chữ ký không còn hợp lệ). Cố ý KHÔNG nhớ giữa các lần gọi:
   * đó là sự cố của một cuộc trò chuyện cụ thể, ghi nhớ theo model sẽ tắt vĩnh viễn việc phát lại suy luận cho mọi cuộc
   * trò chuyện lành mạnh khác. Engine xoá suy luận cũ khỏi lịch sử qua `droppedReplayedThinking` trong sự kiện `done`.
   */
  noReplayThinking: boolean;
  /** Trần token đầu ra học được từ thông điệp lỗi của máy chủ, và giá trị vừa gửi. */
  outputCap?: number;
  lastMax?: number;
  styleOverride?: ThinkingStyle | 'omit';
}

function loadDegradeState(providerId: string, model: string): DegradeState {
  const mem = rememberedRemovals(providerId, model);
  return {
    noEffort: mem.has('effort'),
    noDisplay: mem.has('display'),
    noEager: mem.has('eager_input_streaming'),
    noCache: mem.has('cache_control'),
    noBeta: mem.has('beta_header'),
    noReplayThinking: false,
    outputCap: rememberedOutputCap(mem),
    styleOverride: mem.has('style:adaptive') ? 'always-on' : mem.has('style:budget') ? 'budget' : mem.has('style:omit') ? 'omit' : undefined,
  };
}

/** Thông điệp 400 về khối thinking CŨ trong lịch sử (chữ ký sai, bị sửa, thuộc model/cuộc trò chuyện khác). */
const THINKING_HISTORY_ERROR = /signature|redacted_thinking|thinking block|preserved thinking|cannot be modified|were modified|edited/i;

/** Điều chỉnh yêu cầu theo thông điệp 400; trả true nếu có thay đổi (để gọi lại). */
function degradeAnthropic(err: ProviderError, state: DegradeState, providerId: string, model: string, current: ThinkingStyle): boolean {
  const msg = `${err.message} ${err.details ?? ''}`.toLowerCase();
  const note = (token: string) => rememberRemoval(providerId, model, token);
  if (!state.noEager && msg.includes('eager_input_streaming')) {
    state.noEager = true;
    note('eager_input_streaming');
    return true;
  }
  // Lịch sử chứa thinking không còn hợp lệ → bỏ hết thinking cũ rồi gọi lại (giống `historyEdited`), chỉ cho lần gọi này.
  if (!state.noReplayThinking && msg.includes('thinking') && THINKING_HISTORY_ERROR.test(msg)) {
    state.noReplayThinking = true;
    return true;
  }
  // "max_tokens: 32000 > 8192, which is the maximum allowed…" — hạ xuống đúng giới hạn model (chỉ nhận khi nhỏ hơn giá trị vừa gửi).
  const limit = parseOutputLimit(msg);
  if (limit !== undefined && limit < (state.lastMax ?? Infinity) && (state.outputCap === undefined || limit < state.outputCap)) {
    state.outputCap = limit;
    note(`maxcap=${limit}`);
    return true;
  }
  if (!state.noEffort && (msg.includes('output_config') || findOffendingParam(msg, ['effort']))) {
    state.noEffort = true;
    note('effort');
    return true;
  }
  if (!state.noCache && msg.includes('cache_control')) {
    state.noCache = true;
    note('cache_control');
    return true;
  }
  if (!state.noBeta && (msg.includes('anthropic-beta') || msg.includes('interleaved'))) {
    state.noBeta = true;
    note('beta_header');
    return true;
  }
  if (!state.noDisplay && /\bdisplay\b/.test(msg)) {
    state.noDisplay = true;
    note('display');
    return true;
  }
  // Đoán sai kiểu suy luận của một model lạ: đổi sang kiểu còn lại; không rõ thì bỏ hẳn `thinking`.
  if (/thinking\.type|thinking: |budget_tokens|adaptive|type: enabled|"enabled"/.test(msg)) {
    const effective = state.styleOverride ?? current;
    const reject = '(?:not supported|unsupported|not allowed|invalid|removed|deprecated|not available)';
    const adaptiveRejected = new RegExp(`adaptive[^.;]*${reject}|${reject}[^.;]*adaptive`).test(msg);
    const budgetRejected = new RegExp(`budget_tokens[^.;]*${reject}|${reject}[^.;]*budget_tokens`).test(msg);

    let next: ThinkingStyle | 'omit' | undefined;
    if (effective === 'budget') next = 'always-on'; // kiểu cũ bị từ chối → dùng adaptive
    else if (adaptiveRejected || (!budgetRejected && (msg.includes('budget_tokens') || msg.includes('enabled')))) next = 'budget';
    else next = state.styleOverride === 'omit' ? undefined : 'omit';

    if (next !== undefined && next !== effective) {
      state.styleOverride = next;
      note(next === 'always-on' ? 'style:adaptive' : next === 'budget' ? 'style:budget' : 'style:omit');
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

interface BlockState {
  type: 'text' | 'thinking' | 'redacted' | 'tool_use' | 'other';
  text: string;
  signature?: string;
  redacted?: string;
  id?: string;
  name?: string;
  json: string;
  stopped: boolean;
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause_turn';
    default:
      return 'end_turn';
  }
}

function usageFrom(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number } | null;
}): Usage {
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const usage: Usage = {
    inputTokens: (u.input_tokens ?? 0) + cacheRead + cacheWrite,
    outputTokens: u.output_tokens ?? 0,
  };
  if (cacheRead) usage.cacheReadTokens = cacheRead;
  if (cacheWrite) usage.cacheWriteTokens = cacheWrite;
  const thinking = u.output_tokens_details?.thinking_tokens;
  if (thinking) usage.reasoningTokens = thinking;
  return usage;
}

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  readonly label: string;
  readonly kind = 'anthropic' as const;
  readonly flavor = 'anthropic' as const;
  readonly capabilities: ProviderCapabilities = {
    reasoning: 'summary',
    parallelTools: true,
    vision: true,
    toolArgStreaming: 'incremental',
    thinkingBoundToPrefix: true,
  };

  constructor(private readonly cfg: ProviderRuntimeConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
  }

  private baseURL(): string {
    // SDK tự thêm /v1/…; bỏ hậu tố /v1 nếu người dùng dán cả đường dẫn.
    return (this.cfg.baseUrl || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  private isOfficialHost(): boolean {
    try {
      return new URL(this.baseURL()).hostname.endsWith('anthropic.com');
    } catch {
      return false;
    }
  }

  private async client(): Promise<{ client: Anthropic; key: string }> {
    const key = await this.cfg.getApiKey();
    if (!key) {
      throw new ProviderError('Chưa có khóa API của Anthropic. Hãy đặt khóa trong phần Cài đặt.', {
        kind: 'auth',
        providerId: this.id,
        retryable: false,
      });
    }
    // SDK 1.x gửi khoá qua `Authorization: Bearer`. Gateway/proxy tương thích Anthropic thường chỉ đọc `x-api-key`
    // → với host không phải anthropic.com gửi thêm header này (host chính thức giữ nguyên hành vi mặc định của SDK).
    const defaultHeaders: Record<string, string> = { ...(this.cfg.extraHeaders ?? {}) };
    if (!this.isOfficialHost()) defaultHeaders['x-api-key'] = key;
    const client = new Anthropic({
      apiKey: key,
      baseURL: this.baseURL(),
      maxRetries: 0,
      timeout: 10 * 60 * 1000,
      fetch: this.cfg.fetchImpl,
      defaultHeaders,
      // Bản trình duyệt (tiện ích Chrome/Edge) gọi API trực tiếp bằng khoá của chính người dùng; SDK mặc định từ chối chạy trong
      // trình duyệt. Trong Node (VS Code) tuỳ chọn này không có tác dụng.
      dangerouslyAllowBrowser: true,
    });
    return { client, key };
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    const { client, key } = await this.client();
    const secrets = [key];
    const style = thinkingStyleOf(req.model);
    const state = loadDegradeState(this.id, req.model);
    const policy = resolveRetryPolicy(this.cfg.options);
    const eagerAllowed = this.cfg.options?.eagerInputStreaming !== false;

    // Mỗi vòng hạ cấp phải dựng một generator thử-lại MỚI (generator cũ đã cạn).
    yield* withDegradation(
      () =>
        withRetries({ providerId: this.id, signal: req.signal, policy, log: this.cfg.log }, () =>
          this.runOnce(client, req, secrets, state, eagerAllowed),
        ),
      (err) => degradeAnthropic(err, state, this.id, req.model, style),
    );
  }

  private async *runOnce(
    client: Anthropic,
    req: StreamRequest,
    secrets: string[],
    state: DegradeState,
    eagerAllowed: boolean,
  ): AsyncGenerator<ProviderEvent, void, void> {
    const wantSummaries = req.thinking.summaries && req.thinking.level !== 'off';
    // Trần đầu ra mặc định (32000) vượt giới hạn của model nhỏ/cổng trung gian → 400; trần học được từ thông điệp lỗi được áp ở đây.
    const maxTokens = state.outputCap !== undefined ? Math.min(req.maxOutputTokens, state.outputCap) : req.maxOutputTokens;
    state.lastMax = maxTokens;
    const th = buildThinkingParams(req.model, req.thinking.level, wantSummaries, maxTokens, {
      style: state.styleOverride,
      noDisplay: state.noDisplay,
    });

    const messages = toAnthropicMessages(req.messages, {
      historyEdited: req.historyEdited || state.noReplayThinking,
      providerId: this.id,
      cacheBeforeVolatile: this.isOfficialHost() && !state.noCache,
    });
    let tools = req.tools.map((t) => {
      const tool: Record<string, unknown> = { name: t.name, description: t.description, input_schema: t.inputSchema };
      if (t.eagerInput && eagerAllowed && !state.noEager) tool.eager_input_streaming = true;
      return tool;
    });
    let forbidTools = req.toolChoice === 'none';
    if (tools.length === 0) {
      // Anthropic trả 400 ("Requests which include tool_use or tool_result blocks must define tools") nếu lịch sử có khối công
      // cụ mà không có `tools`: dựng định nghĩa rỗng cho các tên đã dùng và cấm gọi.
      const used = new Set<string>();
      for (const m of messages) {
        if (!Array.isArray(m.content)) continue;
        for (const b of m.content as Array<Record<string, unknown>>) if (b.type === 'tool_use' && typeof b.name === 'string') used.add(b.name);
      }
      if (used.size > 0) {
        tools = [...used].map((name) => ({ name, description: 'Not available in this turn.', input_schema: { type: 'object', properties: {} } }));
        forbidTools = true;
      }
    }

    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: maxTokens,
      messages,
      stream: true,
    };
    if (!isBlank(req.system)) params.system = req.system;
    if (tools.length > 0) {
      params.tools = tools;
      if (forbidTools) params.tool_choice = { type: 'none' };
      else if (req.parallelToolCalls === false) params.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
    }
    if (th.thinking) params.thinking = th.thinking;
    if (th.effort && !state.noEffort) params.output_config = { effort: th.effort };
    if (this.isOfficialHost() && !state.noCache) params.cache_control = { type: 'ephemeral' };

    const headers: Record<string, string> = {};
    if (th.interleavedBeta && !state.noBeta) headers['anthropic-beta'] = INTERLEAVED_BETA;

    if (this.cfg.log) {
      this.cfg.log('debug', `[${this.id}] → messages.stream model=${req.model} thinking=${JSON.stringify(th.thinking ?? null)} effort=${th.effort ?? '-'} tools=${tools.length}`);
    }

    // Luồng THÔ (messages.create + stream) chứ không phải trình bao `messages.stream()`: trình bao đó tự parse JSON đối số
    // công cụ lúc `content_block_stop` và nuốt lỗi (JSON sai → luồng "kết thúc im lặng" → mất cả lượt). Ta tự gom `b.json`
    // và parse chặt bằng makeToolUse, nên đối số hỏng trở thành `parseError` để model sửa lại.
    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await client.messages.create(wellFormedDeep(params) as unknown as Anthropic.MessageCreateParamsStreaming, {
        signal: req.signal,
        headers,
      });
    } catch (err) {
      throw mapAnthropicError(err, this.id, req.signal, secrets);
    }

    const blocks = new Map<number, BlockState>();
    let stopReason: string | null | undefined;
    let sawStop = false;
    // Bộ đếm token cộng dồn: message_start cho phần đầu vào, message_delta cập nhật phần đầu ra
    // (và có thể lặp lại đầu vào — chỉ ghi đè khi API thật sự gửi giá trị).
    const tok = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: undefined as number | undefined };
    const snapshot = (): Usage =>
      usageFrom({
        input_tokens: tok.input,
        cache_read_input_tokens: tok.cacheRead,
        cache_creation_input_tokens: tok.cacheWrite,
        output_tokens: tok.output,
        output_tokens_details: tok.thinking !== undefined ? { thinking_tokens: tok.thinking } : null,
      });

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            const u = event.message.usage;
            tok.input = u.input_tokens ?? 0;
            tok.cacheRead = u.cache_read_input_tokens ?? 0;
            tok.cacheWrite = u.cache_creation_input_tokens ?? 0;
            tok.output = u.output_tokens ?? 0;
            yield { type: 'usage', usage: snapshot() };
            break;
          }
          case 'content_block_start': {
            const cb = event.content_block;
            if (cb.type === 'text') {
              blocks.set(event.index, { type: 'text', text: cb.text ?? '', json: '', stopped: false });
              if (cb.text) yield { type: 'text_delta', text: cb.text };
            } else if (cb.type === 'thinking') {
              blocks.set(event.index, { type: 'thinking', text: cb.thinking ?? '', signature: cb.signature, json: '', stopped: false });
              if (cb.thinking) yield { type: 'thinking_delta', text: cb.thinking };
            } else if (cb.type === 'redacted_thinking') {
              blocks.set(event.index, { type: 'redacted', text: '', redacted: cb.data, json: '', stopped: false });
            } else if (cb.type === 'tool_use') {
              blocks.set(event.index, { type: 'tool_use', text: '', id: cb.id, name: cb.name, json: '', stopped: false });
              yield { type: 'tool_start', id: cb.id, name: cb.name };
            } else {
              blocks.set(event.index, { type: 'other', text: '', json: '', stopped: false });
            }
            break;
          }
          case 'content_block_delta': {
            const b = blocks.get(event.index);
            if (!b) break;
            const d = event.delta;
            if (d.type === 'text_delta') {
              b.text += d.text;
              if (d.text) yield { type: 'text_delta', text: d.text };
            } else if (d.type === 'thinking_delta') {
              b.text += d.thinking;
              if (d.thinking) yield { type: 'thinking_delta', text: d.thinking };
            } else if (d.type === 'signature_delta') {
              b.signature = (b.signature ?? '') + d.signature;
            } else if (d.type === 'input_json_delta') {
              b.json += d.partial_json;
              if (b.id && b.name && d.partial_json) {
                yield { type: 'tool_args_delta', id: b.id, name: b.name, delta: d.partial_json };
              }
            }
            break;
          }
          case 'content_block_stop': {
            const b = blocks.get(event.index);
            if (b) {
              b.stopped = true;
              if (b.type === 'tool_use' && b.id && b.name) yield { type: 'tool_end', id: b.id, name: b.name };
            }
            break;
          }
          case 'message_delta': {
            stopReason = event.delta.stop_reason ?? stopReason;
            if (event.delta.stop_reason === 'refusal') {
              const details = event.delta.stop_details as { category?: string | null; explanation?: string | null } | null;
              this.cfg.log?.('warn', `[${this.id}] model từ chối (refusal): ${details?.category ?? 'không rõ'} ${details?.explanation ?? ''}`);
            }
            const u = event.usage;
            if (u.input_tokens != null) tok.input = u.input_tokens;
            if (u.cache_read_input_tokens != null) tok.cacheRead = u.cache_read_input_tokens;
            if (u.cache_creation_input_tokens != null) tok.cacheWrite = u.cache_creation_input_tokens;
            if (u.output_tokens != null) tok.output = u.output_tokens;
            if (u.output_tokens_details?.thinking_tokens != null) tok.thinking = u.output_tokens_details.thinking_tokens;
            yield { type: 'usage', usage: snapshot() };
            break;
          }
          case 'message_stop':
            sawStop = true;
            break;
        }
      }
    } catch (err) {
      throw mapAnthropicError(err, this.id, req.signal, secrets);
    }

    if (req.signal.aborted) throw abortedError(this.id);
    if (!sawStop && !stopReason) {
      throw new ProviderError('Luồng phản hồi của Anthropic bị ngắt giữa chừng.', { kind: 'network', providerId: this.id, retryable: true });
    }

    const content: ContentBlock[] = [];
    for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
      const b = blocks.get(idx)!;
      if (b.type === 'text') {
        if (b.text) content.push({ type: 'text', text: b.text, provider: this.id });
      } else if (b.type === 'thinking') {
        content.push({ type: 'thinking', text: b.text, signature: b.signature, provider: this.id });
      } else if (b.type === 'redacted') {
        content.push({ type: 'thinking', text: '', redactedData: b.redacted, provider: this.id });
      } else if (b.type === 'tool_use' && b.id && b.name) {
        const tool = makeToolUse(this.id, b.id, b.name, b.json);
        if (!b.stopped && !tool.parseError) {
          tool.parseError = 'Luồng bị ngắt trước khi đối số công cụ hoàn tất.';
          tool.rawArgs = b.json;
        }
        content.push(tool);
      }
    }

    const message: ChatMessage = { role: 'assistant', content, provider: this.id, model: req.model, ts: Date.now() };
    yield {
      type: 'done',
      message,
      stopReason: mapStopReason(stopReason),
      usage: snapshot(),
      // Yêu cầu này được chấp nhận chỉ sau khi bỏ suy luận cũ → engine phải xoá chúng khỏi lịch sử đã lưu.
      ...(state.noReplayThinking ? { droppedReplayedThinking: true } : {}),
    };
  }

  async complete(req: CompleteRequest): Promise<string> {
    const { client, key } = await this.client();
    const policy = resolveRetryPolicy(this.cfg.options);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(req.signal?.reason);
    if (req.signal?.aborted) ctrl.abort(req.signal.reason);
    else req.signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = req.timeoutMs ?? 30_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);

    // complete() phục vụ tóm tắt nền/nén ngữ cảnh nên luôn chọn cấu hình suy luận rẻ nhất:
    // haiku-5-5 → disabled; model luôn bật suy luận → effort 'low'; dòng budget → bỏ `thinking`.
    // Trần đầu ra có sàn: token suy luận (nếu model buộc phải suy luận) cũng tính vào max_tokens.
    const maxTokens = Math.max(req.maxOutputTokens, COMPLETE_MIN_OUTPUT_TOKENS);
    const th = buildThinkingParams(req.model, 'off', false, maxTokens);

    try {
      const message = await retryAsync(
        { providerId: this.id, signal: ctrl.signal, policy, log: this.cfg.log },
        async () => {
          try {
            const params: Record<string, unknown> = {
              model: req.model,
              max_tokens: maxTokens,
              messages: [{ role: 'user', content: req.prompt }],
            };
            if (!isBlank(req.system)) params.system = req.system;
            if (th.thinking) params.thinking = th.thinking;
            if (th.effort) params.output_config = { effort: th.effort };
            return await client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming, { signal: ctrl.signal });
          } catch (err) {
            throw mapAnthropicError(err, this.id, ctrl.signal, [key]);
          }
        },
      );
      return message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    } catch (err) {
      if (timedOut) {
        throw new ProviderError(`Quá ${Math.round(timeoutMs / 1000)} giây chưa có phản hồi.`, { kind: 'timeout', providerId: this.id, retryable: false });
      }
      throw toProviderError(err, this.id, req.signal, [key]);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  async fetchModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { client, key } = await this.client();
    const out: ModelInfo[] = [];
    try {
      for await (const m of client.models.list({ limit: 1000 }, { signal })) {
        if (m.lifecycle === 'retired') continue;
        const created = Date.parse(m.created_at);
        const caps = m.capabilities;
        const info: ModelInfo = {
          id: m.id,
          label: m.display_name || m.id,
          contextWindow: m.max_input_tokens ?? undefined,
          maxOutputTokens: m.max_tokens ?? undefined,
          reasoning: caps?.thinking?.supported ?? undefined,
          vision: caps?.image_input?.supported ?? undefined,
          createdAt: Number.isFinite(created) && created > 0 ? created : undefined,
          tier: m.line === 'haiku' ? 'fast' : m.line === 'sonnet' ? 'balanced' : m.line ? 'top' : undefined,
        };
        if (m.lifecycle === 'deprecated') info.note = 'Sắp ngừng hỗ trợ';
        out.push(info);
      }
    } catch (err) {
      throw mapAnthropicError(err, this.id, signal, [key]);
    }
    return out;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const { client, key } = await this.client();
    try {
      await client.models.list({ limit: 1 }, { signal });
    } catch (err) {
      throw mapAnthropicError(err, this.id, signal, [key]);
    }
  }
}
