/**
 * Dịch vụ tài khoản locaith.ai của VS Code: cầu nối giữa phiên đăng nhập thuần (core/account/session.ts) và giao diện VS Code.
 *  • đăng nhập kiểu OAuth: mở trình duyệt → người dùng bấm «Cho phép» trên locaith.ai → trình duyệt chuyển về vscode://locaithai.locaith-agent/auth?code=…&state=…
 *    (URI handler bên dưới) → đổi mã lấy token thiết bị (PKCE). Có đường dự phòng dán mã cho VS Code từ xa/web;
 *  • token thiết bị nằm trong SecretStorage, dùng chung mọi cửa sổ VS Code (đăng nhập/đăng xuất ở một cửa sổ cập nhật các cửa sổ khác);
 *  • CỔNG: chưa đăng nhập (hoặc phiên hết hiệu lực) thì ChatController từ chối mọi thao tác ngoài đăng nhập — xem `usable`.
 */

import * as os from 'node:os';
import * as vscode from 'vscode';
import { AccountClient, type AccountDevice, type AccountUser, type ClientMeta } from '../core/account/client';
import { resolveAccountConfig, type AccountConfig } from '../core/account/config';
import { AccountSession, type AccountState, type AccountStore, type PendingLogin, type SavedAccount } from '../core/account/session';
import type { AccountView } from '../shared/protocol';
import { OPEN_ONCE_WINDOW_MS, openExternalOnce } from '../core/host/openOnce'; // (lane:customer-bugs)
import type { SecretsLike } from './chrome';
import type { ConfigService } from './config';

const KEY_SESSION = 'account.session';
const KEY_PENDING = 'account.pending';
/** Phải khớp danh sách cho phép trong ext_private.redirect_ok (SQL) — scheme khác thì dùng chế độ dán mã. */
const KNOWN_SCHEMES = new Set(['vscode', 'vscode-insiders', 'vscodium', 'code-oss', 'cursor', 'windsurf', 'positron', 'kiro', 'trae', 'void', 'antigravity']);
const EXT_AUTHORITY = 'locaithai.locaith-agent';

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Kho SecretStorage cho phiên + lần đăng nhập đang chờ. Dữ liệu đọc ra được kiểm hình dạng (kho có thể bị sửa/hỏng). */
export function accountSecretStore(s: SecretsLike, registerSecret?: (v: string) => void): AccountStore {
  const read = async <T>(key: string, ok: (j: any) => j is T): Promise<T | null> => {
    try {
      const raw = await s.get(key);
      const j = raw ? JSON.parse(raw) : null;
      return ok(j) ? j : null;
    } catch {
      return null;
    }
  };
  const isUser = (u: any): u is AccountUser => !!u && str(u.id, 64) && typeof u.email === 'string' && typeof u.name === 'string';
  const isDevice = (d: any): d is AccountDevice => !!d && str(d.id, 64) && typeof d.label === 'string';
  const isSaved = (j: any): j is SavedAccount => !!j && typeof j.token === 'string' && /^lat_[A-Za-z0-9_-]{43}$/.test(j.token) && isDevice(j.device) && isUser(j.user) && Number.isFinite(j.verifiedAt);
  const isPending = (j: any): j is PendingLogin => !!j && str(j.verifier, 128) && str(j.state, 64) && Number.isFinite(j.startedAt) && typeof j.manual === 'boolean';
  return {
    load: () => read(KEY_SESSION, isSaved),
    async save(a) {
      if (a) {
        registerSecret?.(a.token);
        await s.set(KEY_SESSION, JSON.stringify(a));
      } else await s.delete(KEY_SESSION);
    },
    loadPending: () => read(KEY_PENDING, isPending),
    async savePending(p) {
      if (p) {
        registerSecret?.(p.verifier);
        await s.set(KEY_PENDING, JSON.stringify(p));
      } else await s.delete(KEY_PENDING);
    },
  };
}

/** Phần ChatController/RemoteService cần biết về tài khoản (để thay bằng đồ giả khi kiểm thử đơn vị). */
export interface AccountGate {
  /** Đã đăng nhập (kể cả đang trong thời gian ân hạn mất mạng) → được dùng extension. */
  readonly usable: boolean;
  view(): AccountView;
  onChange(cb: () => void): vscode.Disposable;
  signIn(opts?: { manual?: boolean }): Promise<void>;
  cancel(): void;
  signOut(): Promise<void>;
  enterCode(code?: string): Promise<void>;
  manage(): Promise<void>;
  /** Token thiết bị cho các lời gọi tới dịch vụ tài khoản (báo danh máy). */
  token(): string | undefined;
  /** Id ổn định của tài khoản đang đăng nhập (khoá bản đệm «đã đồng ý thông báo dữ liệu» của mô hình Locaith). */
  userId?(): string | undefined;
  /** Hỏi lại máy chủ xem token còn hiệu lực không (cổng Locaith vừa trả 401). Bị thu hồi → phiên chuyển «expired» và extension khoá lại. Có giới hạn tần suất. */
  recheck?(): Promise<void>;
  readonly client: AccountClient;
  readonly cfg: AccountConfig;
}

