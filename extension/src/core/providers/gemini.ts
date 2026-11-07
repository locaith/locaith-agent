/**
 * Adapter Gemini — API cổ điển `models/{model}:streamGenerateContent?alt=sse`.
 *
 * QUYẾT ĐỊNH (10/2026): Google gọi `generateContent` là "legacy nhưng được hỗ trợ đầy đủ" (không có hạn chót
 * ngừng hỗ trợ), còn Interactions API (`/v1beta/interactions`, GA 06/2026) tuy được khuyến nghị cho dự án mới
 * nhưng payload gọi hàm KHÔNG trạng thái (store:false) chưa được tài liệu hoá đủ rõ để hiện thực an toàn.
 * Vì vậy dùng generateContent. Điểm mở rộng: thêm một transport mới (ví dụ `GeminiInteractionsTransport`)
 * rồi chọn trong `GeminiProvider.stream()` theo `cfg.options.api === 'interactions'` — phần chuyển đổi lịch sử
 * và bộ lọc schema ở đây dùng lại được.
 *
 * Điểm cần nhớ:
 *  - Khoá API đặt ở header `x-goog-api-key`, KHÔNG BAO GIỜ trên URL (khỏi lọt vào log truy cập).
 *  - Gemini 3+ bắt buộc phát lại `thoughtSignature` trên lệnh gọi hàm của lượt hiện tại (thiếu → 400).
 *    Ta giữ nguyên các `part` mang chữ ký trong `block.raw` và phát lại nguyên văn. Lệnh gọi hàm do hãng khác
 *    sinh ra (không có chữ ký) được đính chữ ký "bỏ qua kiểm tra" theo hướng dẫn của Google.
 *  - Lệnh gọi hàm đến nguyên cụm (không stream từng mảnh) → một `tool_args_delta` duy nhất.
 *  - Schema hàm chỉ chấp nhận tập con OpenAPI → `sanitizeSchemaForGemini`.
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
  type ProviderRuntimeConfig,
  type StopReason,
  type StreamRequest,
  type Usage,
} from '../types';
import { wellFormedDeep } from '../textSafe';
import { cloneJson, completeViaStream, isObject } from './common';
import { isBlank, makeToolUse, normalizeHistory } from './history';
import {
  abortedError,
  joinUrl,
  openSse,
  optNumber,
  parseSupportedValues,
  pickNearest,
  rememberRemoval,
  rememberedRemovals,
  requestJson,
  resolveRetryPolicy,
  retryAsync,
  classifyHttpError,
  synthToolId,
  toProviderError,
  withDegradation,
  withRetries,
  boundFetch,
  type HttpContext,
} from './http';
import { selectGeminiModels, type GeminiApiModel } from './modelFilters';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** Chữ ký "bỏ qua kiểm tra" Google cho phép dùng với lệnh gọi hàm không do Gemini sinh ra. */
export const SKIP_SIGNATURE = 'skip_thought_signature_validator';
const SYNTH_ID_PREFIX = 'gemini_call_';
const DEFAULT_MAX_OUTPUT_CAP = 65_536;

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const STRING_FORMATS = new Set(['enum', 'date-time']);
const NUMBER_FORMATS = new Set(['float', 'double']);
const INTEGER_FORMATS = new Set(['int32', 'int64']);

/**
 * Rút JSON Schema về tập con OpenAPI mà Gemini chấp nhận. Giữ type (VIẾT HOA theo proto enum), description,
 * enum (chuỗi), properties, required, items, nullable, anyOf, minItems/maxItems và format hợp lệ;
 * bỏ additionalProperties, $schema, $ref, default, examples, pattern, min/max… (engine tự kiểm tra đối số).
 */
