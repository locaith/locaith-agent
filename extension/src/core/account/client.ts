/**
 * Máy khách dịch vụ tài khoản locaith.ai (Supabase RPC qua khoá anon). Mỗi hàm trả kết quả có kiểu thay vì ném lỗi:
 *  • `invalid_grant` / `invalid_token` = máy chủ đã trả lời và DỨT KHOÁT từ chối (mã sai/hết hạn, token bị thu hồi);
 *  • `network` = không tới được máy chủ (mất mạng, hết giờ); `server` = máy chủ trả lỗi HTTP / dữ liệu lạ.
 * Hai loại sau KHÔNG có nghĩa token hỏng — người gọi giữ phiên (trong thời gian ân hạn) thay vì đăng xuất oan.
 * Không import `vscode`. Không ghi token vào bất kỳ log nào.
 */

import type { AccountConfig } from './config';

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
}

export interface AccountDevice {
  id: string;
  label: string;
  /** ISO 8601. */
  expiresAt: string;
}

export interface ClientMeta {
  client?: string;
  platform?: string;
  app?: string;
  vscode?: string;
  ext?: string;
}

export type ExchangeResult = { ok: true; token: string; device: AccountDevice; user: AccountUser } | { ok: false; error: 'invalid_grant' | 'network' | 'server' };
export type WhoamiResult = { ok: true; user: AccountUser; device: AccountDevice } | { ok: false; error: 'invalid_token' | 'network' | 'server' };
export type SimpleResult = { ok: true } | { ok: false; error: string };
/** `keyed`: khoá tài khoản của máy ĐÃ nằm trong danh bạ (chỉ có mặt khi có truyền khoá; false = máy chủ chưa hỗ trợ hoặc vừa xoá khoá). */
export type HostUpsertResult = { ok: true; keyed?: boolean } | { ok: false; error: string };

type Rpc = { kind: 'ok'; data: unknown } | { kind: 'err'; error: 'network' | 'server'; status?: number };

const TOKEN_RE = /^lat_[A-Za-z0-9_-]{43}$/;
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

function parseUser(v: unknown): AccountUser | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const id = str(o.id, 64);
  if (!id) return undefined;
  return { id, email: str(o.email, 320) ?? '', name: str(o.name, 120) ?? str(o.email, 320) ?? 'Locaith', avatar: str(o.avatar, 600) ?? null };
}

function parseDevice(v: unknown): AccountDevice | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const id = str(o.id, 64);
  if (!id) return undefined;
  return { id, label: str(o.label, 80) ?? 'VS Code', expiresAt: str(o.expires_at, 64) ?? '' };
}

export class AccountClient {
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly cfg: AccountConfig,
    o: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.f = o.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = o.timeoutMs ?? 12_000;
  }

  private async rpc(fn: string, args: Record<string, unknown>): Promise<Rpc> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.f(`${this.cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: this.cfg.anonKey, authorization: `Bearer ${this.cfg.anonKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(args),
        signal: ctl.signal,
      });
      if (!res.ok) return { kind: 'err', error: 'server', status: res.status };
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return { kind: 'err', error: 'server', status: res.status };
      }
      return { kind: 'ok', data };
    } catch {
      return { kind: 'err', error: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Đổi mã uỷ quyền + verifier lấy token thiết bị (token chỉ trả đúng một lần). */
  async exchange(code: string, verifier: string, meta: ClientMeta): Promise<ExchangeResult> {
    const r = await this.rpc('ext_auth_exchange', { p_code: code, p_verifier: verifier, p_meta: meta });
    if (r.kind === 'err') return { ok: false, error: r.error };
    const d = r.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object') return { ok: false, error: 'server' };
    if (d.ok !== true) return { ok: false, error: d.error === 'invalid_grant' ? 'invalid_grant' : 'server' };
    const user = parseUser(d.user);
    const device = parseDevice(d.device);
    if (typeof d.token !== 'string' || !TOKEN_RE.test(d.token) || !user || !device) return { ok: false, error: 'server' };
    return { ok: true, token: d.token, device, user };
  }

  /** Xác minh token còn hiệu lực (và gia hạn trượt phía máy chủ). */
  async whoami(token: string): Promise<WhoamiResult> {
    const r = await this.rpc('ext_auth_whoami', { p_token: token });
    if (r.kind === 'err') return { ok: false, error: r.error };
    const d = r.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object') return { ok: false, error: 'server' };
    if (d.ok !== true) return { ok: false, error: d.error === 'invalid_token' ? 'invalid_token' : 'server' };
    const user = parseUser(d.user);
    const device = parseDevice(d.device);
    return user && device ? { ok: true, user, device } : { ok: false, error: 'server' };
  }

  /** Thu hồi token thiết bị này ở máy chủ (cố gắng hết sức — mất mạng thì chỉ xoá cục bộ). */
  async logout(token: string): Promise<boolean> {
    const r = await this.rpc('ext_auth_logout', { p_token: token });
    return r.kind === 'ok';
  }

  /**
   * Báo danh một cửa sổ VS Code đang bật Remote để trang locaith.ai liệt kê «Máy của bạn».
   *
   * `accountKey` (0.6.5, «đúng tài khoản là vào được»): khoá tài khoản của máy (base64url 22 ký tự). Quy ước:
   *  • bỏ trống (undefined) → không gửi tham số, máy chủ GIỮ NGUYÊN khoá đang có;
   *  • '' → xoá khoá khỏi danh bạ (tắt tin cậy theo tài khoản);
   *  • khác → đặt/xoay khoá.
   * Máy chủ chưa nâng cấp (hàm cũ không có tham số này) trả 400/404: gửi lại KHÔNG kèm khoá để việc báo danh vẫn thành công, và `keyed:false` cho người gọi biết
   * trang web chưa thể mở máy này bằng tài khoản (phải dùng liên kết ghép đôi như trước). `keyed` chỉ có mặt khi có truyền `accountKey`.
   */
  async hostUpsert(token: string, hostId: string, label: string, workspace: string | undefined, meta: ClientMeta, accountKey?: string): Promise<HostUpsertResult> {
    const base = { p_token: token, p_host_id: hostId, p_label: label, p_workspace: workspace ?? null, p_meta: meta };
    let r = await this.rpc('ext_host_upsert', accountKey === undefined ? base : { ...base, p_account_psk: accountKey });
    let sentKey = accountKey !== undefined;
    if (sentKey && r.kind === 'err' && r.error === 'server' && (r.status === 400 || r.status === 404)) {
      r = await this.rpc('ext_host_upsert', base);
      sentKey = false;
    }
    if (r.kind === 'err') return { ok: false, error: r.error };
    const d = r.data as Record<string, unknown> | null;
    if (!d || d.ok !== true) return { ok: false, error: typeof d?.error === 'string' ? d.error : 'server' };
    return accountKey === undefined ? { ok: true } : { ok: true, keyed: sentKey && accountKey !== '' };
  }

  async hostRemove(token: string, hostId: string): Promise<boolean> {
    const r = await this.rpc('ext_host_remove', { p_token: token, p_host_id: hostId });
    return r.kind === 'ok';
  }
}