export interface AccountDeps {
  config: ConfigService;
  secrets: SecretsLike;
  version: string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  registerSecret?: (v: string) => void;
  /** Kiểm thử: ghi đè cấu hình/khách. */
  cfg?: AccountConfig;
  client?: AccountClient;
}

export class AccountService implements AccountGate, vscode.Disposable {
  readonly session: AccountSession;
  readonly cfg: AccountConfig;
  readonly client: AccountClient;
  /** Chỉ kiểm thử (ND_AGENT_TEST=1): URL đăng nhập gần nhất thay vì mở trình duyệt thật. */
  lastLoginUrl?: string;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subs: vscode.Disposable[] = [];
  private readonly status$: vscode.StatusBarItem;
  private readonly testMode = process.env.ND_AGENT_TEST === '1';
  private lastStatus: AccountState['status'] = 'signedOut';
  private lastFocusVerify = 0;
  private signInAt = -Infinity;

  constructor(private readonly d: AccountDeps) {
    this.cfg = d.cfg ?? resolveAccountConfig();
    this.client = d.client ?? new AccountClient(this.cfg);
    this.session = new AccountSession({
      client: this.client,
      store: accountSecretStore(d.secrets, d.registerSecret),
      webUrl: this.cfg.webUrl,
      redirectUri: () => `${KNOWN_SCHEMES.has(vscode.env.uriScheme) ? vscode.env.uriScheme : 'vscode'}://${EXT_AUTHORITY}/auth`,
      deviceLabel: () => this.deviceLabel(),
      meta: () => this.meta(),
      openUrl: async (url) => {
        if (this.testMode) {
          this.lastLoginUrl = url;
          return;
        }
        await openExternalOnce(url, (x) => vscode.env.openExternal(vscode.Uri.parse(x)));
      },
      log: d.log,
    });
    this.status$ = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.status$.command = 'locaithAgent.account.signIn';
    this.subs.push(
      this.status$,
      this.changed,
      vscode.window.registerUriHandler({ handleUri: (uri) => this.onUri(uri) }),
      vscode.commands.registerCommand('locaithAgent.account.signIn', () => this.signIn()),
      vscode.commands.registerCommand('locaithAgent.account.signOut', () => this.signOut()),
      vscode.commands.registerCommand('locaithAgent.account.enterCode', () => this.enterCode()),
      vscode.commands.registerCommand('locaithAgent.account.manage', () => this.manage()),
      vscode.window.onDidChangeWindowState((s) => {
        // Thu hồi từ trang web có hiệu lực sớm khi người dùng quay lại VS Code — nhưng không hỏi máy chủ mỗi lần lấy lại tiêu điểm (tối đa 5 phút/lần).
        if (s.focused && Date.now() - this.lastFocusVerify > 5 * 60_000) {
          this.lastFocusVerify = Date.now();
          void this.session.verify().catch(() => undefined);
        }
      }),
    );
    const off = this.session.onChange((s) => this.onState(s));
    this.subs.push({ dispose: off });
    this.refreshStatusBar();
  }

  /** Khi kích hoạt: nạp phiên đã lưu và xác minh (không chặn khởi động — mất mạng vẫn vào được trong thời gian ân hạn). */
  async init(): Promise<void> {
    await this.session.init();
  }

  /** Cửa sổ khác vừa đăng nhập/đăng xuất (SecretStorage đổi) → đồng bộ trạng thái. */
  async reload(): Promise<void> {
    await this.session.reload();
  }

  private vi(): boolean {
    return this.d.config.language() === 'vi';
  }

  get usable(): boolean {
    return this.session.usable;
  }

  token(): string | undefined {
    return this.session.token;
  }

  userId(): string | undefined {
    return this.session.user?.id;
  }

  // ── (lane:gateway-client) token thiết bị cho cổng Locaith: nhãn chẩn đoán + làm mới khi 401 ──
  deviceId(): string | undefined {
    return this.session.deviceId;
  }

  refreshToken(stale: string): Promise<string | undefined> {
    return this.session.refreshToken(stale).catch(() => undefined);
  }

  expireToken(token: string): Promise<void> {
    return this.session.expireToken(token).catch(() => undefined);
  }

  private lastRecheck = 0;

