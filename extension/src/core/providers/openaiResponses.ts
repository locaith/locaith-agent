/**
 * Adapter OpenAI Responses API — dùng cho OpenAI (flavor 'openai'), xAI Grok (flavor 'xai') và mọi
 * endpoint tương thích Responses (flavor 'generic').
 *
 * Vì sao Responses mà không phải Chat Completions: GPT-6 Astra/Sol KHÔNG hỗ trợ function calling trên
 * Chat Completions, và với Grok 4.5+ chỉ Responses mới giữ được mạch suy luận qua các lượt gọi công cụ.
 *
 * Chạy không trạng thái (`store:false`): mọi item đầu ra của lượt trước (reasoning + function_call +
 * message) được lưu nguyên văn trong `block.raw` và phát lại đúng thứ tự cùng `function_call_output`.
 * Item reasoning mang `encrypted_content` nên model vẫn nhớ mạch suy luận mà server không lưu gì.
 *
 * Khác biệt giữa các hãng được xử lý bằng cơ chế "hạ cấp thích nghi": khi server trả 400 vì một tham số
 * (reasoning.effort không hợp lệ, reasoning.summary, include…), adapter tự chỉnh/bỏ tham số rồi gọi lại và
 * nhớ lựa chọn theo từng model.
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
import { cloneJson, completeViaStream, isObject } from './common';
import { dataUrl, isBlank, makeToolUse, normalizeHistory } from './history';
import {
  abortedError,
  classifyHttpError,
  findOffendingParam,
  joinUrl,
  openSse,
  optNumber,
  parseOutputLimit,
  parseSupportedValues,
  pickNearest,
  rememberRemoval,
  rememberedOutputCap,
  rememberedRemovals,
  requestJson,
  resolveRetryPolicy,
  retryAsync,
  toProviderError,
  withDegradation,
  withRetries,
  boundFetch,
  type HttpContext,
} from './http';
import { selectGenericModels, selectOpenAIModels, selectXaiModels, type RawModel } from './modelFilters';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1';

export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Mức suy luận ban đầu cho từng hãng; sai thì server báo và `degradeResponses` sẽ chỉnh. */
export function initialEffort(flavor: ProviderFlavor, model: string, level: StreamRequest['thinking']['level']): string | undefined {
  if (/non-reasoning/i.test(model)) return undefined;
  if (flavor === 'xai') {
    // Grok 4.5+ không tắt được suy luận: "off" → low.
    return { off: 'low', low: 'low', medium: 'medium', high: 'high', max: 'xhigh' }[level];
  }
  return { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'max' }[level];
}

// ─────────────────────────────────────────────────────────────────────────────
// Trạng thái hạ cấp
// ─────────────────────────────────────────────────────────────────────────────

interface RespDegrade {
  noReasoning: boolean;
  noSummary: boolean;
  noInclude: boolean;
  noParallel: boolean;
  noCacheKey: boolean;
  noStrict: boolean;
  /** Không phát lại item reasoning trong lịch sử (server báo không tìm thấy/không được lưu). */
  noReplayReasoning: boolean;
  noToolChoice: boolean;
  effortOverride?: string;
  /** Trần token đầu ra học được từ thông điệp lỗi của máy chủ, và giá trị vừa gửi. */
  outputCap?: number;
  lastMax?: number;
}

function loadDegrade(providerId: string, model: string): RespDegrade {
  const mem = rememberedRemovals(providerId, model);
  const eff = [...mem].find((t) => t.startsWith('effort='));
  return {
    noReasoning: mem.has('reasoning'),
    noSummary: mem.has('reasoning.summary'),
    noInclude: mem.has('include'),
    noParallel: mem.has('parallel_tool_calls'),
    noCacheKey: mem.has('prompt_cache_key'),
    noStrict: mem.has('strict'),
    noReplayReasoning: mem.has('replay_reasoning'),
    noToolChoice: mem.has('tool_choice'),
    effortOverride: eff ? eff.slice('effort='.length) : undefined,
    outputCap: rememberedOutputCap(mem),
  };
}

