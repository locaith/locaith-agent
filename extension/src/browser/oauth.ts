/**
 * Đăng nhập bằng tài khoản (OAuth 2.0 — Authorization Code + PKCE) cho bản trình duyệt, thay cho việc dán khoá API.
 *
 * Hai luồng:
 *  - `openrouter`: đăng nhập OpenRouter một chạm; kết quả là một KHOÁ API của chính người dùng (do OpenRouter cấp, quản lý/thu hồi được ở trang OpenRouter),
 *    lưu như khoá thường. https://openrouter.ai/docs/use-cases/oauth-pkce
 *  - `oauth2`: OAuth 2.0 + PKCE tổng quát cho API tuỳ chỉnh (cổng nội bộ, nhà cung cấp có OAuth công khai…): người dùng nhập địa chỉ xác thực/cấp token và client id
 *    (client công khai, không cần bí mật). Access token dùng làm Bearer; tự làm mới bằng refresh token.
 *
 * KHÔNG hỗ trợ đăng nhập bằng gói thuê bao Claude/ChatGPT/Gemini của người dùng: Anthropic cấm dùng OAuth gói Free/Pro/Max ngoài ứng dụng chính thức của họ;
 * Google cũng không cho phép; OpenAI chỉ có chương trình "plan usage" riêng (yêu cầu callback loopback + đăng ký) — chưa làm.
 *
 * Bảo mật: PKCE S256 + `state` ngẫu nhiên mỗi lần; địa chỉ xác thực/cấp token chỉ nhận https (http chỉ cho localhost); phản hồi lỗi không bao giờ được chép nguyên văn
 * (có thể chứa bí mật); token nằm trong chrome.storage.local của extension (không mã hoá trên đĩa — giống khoá API) và được đăng ký với bộ che bí mật của nhật ký.
 */

import { boundFetch } from '../core/providers/http';
import type { OAuthSpecInput } from '../shared/protocol';
import type { KeyValueStore } from './kv';

export type OAuthSpec = OAuthSpecInput;

interface TokenSet {
  access: string;
  refresh?: string;
  /** Epoch ms; không có = không hết hạn theo thông tin nhà cung cấp trả. */
  expiresAt?: number;
}

interface Stored {
  spec: OAuthSpec;
  /** 'key' = kết quả là khoá API (lưu ở kho khoá); 'token' = access/refresh token (lưu ở đây). */
  method: 'key' | 'token';
  signedInAt?: number;
  tokens?: TokenSet;
}

const STORE_KEY = 'nd.oauth';
export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
/** Làm mới trước khi hết hạn một khoảng để lời gọi đang bay không bị 401. */
const REFRESH_SKEW_MS = 60_000;

/** Lỗi có thông điệp tiếng Việt an toàn để hiện cho người dùng (không chứa bí mật). */
export class OAuthError extends Error {}

