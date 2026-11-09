/**
 * Remote cho Locaith CLI — điều khiển phiên CLI đang chạy từ trang locaith.ai (điện thoại / máy khác), như extension VS Code.
 *
 * DÙNG CHUNG LÕI với extension (không viết lại): `RemoteServer` (luồng sự kiện + vòng đệm nối lại), `RelayHost` (bắt tay + mã hoá đầu-cuối + ghép đôi + tin cậy theo tài khoản),
 * `RealtimeLink` (Supabase Realtime), `toRemoteState`/`sanitizeEvents` (rút gọn trước khi gửi), `AccountClient` (báo danh máy lên danh bạ tài khoản). Phần riêng của CLI chỉ là
 * «cái nối»: đọc trạng thái từ `CliRuntime`, đẩy sự kiện của runtime ra luồng, và biến lệnh từ xa thành lời gọi runtime — qua bộ lọc `vetRemoteSend` (không cho `!shell`).
 *
 * Mô hình tin cậy (giống extension, xem docs/REMOTE-RELAY.md): bí mật nằm ở tên kênh (mã máy 128 bit) và ở mã hoá đầu-cuối; relay chỉ thấy bản mã. «Tin cậy theo tài khoản»: máy sinh một
 * khoá tài khoản 128 bit, báo lên danh bạ (`ext_host_upsert`) — chỉ CHÍNH chủ tài khoản đọc lại được qua `ext_hosts_list` — nên trình duyệt đăng nhập đúng tài khoản mở được máy mà
 * không cần ghép đôi. Không có tài khoản (chỉ dùng khoá hãng khác): Remote không chạy.
 *
 * Mặc định TẮT (extension thì bật sẵn): bật bằng `/remote` hoặc `locaith --remote`. Không import `vscode`, không import giao diện: kiểm thử được bằng relay giả.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { AccountClient, type ClientMeta } from '../../core/account/client';
import { resolveAccountConfig, type AccountConfig } from '../../core/account/config';
import { accountLink } from '../../core/remote/accountLink';
import { b64u, pairingLink, topicOf } from '../../core/remote/e2e';
import { RealtimeLink } from '../../core/remote/phoenix';
import { REMOTE_API_VERSION, type RemoteCommand, type RemoteHostInfo, type RemoteState } from '../../core/remote/protocol';
import type { QueueState } from '../../core/remote/queue';
import { RelayHost, type PairRequest, type RelayLink, type RelayStatus } from '../../core/remote/relayHost';
import { remoteProviders, sanitizeEvents, toRemoteState } from '../../core/remote/sanitize';
import { RemoteServer, type RemoteBackend } from '../../core/remote/server';
import { nodeSocket } from '../../core/remote/wsNode';
import type { PermissionMode, TItem, ThinkingLevel, UiEvent, ViewState } from '../../shared/protocol';
import { applyEvent } from '../../shared/transcript';
import type { CliRuntime, RuntimeEvent, RuntimeStatus } from '../runtime/contract';
import { vetRemoteSend } from './commands';
import { RemoteFileStore } from './store';

/** Báo danh máy lên danh bạ mỗi chừng này (như extension). */
const REGISTER_EVERY_MS = 5 * 60_000;
/** Đẩy snapshot mới (đổi phiên/model/chế độ…) nhiều nhất mỗi chừng này. */
const SNAPSHOT_MIN_GAP_MS = 400;
/** Báo chủ máy có trình duyệt «tài khoản» vừa vào: tối đa một lần mỗi chừng này. */
const ACCOUNT_NOTICE_GAP_MS = 60_000;

export type RemoteLinkState = 'off' | 'connecting' | 'online' | 'queued';

