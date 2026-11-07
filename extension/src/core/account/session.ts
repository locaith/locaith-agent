/**
 * Phiên đăng nhập tài khoản locaith.ai của extension — bộ máy trạng thái thuần (không import `vscode`), mọi phụ thuộc được tiêm vào để kiểm thử.
 *
 *   signedOut ──startLogin──▶ signingIn ──callback/mã──▶ signedIn ──verify (định kỳ)──▶ signedIn
 *                                │  ▲                       │  ▲                          │
 *                         huỷ/quá hạn │                      │  └─ mất mạng: ân hạn 7 ngày ─┘ (offline = true)
 *                                ▼  │                      ▼
 *                            signedOut                  expired  (token bị thu hồi / hết hạn / quá ân hạn)
 *
 *  • Luồng đăng nhập = mã uỷ quyền + PKCE (xem supabase/migrations/20261104_extension_account_and_remote_registry.sql ở repo trang web).
 *  • `verifier` + `state` của lần đăng nhập đang chờ được LƯU (SecretStorage) để callback tới một cửa sổ VS Code khác / sau khi VS Code khởi động lại vẫn khớp.
 *  • Token thiết bị chỉ nằm trong SecretStorage; không bao giờ ghi log.
 */

import { AccountClient, type AccountDevice, type AccountUser, type ClientMeta } from './client';
import { challengeOf, newState, newVerifier, safeEqual } from './pkce';

export type AccountState =
  | { status: 'signedOut'; error?: string }
  | { status: 'signingIn'; startedAt: number; manual: boolean }
  | { status: 'signedIn'; user: AccountUser; device: AccountDevice; verifiedAt: number; offline: boolean }
  | { status: 'expired'; user?: AccountUser; reason: 'revoked' | 'grace' };

export interface SavedAccount {
  token: string;
  device: AccountDevice;
  user: AccountUser;
  verifiedAt: number;
}

export interface PendingLogin {
  verifier: string;
  state: string;
  startedAt: number;
  manual: boolean;
}

export interface AccountStore {
  load(): Promise<SavedAccount | null>;
  save(a: SavedAccount | null): Promise<void>;
  loadPending(): Promise<PendingLogin | null>;
  savePending(p: PendingLogin | null): Promise<void>;
}

export interface SessionDeps {
  client: AccountClient;
  store: AccountStore;
  webUrl: string;
  /** Địa chỉ trang đích mà locaith.ai chuyển trình duyệt về sau khi cho phép (vscode://locaithai.locaith-agent/auth, hoặc loopback). */
  redirectUri: () => string;
  /** Tên hiển thị của máy trong trang «Cho phép» và danh sách thiết bị. */
  deviceLabel: () => string;
  meta: () => ClientMeta;
  openUrl: (url: string) => Promise<void>;
  now?: () => number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /** Hết thời gian chờ người dùng bấm «Cho phép». */
  loginTtlMs?: number;
  /** Mất mạng tối đa bao lâu thì vẫn cho dùng (tính từ lần xác minh thành công cuối). */
  graceMs?: number;
  /** Chu kỳ tự xác minh lại. */
  verifyEveryMs?: number;
}

const MIN = 60_000;
const DAY = 86_400_000;

export class AccountSession {
  private st: AccountState = { status: 'signedOut' };
  private saved: SavedAccount | null = null;
  private readonly listeners = new Set<(s: AccountState) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private verifying?: Promise<void>;
  private readonly now: () => number;
  private readonly loginTtl: number;
  private readonly grace: number;
  private readonly every: number;
  private disposed = false;

  constructor(private readonly d: SessionDeps) {
    this.now = d.now ?? Date.now;
    this.loginTtl = d.loginTtlMs ?? 10 * MIN;
    this.grace = d.graceMs ?? 7 * DAY;
    this.every = d.verifyEveryMs ?? 30 * MIN;
  }

  get state(): AccountState {
    return this.st;
  }