// ── PKCE (RFC 7636) ─────────────────────────────────────────────────────────────

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(byteLength = 48, rng: (b: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const buf = new Uint8Array(byteLength);
  return base64url(rng(buf));
}

/** code_challenge = BASE64URL(SHA-256(code_verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return base64url(new Uint8Array(digest));
}

// ── kiểm tra cấu hình ───────────────────────────────────────────────────────────

/** https (hoặc http tới máy cục bộ), không kèm tên đăng nhập. */
export function isSafeOAuthUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export function validateSpec(spec: OAuthSpec): string | null {
  if (spec.flow === 'openrouter') return null;
  if (spec.flow !== 'oauth2') return 'Loại đăng nhập không hợp lệ.';
  if (!isSafeOAuthUrl(spec.authorizeUrl)) return 'Địa chỉ trang đăng nhập (authorize) không hợp lệ: cần https, không kèm tên đăng nhập.';
  if (!isSafeOAuthUrl(spec.tokenUrl)) return 'Địa chỉ cấp token không hợp lệ: cần https, không kèm tên đăng nhập.';
  if (!spec.clientId || /\s/.test(spec.clientId) || spec.clientId.length > 300) return 'Client ID không hợp lệ (đang trống hoặc có khoảng trắng).';
  if ((spec.scopes ?? '').length > 500) return 'Danh sách scope quá dài.';
  return null;
}

export function buildAuthorizeUrl(spec: OAuthSpec, p: { redirectUri: string; challenge: string; state: string }): string {
  if (spec.flow === 'openrouter') {
    const u = new URL(OPENROUTER_AUTH_URL);
    u.searchParams.set('callback_url', p.redirectUri);
    u.searchParams.set('code_challenge', p.challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', p.state);
    return u.toString();
  }
  const u = new URL(spec.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', spec.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (spec.scopes?.trim()) u.searchParams.set('scope', spec.scopes.trim());
  return u.toString();
}

const short = (s: unknown, n = 160) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, n);

/**
 * Phân tích URL nhà cung cấp chuyển hướng về. `requireState`: luồng OAuth 2.0 tổng quát bắt buộc `state` khớp; OpenRouter chấp nhận thiếu `state`
 * (PKCE đã buộc mã vào phiên này: kẻ tấn công không đổi được mã của họ vì thiếu code_verifier) nhưng nếu CÓ thì phải khớp.
 */
export function parseRedirect(finalUrl: string, redirectUri: string, expectedState: string, requireState: boolean): { code: string } | { error: string } {
  let u: URL;
  let base: URL;
  try {
    u = new URL(finalUrl);
    base = new URL(redirectUri);
  } catch {
    return { error: 'Địa chỉ chuyển hướng không hợp lệ.' };
  }
  if (u.origin !== base.origin || u.pathname !== base.pathname) return { error: 'Nhà cung cấp chuyển hướng tới địa chỉ không đúng với địa chỉ đã đăng ký — đã bỏ qua để an toàn.' };
  const params = new URLSearchParams(u.search);
  const err = params.get('error');
  if (err) {
    if (err === 'access_denied') return { error: 'Bạn đã từ chối cấp quyền ở trang đăng nhập.' };
    return { error: `Nhà cung cấp báo lỗi đăng nhập: ${short(err, 60)}${params.get('error_description') ? ` — ${short(params.get('error_description'))}` : ''}` };
  }
  const st = params.get('state');
  if ((st === null && requireState) || (st !== null && st !== expectedState)) return { error: 'Phản hồi không khớp phiên đăng nhập hiện tại (state) — đã bỏ qua để an toàn. Hãy thử đăng nhập lại.' };
  const code = params.get('code');
  if (!code) return { error: 'Trang đăng nhập không trả về mã xác thực.' };
  return { code };
}

// ── quản lý đăng nhập ───────────────────────────────────────────────────────────

export interface OAuthDeps {
  kv: KeyValueStore;
  /** Bảo đảm có quyền `identity` (xin lúc chạy nếu là quyền tuỳ chọn). Trả false nếu bị từ chối. */
  ensureIdentity(): Promise<boolean>;
  /** Mở trang đăng nhập (cửa sổ do trình duyệt quản lý); trả URL cuối cùng sau khi chuyển hướng về `redirectUri()`. */
  launch(url: string): Promise<string>;
  redirectUri(): string;
  /** Lưu / xoá khoá API (luồng openrouter). */
  setKey(providerId: string, key: string): Promise<void>;
  deleteKey(providerId: string): Promise<void>;
  /** Xin quyền gọi tới máy chủ nhận token (extension không có quyền mọi trang). Trả false nếu bị từ chối. */
  ensureOrigin?(url: string): Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: (b: Uint8Array) => Uint8Array;
}

export interface OAuthSummary {
  flow: OAuthSpec['flow'];
  signedIn: boolean;
}

export class OAuthManager {
  private cache: Record<string, Stored> | null = null;
  private readonly refreshing = new Map<string, Promise<string | undefined>>();
  private loginBusy = false;

  constructor(private readonly d: OAuthDeps) {}

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  private async all(): Promise<Record<string, Stored>> {
    if (this.cache) return this.cache;
    const raw = await this.d.kv.get<Record<string, Stored>>(STORE_KEY);
    const out: Record<string, Stored> = {};
    if (raw && typeof raw === 'object') for (const [id, s] of Object.entries(raw)) if (s && typeof s === 'object' && (s.spec?.flow === 'openrouter' || s.spec?.flow === 'oauth2')) out[id] = s;
    this.cache = out;
    return out;
  }

  private async save(): Promise<void> {
    await this.d.kv.set(STORE_KEY, this.cache ?? {});
  }

  /** Gắn cấu hình đăng nhập cho một nhà cung cấp (chưa đăng nhập). */
  async register(providerId: string, spec: OAuthSpec): Promise<void> {
    const bad = validateSpec(spec);
    if (bad) throw new OAuthError(bad);
    const all = await this.all();
    all[providerId] = { spec, method: spec.flow === 'openrouter' ? 'key' : 'token' };
    await this.save();
  }

  /** Quên hoàn toàn (khi xoá nhà cung cấp). */
  async forget(providerId: string): Promise<void> {
    const all = await this.all();
    if (!(providerId in all)) return;
    delete all[providerId];
    await this.save();
  }

  async summary(providerId: string): Promise<OAuthSummary | undefined> {
    const s = (await this.all())[providerId];
    if (!s) return undefined;
    return { flow: s.spec.flow, signedIn: s.method === 'key' ? !!s.signedInAt : !!s.tokens };
  }

  async login(providerId: string): Promise<void> {
    const all = await this.all();
    const entry = all[providerId];
    if (!entry) throw new OAuthError('Nhà cung cấp này chưa có cấu hình đăng nhập OAuth.');
    const bad = validateSpec(entry.spec);
    if (bad) throw new OAuthError(bad);
    if (this.loginBusy) throw new OAuthError('Đang có một phiên đăng nhập khác. Hãy hoàn tất hoặc đóng cửa sổ đăng nhập đó trước.');
    this.loginBusy = true;
    try {
      if (!(await this.d.ensureIdentity())) throw new OAuthError('Chưa được cấp quyền "identity" của trình duyệt — cần quyền này để mở cửa sổ đăng nhập.');
      const tokenUrl = entry.spec.flow === 'oauth2' ? entry.spec.tokenUrl : OPENROUTER_EXCHANGE_URL;
      if (this.d.ensureOrigin && !(await this.d.ensureOrigin(tokenUrl))) throw new OAuthError(`Chưa được cấp quyền truy cập ${new URL(tokenUrl).host} (nơi nhận mã đăng nhập).`);

      const verifier = randomToken(48, this.d.random);
      const state = randomToken(24, this.d.random);
      const redirectUri = this.d.redirectUri();
      const url = buildAuthorizeUrl(entry.spec, { redirectUri, challenge: await pkceChallenge(verifier), state });

      let finalUrl: string;
      try {
        finalUrl = await this.d.launch(url);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new OAuthError(/did not approve|cancel|closed|user/i.test(m) ? 'Cửa sổ đăng nhập đã bị đóng hoặc bạn không đồng ý.' : `Không mở được trang đăng nhập: ${short(m)}`);
      }
      const parsed = parseRedirect(finalUrl, redirectUri, state, entry.spec.flow === 'oauth2');
      if ('error' in parsed) throw new OAuthError(parsed.error);

      if (entry.spec.flow === 'openrouter') {
        const json = await this.postForJson(OPENROUTER_EXCHANGE_URL, 'json', { code: parsed.code, code_verifier: verifier, code_challenge_method: 'S256' });
        const key = typeof json.key === 'string' ? json.key.trim() : '';
        if (!key || /\s/.test(key)) throw new OAuthError('OpenRouter không trả về khoá hợp lệ.');
        await this.d.setKey(providerId, key);
        entry.signedInAt = this.now;
        delete entry.tokens;
      } else {
        const json = await this.postForJson(entry.spec.tokenUrl, 'form', {
          grant_type: 'authorization_code',
          code: parsed.code,
          redirect_uri: redirectUri,
          client_id: entry.spec.clientId,
          code_verifier: verifier,
        });
        entry.tokens = this.tokensFrom(json, undefined);
        entry.signedInAt = this.now;
      }
      await this.save();
    } finally {
      this.loginBusy = false;
    }
  }

  /** Access token còn dùng được (tự làm mới nếu sắp/đã hết hạn). undefined = không dùng OAuth token cho nhà cung cấp này hoặc cần đăng nhập lại. */
  async accessToken(providerId: string): Promise<string | undefined> {
    const entry = (await this.all())[providerId];
    if (!entry || entry.method !== 'token' || !entry.tokens) return undefined;
    const t = entry.tokens;
    if (!t.expiresAt || t.expiresAt - REFRESH_SKEW_MS > this.now) return t.access;
    if (!t.refresh) return t.expiresAt > this.now ? t.access : undefined;
    let p = this.refreshing.get(providerId);
    if (!p) {
      p = this.refresh(providerId, entry).finally(() => this.refreshing.delete(providerId));
      this.refreshing.set(providerId, p);
    }
    return p;
  }

  private async refresh(providerId: string, entry: Stored): Promise<string | undefined> {
    if (entry.spec.flow !== 'oauth2' || !entry.tokens?.refresh) return undefined;
    try {
      const json = await this.postForJson(entry.spec.tokenUrl, 'form', { grant_type: 'refresh_token', refresh_token: entry.tokens.refresh, client_id: entry.spec.clientId });
      entry.tokens = this.tokensFrom(json, entry.tokens.refresh);
      await this.save();
      return entry.tokens.access;
    } catch (err) {
      // Refresh token bị thu hồi/hết hạn → coi như đã đăng xuất (UI hiện "cần đăng nhập lại"); lỗi mạng tạm thời thì giữ nguyên để thử lại sau.
      if (err instanceof OAuthError && /\(HTTP (400|401)\b/.test(err.message)) {
        delete entry.tokens;
        await this.save();
      }
      return undefined;
    }
  }

  async logout(providerId: string): Promise<void> {
    const entry = (await this.all())[providerId];
    if (!entry) return;
    if (entry.method === 'key' && entry.signedInAt) await this.d.deleteKey(providerId);
    delete entry.tokens;
    delete entry.signedInAt;
    await this.save();
  }

  private tokensFrom(json: Record<string, unknown>, keepRefresh: string | undefined): TokenSet {
    const access = typeof json.access_token === 'string' ? json.access_token.trim() : '';
    if (!access || /\s/.test(access)) throw new OAuthError('Máy chủ không trả về access token hợp lệ.');
    const refresh = typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : keepRefresh;
    const exp = typeof json.expires_in === 'number' ? json.expires_in : typeof json.expires_in === 'string' ? Number(json.expires_in) : NaN;
    return { access, refresh, expiresAt: Number.isFinite(exp) && exp > 0 ? this.now + exp * 1000 : undefined };
  }

  /** POST tới điểm cuối token; thông điệp lỗi chỉ lấy `error`/`error_description` (đã cắt), không bao giờ chép nguyên văn phản hồi. */
  private async postForJson(url: string, as: 'json' | 'form', body: Record<string, string>): Promise<Record<string, unknown>> {
    const doFetch = boundFetch(this.d.fetchImpl);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: as === 'json' ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: as === 'json' ? JSON.stringify(body) : new URLSearchParams(body).toString(),
        credentials: 'omit',
        redirect: 'error',
      });
    } catch {
      throw new OAuthError(`Không kết nối được tới ${new URL(url).host}. Kiểm tra mạng, hoặc quyền truy cập máy chủ này của tiện ích.`);
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
    } catch {
      /* phản hồi không phải JSON */
    }
    if (!res.ok) {
      const code = typeof json.error === 'string' ? json.error : typeof (json.error as { code?: unknown } | undefined)?.code === 'string' ? String((json.error as { code: string }).code) : '';
      const desc = typeof json.error_description === 'string' ? json.error_description : typeof json.message === 'string' ? json.message : typeof (json.error as { message?: unknown } | undefined)?.message === 'string' ? String((json.error as { message: string }).message) : '';
      const hint = res.status === 400 && code === 'invalid_grant' ? 'invalid_grant (mã/refresh token đã dùng, hết hạn hoặc bị thu hồi)' : code;
      throw new OAuthError(`Máy chủ ${new URL(url).host} từ chối (HTTP ${res.status}${hint ? `, ${short(hint, 80)}` : ''})${desc ? `: ${short(desc)}` : ''}.`);
    }
    return json;
  }
}