  /** Cổng Locaith trả 401 cho token này: kiểm tra lại với máy chủ tài khoản ngay (không đợi chu kỳ 30 phút). Tối đa một lần mỗi 10 giây dù có nhiều lượt gọi lỗi cùng lúc (agent con). */
  async recheck(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRecheck < 10_000) return;
    this.lastRecheck = now;
    await this.session.verify(true).catch(() => undefined);
  }

  onChange(cb: () => void): vscode.Disposable {
    return this.changed.event(() => cb());
  }

  view(): AccountView {
    const s = this.session.state;
    const user = this.session.user;
    return {
      status: s.status,
      ...(user ? { user: { name: user.name, email: user.email, avatar: user.avatar } } : {}),
      ...(s.status === 'signedIn' && s.offline ? { offline: true } : {}),
      ...(s.status === 'signedOut' && s.error ? { error: s.error } : {}),
      ...(s.status === 'expired' ? { reason: s.reason } : {}),
      ...(s.status === 'signingIn' && s.manual ? { manual: true } : {}),
      webUrl: this.cfg.webUrl,
    };
  }

  // ── nhãn & mô tả máy (tự khai — chỉ để hiển thị) ─────────────────────────
  private deviceLabel(): string {
    const clean = (v: string) => v.replace(/[^A-Za-z0-9 ._()-]/g, '').replace(/\s+/g, ' ').trim();
    const host = clean(os.hostname()) || 'May';
    const app = clean(vscode.env.appName.replace(/^Visual Studio Code/, 'VS Code')) || 'VS Code';
    return `${host} · ${app}`.replace(/·/g, '-').slice(0, 60);
  }

  private meta(): ClientMeta {
    return { client: 'vscode', platform: process.platform, app: vscode.env.appName, vscode: vscode.version, ext: this.d.version };
  }

  // ── thao tác ──────────────────────────────────────────────────────────────
  async signIn(opts: { manual?: boolean } = {}): Promise<void> {
    if (this.session.state.status === 'signedIn') return;
    // (lane:customer-bugs) Bấm «Đăng nhập» hai lần liên tiếp = hai tab trình duyệt, và lần sau ghi đè state của lần trước (tab đầu sẽ hỏng): chỉ nhận một lần trong cửa sổ ngắn.
    if (Date.now() - this.signInAt < OPEN_ONCE_WINDOW_MS) return;
    this.signInAt = Date.now();
    const manual = opts.manual ?? (vscode.env.uiKind === vscode.UIKind.Web || !KNOWN_SCHEMES.has(vscode.env.uriScheme));
    let url: string;
    try {
      ({ url } = await this.session.startLogin({ manual }));
    } catch (err) {
      this.d.log('warn', `Đăng nhập: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (this.testMode) return;
    const vi = this.vi();
    const again = vi ? 'Mở lại trang đăng nhập' : 'Reopen sign-in page';
    const code = vi ? 'Dán mã' : 'Paste code';
    const copy = vi ? 'Sao chép liên kết' : 'Copy link';
    void vscode.window
      .showInformationMessage(
        vi
          ? 'Đã mở trình duyệt để đăng nhập tài khoản Locaith. Bấm «Cho phép» rồi quay lại VS Code. Không thấy trình duyệt? Mở lại hoặc sao chép liên kết; nếu trình duyệt không tự chuyển về VS Code được, bấm «Dán mã».'
          : 'Opened your browser to sign in with your Locaith account. Click “Allow”, then return to VS Code. No browser? Reopen or copy the link; if the browser cannot return to VS Code, choose “Paste code”.',
        again,
        code,
        copy,
      )
      .then(async (pick) => {
        if (pick === again) await openExternalOnce(url, (x) => vscode.env.openExternal(vscode.Uri.parse(x)));
        else if (pick === code) await this.enterCode();
        else if (pick === copy) await vscode.env.clipboard.writeText(url);
      });
  }

  cancel(): void {
    this.session.cancelLogin();
  }

  async signOut(): Promise<void> {
    await this.session.logout();
  }

  /** Dán mã đăng nhập (khi trình duyệt không chuyển về VS Code được). */
  async enterCode(code?: string): Promise<void> {
    const vi = this.vi();
    if (this.session.state.status !== 'signingIn') await this.signIn({ manual: true });
    let value = code;
    if (value === undefined) {
      value = await vscode.window.showInputBox({
        title: vi ? 'Đăng nhập Locaith — dán mã' : 'Locaith sign-in — paste code',
        prompt: vi ? 'Dán mã hiện trên trang locaith.ai sau khi bấm «Cho phép» (hoặc cả đường dẫn vscode://…).' : 'Paste the code shown on locaith.ai after you click “Allow” (or the whole vscode://… link).',
        ignoreFocusOut: true,
        password: true,
      });
    }
    if (!value) return;
    this.report(await this.session.submitCode(value));
  }

  async manage(): Promise<void> {
    const url = `${this.cfg.webUrl}/#remote`;
    if (this.testMode) {
      this.lastLoginUrl = url;
      return;
    }
    await openExternalOnce(url, (x) => vscode.env.openExternal(vscode.Uri.parse(x)));
  }

  /** Trình duyệt chuyển về vscode://locaithai.locaith-agent/auth?code=…&state=… */
  async onUri(uri: vscode.Uri): Promise<void> {
    if (!/^\/?auth\/?$/.test(uri.path)) return;
    const q = new URLSearchParams(uri.query);
    this.report(await this.session.handleCallback({ code: q.get('code'), state: q.get('state'), error: q.get('error') }));
  }

  private report(r: { ok: true } | { ok: false; error: string }): void {
    if (this.testMode) return;
    const vi = this.vi();
    if (r.ok) {
      const u = this.session.user;
      void vscode.window.showInformationMessage(vi ? `Đã đăng nhập Locaith${u?.email ? ` (${u.email})` : ''}.` : `Signed in to Locaith${u?.email ? ` (${u.email})` : ''}.`);
      void vscode.commands.executeCommand('locaithAgent.focus');
      return;
    }
    const msg: Record<string, [string, string]> = {
      denied: ['Bạn đã từ chối đăng nhập trên trang locaith.ai.', 'You declined the sign-in on locaith.ai.'],
      no_pending: ['Không có lần đăng nhập nào đang chờ hoặc đã quá 10 phút. Hãy bấm Đăng nhập lại.', 'No sign-in is pending or it timed out (10 min). Please sign in again.'],
      state_mismatch: ['Liên kết đăng nhập không khớp với yêu cầu của VS Code này — đã bỏ qua. Nếu bạn vừa bấm đăng nhập, hãy thử lại.', 'The sign-in link does not match this VS Code request — ignored. If you just started a sign-in, try again.'],
      invalid_grant: ['Mã đăng nhập sai, đã dùng hoặc hết hạn (5 phút). Hãy đăng nhập lại.', 'The sign-in code is wrong, already used or expired (5 min). Please sign in again.'],
      network: ['Không kết nối được máy chủ Locaith. Kiểm tra mạng rồi bấm Đăng nhập lại (mã còn hiệu lực 5 phút).', 'Could not reach the Locaith server. Check your network and try again (the code stays valid for 5 minutes).'],
      server: ['Máy chủ Locaith trả lỗi. Thử lại sau ít phút.', 'The Locaith server returned an error. Try again in a few minutes.'],
      bad_code: ['Mã không đúng định dạng.', 'That does not look like a sign-in code.'],
    };
    const m = msg[r.error] ?? ['Đăng nhập thất bại.', 'Sign-in failed.'];
    void vscode.window.showWarningMessage(vi ? m[0] : m[1]);
  }

  // ── phản ứng khi trạng thái đổi ───────────────────────────────────────────
  private onState(s: AccountState): void {
    const prev = this.lastStatus;
    this.lastStatus = s.status;
    this.refreshStatusBar();
    this.changed.fire();
    if (this.testMode || prev === s.status) return;
    if (s.status === 'expired' && prev === 'signedIn') {
      const vi = this.vi();
      const again = vi ? 'Đăng nhập lại' : 'Sign in again';
      void vscode.window
        .showWarningMessage(
          s.reason === 'revoked'
            ? vi ? 'Phiên đăng nhập Locaith đã bị thu hồi hoặc hết hạn. Hãy đăng nhập lại để tiếp tục dùng trợ lý.' : 'Your Locaith session was revoked or has expired. Sign in again to keep using the assistant.'
            : vi ? 'Đã hơn 7 ngày không xác minh được phiên đăng nhập Locaith (mất mạng?). Hãy kết nối mạng rồi đăng nhập lại.' : 'Your Locaith session could not be verified for over 7 days (offline?). Connect and sign in again.',
          again,
        )
        .then((pick) => {
          if (pick === again) void this.signIn();
        });
    }
  }

  private refreshStatusBar(): void {
    if (this.session.usable) {
      this.status$.hide();
      return;
    }
    const vi = this.vi();
    const s = this.session.state;
    this.status$.text = s.status === 'signingIn' ? `$(sync~spin) ${vi ? 'Đang chờ đăng nhập…' : 'Waiting for sign-in…'}` : `$(account) ${vi ? 'Đăng nhập Locaith' : 'Sign in to Locaith'}`;
    this.status$.tooltip = vi ? 'Locaith AI cần đăng nhập tài khoản locaith.ai để hoạt động. Bấm để đăng nhập.' : 'Locaith AI needs you to sign in with your locaith.ai account. Click to sign in.';
    this.status$.backgroundColor = s.status === 'expired' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.status$.show();
  }

  dispose(): void {
    this.session.dispose();
    for (const s of this.subs) s.dispose();
  }
}