  /** Đang được phép dùng extension (đã đăng nhập, kể cả khi tạm mất mạng trong thời gian ân hạn). */
  get usable(): boolean {
    return this.st.status === 'signedIn';
  }

  /** Token cho các lời gọi tới dịch vụ tài khoản (báo danh máy…). Chỉ có khi `usable`. */
  get token(): string | undefined {
    return this.usable ? this.saved?.token : undefined;
  }

  /** (lane:gateway-client) Mã thiết bị do máy chủ cấp lúc đăng nhập (chưa băm). Chỉ dùng để băm làm nhãn chẩn đoán, không bao giờ gửi thô. */
  get deviceId(): string | undefined {
    return this.usable ? this.saved?.device.id : undefined;
  }

  /**
   * (lane:gateway-client) Cổng Locaith trả 401 cho `stale`: làm mới bằng cơ chế sẵn có. Token thiết bị không đúc lại được nếu không đăng nhập lại, nên «làm mới» là:
   *   1) đọc lại kho (cửa sổ khác có thể vừa đăng nhập lại → token mới) — có token khác `stale` thì dùng luôn;
   *   2) không thì hỏi máy chủ tài khoản (`whoami`, bỏ qua gộp lời gọi) — thành công và KHÔNG ở chế độ offline = token còn hiệu lực.
   * Máy chủ nói token đã bị thu hồi → phiên chuyển «expired» (giao diện hiện nút đăng nhập) và trả undefined. Mất mạng → undefined (không xác minh được).
   */
  async refreshToken(stale: string): Promise<string | undefined> {
    await this.reload();
    if (this.saved && this.usable && this.saved.token !== stale) return this.saved.token;
    if (!this.saved) return undefined;
    await this.verify(true);
    const s = this.st;
    return s.status === 'signedIn' && !s.offline && this.saved ? this.saved.token : undefined;
  }

  /** (lane:gateway-client) Cổng vẫn từ chối `token` sau khi đã làm mới: xoá nó và chuyển «expired» để người dùng đăng nhập lại. Không đụng tới token khác (cửa sổ khác có thể đã đổi). */
  async expireToken(token: string): Promise<void> {
    const saved = this.saved ?? (await this.d.store.load());
    if (!saved || saved.token !== token) return;
    this.saved = null;
    await this.d.store.save(null);
    this.set({ status: 'expired', user: saved.user, reason: 'revoked' });
    this.d.log?.('warn', 'Cổng Locaith từ chối token đã làm mới — phiên đăng nhập bị khoá, cần đăng nhập lại.');
  }

  get user(): AccountUser | undefined {
    return this.st.status === 'signedIn' ? this.st.user : this.st.status === 'expired' ? this.st.user : undefined;
  }

  onChange(cb: (s: AccountState) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private set(s: AccountState): void {
    this.st = s;
    for (const cb of [...this.listeners]) {
      try {
        cb(s);
      } catch {
        /* người nghe lỗi không được làm hỏng phiên */
      }
    }
  }

  // ── khởi động / đồng bộ giữa các cửa sổ ────────────────────────────────────
  /** Nạp phiên đã lưu rồi xác minh với máy chủ. Mất mạng thì vẫn vào được nếu còn trong thời gian ân hạn. */
  async init(): Promise<void> {
    await this.reload();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.verify().catch(() => undefined), this.every);
    this.timer.unref?.();
    if (this.saved) await this.verify(true);
  }