const PARAM_CANDIDATES = [
  'reasoning.summary',
  'reasoning.effort',
  'reasoning',
  'include',
  'parallel_tool_calls',
  'prompt_cache_key',
  'strict',
  'tool_choice',
] as const;

function degradeResponses(
  err: ProviderError,
  st: RespDegrade,
  providerId: string,
  model: string,
  wantedEffort: string | undefined,
): boolean {
  const msg = `${err.message} ${err.details ?? ''}`;
  const note = (token: string) => rememberRemoval(providerId, model, token);

  // Item reasoning cũ không phát lại được (server không lưu / thiếu encrypted_content / thiếu item đi kèm).
  // "Item 'fc_…' of type 'function_call' was provided without its required 'reasoning' item" cũng là lỗi phát lại, KHÔNG phải
  // lỗi tham số `reasoning` (nếu nhầm, ta xoá vĩnh viễn reasoning.effort của model này).
  if (
    !st.noReplayReasoning &&
    /reasoning|\brs_[a-z0-9]/i.test(msg) &&
    /not found|not persisted|encrypted|following item|required following|without its required|was provided without/i.test(msg)
  ) {
    st.noReplayReasoning = true;
    note('replay_reasoning');
    return true;
  }

  // "max_output_tokens quá lớn": hạ xuống đúng giới hạn máy chủ báo (chỉ nhận khi nhỏ hơn giá trị vừa gửi).
  const limit = parseOutputLimit(msg);
  if (limit !== undefined && limit < (st.lastMax ?? Infinity) && (st.outputCap === undefined || limit < st.outputCap)) {
    st.outputCap = limit;
    note(`maxcap=${limit}`);
    return true;
  }

  // "Your organization must be verified to generate reasoning summaries" → chỉ bỏ summary, giữ nguyên effort.
  if (!st.noSummary && /summar/i.test(msg)) {
    st.noSummary = true;
    note('reasoning.summary');
    return true;
  }

  const param = findOffendingParam(msg, PARAM_CANDIDATES);

  if (param === 'reasoning.effort' || (param === 'reasoning' && /effort/i.test(msg))) {
    const effective = st.effortOverride ?? wantedEffort;
    const supported = parseSupportedValues(msg);
    if (supported.length > 0 && effective) {
      const next = pickNearest(effective, supported, EFFORT_ORDER);
      if (next && next !== effective) {
        st.effortOverride = next;
        note(`effort=${next}`);
        return true;
      }
    }
    if (!st.noReasoning) {
      st.noReasoning = true;
      note('reasoning');
      return true;
    }
    return false;
  }
  switch (param) {
    case 'tool_choice':
      if (st.noToolChoice) return false;
      st.noToolChoice = true;
      note('tool_choice');
      return true;
    case 'reasoning.summary':
      if (st.noSummary) return false;
      st.noSummary = true;
      note('reasoning.summary');
      return true;
    case 'reasoning':
      if (st.noReasoning) return false;
      st.noReasoning = true;
      note('reasoning');
      return true;
    case 'include':
      if (st.noInclude) return false;
      st.noInclude = true;
      note('include');
      return true;
    case 'parallel_tool_calls':
      if (st.noParallel) return false;
      st.noParallel = true;
      note('parallel_tool_calls');
      return true;
    case 'prompt_cache_key':
      if (st.noCacheKey) return false;
      st.noCacheKey = true;
      note('prompt_cache_key');
      return true;
    case 'strict':
      if (st.noStrict) return false;
      st.noStrict = true;
      note('strict');
      return true;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chuyển đổi lịch sử → input[]
// ─────────────────────────────────────────────────────────────────────────────

type Item = Record<string, unknown>;

/** call_id tối đa 64 ký tự. */
function safeCallId(id: string): string {
  return id.length <= 64 ? id : id.slice(0, 64);
}

/**
 * Item reasoning phải đi kèm item liền sau nó (message hoặc function_call). Phản hồi bị cắt giữa chừng
 * có thể để lại reasoning "mồ côi" → bỏ nó để khỏi bị server từ chối.
 */
export function dropOrphanReasoning(items: Item[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type === 'reasoning') {
      const next = items[i + 1];
      const pairs = next && (next.type === 'function_call' || next.type === 'message' || (next.role === 'assistant' && next.type === undefined));
      if (!pairs) continue;
    }
    out.push(it);
  }
  return out;
}

export function toResponsesInput(
  history: readonly ChatMessage[],
  providerId: string,
  opts: { dropReasoning?: boolean } = {},
): Item[] {
  /** Item thô của chính hãng này (nếu có) — khối của hãng khác hoặc thiếu `raw` thì bỏ qua. */
  const ownRaw = (b: { provider?: string; raw?: unknown }): Item | undefined =>
    b.provider === providerId && isObject(b.raw) ? (b.raw as Item) : undefined;
  const items: Item[] = [];
  for (const m of normalizeHistory(history)) {
    if (m.role === 'user') {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const text = isBlank(b.content) ? (b.isError ? '(lỗi, không có thông điệp)' : '(không có đầu ra)') : b.content;
        const output =
          b.images && b.images.length > 0
            ? [{ type: 'input_text', text }, ...b.images.map((img) => ({ type: 'input_image', image_url: dataUrl(img.mediaType, img.data) }))]
            : text;
        items.push({ type: 'function_call_output', call_id: safeCallId(b.toolUseId), output });
      }
      const parts: Item[] = [];
      for (const b of m.content) {
        if (b.type === 'text' && !isBlank(b.text)) parts.push({ type: 'input_text', text: b.text });
        else if (b.type === 'image') parts.push({ type: 'input_image', image_url: dataUrl(b.mediaType, b.data) });
      }
      if (parts.length > 0) items.push({ role: 'user', content: parts });
    } else {
      const outItems: Item[] = [];
      // Item `fc_…`/`msg_…` ĐI KÈM item reasoning của nó. Nếu reasoning không được phát lại (đã bị nén/cắt tỉa hoặc server
      // không nhận), phát lại item thô kèm `id` sẽ bị từ chối ("provided without its required 'reasoning' item") →
      // khi đó dùng dạng không-id (function_call trần, tin nhắn assistant dạng văn bản).
      const keepsReasoning = !opts.dropReasoning && m.content.some((b) => b.type === 'thinking' && ownRaw(b)?.type === 'reasoning');
      for (const b of m.content) {
        if (b.type === 'thinking') {
          const raw = ownRaw(b);
          if (!opts.dropReasoning && raw?.type === 'reasoning') outItems.push(cloneJson(raw));
        } else if (b.type === 'text') {
          const raw = ownRaw(b);
          if (raw?.type === 'message' && keepsReasoning) outItems.push(cloneJson(raw));
          else if (!isBlank(b.text)) outItems.push({ role: 'assistant', content: b.text });
        } else if (b.type === 'tool_use') {
          const raw = ownRaw(b);
          if (raw?.type === 'function_call') {
            const copy = cloneJson(raw);
            copy.call_id = safeCallId(String(copy.call_id ?? b.id));
            if (!keepsReasoning) {
              delete copy.id;
              delete copy.status;
            }
            outItems.push(copy);
          } else {
            outItems.push({ type: 'function_call', call_id: safeCallId(b.id), name: b.name, arguments: JSON.stringify(b.input) });
          }
        }
      }
      items.push(...dropOrphanReasoning(outItems));
    }
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lỗi từ sự kiện luồng
// ─────────────────────────────────────────────────────────────────────────────

const CODE_TO_STATUS: Record<string, number> = {
  rate_limit_exceeded: 429,
  insufficient_quota: 429,
  server_error: 500,
  internal_error: 500,
  overloaded: 503,
  service_unavailable: 503,
  context_length_exceeded: 400,
  invalid_prompt: 400,
  invalid_request_error: 400,
  invalid_api_key: 401,
  authentication_error: 401,
};

function errorFromEvent(providerId: string, err: unknown, secrets: ReadonlyArray<string | undefined>): ProviderError {
  const e = (isObject(err) ? err : {}) as { code?: unknown; message?: unknown; type?: unknown };
  const code = typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : '';
  const status = CODE_TO_STATUS[code] ?? 500;
  const body = JSON.stringify({ error: { message: String(e.message ?? 'Lỗi không rõ'), code } });
  return classifyHttpError(providerId, status, body, undefined, secrets);
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

interface ItemState {
  type: string;
  callId?: string;
  name?: string;
  args: string;
  started: boolean;
  argsEmitted: boolean;
  ended: boolean;
  summaryParts: number;
  emittedThinking: boolean;
  done?: Item;
}

function mapUsage(u: unknown): Usage {
  const usage = (isObject(u) ? u : {}) as {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  const out: Usage = { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  if (cached) out.cacheReadTokens = cached;
  if (reasoning) out.reasoningTokens = reasoning;
  return out;
}

export function itemsToBlocks(outputItems: readonly Item[], providerId: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const it of outputItems) {
    if (it.type === 'reasoning') {
      const summary = Array.isArray(it.summary) ? (it.summary as Array<{ text?: string }>).map((s) => s.text ?? '').filter(Boolean) : [];
      const content = Array.isArray(it.content) ? (it.content as Array<{ text?: string }>).map((s) => s.text ?? '').filter(Boolean) : [];
      const text = (summary.length > 0 ? summary : content).join('\n\n');
      blocks.push({ type: 'thinking', text, provider: providerId, raw: cloneJson(it) });
    } else if (it.type === 'message') {
      const parts = Array.isArray(it.content) ? (it.content as Array<{ type?: string; text?: string; refusal?: string }>) : [];
      const text = parts.map((p) => (p.type === 'refusal' ? p.refusal ?? '' : p.text ?? '')).join('');
      blocks.push({ type: 'text', text, provider: providerId, raw: cloneJson(it) });
    } else if (it.type === 'function_call') {
      const callId = String(it.call_id ?? it.id ?? '');
      blocks.push(makeToolUse(providerId, callId, String(it.name ?? ''), it.arguments as string | undefined, cloneJson(it)));
    }
  }
  return blocks;
}

export class OpenAIResponsesProvider implements LLMProvider {
  readonly id: string;
  readonly label: string;
  readonly kind = 'openai-responses' as const;
  readonly flavor: ProviderFlavor;
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly cfg: ProviderRuntimeConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.flavor = cfg.flavor === 'xai' || cfg.flavor === 'openai' ? cfg.flavor : 'generic';
    this.capabilities = {
      reasoning: this.flavor === 'generic' ? 'hidden' : 'summary',
      parallelTools: true,
      vision: true,
      // xAI trả nguyên cụm lệnh gọi hàm, không stream đối số từng mảnh.
      toolArgStreaming: this.flavor === 'xai' ? 'whole' : 'incremental',
    };
  }

  private baseUrl(): string {
    return (this.cfg.baseUrl || (this.flavor === 'xai' ? XAI_DEFAULT_BASE_URL : OPENAI_DEFAULT_BASE_URL)).replace(/\/+$/, '');
  }

  private async http(): Promise<{ ctx: HttpContext; key: string | undefined; headers: Record<string, string> }> {
    const key = await this.cfg.getApiKey();
    // Endpoint Responses tương thích chạy cục bộ (flavor generic, requiresKey:false) có thể không cần khoá.
    const keyOptional = this.flavor === 'generic' && this.cfg.options?.requiresKey === false;
    if (!key && !keyOptional) {
      throw new ProviderError(`Chưa có khóa API cho ${this.label}. Hãy đặt khóa trong phần Cài đặt.`, {
        kind: 'auth',
        providerId: this.id,
        retryable: false,
      });
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(this.cfg.extraHeaders ?? {}) };
    if (key) headers.authorization = `Bearer ${key}`;
    return {
      key,
      ctx: { providerId: this.id, fetchImpl: boundFetch(this.cfg.fetchImpl), secrets: [key], log: this.cfg.log },
      headers,
    };
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    const { ctx, headers } = await this.http();
    const st = loadDegrade(this.id, req.model);
    const policy = resolveRetryPolicy(this.cfg.options);
    const wantedEffort = initialEffort(this.flavor, req.model, req.thinking.level);

    yield* withDegradation(
      () =>
        withRetries({ providerId: this.id, signal: req.signal, policy, log: this.cfg.log }, () =>
          this.runOnce(ctx, headers, req, st, wantedEffort),
        ),
      (err) => degradeResponses(err, st, this.id, req.model, wantedEffort),
      4,
      // 404 "Item with id 'rs_…' not found" cũng cần được xử lý như lỗi tham số.
      ['bad_request', 'not_found'],
    );
  }

  private buildBody(req: StreamRequest, st: RespDegrade, wantedEffort: string | undefined): Record<string, unknown> {
    st.lastMax = st.outputCap !== undefined ? Math.min(req.maxOutputTokens, st.outputCap) : req.maxOutputTokens;
    const body: Record<string, unknown> = {
      model: req.model,
      input: toResponsesInput(req.messages, this.id, { dropReasoning: st.noReplayReasoning }),
      max_output_tokens: st.lastMax,
      store: false,
      stream: true,
    };
    if (!isBlank(req.system)) body.instructions = req.system;

    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => {
        const tool: Record<string, unknown> = { type: 'function', name: t.name, description: t.description, parameters: t.inputSchema };
        if (this.flavor === 'openai' && !st.noStrict) tool.strict = false;
        return tool;
      });
      if (!st.noParallel) body.parallel_tool_calls = req.parallelToolCalls !== false;
      if (req.toolChoice === 'none' && !st.noToolChoice) body.tool_choice = 'none';
    }

    const effort = st.effortOverride ?? wantedEffort;
    if (effort && !st.noReasoning) {
      const reasoning: Record<string, unknown> = { effort };
      if (this.flavor === 'openai' && !st.noSummary && req.thinking.summaries && req.thinking.level !== 'off' && effort !== 'none') {
        reasoning.summary = 'auto';
      }
      body.reasoning = reasoning;
    }
    if (!st.noInclude && this.flavor !== 'generic') body.include = ['reasoning.encrypted_content'];
    if (this.flavor === 'openai' && req.sessionKey && !st.noCacheKey) body.prompt_cache_key = req.sessionKey;
    return body;
  }

  private async *runOnce(
    ctx: HttpContext,
    headers: Record<string, string>,
    req: StreamRequest,
    st: RespDegrade,
    wantedEffort: string | undefined,
  ): AsyncGenerator<ProviderEvent, void, void> {
    const body = this.buildBody(req, st, wantedEffort);
    this.cfg.log?.('debug', `[${this.id}] → POST /responses model=${req.model} effort=${JSON.stringify(body.reasoning ?? null)} tools=${req.tools.length}`);

    const items = new Map<number, ItemState>();
    let finalResponse: Record<string, unknown> | undefined;
    let incomplete = false;

    const state = (idx: number, type = 'unknown'): ItemState => {
      let s = items.get(idx);
      if (!s) {
        s = { type, args: '', started: false, argsEmitted: false, ended: false, summaryParts: 0, emittedThinking: false };
        items.set(idx, s);
      }
      return s;
    };

    const sse = openSse(
      ctx,
      joinUrl(this.baseUrl(), 'responses'),
      { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify(wellFormedDeep(body)) },
      {
        signal: req.signal,
        headerTimeoutMs: optNumber(this.cfg.options, 'headerTimeoutMs'),
        idleTimeoutMs: optNumber(this.cfg.options, 'idleTimeoutMs'),
      },
    );

    for await (const msg of sse) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        continue; // dòng không phải JSON (keep-alive lạ) → bỏ qua
      }
      const type = String(data.type ?? msg.event ?? '');
      const outIndex = typeof data.output_index === 'number' ? data.output_index : 0;

      switch (type) {
        case 'response.output_item.added': {
          const it = (data.item ?? {}) as Item;
          const s = state(outIndex, String(it.type ?? 'unknown'));
          s.type = String(it.type ?? s.type);
          if (s.type === 'function_call') {
            s.callId = String(it.call_id ?? it.id ?? '');
            s.name = String(it.name ?? '');
            s.started = true;
            yield { type: 'tool_start', id: s.callId, name: s.name };
            if (typeof it.arguments === 'string' && it.arguments) {
              s.args = it.arguments;
              s.argsEmitted = true;
              yield { type: 'tool_args_delta', id: s.callId, name: s.name, delta: it.arguments };
            }
          }
          break;
        }
        case 'response.function_call_arguments.delta': {
          const s = state(outIndex, 'function_call');
          const delta = String(data.delta ?? '');
          if (s.callId && delta) {
            s.args += delta;
            s.argsEmitted = true;
            yield { type: 'tool_args_delta', id: s.callId, name: s.name ?? '', delta };
          }
          break;
        }
        case 'response.function_call_arguments.done': {
          const s = state(outIndex, 'function_call');
          if (typeof data.arguments === 'string') s.args = data.arguments;
          break;
        }
        case 'response.output_item.done': {
          const it = (data.item ?? {}) as Item;
          const s = state(outIndex, String(it.type ?? 'unknown'));
          s.type = String(it.type ?? s.type);
          s.done = it;
          if (s.type === 'function_call' && !s.ended) {
            s.callId ||= String(it.call_id ?? it.id ?? '');
            s.name ||= String(it.name ?? '');
            const finalArgs = typeof it.arguments === 'string' ? it.arguments : s.args;
            if (!s.started) {
              s.started = true;
              yield { type: 'tool_start', id: s.callId, name: s.name };
            }
            if (!s.argsEmitted && finalArgs) {
              s.argsEmitted = true;
              yield { type: 'tool_args_delta', id: s.callId, name: s.name, delta: finalArgs };
            }
            s.ended = true;
            yield { type: 'tool_end', id: s.callId, name: s.name };
          }
          break;
        }
        case 'response.output_text.delta':
        case 'response.refusal.delta': {
          const delta = String(data.delta ?? '');
          if (delta) yield { type: 'text_delta', text: delta };
          break;
        }
        case 'response.reasoning_summary_part.added': {
          const s = state(outIndex, 'reasoning');
          if (s.emittedThinking && s.summaryParts > 0) yield { type: 'thinking_delta', text: '\n\n' };
          s.summaryParts++;
          break;
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const s = state(outIndex, 'reasoning');
          const delta = String(data.delta ?? '');
          if (delta) {
            s.emittedThinking = true;
            yield { type: 'thinking_delta', text: delta };
          }
          break;
        }
        case 'response.completed':
          finalResponse = (data.response ?? {}) as Record<string, unknown>;
          break;
        case 'response.incomplete':
          finalResponse = (data.response ?? {}) as Record<string, unknown>;
          incomplete = true;
          break;
        case 'response.failed': {
          const resp = (data.response ?? {}) as { error?: unknown };
          throw errorFromEvent(this.id, resp.error ?? data.error, ctx.secrets);
        }
        case 'error':
          throw errorFromEvent(this.id, data.error ?? data, ctx.secrets);
        default:
          break; // created, in_progress, content_part.*, output_text.done, …
      }
    }

    if (req.signal.aborted) throw abortedError(this.id);

    // `response.completed` (hoặc `response.incomplete`) là tín hiệu kết thúc của giao thức. Luồng đứt giữa chừng (mất mạng,
    // proxy ngắt) mà vẫn có vài item đã xong thì KHÔNG được coi là câu trả lời hoàn chỉnh. Riêng máy chủ "generic" tự xưng
    // tương thích Responses nhưng hay bỏ sự kiện này nên được khoan dung.
    if (!finalResponse && this.flavor !== 'generic') {
      throw new ProviderError('Luồng phản hồi bị ngắt giữa chừng (không nhận được response.completed).', {
        kind: 'network',
        providerId: this.id,
        retryable: true,
      });
    }

    // Nguồn sự thật cuối cùng là `response.output`; nếu server không gửi completed thì dùng các item đã gom.
    let outputItems: Item[] | undefined = Array.isArray(finalResponse?.output) ? (finalResponse!.output as Item[]) : undefined;
    if (!outputItems) {
      const done = [...items.entries()].filter(([, s]) => s.done).sort(([a], [b]) => a - b).map(([, s]) => s.done!);
      if (done.length === 0 && !finalResponse) {
        throw new ProviderError('Luồng phản hồi bị ngắt giữa chừng (không nhận được response.completed).', {
          kind: 'network',
          providerId: this.id,
          retryable: true,
        });
      }
      outputItems = done;
    }

    // Phát nốt tool_end cho lệnh gọi mà server chỉ báo trong response.completed.
    for (const it of outputItems) {
      if (it.type !== 'function_call') continue;
      const callId = String(it.call_id ?? it.id ?? '');
      const known = [...items.values()].find((s) => s.callId === callId);
      if (!known) {
        yield { type: 'tool_start', id: callId, name: String(it.name ?? '') };
        if (typeof it.arguments === 'string' && it.arguments) {
          yield { type: 'tool_args_delta', id: callId, name: String(it.name ?? ''), delta: it.arguments };
        }
        yield { type: 'tool_end', id: callId, name: String(it.name ?? '') };
      } else if (!known.ended) {
        known.ended = true;
        yield { type: 'tool_end', id: callId, name: known.name ?? '' };
      }
    }

    const content = itemsToBlocks(outputItems, this.id);
    const hasToolCalls = content.some((b) => b.type === 'tool_use');

    let stopReason: StopReason = hasToolCalls ? 'tool_use' : 'end_turn';
    const details = (finalResponse?.incomplete_details ?? undefined) as { reason?: string } | undefined;
    if (incomplete || finalResponse?.status === 'incomplete') {
      stopReason = details?.reason === 'content_filter' ? 'content_filter' : 'max_tokens';
    }

    const usage = mapUsage(finalResponse?.usage);
    yield { type: 'usage', usage };
    const message: ChatMessage = { role: 'assistant', content, provider: this.id, model: req.model, ts: Date.now() };
    yield { type: 'done', message, stopReason, usage };
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
        { method: 'GET', headers },
        { signal: ctrl.signal, timeoutMs: 8000 },
      ),
    );
    const raw: RawModel[] = (json.data ?? [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({
        id: String(m.id),
        createdAt: typeof m.created === 'number' ? m.created * 1000 : undefined,
      }));
    return this.flavor === 'xai' ? selectXaiModels(raw) : this.flavor === 'openai' ? selectOpenAIModels(raw) : selectGenericModels(raw);
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const { ctx, headers } = await this.http();
    try {
      await requestJson(
        ctx,
        joinUrl(this.baseUrl(), 'models'),
        { method: 'GET', headers },
        { signal, timeoutMs: 15_000 },
      );
    } catch (err) {
      throw toProviderError(err, this.id, signal, ctx.secrets);
    }
  }
}
