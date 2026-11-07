/**
 * Adapter OpenAI Chat Completions — dùng cho DeepSeek (flavor 'deepseek') và mọi API tương thích OpenAI
 * (flavor 'generic': OpenRouter, Ollama, LM Studio, Groq, Together, Mistral, Fireworks, vLLM…).
 *
 * DeepSeek (tài liệu 10/2026):
 *  - `thinking:{type:'enabled'|'disabled'}` (mặc định BẬT) và `reasoning_effort` none/low/high/max.
 *  - Suy luận nằm ở `delta.reasoning_content`.
 *  - Khi có `tools` và đang bật suy luận, MỌI tin nhắn assistant trước đó phải mang `reasoning_content`
 *    (thiếu → HTTP 400) → ta luôn phát lại (chuỗi rỗng nếu không có). Nếu server vẫn phàn nàn về
 *    reasoning_content thì gọi lại với suy luận TẮT.
 *  - `tool_choice` ép buộc bị cấm ở chế độ suy luận → ta chỉ dùng mặc định (auto).
 *
 * Generic: khoan dung — bỏ tham số mà server không biết (stream_options, parallel_tool_calls,
 * reasoning_effort…), đổi giữa `max_tokens` ↔ `max_completion_tokens`, chấp nhận suy luận ở
 * `reasoning_content` hoặc `reasoning`, tool_calls thiếu index/id, thẻ <think> nằm lẫn trong nội dung
 * (engine tự tách).
 */

import {
  ProviderError,
  type ChatMessage,
  type CompleteRequest,
  type ContentBlock,
  type LLMProvider,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderFlavor,
  type ProviderRuntimeConfig,
  type StopReason,
  type StreamRequest,
  type Usage,
} from '../types';
import { wellFormedDeep } from '../textSafe';
import { completeViaStream, isObject } from './common';
import { withAuthRefresh } from './gatewayAuth'; // (lane:gateway-client)
import { AUTH_MESSAGE } from './locaithGateway'; // (lane:gateway-client)
import { dataUrl, isBlank, makeToolUse, normalizeHistory } from './history';
import {
  abortedError,
  classifyHttpError,
  findOffendingParam,
  joinUrl,
  openSse,
  optNumber,
  parseOutputLimit,
  rememberRemoval,
  rememberedOutputCap,
  rememberedRemovals,
  requestJson,
  resolveRetryPolicy,
  retryAsync,
  synthToolId,
  toProviderError,
  withDegradation,
  withRetries,
  boundFetch,
  SSE_OPEN_EVENT,
  type HttpContext,
  type RetryState,
} from './http';
import { selectDeepseekModels, selectGenericModels, type RawModel } from './modelFilters';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MAX_TOKENS = 393_216;

// ─────────────────────────────────────────────────────────────────────────────
// Trạng thái hạ cấp
// ─────────────────────────────────────────────────────────────────────────────

interface ChatDegrade {
  noStreamOptions: boolean;
  noParallel: boolean;
  noReasoningEffort: boolean;
  noThinkingParam: boolean;
  /** DeepSeek: ép tắt suy luận (do lỗi reasoning_content). */
  disableThinking: boolean;
  noToolChoice: boolean;
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** Trần token đầu ra học được từ thông điệp lỗi của máy chủ. */
  outputCap?: number;
  /** Giá trị token đầu ra vừa gửi (để chỉ nhận trần nhỏ hơn nó). */
  lastMax?: number;
}