  /** Đọc lại từ kho (cửa sổ khác vừa đăng nhập/đăng xuất). Không gọi mạng. */
  async reload(): Promise<void> {
    const saved = await this.d.store.load();
    const pending = await this.d.store.loadPending();
    this.saved = saved;
    if (saved) {
      const prev = this.st;
      // Giữ nguyên "offline" nếu đang biết là offline; ngược lại coi là mới xác minh theo dấu thời gian đã lưu.
      const stale = this.now() - saved.verifiedAt > this.grace;
      if (stale) this.set({ status: 'expired', user: saved.user, reason: 'grace' });
      else this.set({ status: 'signedIn', user: saved.user, device: saved.device, verifiedAt: saved.verifiedAt, offline: prev.status === 'signedIn' ? prev.offline : false });
      return;
    }
    if (pending && this.now() - pending.startedAt < this.loginTtl) this.set({ status: 'signingIn', startedAt: pending.startedAt, manual: pending.manual });
    else if (this.st.status !== 'expired') this.set({ status: 'signedOut' });
  }

  // ── đăng nhập ─────────────────────────────────────────────────────────────
  /** Bắt đầu đăng nhập: lưu verifier/state, mở trang locaith.ai. Trả URL (để hiển thị/sao chép khi trình duyệt không tự mở). */
  async startLogin(opts: { manual?: boolean } = {}): Promise<{ url: string }> {
    if (this.st.status === 'signedIn') throw new Error('already_signed_in'); // đổi tài khoản = đăng xuất trước
    const verifier = newVerifier();
    const state = newState();
    const pending: PendingLogin = { verifier, state, startedAt: this.now(), manual: !!opts.manual };
    await this.d.store.savePending(pending);
    const q = new URLSearchParams({
      client: 'vscode',
      challenge: challengeOf(verifier),
      state,
      redirect: this.d.redirectUri(),
      label: this.d.deviceLabel(),
      ...(opts.manual ? { manual: '1' } : {}),
    });
    for (const [k, v] of Object.entries(this.d.meta())) if (v) q.set(`m_${k}`, String(v).slice(0, 40));
    const url = `${this.d.webUrl}/#ext-auth?${q.toString()}`;
    this.set({ status: 'signingIn', startedAt: pending.startedAt, manual: pending.manual });
    try {
      await this.d.openUrl(url);
    } catch (err) {
      this.d.log?.('warn', `Không mở được trình duyệt: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { url };
  }

  cancelLogin(): void {
    void this.d.store.savePending(null).catch(() => undefined);
    if (this.st.status === 'signingIn') this.set({ status: 'signedOut' });
  }

  /** Callback từ trình duyệt (URI handler): `code` + `state`. Mọi callback — kể cả báo lỗi — phải mang đúng `state` đã sinh, nếu không bị bỏ qua. */
  async handleCallback(p: { code?: string | null; state?: string | null; error?: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
    const pending = await this.d.store.loadPending();
    if (!pending || this.now() - pending.startedAt > this.loginTtl) return this.fail('no_pending');
    // Sai state: có thể là yêu cầu giả (trang lạ mở vscode://…). KHÔNG đụng tới pending — đăng nhập thật vẫn đang chờ.
    if (!p.state || !safeEqual(p.state, pending.state)) return this.reject('state_mismatch');
    if (p.error) {
      await this.d.store.savePending(null);
      return this.fail(p.error === 'access_denied' ? 'denied' : 'failed');
    }
    if (!p.code) return this.reject('missing_code');
    return this.finish(p.code, pending);
  }

  /** Người dùng dán mã (khi trình duyệt không tự chuyển về VS Code được — SSH, WSL, Codespaces…). */
  async submitCode(raw: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const code = raw.trim().replace(/^.*[?&]code=/, '').replace(/[&#].*$/, '').replace(/\s+/g, '');
    const pending = await this.d.store.loadPending();
    if (!pending || this.now() - pending.startedAt > this.loginTtl) return this.fail('no_pending');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return this.reject('bad_code'); // dán nhầm: không huỷ lần đăng nhập đang chờ
    return this.finish(code, pending);
  }

  private async finish(code: string, pending: PendingLogin): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = await this.d.client.exchange(code, pending.verifier, this.d.meta());
    if (!r.ok) {
      // Mã/verifier bị máy chủ từ chối thì đã hết dùng được; còn lỗi mạng/máy chủ thì GIỮ pending để người dùng thử lại (mã còn hiệu lực 5 phút).
      if (r.error === 'invalid_grant') await this.d.store.savePending(null);
      return r.error === 'invalid_grant' ? this.fail('invalid_grant') : this.reject(r.error);
    }
    await this.d.store.savePending(null);
    const saved: SavedAccount = { token: r.token, device: r.device, user: r.user, verifiedAt: this.now() };
    await this.d.store.save(saved);
    this.saved = saved;
    this.set({ status: 'signedIn', user: r.user, device: r.device, verifiedAt: saved.verifiedAt, offline: false });
    this.d.log?.('info', `Đã đăng nhập tài khoản Locaith (${r.user.email || r.user.id}).`);
    return { ok: true };
  }

  /** Đăng nhập thất bại hẳn: về signedOut kèm lý do. */
  private fail(error: string): { ok: false; error: string } {
    if (this.st.status === 'signingIn' || this.st.status === 'signedOut') this.set({ status: 'signedOut', error });
    this.d.log?.('warn', `Đăng nhập thất bại: ${error}`);
    return { ok: false, error };
  }

  /** Bỏ qua một callback không hợp lệ/lỗi tạm thời mà KHÔNG làm hỏng lần đăng nhập đang chờ. */
  private reject(error: string): { ok: false; error: string } {
    this.d.log?.('warn', `Bỏ qua callback đăng nhập: ${error}`);
    return { ok: false, error };
  }

  // ── xác minh định kỳ ──────────────────────────────────────────────────────
  /** Hỏi máy chủ token còn hiệu lực không. `force` bỏ qua việc gộp lời gọi đang chạy. */
  verify(force = false): Promise<void> {
    if (this.verifying && !force) return this.verifying;
    const run = this.doVerify().finally(() => {
      if (this.verifying === run) this.verifying = undefined;
    });
    this.verifying = run;
    return run;
  }

  private async doVerify(): Promise<void> {
    if (this.disposed) return;
    const saved = this.saved ?? (await this.d.store.load());
    if (!saved) return;
    this.saved = saved;
    const r = await this.d.client.whoami(saved.token);
    if (this.disposed) return;
    if (r.ok) {
      const next: SavedAccount = { token: saved.token, device: r.device, user: r.user, verifiedAt: this.now() };
      this.saved = next;
      await this.d.store.save(next);
      this.set({ status: 'signedIn', user: r.user, device: r.device, verifiedAt: next.verifiedAt, offline: false });
      return;
    }
    if (r.error === 'invalid_token') {
      // Máy chủ nói dứt khoát: token đã bị thu hồi/hết hạn → xoá cục bộ, yêu cầu đăng nhập lại.
      this.saved = null;
      await this.d.store.save(null);
      this.set({ status: 'expired', user: saved.user, reason: 'revoked' });
      this.d.log?.('warn', 'Phiên đăng nhập Locaith không còn hiệu lực (đã thu hồi hoặc hết hạn).');
      return;
    }
    // Không xác minh được (mất mạng / máy chủ lỗi): giữ phiên trong thời gian ân hạn.
    if (this.now() - saved.verifiedAt <= this.grace) {
      this.set({ status: 'signedIn', user: saved.user, device: saved.device, verifiedAt: saved.verifiedAt, offline: true });
    } else {
      this.set({ status: 'expired', user: saved.user, reason: 'grace' });
      this.d.log?.('warn', 'Quá thời gian ân hạn mà không xác minh được phiên đăng nhập Locaith.');
    }
  }

  // ── đăng xuất ─────────────────────────────────────────────────────────────
  async logout(): Promise<void> {
    const saved = this.saved ?? (await this.d.store.load());
    this.saved = null;
    await this.d.store.save(null);
    await this.d.store.savePending(null);
    this.set({ status: 'signedOut' });
    if (saved) await this.d.client.logout(saved.token).catch(() => false);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.listeners.clear();
  }
}