export interface CliRemoteView {
  /** Đã bật (đang chạy) hay không. */
  on: boolean;
  /** Đường truyền Internet. */
  link: RemoteLinkState;
  /** Số phiên trình duyệt đang mở. */
  sessions: number;
  /** Danh bạ tài khoản ĐÃ giữ khoá → trang locaith.ai mở được máy bằng tài khoản (không cần ghép đôi). */
  keyed: boolean;
  /** Đang mở cửa sổ ghép đôi (chờ trình duyệt). */
  pairing: boolean;
  hostId?: string;
  queue?: QueueState;
  /** Lý do không bật được (thiếu tài khoản…), tiếng Việt/Anh theo `lang`. */
  problem?: string;
}

export interface CliRemoteDeps {
  rt: CliRuntime;
  home: string;
  cwd: string;
  version: string;
  lang: () => 'vi' | 'en';
  env?: NodeJS.ProcessEnv;
  /** Token thiết bị `lat_…` của tài khoản Locaith (cùng token CLI dùng gọi cổng mô hình). undefined = chưa đăng nhập. */
  token: () => string | undefined;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /** Hỏi người ngồi ở máy có cho thiết bị mới ghép đôi không (hiện mã SAS). Mặc định từ chối — KHÔNG BAO GIỜ tự cho phép. */
  approve?: (r: PairRequest) => Promise<boolean>;
  /** Mở trình duyệt. Trả false nếu không mở được. */
  openUrl?: (url: string) => boolean | Promise<boolean>;
  /** Đường truyền relay tuỳ chọn (kiểm thử: relay giả). Mặc định Supabase Realtime thật. */
  createLink?: (topic: string, cfg: AccountConfig) => RelayLink;
  /** Địa chỉ dịch vụ tài khoản (kiểm thử trỏ vào máy chủ giả; ngoài kiểm thử luôn dùng địa chỉ thật). */
  accountConfig?: AccountConfig;
  fetchImpl?: typeof fetch;
  /** Cho phép lệnh từ xa đổi sang chế độ bỏ qua mọi xác nhận. Mặc định: tắt. */
  allowBypass?: () => boolean;
  /** Thông báo cho giao diện: `info` = dòng một lần (có trình duyệt vừa vào…), `warn` = cảnh báo. */
  notify?: (level: 'info' | 'warn', text: string) => void;
  /** Báo khi trạng thái hiển thị đổi (dải trạng thái vẽ lại). */
  onChange?: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

/** Hậu tố phân biệt CLI với VS Code trên cùng máy; nhãn dài quá giới hạn của máy chủ (60) thì CẮT PHẦN TÊN MÁY, không bao giờ cắt hậu tố. */
const LABEL_SUFFIX = ' · CLI';
/**
 * Tên hiển thị của máy trên locaith.ai: «<hostname> · CLI» (≤ 60 ký tự, bỏ ký tự lạ). Hostname thật hay dài (máy CI: `sjc22-bm211-388cc323-…`) nên phải
 * cắt phần tên trước — trước đây cắt cả chuỗi, làm mất « · CLI» và máy hiện trên trang không phân biệt được với VS Code.
 */
export function machineLabel(host: string = os.hostname()): string {
  const clean = host.replace(/[^A-Za-z0-9 ._()-]/g, '').replace(/\s+/g, ' ').trim() || 'May';
  const room = 60 - LABEL_SUFFIX.length;
  const name = clean.length > room ? clean.slice(0, room).trimEnd() : clean;
  return `${name}${LABEL_SUFFIX}`;
}

/** Phần mô tả máy gửi lên danh bạ (máy chủ chỉ giữ vài trường, cắt 24–40 ký tự; chỉ để hiển thị, không dùng phân quyền). */
export function hostMeta(version: string, platform: string = process.platform): ClientMeta {
  return { client: 'cli', platform, app: `Locaith CLI ${version}` };
}

export class CliRemote {
  private readonly o: CliRemoteDeps;
  private readonly store: RemoteFileStore;
  private readonly cfg: AccountConfig;
  private readonly account: AccountClient;
  readonly server: RemoteServer;
  private host?: RelayHost;
  private link?: RelayLink;
  private hostId = '';
  private acctKey: string | null = null;
  private acctUser: string | undefined;
  private keyed = false;
  private running = false;
  private problem: string | undefined;
  private timer?: ReturnType<typeof setInterval>;
  private offRt?: () => void;
  private offQueue?: () => void;
  private starting?: Promise<boolean>;
  private registering: Promise<unknown> = Promise.resolve();
  private snapTimer?: ReturnType<typeof setTimeout>;
  private snapLast = 0;
  private lastAccountNotice = 0;
  /** Hội thoại do chính CliRemote giữ (áp từng sự kiện UI): `Runtime` không công khai transcript qua hợp đồng nên không đọc lại được khi trình duyệt mới vào. */
  private transcript: TItem[] = [];
  private view$: Pick<RuntimeStatus, 'sessionId' | 'title'> = { sessionId: '', title: '' };
  private readonly changeCbs = new Set<() => void>();

