/**
 * Tài khoản locaith.ai của bản Chrome / Edge — TUỲ CHỌN (khác bản VS Code, nơi đăng nhập là bắt buộc): chỉ cần để dùng mô hình Locaith (Locaith-v5-flash / SI).
 * Dùng API key của riêng mình thì không bao giờ phải đăng nhập, và không có byte nào của người dùng đi tới Locaith.
 *
 * Cách đăng nhập: trang `https://locaith.ai/#ext-browser` (người dùng đăng nhập, đọc thông báo dữ liệu, bấm «Tạo mã kết nối») tự làm cả hai nửa của luồng uỷ quyền
 * (lib/extBrowserToken.ts ở repo trang web) và đưa ra một «mã kết nối» = token thiết bị `lat_…`, hiện đúng một lần. Người dùng dán mã vào tiện ích; tiện ích KIỂM mã
 * với máy chủ tài khoản (`ext_auth_whoami`) rồi giữ nó trong chrome.storage.local — KHÔNG mã hoá, như khoá API (xem secrets.ts: trình duyệt không có kho bí mật gắn với hệ điều hành).
 * Không có PKCE ở phía tiện ích vì không có gì để chuyển hướng về: tiện ích chưa bao giờ giữ mã uỷ quyền.
 *
 *   signedOut ──signIn──▶ signingIn ──mã đúng──▶ signedIn ──verify (30 phút / lúc quay lại)──▶ signedIn
 *       ▲                     │ (hoặc dán mã luôn)      │  ▲                                        │
 *       └───── cancel ────────┘                         │  └─ mất mạng: ân hạn 7 ngày (offline) ──────┘
 *                                                       ▼
 *                                                   expired  (token bị thu hồi / hết hạn / quá ân hạn) ──signIn──▶ signingIn
 *
 * Không import `chrome`: kho là KeyValueStore, việc mở trang là hàm được tiêm → kiểm thử đơn vị bằng MemoryKv + máy chủ tài khoản giả. Không bao giờ ghi token vào log.
 */

import { AccountClient, DEVICE_TOKEN_RE, type AccountDevice, type AccountUser } from '../core/account/client';
import type { AccountConfig } from '../core/account/config';
import type { LocaithAccountLike, MementoLike } from '../host/locaith';
import type { AccountView } from '../shared/protocol';
import type { KeyValueStore } from './kv';

const KEY = 'nd.account';
const MIN = 60_000;
const DAY = 86_400_000;

/** Phiên đã lưu: token + người dùng + thiết bị + lần xác minh gần nhất (để tính thời gian ân hạn khi mất mạng). */
export interface SavedBrowserAccount {
  token: string;
  device: AccountDevice;
  user: AccountUser;
  verifiedAt: number;
}

type State =
  | { status: 'signedOut' }
  | { status: 'signingIn'; startedAt: number }
  | { status: 'signedIn'; user: AccountUser; device: AccountDevice; verifiedAt: number; offline: boolean }
  | { status: 'expired'; user?: AccountUser; reason: 'revoked' | 'grace' };

export type EnterCodeResult = { ok: true } | { ok: false; error: 'bad_code' | 'invalid_token' | 'network' | 'server' | 'already_signed_in' };

/** Phần controller cần biết về tài khoản (để thay bằng đồ giả khi kiểm thử đơn vị). Gồm cả `LocaithAccountLike` mà bản ghi đồng ý và cầu nối token dùng. */
export interface BrowserAccountGate extends LocaithAccountLike {
  view(): AccountView;
  onChange(cb: () => void): () => void;
  /** Mở trang cấp mã kết nối và chuyển sang «đang chờ mã». */
  signIn(): Promise<void>;
  cancel(): void;
  /** Kiểm mã dán vào rồi đăng nhập. Mã sai KHÔNG đụng tới phiên hiện có. */
  enterCode(raw: string): Promise<EnterCodeResult>;
  signOut(): Promise<void>;
  /** Mở «Quản lý thiết bị» trên locaith.ai (nơi thu hồi mã). */
  manage(): Promise<void>;
  /** Hỏi lại máy chủ token còn hiệu lực không (cổng mô hình vừa trả 401). Có giới hạn tần suất. */
  recheck(): Promise<void>;
  verify(force?: boolean): Promise<void>;
}

/** Lấy token thiết bị từ chuỗi người dùng dán (có thể kèm dấu nháy, khoảng trắng, xuống dòng hay cả câu). Không có token hợp lệ → undefined. */
export function extractDeviceToken(raw: unknown): string | undefined {
  const m = /lat_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/.exec(typeof raw === 'string' ? raw : '');
  return m && DEVICE_TOKEN_RE.test(m[0]) ? m[0] : undefined;
}