export function sanitizeSchemaForGemini(schema: unknown): Record<string, unknown> | undefined {
  if (!isObject(schema)) return undefined;
  const out: Record<string, unknown> = {};

  let type: unknown = schema.type;
  let nullable = schema.nullable === true;
  if (Array.isArray(type)) {
    if (type.includes('null')) nullable = true;
    type = type.find((t) => t !== 'null');
  }
  if (typeof type !== 'string') {
    if (isObject(schema.properties)) type = 'object';
    else if (schema.items !== undefined) type = 'array';
    else if (Array.isArray(schema.enum) || schema.const !== undefined) type = 'string';
  }
  const lowerType = typeof type === 'string' ? type.toLowerCase() : undefined;
  if (lowerType && lowerType !== 'null') out.type = lowerType.toUpperCase();
  if (nullable) out.nullable = true;

  if (typeof schema.title === 'string') out.title = schema.title;
  if (typeof schema.description === 'string') out.description = schema.description;

  if (typeof schema.format === 'string') {
    const f = schema.format;
    const ok =
      (lowerType === 'string' && STRING_FORMATS.has(f)) ||
      (lowerType === 'number' && NUMBER_FORMATS.has(f)) ||
      (lowerType === 'integer' && INTEGER_FORMATS.has(f));
    if (ok) out.format = f;
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : schema.const !== undefined ? [schema.const] : undefined;
  if (enumValues && out.type === 'STRING') out.enum = enumValues.map((v) => String(v));

  if (isObject(schema.properties)) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      const s = sanitizeSchemaForGemini(v);
      if (s) props[k] = s;
    }
    if (Object.keys(props).length > 0) {
      out.properties = props;
      if (!out.type) out.type = 'OBJECT';
      if (Array.isArray(schema.required)) {
        const req = schema.required.filter((r): r is string => typeof r === 'string' && r in props);
        if (req.length > 0) out.required = req;
      }
    }
  }

  if (schema.items !== undefined) {
    const items = sanitizeSchemaForGemini(Array.isArray(schema.items) ? schema.items[0] : schema.items);
    if (items) out.items = items;
    if (!out.type) out.type = 'ARRAY';
    if (typeof schema.minItems === 'number') out.minItems = schema.minItems;
    if (typeof schema.maxItems === 'number') out.maxItems = schema.maxItems;
  }

  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (variants) {
    const any = variants.map(sanitizeSchemaForGemini).filter((x): x is Record<string, unknown> => !!x);
    if (any.length > 0) out.anyOf = any;
  }
  return out;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export function toFunctionDeclarations(tools: StreamRequest['tools']): GeminiFunctionDeclaration[] {
  return tools.map((t) => {
    const params = sanitizeSchemaForGemini(t.inputSchema);
    const decl: GeminiFunctionDeclaration = { name: t.name, description: t.description };
    // Gemini từ chối OBJECT không có thuộc tính → bỏ hẳn `parameters` cho tool không tham số.
    if (params && params.properties) decl.parameters = params;
    return decl;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Thinking
// ─────────────────────────────────────────────────────────────────────────────

export type GeminiFamily = 'g25' | 'g3' | 'none';

export function geminiFamily(model: string): GeminiFamily {
  const id = model.replace(/^models\//, '').toLowerCase();
  if (!id.startsWith('gemini-')) return 'none'; // gemma… không có thinkingConfig
  if (/^gemini-2\.5/.test(id)) return 'g25';
  if (/^gemini-(?:1|2)(?:\.|-)/.test(id)) return 'none';
  return 'g3'; // gemini-3*, gemini-4*, bí danh `-latest`, id tương lai
}

interface GeminiDegrade {
  noThinkingConfig: boolean;
  levelOverride?: string;
  maxOutputCap: number;
}

function loadDegrade(providerId: string, model: string): GeminiDegrade {
  const mem = rememberedRemovals(providerId, model);
  const lvl = [...mem].find((t) => t.startsWith('level='));
  const cap = [...mem].find((t) => t.startsWith('maxcap='));
  return {
    noThinkingConfig: mem.has('thinkingConfig'),
    levelOverride: lvl ? lvl.slice('level='.length) : undefined,
    maxOutputCap: cap ? Number(cap.slice('maxcap='.length)) || DEFAULT_MAX_OUTPUT_CAP : DEFAULT_MAX_OUTPUT_CAP,
  };
}

const LEVEL_ORDER = ['minimal', 'low', 'medium', 'high'] as const;

export function buildThinkingConfig(
  model: string,
  level: StreamRequest['thinking']['level'],
  summaries: boolean,
  st: Pick<GeminiDegrade, 'noThinkingConfig' | 'levelOverride'>,
): Record<string, unknown> | undefined {
  if (st.noThinkingConfig) return undefined;
  const family = geminiFamily(model);
  if (family === 'none') return undefined;
  const wantThoughts = summaries && level !== 'off';
  if (family === 'g25') {
    const isPro = /pro/i.test(model);
    const budget = { off: isPro ? 128 : 0, low: 1024, medium: 8192, high: 24576, max: -1 }[level];
    const cfg: Record<string, unknown> = { thinkingBudget: budget };
    if (wantThoughts && budget !== 0) cfg.includeThoughts = true;
    return cfg;
  }
  const lvl = st.levelOverride ?? { off: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high' }[level];
  const cfg: Record<string, unknown> = { thinkingLevel: lvl };
  if (wantThoughts && lvl !== 'minimal') cfg.includeThoughts = true;
  return cfg;
}

function degradeGemini(err: ProviderError, st: GeminiDegrade, providerId: string, model: string, level: StreamRequest['thinking']['level']): boolean {
  const msg = `${err.message} ${err.details ?? ''}`;
  const note = (t: string) => rememberRemoval(providerId, model, t);

  if (/maxoutputtokens|max_output_tokens/i.test(msg)) {
    const nums = [...msg.matchAll(/\b(\d{4,7})\b/g)].map((m) => Number(m[1]));
    const limit = nums.length > 0 ? Math.min(...nums.filter((n) => n < st.maxOutputCap)) : NaN;
    const next = Number.isFinite(limit) && limit >= 1024 ? limit : Math.max(8192, Math.floor(st.maxOutputCap / 2));
    if (next < st.maxOutputCap) {
      st.maxOutputCap = next;
      note(`maxcap=${next}`);
      return true;
    }
    return false;
  }

  // Chỉ khi lỗi nói về cấu hình suy luận (thinkingConfig/Level/Budget, includeThoughts). KHÔNG khớp "thought_signature"
  // ("Corrupted thought signature"): đó là lỗi chữ ký của lịch sử, bỏ thinkingConfig không sửa được mà còn xoá nó vĩnh viễn.
  if (/thinking(?:config|level|budget)|thinking_(?:config|level|budget)|includethoughts|include_thoughts|\bthinking\b/i.test(msg) && !/thought[ _]?signature/i.test(msg) && !st.noThinkingConfig) {
    if (geminiFamily(model) === 'g3') {
      const current = st.levelOverride ?? { off: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high' }[level];
      const supported = parseSupportedValues(msg).map((s) => s.toLowerCase());
      let next: string | undefined = supported.length > 0 ? pickNearest(current, supported, LEVEL_ORDER) : undefined;
      // Không có danh sách giá trị hợp lệ: 'minimal' không được hỗ trợ ở nhiều model → thử 'low' trước khi bỏ hẳn.
      if (!next && current === 'minimal') next = 'low';
      if (next && next !== current) {
        st.levelOverride = next;
        note(`level=${next}`);
        return true;
      }
    }
    st.noThinkingConfig = true;
    note('thinkingConfig');
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chuyển đổi lịch sử
// ─────────────────────────────────────────────────────────────────────────────

type Part = Record<string, unknown>;
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

export function toGeminiContents(history: readonly ChatMessage[], opts: { providerId: string; model: string }): Content[] {
  const family = geminiFamily(opts.model);
  const ownRaw = (b: { provider?: string; raw?: unknown }): Part | undefined =>
    b.provider === opts.providerId && isObject(b.raw) ? (b.raw as Part) : undefined;

  const msgs = normalizeHistory(history);
  // id lệnh gọi do chính Gemini cấp (cần echo trong functionResponse); id tự sinh thì không gửi.
  const apiIds = new Set<string>();
  for (const m of msgs) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue;
      const raw = ownRaw(b);
      const fc = raw && isObject(raw.functionCall) ? raw.functionCall : undefined;
      if (fc && fc.id === b.id) apiIds.add(b.id);
    }
  }

  const out: Content[] = [];
  for (const m of msgs) {
    if (m.role === 'user') {
      const parts: Part[] = [];
      const extra: Part[] = [];
      let lastFr: Part | undefined;
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const text = isBlank(b.content) ? (b.isError ? '(lỗi, không có thông điệp)' : '(không có đầu ra)') : b.content;
          const fr: Part = {
            name: b.name,
            response: b.isError ? { error: text } : { result: text },
          };
          if (apiIds.has(b.toolUseId)) fr.id = b.toolUseId;
          parts.push({ functionResponse: fr });
          lastFr = fr;
          for (const img of b.images ?? []) extra.push({ inlineData: { mimeType: img.mediaType, data: img.data } });
        }
      }
      parts.push(...extra);
      const volatile: string[] = [];
      for (const b of m.content) {
        if (b.type === 'text' && !isBlank(b.text)) {
          if (b.volatile) volatile.push(b.text);
          else parts.push({ text: b.text });
        } else if (b.type === 'image') parts.push({ inlineData: { mimeType: b.mediaType, data: b.data } });
      }
      // Dòng ngân sách vòng lặp (`volatile`): gộp vào cuối kết quả của lời gọi hàm cuối thay vì thêm một phần chữ trong tin user — Gemini 3 coi tin có
      // chữ là ranh giới lượt (chữ ký suy luận của các vòng trước không còn được đòi/dùng).
      if (volatile.length > 0) {
        const note = volatile.join('\n\n');
        const resp = lastFr && isObject(lastFr.response) ? (lastFr.response as Record<string, unknown>) : undefined;
        const key = resp && typeof resp.result === 'string' ? 'result' : resp && typeof resp.error === 'string' ? 'error' : undefined;
        if (resp && key) resp[key] = `${String(resp[key])}\n\n${note}`;
        else parts.push({ text: note });
      }
      if (parts.length > 0) out.push({ role: 'user', parts });
    } else {
      const parts: Part[] = [];
      let firstCallInMessage = true;
      for (const b of m.content) {
        if (b.type === 'thinking') {
          const raw = ownRaw(b);
          // Tóm tắt suy luận không cần phát lại; chỉ giữ khi nó mang chữ ký.
          if (raw && raw.thoughtSignature) parts.push(cloneJson(raw));
        } else if (b.type === 'text') {
          const raw = ownRaw(b);
          if (raw) parts.push(cloneJson(raw));
          else if (!isBlank(b.text)) parts.push({ text: b.text });
        } else if (b.type === 'tool_use') {
          const raw = ownRaw(b);
          if (raw && isObject(raw.functionCall)) {
            parts.push(cloneJson(raw));
          } else {
            const part: Part = { functionCall: { name: b.name, args: b.input } };
            // Lệnh gọi do hãng khác sinh ra: Gemini 3+ đòi chữ ký ở lệnh gọi đầu tiên của mỗi lượt.
            if (family === 'g3' && firstCallInMessage) part.thoughtSignature = SKIP_SIGNATURE;
            parts.push(part);
          }
          firstCallInMessage = false;
        }
      }
      if (parts.length > 0) out.push({ role: 'model', parts });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lỗi / usage / kết thúc
// ─────────────────────────────────────────────────────────────────────────────

function errorFromBody(providerId: string, err: unknown, secrets: ReadonlyArray<string | undefined>): ProviderError {
  const e = (isObject(err) ? err : {}) as { code?: unknown; message?: unknown; status?: unknown };
  const status = typeof e.code === 'number' && e.code >= 400 && e.code < 600 ? e.code : 500;
  return classifyHttpError(providerId, status, JSON.stringify({ error: e }), undefined, secrets);
}

function mapUsage(u: unknown): Usage {
  const m = (isObject(u) ? u : {}) as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  const thoughts = m.thoughtsTokenCount ?? 0;
  const usage: Usage = {
    inputTokens: (m.promptTokenCount ?? 0) + (m.toolUsePromptTokenCount ?? 0),
    // candidatesTokenCount KHÔNG gồm token suy luận nhưng được tính tiền như đầu ra.
    outputTokens: (m.candidatesTokenCount ?? 0) + thoughts,
  };
  if (m.cachedContentTokenCount) usage.cacheReadTokens = m.cachedContentTokenCount;
  if (thoughts) usage.reasoningTokens = thoughts;
  return usage;
}

const CONTENT_FILTER_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);
const MALFORMED_REASONS = new Set(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS']);

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
  readonly id: string;
  readonly label: string;
  readonly kind = 'gemini' as const;
  readonly flavor = 'gemini' as const;
  readonly capabilities: ProviderCapabilities = {
    reasoning: 'summary',
    parallelTools: true,
    vision: true,
    toolArgStreaming: 'whole',
  };

  constructor(private readonly cfg: ProviderRuntimeConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
  }

  private baseUrl(): string {
    return (this.cfg.baseUrl || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private async http(): Promise<{ ctx: HttpContext; headers: Record<string, string> }> {
    const key = await this.cfg.getApiKey();
    if (!key) {
      throw new ProviderError('Chưa có khóa API của Google Gemini. Hãy đặt khóa trong phần Cài đặt.', {
        kind: 'auth',
        providerId: this.id,
        retryable: false,
      });
    }
    return {
      ctx: { providerId: this.id, fetchImpl: boundFetch(this.cfg.fetchImpl), secrets: [key], log: this.cfg.log },
      // Khoá ở header, không bao giờ ở ?key= (khỏi lọt vào log truy cập).
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json', ...(this.cfg.extraHeaders ?? {}) },
    };
  }

  private modelPath(model: string): string {
    return model.includes('/') ? model : `models/${model}`;
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    const { ctx, headers } = await this.http();
    const st = loadDegrade(this.id, req.model);
    const policy = resolveRetryPolicy(this.cfg.options);
    yield* withDegradation(
      () =>
        withRetries({ providerId: this.id, signal: req.signal, policy, log: this.cfg.log }, () =>
          this.runOnce(ctx, headers, req, st),
        ),
      (err) => degradeGemini(err, st, this.id, req.model, req.thinking.level),
    );
  }

  private buildBody(req: StreamRequest, st: GeminiDegrade): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents: toGeminiContents(req.messages, { providerId: this.id, model: req.model }),
    };
    if (!isBlank(req.system)) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.tools.length > 0) {
      body.tools = [{ functionDeclarations: toFunctionDeclarations(req.tools) }];
      body.toolConfig = { functionCallingConfig: { mode: req.toolChoice === 'none' ? 'NONE' : 'AUTO' } };
    }
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: Math.min(req.maxOutputTokens, st.maxOutputCap),
    };
    const thinking = buildThinkingConfig(req.model, req.thinking.level, req.thinking.summaries, st);
    if (thinking) generationConfig.thinkingConfig = thinking;
    body.generationConfig = generationConfig;
    return body;
  }

  private async *runOnce(
    ctx: HttpContext,
    headers: Record<string, string>,
    req: StreamRequest,
    st: GeminiDegrade,
  ): AsyncGenerator<ProviderEvent, void, void> {
    const body = this.buildBody(req, st);
    const url = `${joinUrl(this.baseUrl(), `${this.modelPath(req.model)}:streamGenerateContent`)}?alt=sse`;
    this.cfg.log?.('debug', `[${this.id}] → POST ${this.modelPath(req.model)}:streamGenerateContent thinking=${JSON.stringify((body.generationConfig as Record<string, unknown>).thinkingConfig ?? null)} tools=${req.tools.length}`);

    const blocks: ContentBlock[] = [];
    let acc: { kind: 'text' | 'thinking'; text: string; sig?: string } | null = null;
    let finish: string | undefined;
    let usageMeta: unknown;
    let sawData = false;
    let blockedBy: string | undefined;

    const flush = () => {
      if (!acc) return;
      if (acc.kind === 'thinking') {
        blocks.push({
          type: 'thinking',
          text: acc.text,
          provider: this.id,
          ...(acc.sig ? { raw: { thought: true, text: acc.text, thoughtSignature: acc.sig } } : {}),
        });
      } else {
        blocks.push({
          type: 'text',
          text: acc.text,
          provider: this.id,
          ...(acc.sig ? { raw: { text: acc.text, thoughtSignature: acc.sig } } : {}),
        });
      }
      acc = null;
    };

    const sse = openSse(
      ctx,
      url,
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
        continue;
      }
      if (data.error) throw errorFromBody(this.id, data.error, ctx.secrets);
      sawData = true;
      if (data.usageMetadata) usageMeta = data.usageMetadata;
      const feedback = data.promptFeedback as { blockReason?: string } | undefined;
      if (feedback?.blockReason) blockedBy = feedback.blockReason;

      const cand = (Array.isArray(data.candidates) ? data.candidates[0] : undefined) as
        | { content?: { parts?: Part[] }; finishReason?: string }
        | undefined;
      if (!cand) continue;

      for (const part of cand.content?.parts ?? []) {
        const sig = typeof part.thoughtSignature === 'string' && part.thoughtSignature ? part.thoughtSignature : undefined;
        if (isObject(part.functionCall)) {
          flush();
          const fc = part.functionCall as { name?: string; args?: unknown; id?: string };
          const name = String(fc.name ?? '');
          const id = typeof fc.id === 'string' && fc.id ? fc.id : synthToolId(SYNTH_ID_PREFIX);
          const args = isObject(fc.args) ? fc.args : {};
          yield { type: 'tool_start', id, name };
          yield { type: 'tool_args_delta', id, name, delta: JSON.stringify(args) };
          yield { type: 'tool_end', id, name };
          blocks.push(makeToolUse(this.id, id, name, args, cloneJson(part)));
        } else if (part.thought === true && typeof part.text === 'string') {
          if (acc && acc.kind !== 'thinking') flush();
          acc ??= { kind: 'thinking', text: '' };
          acc.text += part.text;
          if (sig) acc.sig = sig;
          if (part.text) yield { type: 'thinking_delta', text: part.text };
        } else if (typeof part.text === 'string') {
          if (part.text === '') {
            // Phần rỗng chỉ để mang chữ ký (thường ở cuối luồng) → gắn vào khối văn bản gần nhất.
            if (sig) {
              if (acc) acc.sig = sig;
              else {
                const last = blocks[blocks.length - 1];
                if (last && last.type === 'text') last.raw = { text: last.text, thoughtSignature: sig };
                else blocks.push({ type: 'text', text: '', provider: this.id, raw: { text: '', thoughtSignature: sig } });
              }
            }
            continue;
          }
          if (acc && acc.kind !== 'text') flush();
          acc ??= { kind: 'text', text: '' };
          acc.text += part.text;
          if (sig) acc.sig = sig;
          yield { type: 'text_delta', text: part.text };
        }
      }
      if (cand.finishReason) finish = cand.finishReason;
    }
    flush();

    if (req.signal.aborted) throw abortedError(this.id);
    if (!sawData) {
      throw new ProviderError('Máy chủ Gemini kết thúc luồng mà không gửi dữ liệu nào.', { kind: 'server', providerId: this.id, retryable: true });
    }
    if (blockedBy && blocks.length === 0) {
      throw new ProviderError(`Yêu cầu bị bộ lọc an toàn của Gemini chặn (${blockedBy}).`, {
        kind: 'content_filter',
        providerId: this.id,
        retryable: false,
      });
    }
    // Phản hồi hoàn chỉnh luôn có `finishReason` ở khối cuối. Luồng đứt giữa chừng thì không có → không được coi là xong.
    if (!finish && !blockedBy) {
      throw new ProviderError('Luồng phản hồi của Gemini bị ngắt giữa chừng (không nhận được finishReason).', {
        kind: 'network',
        providerId: this.id,
        retryable: true,
      });
    }
    if (finish && MALFORMED_REASONS.has(finish)) {
      throw new ProviderError(
        `Gemini trả về lệnh gọi công cụ sai định dạng (${finish}). Hãy thử lại hoặc đổi model.`,
        { kind: 'server', providerId: this.id, retryable: true },
      );
    }

    const hasCalls = blocks.some((b) => b.type === 'tool_use');
    let stopReason: StopReason;
    if (finish === 'MAX_TOKENS') stopReason = 'max_tokens';
    else if (finish && CONTENT_FILTER_REASONS.has(finish)) stopReason = 'content_filter';
    else stopReason = hasCalls ? 'tool_use' : 'end_turn';

    const usage = mapUsage(usageMeta);
    yield { type: 'usage', usage };
    const message: ChatMessage = { role: 'assistant', content: blocks, provider: this.id, model: req.model, ts: Date.now() };
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
    // Hạn mức thời gian chung ~5 giây cho toàn bộ các trang (theo skill gemini-model-list).
    const deadline = setTimeout(() => ctrl.abort(new DOMException('deadline', 'TimeoutError')), 5000);
    try {
      const all: GeminiApiModel[] = [];
      let pageToken = '';
      for (let page = 0; page < 5; page++) {
        let url = `${this.baseUrl()}/models?pageSize=200`;
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
        const body = await retryAsync({ providerId: this.id, signal: ctrl.signal, policy, log: this.cfg.log }, () =>
          requestJson<{ models?: GeminiApiModel[]; nextPageToken?: string }>(
            ctx,
            url,
            { method: 'GET', headers: { 'x-goog-api-key': headers['x-goog-api-key'] } },
            { signal: ctrl.signal, timeoutMs: 5000 },
          ),
        );
        all.push(...(body.models ?? []));
        if (!body.nextPageToken) break;
        pageToken = body.nextPageToken;
      }
      const byId = new Map(all.map((m) => [m.name.replace(/^models\//, ''), m]));
      return selectGeminiModels(all, 'text').map((o) => {
        const raw = byId.get(o.value);
        const info: ModelInfo = { id: o.value, label: o.label, tier: o.tier, vision: true };
        if (raw?.inputTokenLimit) info.contextWindow = raw.inputTokenLimit;
        if (raw?.outputTokenLimit) info.maxOutputTokens = raw.outputTokenLimit;
        if (raw?.thinking !== undefined) info.reasoning = raw.thinking;
        return info;
      });
    } catch (err) {
      throw toProviderError(err, this.id, signal, ctx.secrets);
    } finally {
      clearTimeout(deadline);
    }
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const { ctx, headers } = await this.http();
    try {
      await requestJson(
        ctx,
        `${this.baseUrl()}/models?pageSize=1`,
        { method: 'GET', headers: { 'x-goog-api-key': headers['x-goog-api-key'] } },
        { signal, timeoutMs: 15_000 },
      );
    } catch (err) {
      throw toProviderError(err, this.id, signal, ctx.secrets);
    }
  }
}