function loadDegrade(providerId: string, model: string): ChatDegrade {
  const mem = rememberedRemovals(providerId, model);
  return {
    noStreamOptions: mem.has('stream_options'),
    noParallel: mem.has('parallel_tool_calls'),
    noReasoningEffort: mem.has('reasoning_effort'),
    noThinkingParam: mem.has('thinking'),
    disableThinking: mem.has('thinking_off'),
    noToolChoice: mem.has('tool_choice'),
    tokenParam: mem.has('use_max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens',
    outputCap: rememberedOutputCap(mem),
  };
}

const PARAM_CANDIDATES = ['stream_options', 'parallel_tool_calls', 'reasoning_effort', 'max_completion_tokens', 'max_tokens', 'thinking', 'tool_choice'] as const;

function degradeChat(err: ProviderError, st: ChatDegrade, providerId: string, model: string, flavor: ProviderFlavor): boolean {
  const msg = `${err.message} ${err.details ?? ''}`;
  const note = (t: string) => rememberRemoval(providerId, model, t);

  if (flavor === 'deepseek' && /reasoning_content/i.test(msg) && !st.disableThinking) {
    st.disableThinking = true;
    note('thinking_off');
    return true;
  }

  // "max_tokens quá lớn": đổi tên tham số không cứu được, phải hạ độ lớn xuống đúng giới hạn máy chủ báo.
  // (Chỉ nhận khi nhỏ hơn giá trị vừa gửi: "maximum context length is 128000 tokens" là lỗi ngữ cảnh, không phải trần đầu ra.)
  const limit = parseOutputLimit(msg);
  if (limit !== undefined && limit < (st.lastMax ?? Infinity) && (st.outputCap === undefined || limit < st.outputCap)) {
    st.outputCap = limit;
    note(`maxcap=${limit}`);
    return true;
  }

  switch (findOffendingParam(msg, PARAM_CANDIDATES)) {
    case 'tool_choice':
      if (st.noToolChoice) return false;
      st.noToolChoice = true;
      note('tool_choice');
      return true;
    case 'stream_options':
      if (st.noStreamOptions) return false;
      st.noStreamOptions = true;
      note('stream_options');
      return true;
    case 'parallel_tool_calls':
      if (st.noParallel) return false;
      st.noParallel = true;
      note('parallel_tool_calls');
      return true;
    case 'reasoning_effort':
      if (st.noReasoningEffort) return false;
      st.noReasoningEffort = true;
      note('reasoning_effort');
      return true;
    case 'thinking':
      if (st.noThinkingParam) return false;
      st.noThinkingParam = true;
      note('thinking');
      return true;
    case 'max_completion_tokens':
      if (st.tokenParam === 'max_tokens') return false;
      st.tokenParam = 'max_tokens';
      return true;
    case 'max_tokens':
      if (st.tokenParam === 'max_completion_tokens') return false;
      st.tokenParam = 'max_completion_tokens';
      note('use_max_completion_tokens');
      return true;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chuyển đổi lịch sử
// ─────────────────────────────────────────────────────────────────────────────

type Msg = Record<string, unknown>;

/** Một số server giới hạn độ dài id lệnh gọi tool (OpenAI: 40). */
function safeToolId(id: string): string {
  return id.length <= 40 ? id : id.slice(0, 40);
}

export function toChatMessages(
  system: string,
  history: readonly ChatMessage[],
  opts: { providerId: string; echoReasoning: boolean },
): Msg[] {
  const out: Msg[] = [];
  if (!isBlank(system)) out.push({ role: 'system', content: system });

  for (const m of normalizeHistory(history)) {
    if (m.role === 'user') {
      const toolImages: ContentBlock[] = [];
      let lastTool = -1;
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const text = isBlank(b.content) ? (b.isError ? '(lỗi, không có thông điệp)' : '(không có đầu ra)') : b.content;
        out.push({ role: 'tool', tool_call_id: safeToolId(b.toolUseId), content: text });
        lastTool = out.length - 1;
        if (b.images) toolImages.push(...b.images);
      }
      const texts: string[] = [];
      const volatile: string[] = [];
      const images: ContentBlock[] = [...toolImages];
      for (const b of m.content) {
        if (b.type === 'text' && !isBlank(b.text)) (b.volatile ? volatile : texts).push(b.text);
        else if (b.type === 'image') images.push(b);
      }
      // Dòng ngân sách vòng lặp (`volatile`, đổi ở MỖI lần gọi): nếu tin có kết quả công cụ thì GỘP vào cuối tin `tool` cuối cùng — không tạo tin `user`
      // cuối cùng, vì DeepSeek (và vài máy chủ khác) coi tin user cuối là RANH GIỚI LƯỢT và bỏ suy luận của các vòng công cụ phía trước.
      // Tiền tố lịch sử không đổi (ghi chú chỉ nằm ở tin cuối của payload) nên bộ nhớ đệm tiền tố của máy chủ vẫn dùng được.
      if (volatile.length > 0) {
        if (lastTool >= 0) out[lastTool].content = `${String(out[lastTool].content)}\n\n${volatile.join('\n\n')}`;
        else texts.push(...volatile);
      }
      if (images.length === 0) {
        if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n\n') });
      } else {
        const parts: Msg[] = texts.map((t) => ({ type: 'text', text: t }));
        if (toolImages.length > 0 && texts.length === 0) parts.push({ type: 'text', text: 'Hình ảnh do công cụ trả về:' });
        for (const img of images) {
          if (img.type === 'image') parts.push({ type: 'image_url', image_url: { url: dataUrl(img.mediaType, img.data) } });
        }
        out.push({ role: 'user', content: parts });
      }
    } else {
      let text = '';
      let reasoning = '';
      const toolCalls: Msg[] = [];
      for (const b of m.content) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'thinking') {
          if (b.provider === opts.providerId) reasoning += (reasoning && b.text ? '\n\n' : '') + b.text;
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: safeToolId(b.id),
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          });
        }
      }
      if (isBlank(text) && toolCalls.length === 0) continue;
      const msg: Msg = { role: 'assistant', content: isBlank(text) ? (toolCalls.length > 0 ? null : '') : text };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      if (opts.echoReasoning) msg.reasoning_content = reasoning;
      out.push(msg);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lỗi & usage
// ─────────────────────────────────────────────────────────────────────────────

function errorFromBody(providerId: string, err: unknown, secrets: ReadonlyArray<string | undefined>): ProviderError {
  const e = (isObject(err) ? err : {}) as { code?: unknown; message?: unknown; type?: unknown; status?: unknown };
  const status = typeof e.status === 'number' ? e.status : typeof e.code === 'number' ? e.code : 500;
  const body = JSON.stringify({ error: { message: String(e.message ?? 'Lỗi không rõ'), code: e.code, type: e.type } });
  return classifyHttpError(providerId, status >= 400 && status < 600 ? status : 500, body, undefined, secrets);
}

function mapUsage(u: unknown): Usage | undefined {
  if (!isObject(u)) return undefined;
  const usage = u as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  const out: Usage = { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 };
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (cached) out.cacheReadTokens = cached;
  if (reasoning) out.reasoningTokens = reasoning;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

interface CallState {
  id: string;
  name: string;
  args: string;
  started: boolean;
  ended: boolean;
}

export class OpenAIChatProvider implements LLMProvider {
  readonly id: string;
  readonly label: string;
  readonly kind = 'openai-chat' as const;
  readonly flavor: ProviderFlavor;
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly cfg: ProviderRuntimeConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.flavor = cfg.flavor === 'deepseek' ? 'deepseek' : 'generic';
    this.capabilities = {
      reasoning: this.flavor === 'deepseek' ? 'native-visible' : 'hidden',
      parallelTools: true,
      vision: this.flavor !== 'deepseek',
      toolArgStreaming: 'incremental',
    };
  }

  private baseUrl(): string {
    return (this.cfg.baseUrl || (this.flavor === 'deepseek' ? DEEPSEEK_DEFAULT_BASE_URL : '')).replace(/\/+$/, '');
  }

  private async http(): Promise<{ ctx: HttpContext; headers: Record<string, string>; hasKey: boolean }> {
    // (lane:gateway-client) Nhà cung cấp tài khoản: token lấy qua người giữ token — token đã đánh dấu hỏng không bao giờ được trả ra, mà phải làm mới trước.
    const key = this.cfg.auth ? await this.cfg.auth.acquire() : await this.cfg.getApiKey();
    // Server cục bộ (Ollama, LM Studio…) không cần khoá; DeepSeek thì bắt buộc.
    const requiresKey = this.flavor === 'deepseek' || this.cfg.options?.requiresKey === true;
    if (!key && this.cfg.auth && (await this.cfg.getApiKey())) {
      // Đã đăng nhập nhưng token bị cổng từ chối và chưa làm mới được: không gửi đi, báo lỗi hành động được (đăng nhập lại).
      throw new ProviderError(AUTH_MESSAGE, { kind: 'auth', providerId: this.id, status: 401, retryable: false, accountAuth: true });
    }
    if (!key && requiresKey) {
      // Nhà cung cấp dùng tài khoản Locaith (credential 'account') không có "khoá API" để nhập: thiếu token nghĩa là chưa đăng nhập.
      throw new ProviderError(
        this.cfg.credential === 'account' ? 'Cần đăng nhập tài khoản Locaith để dùng mô hình này.' : `Chưa có khóa API cho ${this.label}. Hãy đặt khóa trong phần Cài đặt.`,
        { kind: 'auth', providerId: this.id, retryable: false },
      );
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(this.cfg.extraHeaders ?? {}), ...(this.cfg.requestHeaders?.({}) ?? {}) };
    if (key) headers.authorization = `Bearer ${key}`;
    return {
      hasKey: !!key,
      headers,
      ctx: { providerId: this.id, fetchImpl: boundFetch(this.cfg.fetchImpl), secrets: [key], log: this.cfg.log },
    };
  }

  /** Báo cổng Locaith: người dùng đã rời hàng chờ (bấm Dừng). Không chờ kết quả, mọi lỗi bị nuốt — vé cũng tự hết hạn phía cổng. */
  private leaveQueue(ctx: HttpContext, headers: Record<string, string>, ticket: string | undefined): void {
    if (!ticket) return;
    try {
      const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(5000) : undefined;
      const doFetch = ctx.fetchImpl; // gọi như hàm trần (xem boundFetch)
      void doFetch(joinUrl(this.baseUrl(), 'queue/leave'), { method: 'POST', headers, body: JSON.stringify({ ticket }), ...(signal ? { signal } : {}) })
        .then((r) => r.body?.cancel().catch(() => undefined))
        .catch(() => undefined);
    } catch {
      /* không quan trọng */
    }
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    // Chốt chặn trước lời gọi trò chuyện (ví dụ chưa đồng ý thông báo dữ liệu của Locaith): không có byte nào rời máy.
    const blocked = this.cfg.guard?.();
    if (blocked) throw blocked;
    const { ctx, headers, hasKey } = await this.http();
    const st = loadDegrade(this.id, req.model);
    const policy = resolveRetryPolicy(this.cfg.options);

    const chain = () =>
      withDegradation(
        () =>
          withRetries(
            { providerId: this.id, signal: req.signal, policy, log: this.cfg.log, onQueueLeave: (ticket) => this.leaveQueue(ctx, headers, ticket) },
            (rs) => this.runOnce(ctx, headers, req, st, rs),
          ),
        (err) => degradeChat(err, st, this.id, req.model, this.flavor),
      );
    try {
      const auth = this.cfg.auth;
      if (auth) {
        // (lane:gateway-client) 401: làm mới token đúng một lần rồi gửi lại đúng một lần; vẫn 401 thì dừng.
        yield* withAuthRefresh(
          {
            auth,
            providerId: this.id,
            signal: req.signal,
            log: this.cfg.log,
            message: AUTH_MESSAGE,
            getKey: () => /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1],
            setKey: (k) => {
              headers.authorization = `Bearer ${k}`;
              ctx.secrets = [k];
            },
          },
          chain,
          this.cfg.credential,
        );
      } else {
        yield* chain();
      }
    } catch (err) {
      if (!hasKey && err instanceof ProviderError && err.kind === 'auth') {
        throw new ProviderError(`Máy chủ ${this.label} yêu cầu khóa API nhưng chưa có khóa nào được đặt.`, {
          kind: 'auth',
          providerId: this.id,
          status: err.status,
          retryable: false,
        });
      }
      throw err;
    }
  }

  private buildBody(req: StreamRequest, st: ChatDegrade): Record<string, unknown> {
    const hasTools = req.tools.length > 0;
    // DeepSeek: suy luận bật + có tools → phải phát lại reasoning_content của mọi lượt trước.
    // (Nếu server không nhận tham số `thinking`, ta bỏ nó và DeepSeek mặc định BẬT suy luận.)
    const thinkingOn = this.flavor === 'deepseek' && !st.disableThinking && (st.noThinkingParam ? true : req.thinking.level !== 'off');
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toChatMessages(req.system, req.messages, {
        providerId: this.id,
        echoReasoning: this.flavor === 'deepseek' && thinkingOn && hasTools,
      }),
      stream: true,
    };
    const wanted = this.flavor === 'deepseek' ? Math.min(req.maxOutputTokens, DEEPSEEK_MAX_TOKENS) : req.maxOutputTokens;
    st.lastMax = st.outputCap !== undefined ? Math.min(wanted, st.outputCap) : wanted;
    body[st.tokenParam] = st.lastMax;
    if (!st.noStreamOptions) body.stream_options = { include_usage: true };

    if (hasTools) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      if (req.parallelToolCalls === false && !st.noParallel) body.parallel_tool_calls = false;
      if (req.toolChoice === 'none' && !st.noToolChoice) body.tool_choice = 'none';
    }

    if (this.flavor === 'deepseek') {
      if (!st.noThinkingParam) body.thinking = { type: thinkingOn ? 'enabled' : 'disabled' };
      if (thinkingOn && !st.noReasoningEffort) {
        body.reasoning_effort = { low: 'low', medium: 'high', high: 'high', max: 'max', off: 'low' }[req.thinking.level];
      }
    } else if (req.thinking.level !== 'off' && !st.noReasoningEffort) {
      body.reasoning_effort = req.thinking.level === 'max' ? 'high' : req.thinking.level;
    }
    return body;
  }

  private async *runOnce(
    ctx: HttpContext,
    baseHeaders: Record<string, string>,
    req: StreamRequest,
    st: ChatDegrade,
    rs: RetryState = {},
  ): AsyncGenerator<ProviderEvent, void, void> {
    const body = this.buildBody(req, st);
    // Tiêu đề tính theo từng lời gọi (cổng Locaith: mã phiên cuộc trò chuyện + mã vé nếu đang xếp hàng).
    const headers = this.cfg.requestHeaders ? { ...baseHeaders, ...this.cfg.requestHeaders({ sessionKey: req.sessionKey, ticket: rs.ticket }) } : baseHeaders;
    this.cfg.log?.('debug', `[${this.id}] → POST /chat/completions model=${req.model} tools=${req.tools.length} thinking=${JSON.stringify(body.thinking ?? null)}`);

    const calls = new Map<number, CallState>();
    let content = '';
    let reasoning = '';
    let finish: string | null = null;
    let usage: Usage | undefined;
    let sawChunk = false;

    let sawDone = false; // `data: [DONE]` do bộ phân tích SSE nuốt và báo qua onSentinel
    const sse = openSse(
      ctx,
      joinUrl(this.baseUrl(), 'chat/completions'),
      { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify(wellFormedDeep(body)) },
      {
        signal: req.signal,
        headerTimeoutMs: optNumber(this.cfg.options, 'headerTimeoutMs'),
        idleTimeoutMs: optNumber(this.cfg.options, 'idleTimeoutMs'),
        onSentinel: () => {
          sawDone = true;
        },
        // Đang xếp hàng (đã có mã vé): báo ngay khi cổng nhận yêu cầu để giao diện bỏ dải hàng chờ.
        markOpen: !!rs.ticket,
      },
    );

    const endCall = function* (c: CallState): Generator<ProviderEvent, void, void> {
      if (c.started && !c.ended) {
        c.ended = true;
        yield { type: 'tool_end', id: c.id, name: c.name };
      }
    };

    for await (const msg of sse) {
      if (msg.event === SSE_OPEN_EVENT) {
        yield { type: 'queue_end' };
        continue;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (data.error) throw errorFromBody(this.id, data.error, ctx.secrets);
      sawChunk = true;

      const u = mapUsage(data.usage);
      if (u) usage = u;

      const choice = (Array.isArray(data.choices) ? data.choices[0] : undefined) as
        | { delta?: Record<string, unknown>; finish_reason?: string | null }
        | undefined;
      if (!choice) continue;
      const delta = choice.delta ?? {};

      const r = (delta.reasoning_content ?? delta.reasoning) as unknown;
      if (typeof r === 'string' && r) {
        reasoning += r;
        yield { type: 'thinking_delta', text: r };
      }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }

      const tcs = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
      for (const tc of tcs) {
        const fn = (isObject(tc.function) ? tc.function : {}) as { name?: unknown; arguments?: unknown };
        const tcId = typeof tc.id === 'string' && tc.id ? tc.id : undefined;
        const lastIdx = calls.size > 0 ? Math.max(...calls.keys()) : -1;
        let idx = typeof tc.index === 'number' ? tc.index : tcId ? lastIdx + 1 : Math.max(lastIdx, 0);
        // Một số server (vd. lớp tương thích của Gemini) gửi mọi lệnh gọi với index 0 nhưng id khác nhau.
        const existing = calls.get(idx);
        if (existing && tcId && existing.id && existing.started && tcId !== existing.id) idx = lastIdx + 1;
        let c = calls.get(idx);
        if (!c) {
          // Có lệnh gọi mới → các lệnh trước đó đã đủ đối số.
          for (const prev of calls.values()) yield* endCall(prev);
          c = { id: tcId ?? '', name: '', args: '', started: false, ended: false };
          calls.set(idx, c);
        }
        if (tcId && !c.id) c.id = tcId;
        if (typeof fn.name === 'string' && fn.name) c.name += c.started ? '' : fn.name;
        if (!c.started && c.name) {
          c.id ||= synthToolId('call_');
          c.started = true;
          yield { type: 'tool_start', id: c.id, name: c.name };
        }
        const argChunk = typeof fn.arguments === 'string' ? fn.arguments : isObject(fn.arguments) ? JSON.stringify(fn.arguments) : '';
        if (argChunk) {
          c.args += argChunk;
          if (c.started) yield { type: 'tool_args_delta', id: c.id, name: c.name, delta: argChunk };
        }
      }

      if (choice.finish_reason) finish = choice.finish_reason;
    }

    if (req.signal.aborted) throw abortedError(this.id);
    if (!sawChunk) {
      throw new ProviderError('Máy chủ kết thúc luồng mà không gửi dữ liệu nào.', { kind: 'server', providerId: this.id, retryable: true });
    }
    // Luồng đứt giữa chừng (mất mạng, proxy ngắt) thì kết thúc "sạch" mà không có finish_reason, [DONE] hay thống kê token.
    // Không được coi đó là một câu trả lời hoàn chỉnh — văn bản/đối số công cụ có thể đang cụt.
    if (finish === null && !sawDone && !usage) {
      throw new ProviderError('Luồng phản hồi bị ngắt giữa chừng (không nhận được tín hiệu kết thúc).', { kind: 'network', providerId: this.id, retryable: true });
    }

    // Đối số đến muộn hơn tên (hiếm): phát bù các mảnh chưa phát.
    for (const c of calls.values()) {
      if (!c.started && c.name) {
        c.id ||= synthToolId('call_');
        c.started = true;
        yield { type: 'tool_start', id: c.id, name: c.name };
        if (c.args) yield { type: 'tool_args_delta', id: c.id, name: c.name, delta: c.args };
      }
      yield* endCall(c);
    }

    if (finish === 'insufficient_system_resource' || finish === 'aborted') {
      throw new ProviderError(`Máy chủ ngắt phản hồi giữa chừng (${finish}). Hãy thử lại sau.`, {
        kind: 'server',
        providerId: this.id,
        retryable: true,
      });
    }

    const blocks: ContentBlock[] = [];
    if (reasoning) blocks.push({ type: 'thinking', text: reasoning, provider: this.id });
    if (content) blocks.push({ type: 'text', text: content, provider: this.id });
    for (const [, c] of [...calls.entries()].sort(([a], [b]) => a - b)) {
      if (!c.name) continue;
      blocks.push(makeToolUse(this.id, c.id, c.name, c.args));
    }
    const hasCalls = blocks.some((b) => b.type === 'tool_use');

    let stopReason: StopReason;
    switch (finish) {
      case 'length':
        stopReason = 'max_tokens';
        break;
      case 'content_filter':
        stopReason = 'content_filter';
        break;
      case 'tool_calls':
      case 'function_call':
        stopReason = 'tool_use';
        break;
      default:
        // 'stop' / null / lạ: có lệnh gọi công cụ thì vẫn là tool_use (Ollama hay báo 'stop').
        stopReason = hasCalls ? 'tool_use' : 'end_turn';
    }

    const finalUsage = usage ?? { inputTokens: 0, outputTokens: 0 };
    yield { type: 'usage', usage: finalUsage };
    const message: ChatMessage = { role: 'assistant', content: blocks, provider: this.id, model: req.model, ts: Date.now() };
    yield { type: 'done', message, stopReason, usage: finalUsage };
  }

  complete(req: CompleteRequest): Promise<string> {
    return completeViaStream(this, req);
  }

  async fetchModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { ctx, headers } = await this.http();
    const policy = resolveRetryPolicy(this.cfg.options);
    const ctrl = new AbortController();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    const json = await retryAsync({ providerId: this.id, signal: ctrl.signal, policy, log: this.cfg.log }, () =>
      requestJson<{ data?: Array<Record<string, unknown>> }>(
        ctx,
        joinUrl(this.baseUrl(), 'models'),
        { method: 'GET', headers: { ...headers, 'content-type': 'application/json' } },
        { signal: ctrl.signal, timeoutMs: 8000 },
      ),
    );
    const raw: RawModel[] = (json.data ?? [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => {
        const top = (isObject(m.top_provider) ? m.top_provider : {}) as { max_completion_tokens?: number };
        return {
          id: String(m.id),
          name: typeof m.name === 'string' ? m.name : undefined,
          createdAt: typeof m.created === 'number' && m.created > 0 ? m.created * 1000 : undefined,
          contextWindow: typeof m.context_length === 'number' ? m.context_length : undefined,
          // OpenRouter: top_provider.max_completion_tokens · cổng Locaith: max_output_tokens ngay ở cấp trên.
          maxOutputTokens: typeof m.max_output_tokens === 'number' ? m.max_output_tokens : typeof top.max_completion_tokens === 'number' ? top.max_completion_tokens : undefined,
        };
      });
    return this.flavor === 'deepseek' ? selectDeepseekModels(raw) : selectGenericModels(raw);
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const { ctx, headers } = await this.http();
    try {
      await requestJson(ctx, joinUrl(this.baseUrl(), 'models'), { method: 'GET', headers }, { signal, timeoutMs: 15_000 });
    } catch (err) {
      throw toProviderError(err, this.id, signal, ctx.secrets);
    }
  }
}
