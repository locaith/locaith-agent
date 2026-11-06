/**
 * Lớp HTTP dùng chung: chuẩn hoá lỗi, thử lại có backoff, hủy/timeout, che khoá API,
 * và cơ chế "hạ cấp thích nghi" (tự bỏ tham số mà server không hỗ trợ rồi gọi lại).
 *
 * Nguyên tắc thử lại: CHỈ thử lại khi chưa có nội dung nào được trả cho người dùng
 * (không bao giờ phát lại giữa chừng một câu trả lời đang stream).
 */

import { ProviderError, type LogLevel, type ProviderEvent } from '../types';
import { classifyGatewayError } from './locaithGateway';
import { parseSse, DEFAULT_IDLE_TIMEOUT_MS, type SseMessage } from './sse';

// ─────────────────────────────────────────────────────────────────────────────
// Che khoá
// ─────────────────────────────────────────────────────────────────────────────

const GENERIC_SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bxai-[A-Za-z0-9_-]{16,}/g,
  // Token thiết bị tài khoản Locaith (`lat_` + 43 ký tự): là khoá của nhà cung cấp `locaith`, không được lọt vào log/thông báo lỗi.
  /\blat_[A-Za-z0-9_-]{20,}/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /((?:x-api-key|x-goog-api-key|api[-_]?key|authorization)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** Thay mọi khoá (khoá cụ thể + mẫu phổ biến) bằng `***` trước khi ghi log hoặc đưa vào thông báo lỗi. */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('***');
  }
  for (const re of GENERIC_SECRET_PATTERNS) {
    out = out.replace(re, (_m, p1: string | undefined) => (p1 && p1.length > 8 ? `${p1}***` : p1 ? `${p1} ***` : '***'));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phân tích thông điệp lỗi
// ─────────────────────────────────────────────────────────────────────────────

/** Tách danh sách giá trị hợp lệ từ câu lỗi kiểu "Supported values are: 'low', 'medium' and 'high'". */
export function parseSupportedValues(message: string): string[] {
  const patterns = [
    // `\b` đầu mẫu để "valid" không khớp nhầm bên trong "Invalid value: 'none'".
    /\b(?:supported|allowed|valid|available|accepted|possible)\s+(?:values?|options?|levels?|efforts?)\b[^:]*:\s*([^\n]+)/i,
    /(?:must|should|expected to)\s+be\s+one\s+of\b[^:]*:?\s*([^\n]+)/i,
    /expected\s+one\s+of\b[^:]*:?\s*([^\n]+)/i,
    /one\s+of\s*[:(]\s*([^\n)]+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(message);
    if (!m) continue;
    const tail = m[1];
    const quoted = [...tail.matchAll(/['"`“”]([^'"`“”]+)['"`“”]/g)].map((x) => x[1].trim()).filter(Boolean);
    const values =
      quoted.length > 0
        ? quoted
        : tail
            .replace(/[.\])]+\s*$/, '')
            .split(/\s*(?:,|\band\b|\bor\b|\|)\s*/i)
            .map((s) => s.replace(/^[\s[(]+|[\s\])]+$/g, ''))
            .filter(Boolean);
    const unique = [...new Set(values)];
    if (unique.length > 0) return unique;
  }
  return [];
}

/** Chọn giá trị gần nhất với `wanted` trong `supported` theo thứ tự thang `order` (ưu tiên giá trị thấp hơn khi bằng nhau). */
export function pickNearest(wanted: string, supported: readonly string[], order: readonly string[]): string | undefined {
  const sup = supported.map((s) => s.toLowerCase());
  if (sup.length === 0) return undefined;
  if (sup.includes(wanted)) return wanted;
  const rank = (v: string) => {
    const i = order.indexOf(v);
    return i === -1 ? Number.NaN : i;
  };
  const target = rank(wanted);
  const ranked = sup.filter((s) => !Number.isNaN(rank(s)));
  if (Number.isNaN(target) || ranked.length === 0) return sup[0];
  let best = ranked[0];
  let bestDist = Math.abs(rank(best) - target);
  for (const s of ranked) {
    const d = Math.abs(rank(s) - target);
    if (d < bestDist || (d === bestDist && rank(s) < rank(best))) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Tìm tham số bị server phàn nàn trong câu lỗi. Trả về ứng viên xuất hiện sớm nhất trong thông điệp
 * (so khớp không phân biệt hoa thường, chấp nhận `a.b` ↔ `a_b`).
 */
export function findOffendingParam(message: string, candidates: readonly string[]): string | undefined {
  const lower = message.toLowerCase();
  let best: { name: string; index: number } | undefined;
  for (const name of candidates) {
    const variants = new Set([name.toLowerCase(), name.toLowerCase().replace(/\./g, '_'), name.toLowerCase().replace(/_/g, '.')]);
    for (const v of variants) {
      const idx = lower.indexOf(v);
      if (idx !== -1 && (!best || idx < best.index)) best = { name, index: idx };
    }
  }
  return best?.name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phân loại lỗi HTTP
// ─────────────────────────────────────────────────────────────────────────────

const CONTEXT_PHRASES =
  /context[_ ](?:length|window)|maximum context|too many tokens|prompt is too long|input (?:is )?too long|exceeds? (?:the )?(?:maximum|max|model'?s?)|request too large|token limit|reduce the length|maximum prompt length|input token count|exceeds the maximum number of tokens/i;
const AUTH_PHRASES = /api key not valid|api_key_invalid|invalid api key|incorrect api key|invalid x-api-key|invalid authentication|unauthorized|authentication[_ ]error|permission[_ ]denied/i;
const QUOTA_PHRASES = /insufficient[_ ]quota|exceeded your current quota|billing|insufficient balance|out of credits?|payment required/i;

export interface ParsedErrorBody {
  message: string;
  code?: string;
  type?: string;
}

export function extractErrorBody(bodyText: string): ParsedErrorBody {
  const trimmed = bodyText.trim();
  if (!trimmed) return { message: '' };
  try {
    let json: unknown = JSON.parse(trimmed);
    if (Array.isArray(json)) json = json[0];
    const root = (json ?? {}) as Record<string, unknown>;
    const err = (root.error ?? root) as unknown;
    if (typeof err === 'string') return { message: err };
    const e = err as Record<string, unknown>;
    const inner = typeof e.error === 'object' && e.error ? (e.error as Record<string, unknown>) : undefined;
    const msg = String(e.message ?? inner?.message ?? root.message ?? root.detail ?? '');
    const code = e.code ?? e.status ?? inner?.code;
    const type = e.type ?? inner?.type;
    return {
      message: msg || trimmed.slice(0, 300),
      code: code === undefined || code === null ? undefined : String(code),
      type: type === undefined || type === null ? undefined : String(type),
    };
  } catch {
    return { message: trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) };
  }
}

type HeadersLike = Headers | Record<string, string | string[] | undefined> | undefined | null;

function headerValue(headers: HeadersLike, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const rec = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Đọc `retry-after-ms` / `retry-after` (giây hoặc ngày HTTP) → mili-giây. */
export function parseRetryAfter(headers: HeadersLike): number | undefined {
  const ms = headerValue(headers, 'retry-after-ms');
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const ra = headerValue(headers, 'retry-after');
  if (ra !== undefined) {
    const s = Number(ra);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

export function classifyHttpError(
  providerId: string,
  status: number | undefined,
  bodyText: string,
  headers?: HeadersLike,
  secrets: ReadonlyArray<string | undefined> = [],
): ProviderError {
  const body = extractErrorBody(bodyText);
  const provMsg = redactSecrets(body.message, secrets).slice(0, 400);
  const details = redactSecrets(bodyText, secrets).slice(0, 1200);
  const retryAfterMs = parseRetryAfter(headers);
  // Cổng Locaith: xếp hàng (429), cần đồng ý thông báo dữ liệu (403), phiên đăng nhập hết hiệu lực (401) — nhận ra bằng `error.code`, không phải lỗi chung.
  const gateway = classifyGatewayError(providerId, status, bodyText, retryAfterMs);
  if (gateway) return gateway;
  const hay = `${body.message} ${body.code ?? ''} ${body.type ?? ''}`;
  const withProv = (head: string) => (provMsg ? `${head} (${provMsg})` : head);
  const mk = (
    kind: ProviderError['kind'],
    message: string,
    retryable?: boolean,
  ): ProviderError => new ProviderError(message, { kind, providerId, status, retryable, retryAfterMs, details });

  if (status === 401) return mk('auth', 'Khóa API không hợp lệ hoặc đã bị thu hồi.', false);
  if (status === 402 || QUOTA_PHRASES.test(hay)) {
    if (status === 429 || status === 402 || status === 403) {
      return mk('rate_limit', withProv('Tài khoản đã hết hạn mức hoặc chưa kích hoạt thanh toán'), false);
    }
  }
  if (status === 403) {
    return mk('auth', withProv('Khóa API không đủ quyền truy cập (hoặc tài khoản/vùng chưa được cấp quyền dùng model này)'), false);
  }
  if (status === 404) {
    return mk('not_found', withProv('Không tìm thấy model hoặc đường dẫn API. Hãy kiểm tra tên model và URL gốc'), false);
  }
  if (status === 413) {
    return mk('context_length', 'Yêu cầu quá lớn: ngữ cảnh vượt giới hạn của model. Hãy nén cuộc trò chuyện hoặc bắt đầu cuộc mới.', false);
  }
  if (status === 429) {
    return mk('rate_limit', withProv('Đã chạm giới hạn tốc độ hoặc hạn mức của nhà cung cấp'), true);
  }
  if (status === 400 || status === 422) {
    if (AUTH_PHRASES.test(hay) && !CONTEXT_PHRASES.test(hay)) {
      return mk('auth', 'Khóa API không hợp lệ hoặc đã bị thu hồi.', false);
    }
    if (CONTEXT_PHRASES.test(hay)) {
      return mk('context_length', withProv('Ngữ cảnh vượt quá giới hạn của model. Hãy nén cuộc trò chuyện hoặc bắt đầu cuộc mới'), false);
    }
    return mk('bad_request', withProv(`Nhà cung cấp từ chối yêu cầu (HTTP ${status})`), false);
  }
  if (status === 408) return mk('timeout', 'Máy chủ nhà cung cấp hết thời gian chờ (HTTP 408).', true);
  if (status === 503 || status === 529) {
    return mk('overloaded', withProv(`Máy chủ nhà cung cấp đang quá tải (HTTP ${status})`), true);
  }
  if (status !== undefined && status >= 500) {
    return mk('server', withProv(`Máy chủ nhà cung cấp gặp lỗi (HTTP ${status})`), true);
  }
  return mk('unknown', withProv(`Lỗi không xác định${status ? ` (HTTP ${status})` : ''}`), false);
}

const NETWORK_CODE_TEXT: Record<string, string> = {
  ENOTFOUND: 'Không phân giải được tên miền — kiểm tra URL và kết nối mạng',
  EAI_AGAIN: 'Không phân giải được tên miền (DNS tạm thời lỗi)',
  ECONNREFUSED: 'Máy chủ từ chối kết nối — dịch vụ đã được bật chưa?',
  ECONNRESET: 'Kết nối bị ngắt đột ngột',
  EPIPE: 'Kết nối bị ngắt đột ngột',
  ETIMEDOUT: 'Kết nối bị quá thời gian',
  UND_ERR_CONNECT_TIMEOUT: 'Kết nối tới máy chủ bị quá thời gian',
  UND_ERR_HEADERS_TIMEOUT: 'Máy chủ phản hồi quá chậm',
  UND_ERR_SOCKET: 'Kết nối bị ngắt đột ngột',
  CERT_HAS_EXPIRED: 'Chứng chỉ SSL của máy chủ đã hết hạn',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Không xác minh được chứng chỉ SSL (proxy/công ty chặn?)',
  SELF_SIGNED_CERT_IN_CHAIN: 'Chứng chỉ SSL tự ký (proxy/công ty chặn?)',
};

function errorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function abortedError(providerId: string): ProviderError {
  return new ProviderError('Đã hủy theo yêu cầu.', { kind: 'aborted', providerId, retryable: false });
}

/** Đưa mọi lỗi bắt được (fetch/AbortError/…) về ProviderError. */
export function toProviderError(
  err: unknown,
  providerId: string,
  signal?: AbortSignal,
  secrets: ReadonlyArray<string | undefined> = [],
): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted && !(signal.reason instanceof Error && signal.reason.name === 'TimeoutError')) return abortedError(providerId);
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError') {
    return new ProviderError('Hết thời gian chờ phản hồi từ máy chủ.', { kind: 'timeout', providerId, retryable: true, cause: err });
  }
  if (name === 'AbortError') return abortedError(providerId);
  const code = errorCode(err);
  const text = code && NETWORK_CODE_TEXT[code] ? NETWORK_CODE_TEXT[code] : 'Không kết nối được tới máy chủ';
  const raw = err instanceof Error ? redactSecrets(err.message, secrets) : String(err);
  const timeoutLike = code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT';
  return new ProviderError(`${text}${code ? ` (${code})` : ''}.`, {
    kind: timeoutLike ? 'timeout' : 'network',
    providerId,
    retryable: true,
    details: raw.slice(0, 500),
    cause: err,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Thử lại có backoff
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 60_000 };

/** Đọc một tuỳ chọn số dương từ `ProviderRuntimeConfig.options` (ví dụ `idleTimeoutMs`, `headerTimeoutMs`). */
export function optNumber(options: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = options?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Giá trị mặc định cho thời gian chờ header phản hồi (model suy luận có thể chưa gửi chunk đầu trong nhiều phút). */
export const DEFAULT_HEADER_TIMEOUT_MS = 300_000;

/** Đọc `options.retry` của ProviderRuntimeConfig (test dùng giá trị nhỏ để khỏi chờ thật). */
export function resolveRetryPolicy(options?: Record<string, unknown>): RetryPolicy {
  const r = (options?.retry ?? {}) as Partial<RetryPolicy>;
  return {
    maxRetries: typeof r.maxRetries === 'number' ? r.maxRetries : DEFAULT_RETRY_POLICY.maxRetries,
    baseDelayMs: typeof r.baseDelayMs === 'number' ? r.baseDelayMs : DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: typeof r.maxDelayMs === 'number' ? r.maxDelayMs : DEFAULT_RETRY_POLICY.maxDelayMs,
  };
}

/** Ngủ có thể hủy; ném DOMException('AbortError') khi bị hủy. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Thời gian chờ trước lần thử kế tiếp; `null` = không đáng thử lại
 * (server yêu cầu chờ quá `maxDelayMs`, ví dụ hết hạn mức theo ngày).
 */
export function computeRetryDelay(
  err: ProviderError,
  retriesSoFar: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number | null {
  if (err.retryAfterMs !== undefined) {
    if (err.retryAfterMs > policy.maxDelayMs) return null;
    return Math.min(policy.maxDelayMs, Math.round(err.retryAfterMs * (1 + 0.1 * random())));
  }
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retriesSoFar);
  return Math.min(policy.maxDelayMs, Math.round(backoff * (0.75 + 0.5 * random())));
}

export interface RetryConfig {
  providerId: string;
  signal: AbortSignal;
  policy: RetryPolicy;
  random?: () => number;
  log?: (level: LogLevel, message: string) => void;
  /**
   * Hàng chờ của cổng Locaith: người dùng dừng (hoặc huỷ) khi đang đứng trong hàng → gọi (không chờ kết quả) để báo cổng nhả chỗ.
   * `ticket` là mã vé cuối cùng cổng cấp.
   */
  onQueueLeave?: (ticket: string | undefined) => void;
  /** Đồng hồ (kiểm thử). */
  now?: () => number;
}

/** Trạng thái chuyền giữa các lần chạy lại của `withRetries`. */
export interface RetryState {
  /** Mã vé hàng chờ cuối cùng cổng cấp: gửi lại ở lần hỏi kế tiếp (chỉ là bản dội — cổng giữ chỗ theo tài khoản). */
  ticket?: string;
}

/** Sự kiện nào được coi là "đã có nội dung đến tay người dùng" — sau đó không được thử lại nữa. */
export function isContentEvent(ev: ProviderEvent): boolean {
  return ev.type === 'thinking_delta' || ev.type === 'text_delta' || ev.type === 'tool_start' || ev.type === 'tool_args_delta' || ev.type === 'tool_end' || ev.type === 'done';
}

/**
 * Chạy `run()`; nếu nó ném lỗi có thể thử lại và CHƯA trả nội dung nào, phát sự kiện `retry`,
 * chờ backoff (hủy được) rồi chạy lại.
 *
 * Xếp hàng (cổng Locaith báo `queued`) là trường hợp riêng: KHÔNG tính vào `maxRetries`, không giới hạn số lần — phát sự kiện `queue`
 * (vị trí + mốc thử lại để giao diện đếm ngược), chờ đúng thời gian cổng bảo (huỷ được), rồi gửi lại cùng yêu cầu kèm mã vé trong `state.ticket`.
 */
export async function* withRetries(
  cfg: RetryConfig,
  run: (state: RetryState) => AsyncGenerator<ProviderEvent, void, void>,
): AsyncGenerator<ProviderEvent, void, void> {
  let retries = 0;
  let queueAttempts = 0;
  const state: RetryState = {};
  const now = cfg.now ?? Date.now;
  for (;;) {
    let yielded = false;
    try {
      for await (const ev of run(state)) {
        if (isContentEvent(ev)) yielded = true;
        yield ev;
      }
      return;
    } catch (err) {
      const perr = toProviderError(err, cfg.providerId, cfg.signal);
      if (cfg.signal.aborted) {
        if (queueAttempts > 0) cfg.onQueueLeave?.(state.ticket);
        throw abortedError(cfg.providerId);
      }
      if (perr.kind === 'queued' && perr.queue && !yielded) {
        queueAttempts++;
        const q = perr.queue;
        if (q.ticket) state.ticket = q.ticket;
        cfg.log?.('info', `[${cfg.providerId}] đang xếp hàng: vị trí ${q.position}, hỏi lại sau ${q.retryAfterMs}ms (lần ${queueAttempts})`);
        yield {
          type: 'queue',
          position: q.position,
          ahead: q.ahead,
          attempt: queueAttempts,
          waitMs: q.retryAfterMs,
          retryAt: now() + q.retryAfterMs,
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
          ...(q.active !== undefined ? { active: q.active } : {}),
          ...(q.waiting !== undefined ? { waiting: q.waiting } : {}),
        };
        try {
          await sleep(q.retryAfterMs, cfg.signal);
        } catch {
          cfg.onQueueLeave?.(state.ticket);
          throw abortedError(cfg.providerId);
        }
        continue;
      }
      // Lỗi có `retryLimit` riêng (cổng Locaith bảo trì: một lần) chỉ được HẠ mức chung, không bao giờ nâng lên.
      const limit = perr.retryLimit === undefined ? cfg.policy.maxRetries : Math.min(cfg.policy.maxRetries, perr.retryLimit);
      if (yielded || !perr.retryable || retries >= limit) throw perr;
      // Hết thời gian chờ thường là server treo: thử lại một lần là đủ (không đợi thêm nhiều lần chục phút).
      if (perr.kind === 'timeout' && retries >= 1) throw perr;
      const delay = computeRetryDelay(perr, retries, cfg.policy, cfg.random);
      if (delay === null) {
        const waitMin = Math.ceil((perr.retryAfterMs ?? 0) / 60000);
        throw new ProviderError(`${perr.message} Máy chủ yêu cầu chờ khoảng ${waitMin} phút trước khi thử lại.`, {
          kind: perr.kind,
          providerId: perr.providerId,
          status: perr.status,
          retryable: false,
          retryAfterMs: perr.retryAfterMs,
          details: perr.details,
        });
      }
      retries++;
      cfg.log?.('warn', `[${cfg.providerId}] thử lại lần ${retries}/${cfg.policy.maxRetries} sau ${delay}ms: ${perr.message}`);
      yield { type: 'retry', attempt: retries, maxAttempts: cfg.policy.maxRetries, delayMs: delay, reason: perr.message };
      try {
        await sleep(delay, cfg.signal);
      } catch {
        throw abortedError(cfg.providerId);
      }
    }
  }
}

/** Bản không phải generator của withRetries, dùng cho các lời gọi một lần (complete, danh sách model). */
export async function retryAsync<T>(
  cfg: RetryConfig,
  fn: () => Promise<T>,
  onRetry?: (attempt: number, delayMs: number, reason: string) => void,
): Promise<T> {
  let retries = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const perr = toProviderError(err, cfg.providerId, cfg.signal);
      if (cfg.signal.aborted) throw abortedError(cfg.providerId);
      if (!perr.retryable || retries >= cfg.policy.maxRetries) throw perr;
      const delay = computeRetryDelay(perr, retries, cfg.policy, cfg.random);
      if (delay === null) throw perr;
      retries++;
      onRetry?.(retries, delay, perr.message);
      cfg.log?.('warn', `[${cfg.providerId}] thử lại lần ${retries}/${cfg.policy.maxRetries} sau ${delay}ms: ${perr.message}`);
      try {
        await sleep(delay, cfg.signal);
      } catch {
        throw abortedError(cfg.providerId);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hạ cấp thích nghi: bỏ tham số không được hỗ trợ rồi gọi lại
// ─────────────────────────────────────────────────────────────────────────────

const removedParams = new Map<string, Set<string>>();

function memKey(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

/** Các tham số đã biết là server của provider+model này không chấp nhận (nhớ trong bộ nhớ tiến trình). */
export function rememberedRemovals(providerId: string, model: string): Set<string> {
  return new Set(removedParams.get(memKey(providerId, model)) ?? []);
}

export function rememberRemoval(providerId: string, model: string, param: string): void {
  const key = memKey(providerId, model);
  const set = removedParams.get(key) ?? new Set<string>();
  set.add(param);
  removedParams.set(key, set);
}

export function resetParamMemory(): void {
  removedParams.clear();
}

/**
 * Giới hạn token đầu ra mà máy chủ báo trong thông điệp 400, nếu có:
 *   Anthropic  "max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for …"
 *   OpenAI     "max_tokens is too large: 32000. This model supports at most 16384 completion tokens, …"
 *   DeepSeek   "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]"
 * Trần mặc định (32000) vượt giới hạn của model nhỏ/cổng trung gian sẽ bị từ chối mãi mãi — đổi tên tham số không cứu được.
 */
export function parseOutputLimit(message: string): number | undefined {
  const patterns: RegExp[] = [
    /max_tokens:\s*\d+\s*>\s*(\d+)/i,
    /supports at most (\d+)\s*(?:completion|output)?\s*tokens/i,
    /valid range of (?:max_tokens|max_completion_tokens)\s+is\s*\[\s*\d+\s*,\s*(\d+)\s*\]/i,
    /(?:max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens)[^.\n]{0,100}?(?:at most|no more than|less than or equal to|not exceed|<=|maximum (?:value )?(?:of|is|allowed is)?)\s*(\d{3,7})/i,
    /(?:maximum|max(?:imum)? allowed)[^.\n]{0,40}?(\d{3,7})\s*(?:output |completion )?tokens/i,
  ];
  for (const re of patterns) {
    const m = re.exec(message);
    const n = m ? Number(m[1]) : NaN;
    if (Number.isFinite(n) && n >= 256) return n;
  }
  return undefined;
}

/** Trần đầu ra nhỏ nhất đã học được cho provider+model này (token nhớ dạng `maxcap=N`). */
export function rememberedOutputCap(mem: ReadonlySet<string>): number | undefined {
  let cap: number | undefined;
  for (const t of mem) {
    if (!t.startsWith('maxcap=')) continue;
    const n = Number(t.slice('maxcap='.length));
    if (Number.isFinite(n) && n > 0 && (cap === undefined || n < cap)) cap = n;
  }
  return cap;
}

/**
 * Chạy `run`; nếu nó ném ProviderError mà `degrade()` xử lý được (đã chỉnh trạng thái yêu cầu) và
 * chưa có nội dung nào được trả ra, chạy lại. Tối đa `maxRounds` lần chỉnh.
 */
export async function* withDegradation(
  run: (round: number) => AsyncGenerator<ProviderEvent, void, void>,
  degrade: (err: ProviderError, round: number) => boolean,
  maxRounds = 4,
  kinds: ReadonlyArray<ProviderError['kind']> = ['bad_request'],
): AsyncGenerator<ProviderEvent, void, void> {
  for (let round = 0; ; round++) {
    let yielded = false;
    try {
      for await (const ev of run(round)) {
        if (isContentEvent(ev)) yielded = true;
        yield ev;
      }
      return;
    } catch (err) {
      if (!(err instanceof ProviderError) || yielded || round >= maxRounds) throw err;
      if (!kinds.includes(err.kind)) throw err;
      if (!degrade(err, round)) throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gọi HTTP: luồng SSE và JSON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `fetch` mặc định phải được gọi như một HÀM TRẦN. Trình duyệt ném `TypeError: Illegal invocation` khi `fetch` bị gọi với `this` là một đối tượng
 * khác `window` — đúng điều xảy ra với `ctx.fetchImpl(...)` nếu `fetchImpl` là `fetch` gốc gán vào thuộc tính (Node thì bỏ qua `this`, nên lỗi này
 * chỉ lộ ra ở bản trình duyệt: mọi nhà cung cấp báo "Không kết nối được tới máy chủ"). Luôn dùng hàm này thay cho `impl ?? fetch`.
 */
export function boundFetch(impl?: typeof fetch): typeof fetch {
  return impl ?? ((input, init) => fetch(input, init));
}

export interface HttpContext {
  providerId: string;
  fetchImpl: typeof fetch;
  /** Các khoá cần che khỏi thông báo lỗi. */
  secrets: ReadonlyArray<string | undefined>;
  log?: (level: LogLevel, message: string) => void;
}

export interface LinkedController {
  controller: AbortController;
  dispose: () => void;
}

/** AbortController tổng hợp: hủy khi tín hiệu của người dùng hủy. */
export function linkSignal(signal?: AbortSignal): LinkedController {
  const controller = new AbortController();
  if (!signal) return { controller, dispose: () => undefined };
  if (signal.aborted) {
    controller.abort(signal.reason);
    return { controller, dispose: () => undefined };
  }
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  return { controller, dispose: () => signal.removeEventListener('abort', onAbort) };
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 64 * 1024);
  } catch {
    return '';
  }
}

export interface FetchOk {
  res: Response;
  controller: AbortController;
  dispose: () => void;
}

/** fetch + hạn chờ header + chuẩn hoá lỗi HTTP. Trả về Response đã `ok`. */
export async function fetchOk(
  ctx: HttpContext,
  url: string,
  init: RequestInit,
  opts: { signal?: AbortSignal; headerTimeoutMs?: number } = {},
): Promise<FetchOk> {
  const { controller, dispose } = linkSignal(opts.signal);
  const headerTimeout = opts.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Header timeout', 'TimeoutError'));
  }, headerTimeout);
  let res: Response;
  try {
    const doFetch = ctx.fetchImpl; // gọi như hàm trần (xem boundFetch)
    res = await doFetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    dispose();
    if (timedOut) {
      throw new ProviderError(`Máy chủ không phản hồi trong ${Math.round(headerTimeout / 1000)} giây.`, {
        kind: 'timeout',
        providerId: ctx.providerId,
        retryable: true,
        cause: err,
      });
    }
    throw toProviderError(err, ctx.providerId, opts.signal, ctx.secrets);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await readErrorBody(res);
    dispose();
    ctx.log?.('warn', `[${ctx.providerId}] HTTP ${res.status}: ${redactSecrets(text, ctx.secrets).slice(0, 300)}`);
    throw classifyHttpError(ctx.providerId, res.status, text, res.headers, ctx.secrets);
  }
  return { res, controller, dispose };
}

/** Thông điệp giả `openSse` phát đầu tiên khi `markOpen`: "phản hồi 200 đã về" (trước mọi dữ liệu thật). */
export const SSE_OPEN_EVENT = 'x-open';

/**
 * POST/GET trả luồng SSE đã phân tích. Tự đóng kết nối khi generator kết thúc/bị dừng.
 * `markOpen`: phát thêm một thông điệp `{ event: SSE_OPEN_EVENT, data: '' }` ngay khi nhận được phản hồi thành công — để biết một yêu cầu đã được nhận
 * (cổng Locaith xếp hàng) mà không phải đợi token đầu tiên, vốn có thể mất cả phút khi ngữ cảnh rất dài.
 */
export async function* openSse(
  ctx: HttpContext,
  url: string,
  init: RequestInit,
  opts: { signal: AbortSignal; headerTimeoutMs?: number; idleTimeoutMs?: number; onSentinel?: () => void; markOpen?: boolean },
): AsyncGenerator<SseMessage, void, void> {
  const { res, controller, dispose } = await fetchOk(ctx, url, init, {
    signal: opts.signal,
    headerTimeoutMs: opts.headerTimeoutMs,
  });
  try {
    if (opts.markOpen) yield { event: SSE_OPEN_EVENT, data: '' };
    if (!res.body) {
      throw new ProviderError('Máy chủ trả về phản hồi rỗng (không có luồng dữ liệu).', {
        kind: 'server',
        providerId: ctx.providerId,
        retryable: true,
      });
    }
    yield* parseSse(res.body, {
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      providerId: ctx.providerId,
      onSentinel: opts.onSentinel,
    });
  } finally {
    controller.abort();
    dispose();
  }
}

/** Gọi một lần, trả JSON. */
export async function requestJson<T = unknown>(
  ctx: HttpContext,
  url: string,
  init: RequestInit,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const { controller, dispose } = linkSignal(opts.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('timeout', 'TimeoutError'));
  }, timeoutMs);
  try {
    let res: Response;
    try {
      const doFetch = ctx.fetchImpl; // gọi như hàm trần (xem boundFetch)
      res = await doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (timedOut) {
        throw new ProviderError(`Máy chủ không phản hồi trong ${Math.round(timeoutMs / 1000)} giây.`, {
          kind: 'timeout',
          providerId: ctx.providerId,
          retryable: true,
          cause: err,
        });
      }
      throw toProviderError(err, ctx.providerId, opts.signal, ctx.secrets);
    }
    // Thân phản hồi THÀNH CÔNG không được cắt: danh sách model của OpenRouter/Gemini có thể >100 KB (chỉ thân lỗi mới cắt 64 KB).
    const text = res.ok ? await res.text().catch(() => '') : await readErrorBody(res);
    if (!res.ok) throw classifyHttpError(ctx.providerId, res.status, text, res.headers, ctx.secrets);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError('Máy chủ trả về dữ liệu không phải JSON hợp lệ.', {
        kind: 'server',
        providerId: ctx.providerId,
        retryable: false,
        details: redactSecrets(text.slice(0, 300), ctx.secrets),
      });
    }
  } catch (err) {
    if (timedOut && !(err instanceof ProviderError)) {
      throw new ProviderError('Hết thời gian chờ phản hồi từ máy chủ.', { kind: 'timeout', providerId: ctx.providerId, retryable: true });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    dispose();
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Tạo id duy nhất cho lệnh gọi tool mà API không cấp id. */
let synthCounter = 0;
export function synthToolId(prefix: string): string {
  synthCounter = (synthCounter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${synthCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