  constructor(o: CliRemoteDeps) {
    this.o = o;
    this.store = new RemoteFileStore(o.home);
    this.cfg = o.accountConfig ?? resolveAccountConfig(o.env ?? process.env);
    this.account = new AccountClient(this.cfg, { ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}), timeoutMs: 12_000 });
    const backend: RemoteBackend = {
      info: () => this.info(),
      prepare: async () => {},
      state: () => this.snapshot(),
      command: (device, cmd) => this.onCommand(device, cmd),
    };
    this.server = new RemoteServer(this.store, backend, {
      ports: [], // chỉ relay: CLI không mở cổng HTTP cục bộ (không có trang nào nói chuyện qua 127.0.0.1 với CLI)
      allowedOrigins: () => [],
      canBypass: () => this.allowBypass(),
      log: (l, m) => this.log(l, m),
      onChange: () => this.changed(),
    });
  }

  // ── nhỏ gọn ──
  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
    this.o.log?.(level, msg);
  }
  private vi(): boolean {
    return this.o.lang() === 'vi';
  }
  /** Remote được đổi sang «Bỏ qua mọi xác nhận» chỉ khi người ngồi ở máy cho phép (cài đặt `remote.allowBypass`) — mặc định KHÔNG. */
  private allowBypass(): boolean {
    return this.o.allowBypass?.() === true;
  }
  private changed(): void {
    for (const cb of [...this.changeCbs]) {
      try {
        cb();
      } catch {
        /* người nghe lỗi không được làm hỏng Remote */
      }
    }
    this.o.onChange?.();
  }
  onChange(cb: () => void): () => void {
    this.changeCbs.add(cb);
    return () => void this.changeCbs.delete(cb);
  }

  /** Mô tả máy cho trang web. Trang hiện «VS Code {vscode} · Locaith AI {ext}»: CLI khai `vscode: 'terminal'` thay vì bịa số phiên bản VS Code. */
  private info(): RemoteHostInfo {
    return { name: os.hostname(), workspace: path.basename(this.o.cwd) || undefined, vscode: 'terminal', ext: this.o.version, platform: process.platform } as RemoteHostInfo;
  }

  // ── trạng thái hiển thị ──
  view(): CliRemoteView {
    const h = this.host;
    const q = this.link?.queue ?? undefined;
    const link: RemoteLinkState = !this.running || !h ? 'off' : q && h.status !== 'online' ? 'queued' : h.status === 'online' ? 'online' : 'connecting';
    return {
      on: this.running,
      link,
      sessions: h?.sessionCount ?? 0,
      keyed: this.keyed,
      pairing: !!h?.pairingState,
      ...(this.hostId ? { hostId: this.hostId } : {}),
      ...(q ? { queue: q } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  get isOn(): boolean {
    return this.running;
  }

  // ── bật / tắt ──
  /**
   * Bật Remote. Trả `ok` + lý do nếu không bật được. Cần: token tài khoản (để báo danh máy và sinh khoá); không có thì Remote không có nghĩa
   * (trang locaith.ai không biết máy nào) — nói thẳng thay vì chạy mà không ai vào được.
   */
  start(): Promise<{ ok: true } | { ok: false; reason: 'no_account' | 'not_trusted' | 'failed'; detail?: string }> {
    this.starting ??= this.doStart().finally(() => (this.starting = undefined)) as Promise<boolean>;
    return this.starting.then(
      () => (this.running ? { ok: true as const } : { ok: false as const, reason: 'failed' as const, ...(this.problem ? { detail: this.problem } : {}) }),
      (err) => ({ ok: false as const, reason: 'failed' as const, detail: err instanceof Error ? err.message : String(err) }),
    );
  }

  private async doStart(): Promise<boolean> {
    if (this.running) return true;
    const token = this.o.token();
    if (!token) {
      this.problem = this.vi() ? 'Chưa đăng nhập tài khoản Locaith (chạy /login). Remote cần tài khoản để trang locaith.ai biết máy này.' : 'Not signed in to a Locaith account (run /login). Remote needs the account so locaith.ai knows this machine.';
      this.changed();
      return false;
    }
    this.problem = undefined;
    this.hostId = this.store.hostId(this.o.cwd);
    const who = await this.account.whoami(token);
    if (!who.ok) {
      this.problem =
        who.error === 'invalid_token'
          ? this.vi()
            ? 'Phiên đăng nhập Locaith không còn hiệu lực — chạy /login lại.'
            : 'Your Locaith sign-in is no longer valid — run /login again.'
          : this.vi()
            ? 'Không tới được máy chủ tài khoản Locaith (kiểm tra mạng).'
            : 'Could not reach the Locaith account server (check your network).';
      this.changed();
      return false;
    }
    this.acctUser = who.user.id;
    this.acctKey = this.store.ensureAccountKey(this.hostId, who.user.id);
    const topic = topicOf(this.hostId);
    const link: RelayLink = this.o.createLink?.(topic, this.cfg) ?? new RealtimeLink({ baseUrl: this.cfg.supabaseUrl, apikey: this.cfg.anonKey, topic, createSocket: nodeSocket, log: (l, m) => this.log(l, m) });
    this.link = link;
    this.attachRuntime();
    const host = new RelayHost({
      hostId: this.hostId,
      server: this.server,
      link,
      approve: (r) => (this.o.approve ? this.o.approve(r) : Promise.resolve(false)),
      // Hiện diện công khai trên kênh: KHÔNG tên máy/thư mục (xem extension). `epoch` đổi khi host khởi động lại → trình duyệt bắt tay lại ngay.
      presence: () => ({ v: 1, epoch: this.server.currentEpoch }),
      log: (l, m) => this.log(l, m),
      onChange: () => this.changed(),
      // Đọc lại mỗi lần bắt tay: xoay khoá / tắt có hiệu lực ngay.
      accountKey: () => this.acctKey,
      onAccountSession: () => this.noticeAccountSession(),
    });
    this.host = host;
    this.offQueue = link.onQueue?.(() => this.changed());
    this.running = true;
    this.timer = setInterval(() => void this.registerHost(), REGISTER_EVERY_MS);
    this.timer.unref?.();
    host.start();
    void this.registerHost();
    this.log('info', 'Remote qua Internet: đã bật (mã hoá đầu-cuối; tin cậy theo tài khoản).');
    this.changed();
    return true;
  }

  /** Tắt Remote = THU HỒI: xoá khoá tài khoản (lần bật sau dùng khoá MỚI) và gỡ máy khỏi danh bạ. */
  async stop(opts: { keepKey?: boolean } = {}): Promise<void> {
    const wasOn = this.running;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.offRt?.();
    this.offRt = undefined;
    this.offQueue?.();
    this.offQueue = undefined;
    if (this.snapTimer) clearTimeout(this.snapTimer);
    this.snapTimer = undefined;
    const host = this.host;
    this.host = undefined;
    host?.stop();
    this.link = undefined;
    this.keyed = false;
    if (wasOn && this.hostId) {
      const token = this.o.token();
      // Xếp vào CÙNG hàng với các lần báo danh để một lần báo danh còn dở không ghi lại hàng vừa gỡ.
      this.registering = this.registering.then(() => (token ? this.account.hostRemove(token, this.hostId).then(() => undefined, () => undefined) : undefined));
      await this.registering.catch(() => undefined);
      if (!opts.keepKey) this.store.dropAccountKey(this.hostId);
    }
    this.changed();
  }

  /** Dọn khi thoát CLI: ngắt đường truyền nhưng GIỮ khoá (mở lại cùng thư mục thì nối tiếp, như extension khi đóng VS Code). */
  async dispose(): Promise<void> {
    if (!this.running) return;
    const wasOn = this.running;
    await this.stop({ keepKey: true });
    void wasOn;
  }

  // ── báo danh máy ──
  private registerHost(): Promise<boolean> {
    const run = this.registering.then(() => this.doRegisterHost());
    this.registering = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doRegisterHost(): Promise<boolean> {
    const token = this.o.token();
    const hostId = this.hostId;
    if (!this.running || !token || !hostId) return false;
    const key = this.acctKey;
    const res = await this.account.hostUpsert(token, hostId, machineLabel(), path.basename(this.o.cwd) || undefined, hostMeta(this.o.version), key ?? '');
    if (!this.running) {
      // Đã tắt trong lúc chờ: đừng để hàng (và khoá) nằm lại trong danh bạ vì lần báo danh vừa xong chạy sau lần gỡ.
      await this.account.hostRemove(token, hostId).catch(() => undefined);
      return false;
    }
    if (!res.ok) {
      this.log('debug', `Remote: báo danh máy thất bại (${res.error})`);
      if (res.error === 'invalid_token') {
        this.problem = this.vi() ? 'Phiên đăng nhập Locaith hết hiệu lực — chạy /login lại, rồi /remote.' : 'Your Locaith sign-in expired — run /login again, then /remote.';
        this.changed();
      }
      return false;
    }
    const keyed = !!key && res.keyed === true;
    if (this.keyed !== keyed) {
      this.keyed = keyed;
      this.changed();
    }
    return keyed;
  }

  /** Có trình duyệt «tài khoản» vừa mở phiên: báo NGAY cho người ngồi ở máy (tối đa mỗi phút một lần). */
  private noticeAccountSession(): void {
    const now = Date.now();
    if (now - this.lastAccountNotice < ACCOUNT_NOTICE_GAP_MS) return;
    this.lastAccountNotice = now;
    this.o.notify?.(
      'warn',
      this.vi()
        ? 'Một trình duyệt đăng nhập cùng tài khoản Locaith vừa mở phiên CLI này từ xa. Không phải bạn? Gõ /remote off để ngắt ngay, rồi đổi mật khẩu tài khoản.'
        : 'A browser signed in to the same Locaith account just opened this CLI session remotely. Not you? Type /remote off to cut it right away, then change your account password.',
    );
  }

  // ── mở trang trên locaith.ai ──
  /**
   * Địa chỉ để mở: vào bằng tài khoản (không ghép đôi) nếu danh bạ đã giữ khoá, không thì liên kết ghép đôi một lần (bí mật 128 bit sau dấu #, không gửi lên máy chủ nào).
   * Phải gọi sau `start()`. Trả undefined nếu chưa bật.
   */
  async webUrl(): Promise<{ url: string; mode: 'account' | 'pairing' } | undefined> {
    const host = this.host;
    if (!this.running || !host) return undefined;
    // Chờ vào kênh tối đa 8 giây để trang vừa mở là vào được ngay; relay quá tải thì khỏi chờ.
    const t0 = Date.now();
    while (host.status !== 'online' && !this.link?.queue && Date.now() - t0 < 8000) await sleep(100);
    if (this.acctKey && (this.keyed || (await this.registerHost()))) return { url: accountLink(this.cfg.webUrl, this.hostId), mode: 'account' };
    const { psk } = host.startPairing();
    return { url: pairingLink(this.cfg.webUrl, { hostId: this.hostId, psk, name: os.hostname() }), mode: 'pairing' };
  }

  async openWeb(): Promise<{ ok: boolean; url?: string; mode?: 'account' | 'pairing'; opened: boolean }> {
    const w = await this.webUrl();
    if (!w) return { ok: false, opened: false };
    let opened = false;
    try {
      opened = (await this.o.openUrl?.(w.url)) === true;
    } catch {
      opened = false;
    }
    return { ok: true, url: w.url, mode: w.mode, opened };
  }

  /** «Đổi khoá tài khoản»: khoá mới → mọi trình duyệt đang vào bằng tài khoản bị ngắt (trang nào còn đăng nhập đúng tài khoản tự lấy khoá mới và vào lại). */
  async rotateKey(): Promise<boolean> {
    if (!this.running || !this.acctUser || !this.host) return false;
    const before = this.acctKey;
    const key = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const prevKeyed = this.keyed;
    // Thứ tự như extension: lưu khoá mới → báo lên danh bạ → (chỉ khi danh bạ đã nhận) đổi khoá của máy và cắt phiên cũ. Cắt trước khi danh bạ có khoá mới thì trình duyệt tự chữa
    // có thể đọc lại khoá CŨ và kẹt ở «đang nối lại».
    this.store.setAccountKey(this.hostId, this.acctUser, key);
    this.acctKey = key;
    this.keyed = false;
    const ok = await this.registerHost();
    if (!ok) {
      if (before) {
        this.store.setAccountKey(this.hostId, this.acctUser, before);
        this.acctKey = before;
      }
      this.keyed = prevKeyed;
      this.changed();
      return false;
    }
    this.host.closeAccountSessions();
    this.changed();
    return true;
  }

  /** Bắt đầu cửa sổ ghép đôi 5 phút (cho thiết bị KHÔNG đăng nhập tài khoản này). Trả liên kết. */
  startPairing(): { url: string; expiresAt: number } | undefined {
    if (!this.running || !this.host) return undefined;
    const { psk, expiresAt } = this.host.startPairing();
    return { url: pairingLink(this.cfg.webUrl, { hostId: this.hostId, psk, name: os.hostname() }), expiresAt };
  }

  /** Thử vào lại relay ngay khi đang xếp hàng vì quá tải. */
  retryNow(): boolean {
    return this.link?.retryNow?.() ?? false;
  }

  // ── runtime → luồng sự kiện ──
  private attachRuntime(): void {
    const rt = this.o.rt;
    const st = rt.status();
    this.view$ = { sessionId: st.sessionId, title: st.title };
    this.offRt?.();
    this.offRt = rt.on((e) => this.onRuntimeEvent(e));
  }

  private onRuntimeEvent(e: RuntimeEvent): void {
    if (!this.running) return;
    switch (e.t) {
      case 'ui': {
        const ev: UiEvent = e.ev;
        try {
          this.transcript = applyEvent(this.transcript, ev);
        } catch {
          /* sự kiện lạ không được làm hỏng Remote */
        }
        const evs = sanitizeEvents([ev]);
        if (evs.length) this.server.publish('events', { events: evs });
        // Đổi chế độ/model/tiêu đề… đi qua `status`; `agent_progress` bị lọc khỏi luồng nên cần snapshot làm mới để trang thấy agent con đang làm gì.
        if (ev.t === 'agent_progress') this.scheduleSnapshot();
        return;
      }
      case 'replay':
        // Mở lại / rẽ nhánh / quay lại / phiên mới / xoá: hội thoại bị DỰNG LẠI → trình duyệt cần snapshot mới (không áp tăng dần được).
        this.transcript = [...e.items];
        this.publishSnapshot();
        return;
      case 'status':
        this.view$ = { sessionId: e.status.sessionId, title: e.status.title };
        this.scheduleSnapshot();
        return;
      case 'toast':
        this.server.publish('toast', { level: e.level, text: e.text.slice(0, 300) });
        return;
      default:
        return; // permission/ask/output/action: chỉ có nghĩa ở terminal (thẻ xin quyền đi qua `ui:tool_permission`)
    }
  }

  private scheduleSnapshot(): void {
    if (this.snapTimer) return;
    const wait = Math.max(0, SNAPSHOT_MIN_GAP_MS - (Date.now() - this.snapLast));
    this.snapTimer = setTimeout(() => {
      this.snapTimer = undefined;
      this.publishSnapshot();
    }, wait);
    this.snapTimer.unref?.();
  }

  private publishSnapshot(): void {
    if (!this.running) return;
    this.snapLast = Date.now();
    this.server.publish('snapshot', { state: this.snapshot() });
  }

  /** Ảnh chụp đầy đủ cho trình duyệt (đồng bộ): hội thoại do ta giữ + trạng thái từ runtime. */
  snapshot(): RemoteState {
    const rt = this.o.rt;
    const s = rt.status();
    const view = viewStateFrom(s, this.transcript, rt);
    return toRemoteState(view, this.info(), { canBypass: this.allowBypass() });
  }

  // ── lệnh từ xa → runtime ──
  private async onCommand(device: { id: string; label: string }, cmd: RemoteCommand): Promise<void> {
    const rt = this.o.rt;
    this.log('info', `Remote: "${device.label}" → ${cmd.type}`);
    // Lệnh dài (gửi tin, thử lại, nén ngữ cảnh) không giữ yêu cầu chờ: tiến độ tới trình duyệt qua luồng sự kiện, lỗi tới qua toast.
    const background = (p: Promise<unknown>): void => {
      p.catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log('warn', `Remote: lệnh ${cmd.type} lỗi: ${msg}`);
        this.server.publish('toast', { level: 'error', text: msg.slice(0, 300) });
      });
    };
    switch (cmd.type) {
      case 'send': {
        const v = vetRemoteSend(cmd.text, { allowBypass: this.allowBypass() });
        if (!v.ok) {
          if (v.error !== 'empty') this.notifyBlocked(v.error);
          throw new Error(v.error);
        }
        this.notifyUse(device.label, this.vi() ? 'gửi tin nhắn' : 'sent a message');
        const attachments = (cmd.attachments ?? []).filter((a) => a.kind === 'image' && !!a.data).map((a) => ({ kind: 'image' as const, name: a.label || 'image', mediaType: a.mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: a.data as string }));
        background(rt.submit(v.text, { attachments }));
        return;
      }
      case 'stop':
        this.notifyUse(device.label, this.vi() ? 'bấm Dừng' : 'pressed Stop');
        rt.interrupt();
        return;
      case 'retry': {
        const last = [...this.transcript].reverse().find((i) => i.kind === 'user');
        if (!last || last.kind !== 'user' || !last.text.trim()) throw new Error('nothing_to_retry');
        const v = vetRemoteSend(last.text, { allowBypass: this.allowBypass() });
        if (!v.ok) throw new Error(v.error);
        background(rt.submit(v.text));
        return;
      }
      case 'compact':
        background(rt.submit('/compact'));
        return;
      case 'new_session':
        this.notifyUse(device.label, this.vi() ? 'mở phiên mới' : 'started a new session');
        await rt.newSession();
        return;
      case 'load_session':
        this.notifyUse(device.label, this.vi() ? 'mở một phiên cũ' : 'opened an earlier session');
        await rt.resume(cmd.id);
        return;
      case 'set_model':
        await rt.setModel(`${cmd.provider}:${cmd.model}`);
        return;
      case 'set_mode':
        this.notifyUse(device.label, this.vi() ? 'đổi chế độ quyền' : 'changed the permission mode');
        rt.setMode(cmd.mode as PermissionMode);
        return;
      case 'set_thinking':
        rt.setThinking(cmd.level as ThinkingLevel);
        return;
      case 'permission_response':
        this.notifyUse(device.label, this.vi() ? 'trả lời yêu cầu quyền' : 'answered a permission request');
        rt.respondPermission(cmd.id, { decision: cmd.decision, ...(cmd.feedback ? { feedback: cmd.feedback } : {}) });
        return;
      default:
        // rename/queue_remove/fork/pin/rewind/bg_task/swarm/get_image: chưa hỗ trợ trong CLI — nói thẳng để trang hiện thông báo, thay vì im lặng.
        throw new Error('unsupported_in_cli');
    }
  }

  private notifyUse(who: string, what: string): void {
    this.o.notify?.('info', this.vi() ? `Từ xa · ${who}: ${what}` : `Remote · ${who}: ${what}`);
  }

  private notifyBlocked(error: string): void {
    const vi = this.vi();
    const text =
      error === 'shell_not_remote'
        ? vi
          ? 'Một thiết bị từ xa vừa thử chạy lệnh shell (dòng bắt đầu bằng «!») — bị chặn: shell trong CLI chạy KHÔNG qua hộp xin quyền, chỉ dùng được ngay tại terminal.'
          : 'A remote device just tried a shell command (a line starting with “!”) — blocked: shell in the CLI runs WITHOUT a permission prompt and is only available at the terminal itself.'
        : error === 'bypass_not_allowed'
          ? vi
            ? 'Một thiết bị từ xa vừa thử đổi sang chế độ «Bỏ qua mọi xác nhận» — bị chặn.'
            : 'A remote device just tried to switch to “Bypass all prompts” — blocked.'
          : vi
            ? 'Một thiết bị từ xa vừa thử chạy một lệnh gạch chéo chỉ dùng được ở terminal — bị chặn.'
            : 'A remote device just tried a slash command that only works at the terminal — blocked.';
    this.o.notify?.('warn', text);
  }
}

/**
 * ViewState tối thiểu cho `toRemoteState` từ trạng thái runtime. Chỉ điền những gì Remote gửi đi: phần còn lại (cài đặt, thùng rác, workspace…) không rời máy.
 * Danh sách model lấy từ `rt.providers` nếu có (giao diện TUI cũng dùng) — thiếu thì chỉ có model đang chọn.
 */
export function viewStateFrom(s: RuntimeStatus, transcript: readonly TItem[], rt: Pick<CliRuntime, 'sessions'> & { modelGroups?: () => ReadonlyArray<{ providerId: string; label: string; models: ReadonlyArray<{ id: string; label: string }> }> }): ViewState {
  const groups = rt.modelGroups?.() ?? [];
  const providers = groups.length
    ? groups.map((g) => ({ id: g.providerId, label: g.label, kind: 'cli', baseUrl: '', hasKey: true, models: g.models.map((m) => ({ id: m.id, label: m.label })) }))
    : [{ id: s.provider, label: s.provider, kind: 'cli', baseUrl: '', hasKey: true, models: [{ id: s.model, label: s.model }] }];
  return {
    version: s.version,
    sessionId: s.sessionId,
    title: s.title,
    transcript: [...transcript],
    todos: s.todos,
    running: s.running,
    provider: s.provider,
    model: s.model,
    mode: s.mode,
    thinkingLevel: s.thinking,
    providers: providers as ViewState['providers'],
    settings: {} as ViewState['settings'],
    sessions: [],
    trash: [],
    workspace: null,
    context: s.context.window > 0 ? { usedTokens: s.context.tokens, limitTokens: s.context.window, percent: s.context.percent } : null,
    editor: null,
    skills: [],
    slashCommands: [],
    allowBypass: false,
    queued: s.queued.map((text, i) => ({ id: `q${i}`, text, attachments: [], ts: 0 })),
    platform: 'vscode',
  } as ViewState;
}

export { REMOTE_API_VERSION, remoteProviders };
export type { RelayStatus };