/**
 * Kho «đồng bộ» (MementoLike) cho bản ghi đồng ý của mô hình Locaith (src/host/locaith.ts) trên chrome.storage: `LocaithConsent` đọc bản đệm ngay trong hàm dựng nên các khoá phải
 * được nạp sẵn (bất đồng bộ) trước khi dựng nó; ghi thì chạy nền. `null` / `undefined` = xoá khoá.
 */
export async function kvMemento(kv: KeyValueStore, keys: string[]): Promise<MementoLike> {
  const prefix = 'nd.mem.';
  const cache = new Map<string, unknown>();
  for (const k of keys) cache.set(k, await kv.get(prefix + k));
  return {
    get<T>(key: string, defaultValue: T): T {
      const v = cache.get(key);
      return v === undefined ? defaultValue : (v as T);
    },
    update(key: string, value: unknown): Promise<void> {
      cache.set(key, value ?? undefined);
      return value === null || value === undefined ? kv.remove(prefix + key) : kv.set(prefix + key, value);
    },
  };
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Dữ liệu đọc từ kho được kiểm hình dạng (kho có thể bị sửa tay / ghi bởi bản cũ). */
export function parseSaved(j: unknown): SavedBrowserAccount | null {
  const o = j as Record<string, any> | null;
  if (!o || typeof o !== 'object' || typeof o.token !== 'string' || !DEVICE_TOKEN_RE.test(o.token) || !Number.isFinite(o.verifiedAt)) return null;
  const u = o.user;
  const d = o.device;
  if (!u || !str(u.id, 64) || typeof u.email !== 'string' || typeof u.name !== 'string') return null;
  if (!d || !str(d.id, 64) || typeof d.label !== 'string') return null;
  return {
    token: o.token,
    verifiedAt: o.verifiedAt,
    user: { id: u.id, email: u.email.slice(0, 320), name: u.name.slice(0, 120), avatar: typeof u.avatar === 'string' && u.avatar.length <= 600 ? u.avatar : null },
    device: { id: d.id, label: d.label.slice(0, 80), expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : '' },
  };
}

export interface BrowserAccountDeps {
  kv: KeyValueStore;
  client: AccountClient;
  cfg: AccountConfig;
  /** Mở một trang web ở tab mới (đã chống nảy đúp ở nơi gọi). */
  openUrl(url: string): Promise<unknown>;
  /** Đăng ký token với bộ che bí mật của nhật ký. */
  registerSecret?(v: string): void;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  now?: () => number;
  /** Mất mạng tối đa bao lâu thì vẫn cho dùng (tính từ lần xác minh thành công cuối). Mặc định 7 ngày. */
  graceMs?: number;
  /** Chu kỳ tự xác minh lại. Mặc định 30 phút. */
  verifyEveryMs?: number;
}

export class BrowserAccount implements BrowserAccountGate {
  private st: State = { status: 'signedOut' };
  private saved: SavedBrowserAccount | null = null;
  /** Lý do lần thử gần nhất thất bại (hiện cạnh ô dán mã); xoá ở lần thử kế tiếp / khi đăng nhập xong. */
  private lastError: string | undefined;
  /** Đang hỏi máy chủ về mã vừa dán (nút «Kết nối» bận). */
  private checking = false;
  private readonly listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private verifying?: Promise<void>;
  private lastRecheck = 0;
  private disposed = false;
  private offKv?: () => void;
  private readonly now: () => number;
  private readonly grace: number;
  private readonly every: number;

  constructor(private readonly d: BrowserAccountDeps) {
    this.now = d.now ?? Date.now;
    this.grace = d.graceMs ?? 7 * DAY;
    this.every = d.verifyEveryMs ?? 30 * MIN;
  }

  // ── truy cập ──────────────────────────────────────────────────────────────
  get connectUrl(): string {
    return `${this.d.cfg.webUrl}/#ext-browser`;
  }

  /** Đang dùng được (đã đăng nhập, kể cả trong thời gian ân hạn mất mạng). */
  get usable(): boolean {
    return this.st.status === 'signedIn';
  }

  token(): string | undefined {
    return this.usable ? this.saved?.token : undefined;
  }

  userId(): string | undefined {
    return this.user?.id;
  }

  /** Mã thiết bị do máy chủ cấp (chưa băm): chỉ để băm làm nhãn chẩn đoán `X-Locaith-Device`, không bao giờ gửi thô. */
  deviceId(): string | undefined {
    return this.usable ? this.saved?.device.id : undefined;
  }

  get user(): AccountUser | undefined {
    return this.st.status === 'signedIn' ? this.st.user : this.st.status === 'expired' ? this.st.user : undefined;
  }

  get status(): State['status'] {
    return this.st.status;
  }

  view(): AccountView {
    const s = this.st;
    const user = this.user;
    return {
      status: s.status,
      optional: true,
      connectUrl: this.connectUrl,
      webUrl: this.d.cfg.webUrl,
      ...(user ? { user: { name: user.name, email: user.email, avatar: user.avatar } } : {}),
      ...(s.status === 'signedIn' && s.offline ? { offline: true } : {}),
      ...((s.status === 'signedOut' || s.status === 'signingIn') && this.lastError ? { error: this.lastError } : {}),
      ...(s.status === 'expired' ? { reason: s.reason } : {}),
      ...(this.checking ? { checking: true } : {}),
    };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        /* người nghe lỗi không được làm hỏng phiên */
      }
    }
  }

  private set(next: State): void {
    const same = JSON.stringify(next) === JSON.stringify(this.st);
    this.st = next;
    if (!same) this.emit();
  }

  // ── khởi động / đồng bộ giữa các cửa sổ ───────────────────────────────────
  /** Nạp phiên đã lưu rồi xác minh với máy chủ (mất mạng thì vẫn vào được trong thời gian ân hạn). Gọi một lần ở khung chat. */
  async init(): Promise<void> {
    await this.reload();
    this.offKv ??= this.d.kv.onChanged((keys) => {
      if (keys.includes(KEY) && !this.disposed) void this.reload().catch(() => undefined); // cửa sổ khác vừa đăng nhập / đăng xuất
    });
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.verify().catch(() => undefined), this.every);
    (this.timer as { unref?: () => void }).unref?.();
    if (this.saved) await this.verify(true);
  }

  private async load(): Promise<SavedBrowserAccount | null> {
    try {
      const saved = parseSaved(await this.d.kv.get(KEY));
      if (saved) this.d.registerSecret?.(saved.token);
      return saved;
    } catch {
      return null;
    }
  }

  /** Đọc lại từ kho (không gọi mạng). */
  async reload(): Promise<void> {
    const saved = await this.load();
    this.saved = saved;
    if (saved) {
      const stale = this.now() - saved.verifiedAt > this.grace;
      if (stale) this.set({ status: 'expired', user: saved.user, reason: 'grace' });
      else this.set({ status: 'signedIn', user: saved.user, device: saved.device, verifiedAt: saved.verifiedAt, offline: this.st.status === 'signedIn' ? this.st.offline : false });
      return;
    }
    // Không còn gì trong kho: cửa sổ khác đã đăng xuất → về signedOut; «đang chờ mã» và «hết hiệu lực» là trạng thái cục bộ, giữ nguyên.
    if (this.st.status === 'signedIn') this.set({ status: 'signedOut' });
  }

  private async persist(a: SavedBrowserAccount | null): Promise<void> {
    if (a) {
      this.d.registerSecret?.(a.token);
      await this.d.kv.set(KEY, a);
    } else await this.d.kv.remove(KEY);
  }

  // ── đăng nhập ─────────────────────────────────────────────────────────────
  async signIn(): Promise<void> {
    if (this.st.status === 'signedIn') return;
    this.lastError = undefined;
    this.set({ status: 'signingIn', startedAt: this.now() });
    try {
      await this.d.openUrl(this.connectUrl);
    } catch (err) {
      this.d.log?.('warn', `Không mở được trang cấp mã kết nối: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  cancel(): void {
    this.lastError = undefined;
    if (this.st.status === 'signingIn') this.set({ status: 'signedOut' });
    else this.emit();
  }

  async enterCode(raw: string): Promise<EnterCodeResult> {
    if (this.st.status === 'signedIn') return { ok: false, error: 'already_signed_in' };
    const token = extractDeviceToken(raw);
    if (!token) return this.refuse('bad_code');
    if (this.checking) return { ok: false, error: 'server' }; // đang kiểm một mã khác: bỏ qua lần bấm đúp
    this.checking = true;
    this.lastError = undefined;
    this.emit();
    let r: Awaited<ReturnType<AccountClient['whoami']>>;
    try {
      r = await this.d.client.whoami(token);
    } finally {
      this.checking = false;
    }
    if (!r.ok) return this.refuse(r.error);
    const saved: SavedBrowserAccount = { token, device: r.device, user: r.user, verifiedAt: this.now() };
    await this.persist(saved);
    this.saved = saved;
    this.lastError = undefined;
    this.set({ status: 'signedIn', user: r.user, device: r.device, verifiedAt: saved.verifiedAt, offline: false });
    this.d.log?.('info', `Đã kết nối tài khoản Locaith (${r.user.email || r.user.id}).`);
    return { ok: true };
  }

  /** Mã sai / máy chủ từ chối / mất mạng: ghi lý do, KHÔNG đụng tới phiên hiện có (đăng nhập thật vẫn đang chờ). */
  private refuse(error: 'bad_code' | 'invalid_token' | 'network' | 'server'): { ok: false; error: typeof error } {
    this.lastError = error;
    this.d.log?.('warn', `Mã kết nối không dùng được: ${error}`);
    // Phát lại trạng thái để giao diện hiện lỗi cạnh ô dán mã (trạng thái không đổi nên `set` sẽ không phát).
    this.emit();
    return { ok: false, error };
  }

  // ── token cho cổng mô hình (lane:gateway-client) ───────────────────────────
  /**
   * Cổng Locaith trả 401 cho `stale`: làm mới bằng cơ chế sẵn có. Token thiết bị không đúc lại được nếu không đăng nhập lại, nên «làm mới» là:
   *   1) đọc lại kho (cửa sổ khác có thể vừa đăng nhập lại → token mới) — có token khác `stale` thì dùng luôn;
   *   2) không thì hỏi máy chủ tài khoản (bỏ qua gộp lời gọi) — thành công và KHÔNG ở chế độ offline = token còn hiệu lực.
   * Máy chủ nói token đã bị thu hồi → phiên chuyển «expired» và trả undefined. Mất mạng → undefined (không xác minh được).
   */
  async refreshToken(stale: string): Promise<string | undefined> {
    await this.reload();
    if (this.saved && this.usable && this.saved.token !== stale) return this.saved.token;
    if (!this.saved) return undefined;
    await this.verify(true);
    const s = this.st;
    return s.status === 'signedIn' && !s.offline && this.saved ? this.saved.token : undefined;
  }

  /** Cổng vẫn từ chối `token` sau khi đã làm mới: xoá nó và chuyển «expired» để người dùng dán mã mới. Không đụng tới token khác (cửa sổ khác có thể đã đổi). */
  async expireToken(token: string): Promise<void> {
    const saved = this.saved ?? (await this.load());
    if (!saved || saved.token !== token) return;
    this.saved = null;
    await this.persist(null);
    this.set({ status: 'expired', user: saved.user, reason: 'revoked' });
    this.d.log?.('warn', 'Cổng Locaith từ chối token đã làm mới — phiên đăng nhập bị khoá, cần mã kết nối mới.');
  }

  /** Cổng Locaith trả 401: kiểm tra lại với máy chủ tài khoản ngay (không đợi chu kỳ 30 phút). Tối đa một lần mỗi 10 giây dù nhiều lượt gọi lỗi cùng lúc. */
  async recheck(): Promise<void> {
    const t = this.now();
    if (t - this.lastRecheck < 10_000) return;
    this.lastRecheck = t;
    await this.verify(true).catch(() => undefined);
  }

  // ── xác minh định kỳ ──────────────────────────────────────────────────────
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
    const saved = this.saved ?? (await this.load());
    if (!saved) return;
    this.saved = saved;
    const r = await this.d.client.whoami(saved.token);
    if (this.disposed) return;
    if (r.ok) {
      const next: SavedBrowserAccount = { token: saved.token, device: r.device, user: r.user, verifiedAt: this.now() };
      this.saved = next;
      await this.persist(next);
      this.set({ status: 'signedIn', user: r.user, device: r.device, verifiedAt: next.verifiedAt, offline: false });
      return;
    }
    if (r.error === 'invalid_token') {
      // Máy chủ nói dứt khoát: token đã bị thu hồi / hết hạn → xoá cục bộ, cần mã mới.
      this.saved = null;
      await this.persist(null);
      this.set({ status: 'expired', user: saved.user, reason: 'revoked' });
      this.d.log?.('warn', 'Mã kết nối Locaith không còn hiệu lực (đã thu hồi hoặc hết hạn).');
      return;
    }
    // Không xác minh được (mất mạng / máy chủ lỗi): giữ phiên trong thời gian ân hạn.
    if (this.now() - saved.verifiedAt <= this.grace) {
      this.set({ status: 'signedIn', user: saved.user, device: saved.device, verifiedAt: saved.verifiedAt, offline: true });
    } else {
      this.set({ status: 'expired', user: saved.user, reason: 'grace' });
      this.d.log?.('warn', 'Quá thời gian ân hạn mà không xác minh được phiên Locaith.');
    }
  }

  // ── đăng xuất / quản lý ────────────────────────────────────────────────────
  async signOut(): Promise<void> {
    const saved = this.saved ?? (await this.load());
    this.saved = null;
    this.lastError = undefined;
    await this.persist(null);
    this.set({ status: 'signedOut' });
    if (saved) await this.d.client.logout(saved.token).catch(() => false); // thu hồi ở máy chủ (cố gắng hết sức)
  }

  async manage(): Promise<void> {
    await this.d.openUrl(`${this.d.cfg.webUrl}/#remote`);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.offKv?.();
    this.listeners.clear();
  }
}
