/**
 * Cổng mô hình Locaith (họ mô hình AI Local: Locaith-v5-flash, Locaith-v5-SI) — phía máy khách.
 *
 *  • hằng số dùng chung (id nhà cung cấp, địa chỉ cổng, cửa sổ ngữ cảnh 1M, phiên bản thông báo dữ liệu);
 *  • đọc hai loại phản hồi đặc biệt của cổng: 429 `locaith_queue` (xếp hàng khi quá 100 người dùng cùng lúc) và 403 `locaith_consent_required`;
 *  • máy khách nhỏ cho bản ghi ĐỒNG Ý THÔNG BÁO DỮ LIỆU theo tài khoản (GET/POST /consent).
 *
 * Không import `vscode`. Hợp đồng đầy đủ (tiêu đề, mã lỗi, hàng chờ): docs/LOCAITH-MODELS.md.
 * Token đăng nhập (`lat_…`) là khoá của nhà cung cấp này; nó chỉ đi tới đúng địa chỉ cổng người dùng đã cấu hình và không bao giờ vào nhật ký.
 */

import { ProviderError, type QueueInfo } from '../types';

export const LOCAITH_PROVIDER_ID = 'locaith';
export const LOCAITH_GATEWAY_URL = 'https://studio-api.locaith.com/api/llm/v1';
export const LOCAITH_MODEL_FLASH = 'locaith-v5-flash';
export const LOCAITH_MODEL_SI = 'locaith-v5-si';
/** Cửa sổ ngữ cảnh và trần đầu ra của họ Locaith-v5 (khớp cổng: 1M token, 393.216 token đầu ra). */
export const LOCAITH_CONTEXT_WINDOW = 1_000_000;
export const LOCAITH_MAX_OUTPUT_TOKENS = 393_216;
/**
 * Phiên bản thông báo dữ liệu. Đổi NỘI DUNG thông báo (webview/src/i18n.ts, khoá `locaith.notice.*`) thì tăng số này để mọi tài khoản được hỏi lại;
 * cổng cũng giữ số tương ứng (`LOCAITH_LLM_NOTICE_VERSION`) và coi bản ghi thấp hơn là chưa đồng ý.
 */
export const LOCAITH_NOTICE_VERSION = 1;

/** Chờ tối thiểu / tối đa giữa hai lần hỏi lại khi đang xếp hàng (mili-giây) — chặn máy chủ báo số vô lý. */
export const QUEUE_MIN_WAIT_MS = 1_000;
export const QUEUE_MAX_WAIT_MS = 60_000;
export const QUEUE_DEFAULT_WAIT_MS = 5_000;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const int = (v: unknown, min: number, max: number): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.min(max, Math.max(min, Math.round(n)));
};

/** Số giây/ms chờ hợp lệ: ưu tiên `retry_after_sec` trong thân, rồi tiêu đề `Retry-After`, cuối cùng là mặc định. */
export function queueWaitMs(retryAfterSec: unknown, headerMs: number | undefined): number {
  const sec = num(retryAfterSec);
  const raw = sec !== undefined ? sec * 1000 : headerMs ?? QUEUE_DEFAULT_WAIT_MS;
  return Math.min(QUEUE_MAX_WAIT_MS, Math.max(QUEUE_MIN_WAIT_MS, Math.round(raw)));
}

export const QUEUE_DEFAULT_MESSAGE = 'Đang có nhiều lượt sử dụng, vui lòng chờ xử lý.';
export const AUTH_MESSAGE = 'Phiên đăng nhập Locaith không còn hiệu lực. Hãy đăng nhập lại tài khoản Locaith.';
export const CONSENT_MESSAGE = 'Cần đồng ý thông báo dữ liệu của Locaith trước khi dùng mô hình Locaith.';
export const QUOTA_DEFAULT_MESSAGE = 'Bạn đã dùng hết hạn mức mô hình Locaith của hôm nay. Hạn mức được làm mới vào ngày mai.';
export const RATE_LIMITED_DEFAULT_MESSAGE = 'Bạn đang gửi quá nhiều yêu cầu tới mô hình Locaith cùng lúc. Hãy chờ một lát rồi thử lại.';
export const UNAVAILABLE_DEFAULT_MESSAGE = 'Dịch vụ mô hình Locaith đang bảo trì. Hãy thử lại sau ít phút.';
export const MODEL_NOT_FOUND_DEFAULT_MESSAGE = 'Mô hình Locaith này không tồn tại hoặc đã ngừng cung cấp. Hãy chọn một model khác trong danh sách.';

/** `locaith_rate_limited`: chỉ tự thử lại khi cổng bảo chờ không quá ngần này; lâu hơn thì hiện thẳng lời cổng. */
export const RATE_LIMIT_AUTO_RETRY_MAX_MS = 60_000;
/** `locaith_unavailable` (bảo trì): thử lại ĐÚNG MỘT lần sau vài giây. */
export const UNAVAILABLE_RETRY_MS = 3_000;
export const UNAVAILABLE_RETRY_MAX_MS = 10_000;
const GATEWAY_MESSAGE_MAX = 600;

/** Lời của cổng hiện nguyên văn cho người dùng: bỏ ký tự điều khiển, cắt độ dài. */
function gatewayMessage(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, GATEWAY_MESSAGE_MAX);
  return s || undefined;
}

/**
 * Nhận ra phản hồi lỗi của CỔNG Locaith qua `error.code` (không dựa vào tên nhà cung cấp, nên cũng đúng với máy chủ tương thích khác dùng cùng mã).
 * Trả `undefined` nếu không phải mã của cổng — phân loại HTTP chung sẽ xử lý.
 */
export function classifyGatewayError(providerId: string, status: number | undefined, bodyText: string, headerRetryMs: number | undefined): ProviderError | undefined {
  let root: Record<string, unknown>;
  try {
    const j = JSON.parse(bodyText.trim());
    if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
    root = j as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const err = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : undefined;
  const code = typeof err?.code === 'string' ? err.code : undefined;
  if (!code || !code.startsWith('locaith_')) return undefined;
  const message = gatewayMessage(err?.message);

  if (code === 'locaith_queue') {
    const q = root.queue && typeof root.queue === 'object' ? (root.queue as Record<string, unknown>) : {};
    const position = int(q.position, 1, 1_000_000) ?? 1;
    const ahead = int(q.ahead, 0, 1_000_000) ?? Math.max(0, position - 1);
    const info: QueueInfo = {
      position,
      ahead,
      retryAfterMs: queueWaitMs(q.retry_after_sec, headerRetryMs),
      ...(typeof q.ticket === 'string' && q.ticket.length <= 120 ? { ticket: q.ticket } : {}),
      ...(int(q.limit, 1, 1_000_000) !== undefined ? { limit: int(q.limit, 1, 1_000_000) } : {}),
      ...(int(q.active, 0, 1_000_000) !== undefined ? { active: int(q.active, 0, 1_000_000) } : {}),
      ...(int(q.waiting, 0, 1_000_000) !== undefined ? { waiting: int(q.waiting, 0, 1_000_000) } : {}),
    };
    return new ProviderError(message ?? QUEUE_DEFAULT_MESSAGE, { kind: 'queued', providerId, status: 429, retryable: true, retryAfterMs: info.retryAfterMs, queue: info, gatewayCode: code });
  }
  if (code === 'locaith_consent_required') {
    return new ProviderError(message ?? CONSENT_MESSAGE, { kind: 'consent_required', providerId, status: 403, retryable: false, gatewayCode: code });
  }
  if (code === 'locaith_unauthorized') {
    // Token đăng nhập bị thu hồi/hết hạn: không bảo người dùng "nhập khoá API" — engine nhờ host kiểm tra lại tài khoản (accountAuth).
    return new ProviderError(AUTH_MESSAGE, { kind: 'auth', providerId, status: 401, retryable: false, accountAuth: true, gatewayCode: code });
  }
  // Hết hạn mức chi tiêu trong NGÀY: Retry-After có thể là nhiều GIỜ (tới nửa đêm) — không bao giờ thử lại, hiện nguyên lời cổng rồi dừng lượt.
  if (code === 'locaith_quota') {
    return new ProviderError(message ?? QUOTA_DEFAULT_MESSAGE, { kind: 'rate_limit', providerId, status: status ?? 429, retryable: false, ...(headerRetryMs !== undefined ? { retryAfterMs: headerRetryMs } : {}), verbatim: true, gatewayCode: code });
  }
  // Giới hạn theo người dùng (quá nhiều yêu cầu song song / quá nhanh): chỉ tự thử lại khi cổng bảo chờ ≤ 60 giây; lâu hơn thì hiện lời cổng.
  if (code === 'locaith_rate_limited') {
    const auto = headerRetryMs === undefined || headerRetryMs <= RATE_LIMIT_AUTO_RETRY_MAX_MS;
    return new ProviderError(message ?? RATE_LIMITED_DEFAULT_MESSAGE, { kind: 'rate_limit', providerId, status: status ?? 429, retryable: auto, ...(headerRetryMs !== undefined ? { retryAfterMs: headerRetryMs } : {}), verbatim: true, gatewayCode: code });
  }
  // Bảo trì / chưa cấu hình: thử lại đúng một lần sau vài giây, hết lần thì hiện lời cổng.
  if (code === 'locaith_unavailable') {
    const wait = Math.min(UNAVAILABLE_RETRY_MAX_MS, Math.max(1_000, headerRetryMs ?? UNAVAILABLE_RETRY_MS));
    return new ProviderError(message ?? UNAVAILABLE_DEFAULT_MESSAGE, { kind: 'overloaded', providerId, status: status ?? 503, retryable: true, retryAfterMs: wait, retryLimit: 1, verbatim: true, gatewayCode: code });
  }
  if (code === 'locaith_model_not_found') {
    return new ProviderError(message ?? MODEL_NOT_FOUND_DEFAULT_MESSAGE, { kind: 'not_found', providerId, status: status ?? 404, retryable: false, verbatim: true, gatewayCode: code });
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bản ghi đồng ý thông báo dữ liệu (theo tài khoản, lưu ở máy chủ)
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsentState {
  /** Tài khoản đã đồng ý phiên bản thông báo hiện hành chưa (theo máy chủ). */
  accepted: boolean;
  /** Phiên bản đã ghi nhận (0 nếu chưa có). */
  version: number;
  /** Phiên bản thông báo hiện hành của máy chủ. */
  current: number;
}

export type ConsentError = 'unauthorized' | 'network' | 'server';
export type ConsentGetResult = { ok: true; state: ConsentState } | { ok: false; error: ConsentError };
export type ConsentPostResult = { ok: true } | { ok: false; error: ConsentError | 'rejected'; message?: string };

/** Bỏ dấu `/` cuối rồi nối đường dẫn con. */
function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Phản hồi của GET /account (cổng Locaith). Không chứa token, email chỉ dạng đã che. */
export interface AccountPayload {
  ok: boolean;
  kind?: string;
  /** null khi chưa có hồ sơ (JWT/internal hoặc cổng chưa cấu hình Supabase). */
  account?: { name?: string; email_masked?: string; plan?: string; avatar?: string; device_label?: string; device_expires_at?: string } | null;
  plan?: string;
  limits?: { unlimited?: boolean; note?: string };
}
export type AccountResult = { ok: true; account: AccountPayload } | { ok: false; error: 'unauthorized' | 'unsupported' | 'network' | 'server' };

export class LocaithGatewayClient {
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: { baseUrl: () => string; fetch?: typeof fetch; timeoutMs?: number; /** (lane:gateway-client) nhãn chẩn đoán X-Locaith-Client/Device (gatewayDiagnosticHeaders). */ headers?: () => Record<string, string> },
  ) {
    this.f = opts.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async call(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<{ status: number; json: unknown } | { error: 'network' }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.f(join(this.opts.baseUrl(), path), {
        method,
        headers: { ...(this.opts.headers?.() ?? {}), authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch {
      return { error: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tài khoản này đã đồng ý chưa? (có thể đã đồng ý ở máy khác). */
  /**
   * Hồ sơ tài khoản + gói (free/pro/plus) + hạn mức. Endpoint mới của cổng; bản cổng cũ trả 404 → { ok: false, error: 'unsupported' }
   * để người gọi tự lùi về cách cũ thay vì báo lỗi cho người dùng.
   */
  async getAccount(token: string): Promise<AccountResult> {
    const r = await this.call('GET', 'account', token);
    if ('error' in r) return { ok: false, error: 'network' };
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'unauthorized' };
    if (r.status === 404 || r.status === 405) return { ok: false, error: 'unsupported' }; // cổng chưa có endpoint này
    if (r.status !== 200 || !r.json) return { ok: false, error: 'server' };
    return { ok: true, account: r.json as AccountPayload };
  }

  async getConsent(token: string): Promise<ConsentGetResult> {
    const r = await this.call('GET', 'consent', token);
    if ('error' in r) return { ok: false, error: 'network' };
    if (r.status === 401) return { ok: false, error: 'unauthorized' };
    const j = r.json as Record<string, unknown> | null;
    if (r.status !== 200 || !j || typeof j !== 'object' || typeof j.accepted !== 'boolean') return { ok: false, error: 'server' };
    const current = int(j.current, 0, 1_000_000) ?? LOCAITH_NOTICE_VERSION;
    return { ok: true, state: { accepted: j.accepted, version: int(j.version, 0, 1_000_000) ?? 0, current } };
  }

  /** Ghi nhận: tài khoản đồng ý thông báo phiên bản `version` (người dùng vừa bấm «Đồng ý và dùng»). */
  async postConsent(token: string, version: number, client: string): Promise<ConsentPostResult> {
    const r = await this.call('POST', 'consent', token, { version, client });
    if ('error' in r) return { ok: false, error: 'network' };
    if (r.status === 401) return { ok: false, error: 'unauthorized' };
    const j = r.json as Record<string, unknown> | null;
    if (r.status === 200 && j && j.ok === true) return { ok: true };
    const err = j && typeof j.error === 'object' && j.error ? (j.error as Record<string, unknown>) : undefined;
    const message = typeof err?.message === 'string' ? err.message.slice(0, 200) : undefined;
    if (r.status >= 400 && r.status < 500) return { ok: false, error: 'rejected', ...(message ? { message } : {}) };
    return { ok: false, error: 'server', ...(message ? { message } : {}) };
  }
}
