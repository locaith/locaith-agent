/**
 * Dịch vụ Remote của VS Code: nối máy chủ điều khiển từ xa (core/remote/server.ts) với khung chat (ChatController) qua HAI đường:
 *  • cục bộ — HTTP 127.0.0.1 (dùng được trên chính máy này, không qua mạng);
 *  • Internet — relay Supabase Realtime, MÃ HOÁ ĐẦU-CUỐI (core/remote/relayHost.ts): dùng được từ điện thoại/máy khác. Cần đăng nhập tài khoản Locaith.
 * Cả hai dùng chung một "trung tâm": cùng luồng sự kiện, cùng danh sách thiết bị (SecretStorage), cùng bộ lệnh được phép, cùng giới hạn tốc độ.
 *  • nghe lén mọi tin host → webview (addMirror) rồi phát lại cho các trang web đã ghép đôi, đã rút gọn (core/remote/sanitize.ts);
 *  • nhận lệnh đã kiểm hợp lệ và chuyển cho đúng bộ xử lý như khi người dùng bấm trong khung chat (handleRemote);
 *  • giao diện trong VS Code: lệnh ghép đôi (mã/liên kết/QR), quản lý/thu hồi thiết bị, nút trên thanh trạng thái.
 * Chỉ chạy khi `locaithAgent.remote.enabled` bật VÀ đã đăng nhập tài khoản Locaith.
 *
 * TIN CẬY THEO TÀI KHOẢN (0.6.5, `locaithAgent.remote.trustAccount`, BẬT SẴN): trình duyệt đã đăng nhập ĐÚNG tài khoản Locaith của chủ máy mở được máy ngay từ locaith.ai — không mã,
 * không liên kết/QR, không hộp thoại «Cho phép». Máy sinh một «khoá tài khoản» ngẫu nhiên 128 bit (SecretStorage, theo từng thư mục/cửa sổ), báo lên danh bạ máy của tài khoản
 * (`ext_host_upsert`), và chỉ chủ tài khoản đọc lại được qua `ext_hosts_list` (cần phiên đăng nhập). Gốc tin cậy vì thế là TÀI KHOẢN LOCAITH chứ không riêng máy này — xem
 * docs/REMOTE-RELAY.md. Tắt cài đặt = quay về ghép đôi từng thiết bị; «Đổi khoá tài khoản» ngắt mọi trình duyệt đang vào.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { accountLink } from '../core/remote/accountLink';
import { b64u, pairingLink as makePairingLink, PSK_BYTES, topicOf } from '../core/remote/e2e';
import { RealtimeLink } from '../core/remote/phoenix';
import type { RemoteHostInfo, RemoteState } from '../core/remote/protocol';
import { fmtCountdown, type QueueState } from '../core/remote/queue';
import { nodeSocket } from '../core/remote/wsNode';
import { buildRemoteView } from '../core/remote/remoteView';
import { RelayHost, type PairRequest, type RelayLink, type RelayStatus } from '../core/remote/relayHost';
import { remoteProviders, sanitizeEvents, sanitizePatch, toRemoteState } from '../core/remote/sanitize';
import type { RemoteBackend, RemoteDevice, RemoteStatus, RemoteStore } from '../core/remote/server';
import { RemoteServer } from '../core/remote/server';
import type { HostMessage, RemoteView } from '../shared/protocol';
import type { AccountGate } from './account';
import type { ChatController } from './chatController';
import type { SecretsLike } from './chrome';
import type { ConfigService } from './config';
import { showPairingQr, type QrPanel } from './remoteQr';

/** Nhịp làm mới snapshot khi có tiến độ agent con (ms): đủ mượt trên điện thoại, không nghẽn đường truyền. */
const AGENT_SNAP_MS = 1500;

const KEY = 'locaithAgent.remote.devices';
const KEY_MACHINE = 'remote.machineSecret';
const REGISTER_EVERY_MS = 5 * 60_000;
/** SecretStorage: khoá tài khoản (16 byte base64url) của từng máy/thư mục — `remote.accountKey.<mã máy>`. */
const KEY_ACCOUNT = 'remote.accountKey.';
const ACCOUNT_KEY_RE = /^[A-Za-z0-9_-]{22}$/;
/** Báo chủ máy có trình duyệt «tài khoản» vừa vào: tối đa một lần mỗi khoảng này (điện thoại nối lại liên tục không được làm ngập khung chat). */
const ACCOUNT_NOTICE_GAP_MS = 60_000;
/** globalState: đã hiện thông báo MỘT LẦN về việc tin cậy theo tài khoản bắt đầu có hiệu lực trên máy này (bản 0.6.5 bật sẵn → người cập nhật phải được báo, không thay đổi lặng lẽ). */
const TRUST_NOTICE_FLAG = 'locaithAgent.remote.trustNoticeShown';

export function remoteSecretStore(s: SecretsLike): RemoteStore {
  return {
    async load(): Promise<RemoteDevice[]> {
      try {
        const raw = await s.get(KEY);
        const j = raw ? (JSON.parse(raw) as unknown) : [];
        if (!Array.isArray(j)) return [];
        return j.filter((d): d is RemoteDevice => {
          if (!d || typeof d.id !== 'string' || typeof d.label !== 'string' || !Number.isFinite(d.createdAt) || !Number.isFinite(d.lastSeen)) return false;
          if (d.kind === 'relay') return typeof d.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(d.key) && typeof d.hostId === 'string' && /^[A-Za-z0-9_-]{22}$/.test(d.hostId);
          return typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash);
        });
      } catch {
        return [];
      }
    },
    async save(list: RemoteDevice[]): Promise<void> {
      if (list.length) await s.set(KEY, JSON.stringify(list));
      else await s.delete(KEY);
    },
  };
}

export interface RemoteServiceDeps {
  controller: ChatController;
  config: ConfigService;
  secrets: SecretsLike;
  account: AccountGate;
  version: string;
  /** Khoá workspace (băm đường dẫn): cùng một thư mục luôn cho cùng một mã máy → trình duyệt đã ghép đôi vẫn dùng được sau khi mở lại. */
  workspaceKey: string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /** Chỉ dùng trong kiểm thử: ép dải cổng (mặc định REMOTE_PORTS). */
  ports?: readonly number[];
  /** Chỉ dùng trong kiểm thử: đường truyền relay tuỳ chọn (mặc định Supabase Realtime thật). */
  createLink?: (topic: string) => RelayLink;
  /** Chỉ dùng trong kiểm thử: thay hộp thoại xác nhận ghép đôi. */
  approve?: (r: PairRequest) => Promise<boolean>;
  /** Chỉ dùng trong kiểm thử: thay việc mở trang Remote của `/remote` trong trình duyệt (ghi lại địa chỉ thay vì mở thật). */
  openUrl?: (url: string) => Promise<void>;
  /** Bộ nhớ nhỏ của extension (globalState): chỉ để nhớ «đã báo một lần về tin cậy theo tài khoản». Vắng thì không báo. */
  state?: Pick<vscode.Memento, 'get' | 'update'>;
}

export interface RemoteServiceStatus extends RemoteStatus {
  /** `queue`: có giá trị khi relay đang QUÁ TẢI và máy này đang xếp hàng chờ (xem core/remote/queue.ts). */
  relay?: { status: RelayStatus; sessions: number; hostId: string; pairing: boolean; trust: boolean; keyed: boolean; queue?: QueueState };
}

/** Cách `/remote` đã mở trang: 'account' = bằng tài khoản (không ghép đôi) · 'pairing' = liên kết ghép đôi qua Internet · 'local' = đường 127.0.0.1 · 'none' = không mở được/bị huỷ. */
export type OpenWebResult = 'account' | 'pairing' | 'local' | 'none';

interface Relay {
  host: RelayHost;
  link: RelayLink;
  hostId: string;
  timer: ReturnType<typeof setInterval>;
  offQueue?: () => void;
  /** Khoá tài khoản hiện hành của máy (base64url 22 ký tự) hoặc null khi `remote.trustAccount` tắt. RelayHost đọc lại ở mỗi lần bắt tay và mỗi nhịp bảo trì. */
  acctKey: string | null;
  /** Mã tài khoản đã sinh ra `acctKey`: khoá chỉ có giá trị với tài khoản này — đổi tài khoản đăng nhập thì khoá bị thay (xem `syncTrust`). */
  acctUser?: string;
  /** Danh bạ tài khoản ĐÃ giữ khoá hiện hành → trang locaith.ai mở được máy này bằng tài khoản. */
  keyed: boolean;
}

/**
 * Phần ChatController cần biết về Remote để hiện trạng thái ngay trong khung chat (bật/tắt, đang xếp hàng khi relay quá tải, ghép đôi…).
 * ChatController được dựng TRƯỚC RemoteService nên nhận qua cầu nối (RemoteBridge) gắn sau.
 */
export interface RemoteGate {
  view(): RemoteView;
  onChange(cb: () => void): vscode.Disposable;
  /** Thử vào lại relay ngay thay vì chờ hết giờ (khi đang xếp hàng); false = chưa được phép. */
  retryNow(): boolean;
  setEnabled(on: boolean): Promise<void>;
  pair(): Promise<void>;
  /** `/remote`: MỘT bước — mở thẳng locaith.ai (vào bằng tài khoản; chỉ khi không được mới dùng liên kết ghép đôi). Trả về cách đã mở để khung chat nói đúng. */
  openWeb(): Promise<OpenWebResult>;
  manage(): Promise<void>;
}

/** Cầu nối gắn muộn: ChatController giữ RemoteBridge, extension.ts gắn RemoteService vào sau khi dựng xong. */
export class RemoteBridge implements RemoteGate, vscode.Disposable {
  private target?: RemoteService;
  private sub?: vscode.Disposable;
  private readonly emitter = new vscode.EventEmitter<void>();
  attach(s: RemoteService): void {
    this.sub?.dispose();
    this.target = s;
    this.sub = s.onDidChange(() => this.emitter.fire());
    this.emitter.fire();
  }
  view(): RemoteView {
    return this.target?.view() ?? { enabled: false, signedIn: false, relay: 'off', devices: 0, streams: 0 };
  }
  onChange(cb: () => void): vscode.Disposable {
    return this.emitter.event(cb);
  }
  retryNow(): boolean {
    return this.target?.retryQueueNow() ?? false;
  }
  setEnabled(on: boolean): Promise<void> {
    return this.target?.setEnabled(on) ?? Promise.resolve();
  }
  pair(): Promise<void> {
    return this.target?.pair() ?? Promise.resolve();
  }
  openWeb(): Promise<OpenWebResult> {
    return this.target?.openWeb() ?? Promise.resolve<OpenWebResult>('none');
  }
  manage(): Promise<void> {
    return this.target?.manage() ?? Promise.resolve();
  }
  dispose(): void {
    this.sub?.dispose();
    this.emitter.dispose();
  }
}

export class RemoteService implements RemoteGate, vscode.Disposable {
  readonly server: RemoteServer;
  private readonly status$: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];
  private readonly vi: () => boolean;
  private relay?: Relay;
  private relayStarting?: Promise<void>;
  private qr?: QrPanel;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Báo mỗi khi trạng thái Remote đổi (bật/tắt, vào/ra relay, hàng chờ, thiết bị) — khung chat cập nhật theo. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly d: RemoteServiceDeps) {
    this.vi = () => d.config.language() === 'vi';
    const backend: RemoteBackend = {
      info: () => this.info(),
      prepare: () => d.controller.refreshView(),
      state: () => {
        // Đẩy nốt các sự kiện còn chờ gửi trước khi chụp: nếu không, snapshot đã chứa chúng mà luồng vẫn gửi lại → máy khách áp hai lần.
        d.controller.flushPending();
        return this.snapshot();
      },
      command: async (device, cmd) => {
        d.log('info', `Remote: "${device.label}" → ${cmd.type}`);
        const run = d.controller.handleRemote(cmd, device.label);
        // Gửi tin / thử lại / nén ngữ cảnh chạy cả phút: không giữ yêu cầu chờ — tiến độ tới máy khách qua luồng sự kiện, lỗi tới qua toast.
        if (cmd.type === 'send' || cmd.type === 'retry' || cmd.type === 'compact') {
          run.catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            d.log('warn', `Remote: lệnh ${cmd.type} lỗi: ${msg}`);
            this.server.publish('toast', { level: 'error', text: msg.slice(0, 300) });
          });
          return;
        }
        await run;
      },
    };
    this.server = new RemoteServer(remoteSecretStore(d.secrets), backend, {
      ports: d.ports,
      allowedOrigins: () => d.config.remoteOrigins(),
      allowedHosts: () => {
        const u = d.config.remotePublicUrl();
        try {
          return u ? [new URL(u).hostname] : [];
        } catch {
          return [];
        }
      },
      idleDays: () => d.config.remoteIdleDays(),
      canBypass: () => d.config.remoteAllowBypass() && d.config.allowBypass(),
      log: d.log,
      onChange: () => this.notify(),
    });

    this.status$ = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.status$.command = 'locaithAgent.remote.manage';
    this.subs.push(
      this.status$,
      d.controller.addMirror((m) => this.onHostMessage(m)),
      vscode.commands.registerCommand('locaithAgent.remote.pair', () => this.pair()),
      vscode.commands.registerCommand('locaithAgent.remote.manage', () => this.manage()),
      d.config.onDidChange((e) => {
        if (e.affectsConfiguration('locaithAgent.remote')) void this.apply();
      }),
      // Đăng nhập/đăng xuất/hết hạn: mở hoặc đóng Remote theo đó (Remote không bao giờ chạy khi chưa đăng nhập).
      d.account.onChange(() => void this.apply()),
    );
  }

  /** Khi kích hoạt (và khi cài đặt/tài khoản đổi): bật hoặc tắt từng đường cho khớp. Tuần tự: bật-tắt nhanh không được để hai lần chạy giẫm lên nhau (nhặt lại khoá vừa xoá…). */
  apply(): Promise<void> {
    const run = this.applying.then(() => this.doApply());
    this.applying = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  private applying: Promise<void> = Promise.resolve();
  /** Đã từng thấy tài khoản dùng được trong lần chạy này: phân biệt «vừa đăng xuất» với «phiên còn đang nạp lúc khởi động» (chưa nạp xong thì KHÔNG được coi là đăng xuất). */
  private wasUsable = false;

  private async doApply(): Promise<void> {
    try {
      const usable = this.d.account.usable;
      const signedOut = this.wasUsable && !usable;
      this.wasUsable = usable;
      const cloud = this.d.config.remoteCloud();
      const on = this.d.config.remoteEnabled() && usable;
      if (on && this.d.config.remoteLocal()) await this.server.start();
      else if (this.server.running) this.server.stop();
      if (on && cloud) {
        await this.startRelay();
        await this.syncTrust();
      } else {
        this.stopRelay();
        // Tắt Remote, tắt đường Internet hoặc đăng xuất = THU HỒI: xoá khoá tài khoản để lần bật lại dùng khoá MỚI — trình duyệt còn cầm khoá cũ (kể cả tab bị bỏ quên) không tự vào lại được.
        // (Đóng VS Code thì KHÔNG xoá — xem dispose — để mở lại là nối tiếp.) Chưa đăng nhập chỉ vì phiên còn đang nạp lúc khởi động thì không xoá gì.
        if (!this.d.config.remoteEnabled() || !cloud || signedOut) await this.dropAccountKey();
      }
    } catch (err) {
      this.d.log('warn', `Remote: ${err instanceof Error ? err.message : String(err)}`);
      void vscode.window.showWarningMessage(`Locaith AI Remote: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.notify();
  }

  status(): RemoteServiceStatus {
    const st = this.server.status(); // danh sách thiết bị dùng chung cho cả hai đường (mỗi thiết bị có `kind`)
    return {
      ...st,
      ...(this.relay
        ? { relay: { status: this.relay.host.status, sessions: this.relay.host.sessionCount, hostId: this.relay.hostId, pairing: !!this.relay.host.pairingState, trust: !!this.relay.acctKey, keyed: this.relay.keyed, ...(this.relay.link.queue ? { queue: this.relay.link.queue } : {}) } }
        : {}),
    };
  }

  /** Cho kiểm thử: máy chủ relay hiện tại. */
  relayHost(): RelayHost | undefined {
    return this.relay?.host;
  }

  // ── đường Internet (relay) ────────────────────────────────────────────────
  /** Mã máy: bí mật riêng của máy (SecretStorage, dùng chung mọi cửa sổ) + khoá workspace → ổn định theo thư mục, không đoán được từ bên ngoài. */
  private async hostId(): Promise<string> {
    let secret = await this.d.secrets.get(KEY_MACHINE);
    if (!secret || secret.length < 32) {
      await this.d.secrets.set(KEY_MACHINE, b64u(randomBytes(32)));
      secret = (await this.d.secrets.get(KEY_MACHINE)) ?? b64u(randomBytes(32)); // đọc lại: hai cửa sổ cùng tạo thì lấy giá trị cuối cùng được lưu
    }
    return b64u(createHash('sha256').update(`${secret}|${this.d.workspaceKey}`).digest().subarray(0, 16));
  }

  private startRelay(): Promise<void> {
    if (this.relay) return Promise.resolve();
    this.relayStarting ??= this.doStartRelay().finally(() => (this.relayStarting = undefined));
    return this.relayStarting;
  }

  private async doStartRelay(): Promise<void> {
    const hostId = await this.hostId();
    const acctKey = await this.loadAccountKey(hostId);
    if (this.relay) return;
    const acct = this.d.account;
    const topic = topicOf(hostId);
    const link: RelayLink =
      this.d.createLink?.(topic) ??
      new RealtimeLink({ baseUrl: acct.cfg.supabaseUrl, apikey: acct.cfg.anonKey, topic, createSocket: nodeSocket, log: this.d.log });
    const host = new RelayHost({
      hostId,
      server: this.server,
      link,
      approve: (r) => (this.d.approve ? this.d.approve(r) : this.askApprove(r)),
      // Hiện diện công khai trên kênh: KHÔNG tên máy/thư mục. `epoch` đổi khi host khởi động lại → trình duyệt bắt tay lại ngay thay vì chờ nhịp ping.
      presence: () => ({ v: 1, epoch: this.server.currentEpoch }),
      log: this.d.log,
      onChange: () => this.notify(),
      // Đọc lại mỗi lần bắt tay: xoay khoá / tắt tin cậy theo tài khoản có hiệu lực ngay, không cần khởi động lại relay.
      accountKey: () => this.relay?.acctKey ?? null,
      onAccountSession: () => this.noticeAccountSession(),
      onPair: (e) => this.qr?.update(e.state === 'requested' ? { state: 'requested', label: e.label, sas: e.sas } : e.state === 'done' ? { state: 'done', label: e.label } : { state: e.state }),
    });
    const timer = setInterval(() => void this.registerHost(), REGISTER_EVERY_MS);
    timer.unref?.();
    this.relay = { host, link, hostId, timer, acctKey, ...(acctKey ? { acctUser: this.d.account.userId?.() } : {}), keyed: false, offQueue: link.onQueue?.((q) => this.onQueue(q)) };
    host.start();
    void this.registerHost();
    this.d.log('info', `Remote qua Internet: đã bật (mã hoá đầu-cuối${acctKey ? '; tin cậy theo tài khoản' : ''}).`);
  }

  private stopRelay(): void {
    const r = this.relay;
    if (!r) return;
    this.relay = undefined;
    clearInterval(r.timer);
    r.offQueue?.();
    r.host.stop();
    this.unregisterHost(r.hostId);
    this.qr?.dispose();
    this.d.log('info', 'Remote qua Internet: đã tắt.');
  }

  /**
   * Khoá tài khoản của máy này (base64url 22 ký tự = 16 byte): tạo lần đầu rồi giữ trong SecretStorage theo mã máy, GẮN với tài khoản đã sinh ra nó
   * (`{u: mã tài khoản, k: khoá}`) — người khác đăng nhập vào cùng VS Code này thì khoá của người trước bị thay, nên tab của người trước không điều khiển được máy của người sau.
   * null khi `remote.trustAccount` tắt, chưa biết tài khoản, hoặc không dùng được kho bí mật (khi tắt thì khoá cũ được xoá luôn).
   * Không bao giờ ghi khoá vào log, thông báo hay trạng thái giao diện.
   */
  private async loadAccountKey(hostId: string): Promise<string | null> {
    const uid = this.d.account.userId?.();
    if (!this.d.config.remoteTrustAccount() || !uid) {
      await this.dropAccountKey(hostId);
      return null;
    }
    const name = KEY_ACCOUNT + hostId;
    const read = async (): Promise<string | null> => {
      try {
        const j = JSON.parse((await this.d.secrets.get(name)) ?? 'null') as { u?: unknown; k?: unknown } | null;
        return j && j.u === uid && typeof j.k === 'string' && ACCOUNT_KEY_RE.test(j.k) ? j.k : null;
      } catch {
        return null; // chưa có / hỏng / của tài khoản khác
      }
    };
    try {
      const had = await read();
      if (had) return had;
      await this.d.secrets.set(name, JSON.stringify({ u: uid, k: b64u(randomBytes(PSK_BYTES)) }));
      return await read(); // đọc lại: hai cửa sổ cùng tạo thì lấy giá trị cuối cùng được lưu
    } catch (err) {
      // Không ghi/đọc được kho bí mật: tắt riêng tính năng này (Remote vẫn chạy, ghép đôi như trước) thay vì làm hỏng cả dịch vụ. Lần `apply()` sau sẽ thử lại.
      this.d.log('warn', `Remote: không dùng được khoá tài khoản (${err instanceof Error ? err.message : String(err)}); chỉ ghép đôi từng thiết bị.`);
      return null;
    }
  }

  /** Xoá khoá tài khoản đã lưu của máy này (thu hồi). Không ném: kho bí mật hỏng thì khoá cũng không dùng được. */
  private async dropAccountKey(hostId?: string): Promise<void> {
    try {
      await this.d.secrets.delete(KEY_ACCOUNT + (hostId ?? (await this.hostId())));
    } catch {
      /* không quan trọng */
    }
  }

  /**
   * Đồng bộ tin cậy theo tài khoản với cài đặt VÀ tài khoản đang đăng nhập khi relay đang chạy:
   *  • tắt `remote.trustAccount` (hoặc không còn biết tài khoản) → cắt mọi phiên «tài khoản», xoá khoá (cả trong danh bạ);
   *  • bật lên → tạo khoá và báo lên danh bạ;
   *  • ĐỔI tài khoản đăng nhập → khoá của tài khoản trước bị thay bằng khoá mới và mọi phiên cũ bị cắt.
   */
  private async syncTrust(): Promise<void> {
    const r = this.relay;
    if (!r) return;
    const uid = this.d.account.userId?.();
    const want = this.d.config.remoteTrustAccount() && !!uid;
    if (!want) {
      if (!r.acctKey) return;
      r.acctKey = null;
      r.acctUser = undefined;
      r.keyed = false;
      r.host.closeAccountSessions();
      await this.dropAccountKey(r.hostId); // bật lại sau này = khoá MỚI, khoá cũ không sống lại
    } else if (r.acctKey && r.acctUser === uid) {
      return;
    } else {
      const had = !!r.acctKey;
      r.acctKey = await this.loadAccountKey(r.hostId);
      r.acctUser = r.acctKey ? uid : undefined;
      r.keyed = false;
      if (had) r.host.closeAccountSessions(); // khoá của tài khoản trước không được dùng tiếp
    }
    await this.registerHost();
    this.notify();
  }

  /**
   * «Đổi khoá tài khoản»: khoá mới → mọi trình duyệt đang vào bằng tài khoản bị ngắt; trình duyệt nào còn đăng nhập đúng tài khoản sẽ tự lấy khoá mới từ danh bạ và vào lại.
   * THỨ TỰ: lưu khoá mới → báo lên danh bạ → (chỉ khi danh bạ đã nhận) đổi khoá của máy và cắt phiên cũ. Cắt trước khi danh bạ có khoá mới thì trình duyệt tự chữa có thể đọc lại
   * khoá CŨ và kẹt ở «đang nối lại» (host im lặng khi MAC sai). Báo danh bạ không được → không đổi gì cả (khoá cũ còn nguyên) và trả false.
   * (Ngắt được trang bị bỏ quên/khoá bị lộ, nhưng KHÔNG chặn được kẻ đang giữ phiên đăng nhập Locaith của bạn — muốn chặn hẳn thì tắt Remote hoặc `remote.trustAccount`.)
   */
  async rotateAccountKey(): Promise<boolean> {
    const r = this.relay;
    const uid = this.d.account.userId?.();
    if (!r || !r.acctKey || !uid) return false;
    const name = KEY_ACCOUNT + r.hostId;
    const key = b64u(randomBytes(PSK_BYTES));
    let before: string | undefined;
    try {
      before = await this.d.secrets.get(name);
      await this.d.secrets.set(name, JSON.stringify({ u: uid, k: key }));
    } catch (err) {
      this.d.log('warn', `Remote: không đổi được khoá tài khoản (${err instanceof Error ? err.message : String(err)}).`);
      return false; // chưa đổi gì
    }
    // Việc xoay chỉ còn hiệu lực chừng nào máy vẫn đang bật tin cậy với ĐÚNG tài khoản này: tắt cài đặt / đổi tài khoản trong lúc chờ thì bỏ (các luồng đó tự xử lý khoá).
    const valid = (): boolean => this.relay === r && !!r.acctKey && r.acctUser === uid && this.d.config.remoteTrustAccount() && this.d.account.userId?.() === uid;
    const ok = await this.registerHost({
      key,
      valid,
      commit: () => {
        r.acctKey = key;
        r.acctUser = uid;
        r.keyed = true;
        r.host.closeAccountSessions();
      },
    });
    if (!ok) {
      // Danh bạ không nhận (mất mạng/máy chủ): trả kho bí mật về như cũ để khoá trong kho, trong bộ nhớ và trong danh bạ vẫn là MỘT khoá.
      // Nếu trong lúc chờ trạng thái đã bị luồng khác đổi (tắt tin cậy, đổi tài khoản) thì không đụng vào kho — luồng đó đã tự xử lý khoá.
      if (valid()) {
        try {
          if (before !== undefined) await this.d.secrets.set(name, before);
          else await this.d.secrets.delete(name);
        } catch {
          /* lần khởi động sau sẽ tự sửa */
        }
      }
      return false;
    }
    this.notify();
    return true;
  }

  /** Có trình duyệt «tài khoản» vừa mở phiên: báo NGAY TRONG khung chat (không dùng thông báo hệ thống), tối đa mỗi `ACCOUNT_NOTICE_GAP_MS` một lần. */
  private lastAccountNotice = 0;
  private noticeAccountSession(): void {
    const now = Date.now();
    if (now - this.lastAccountNotice < ACCOUNT_NOTICE_GAP_MS) return;
    this.lastAccountNotice = now;
    // Khung chat đang ẩn thì tin được giữ lại và hiện khi khung chat mở lại (ChatController.notifyLocal) — không dùng thanh trạng thái hay hộp thông báo của VS Code.
    this.d.controller.notifyLocal(
      'info',
      this.vi()
        ? 'Một trình duyệt đăng nhập cùng tài khoản Locaith vừa mở VS Code này từ xa. Không phải bạn? Tắt công tắc Remote để ngắt ngay, rồi đổi mật khẩu tài khoản.'
        : 'A browser signed in to the same Locaith account just opened this VS Code remotely. Not you? Turn the Remote switch off to cut it right away, then change your account password.',
    );
  }

  /**
   * Báo danh máy cho tài khoản để tab «VS Code từ xa» liệt kê «Máy của bạn», kèm khoá tài khoản (hoặc xoá khoá khi tắt tin cậy). Lỗi không chặn Remote.
   * true = danh bạ ĐÃ giữ khoá hiện hành, tức trang web mở được máy này bằng tài khoản (máy chủ chưa nâng cấp migration thì luôn false → vẫn ghép đôi như trước).
   */
  private registerHost(rotate?: { key: string; valid: () => boolean; commit: () => void }): Promise<boolean> {
    // Tuần tự: hai lần báo danh chồng nhau (nhịp 5 phút + xoay khoá) có thể xong sai thứ tự và để lại khoá CŨ trong danh bạ. Mỗi lần chạy đọc khoá hiện hành lúc nó bắt đầu chạy.
    const run = this.registering.then(() => this.doRegisterHost(rotate));
    this.registering = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  private registering: Promise<void> = Promise.resolve();

  /** Gỡ máy (và khoá) khỏi danh bạ — xếp vào CÙNG hàng với các lần báo danh để một lần báo danh mới (tắt rồi bật Remote nhanh) không bị lần gỡ cũ xoá mất. */
  private unregisterHost(hostId: string): void {
    const token = this.d.account.token();
    if (!token) return; // đã đăng xuất: ext_auth_logout xoá các máy của thiết bị này ở máy chủ
    this.registering = this.registering.then(
      () => this.d.account.client.hostRemove(token, hostId).then(() => undefined, () => undefined),
      () => undefined,
    );
  }

  private async doRegisterHost(rotate?: { key: string; valid: () => boolean; commit: () => void }): Promise<boolean> {
    const r = this.relay;
    const token = this.d.account.token();
    if (!r || !token) return false;
    if (rotate && !rotate.valid()) return false;
    const key = rotate?.key ?? r.acctKey;
    const res = await this.d.account.client.hostUpsert(
      token,
      r.hostId,
      os.hostname(),
      vscode.workspace.workspaceFolders?.[0]?.name,
      { client: 'vscode', platform: process.platform, app: vscode.env.appName, vscode: vscode.version, ext: this.d.version },
      key ?? '',
    );
    if (this.relay !== r) {
      // Remote đã tắt trong lúc chờ: đừng để hàng (và khoá) máy này nằm lại trong danh bạ vì lần báo danh vừa xong chạy sau lần gỡ. (Chờ xong rồi mới tới lượt kế tiếp trong hàng.)
      await this.d.account.client.hostRemove(token, r.hostId).catch(() => undefined);
      return false;
    }
    if (!res.ok) {
      this.d.log('debug', `Remote: báo danh máy thất bại (${res.error})`);
      return false;
    }
    const keyed = !!key && res.keyed === true && (rotate ? true : r.acctKey === key);
    if (rotate && keyed) {
      // Danh bạ đã giữ khoá mới → đổi khoá của máy và cắt phiên cũ, ngay trong lượt này. Nếu trong lúc chờ có luồng khác tắt/đổi tin cậy thì không commit (luồng đó sẽ báo lại danh bạ).
      if (!rotate.valid()) return false;
      rotate.commit();
    }
    if (r.keyed !== keyed) {
      r.keyed = keyed;
      this.notify();
    }
    if (keyed) void this.announceTrustOnce();
    return keyed;
  }

  /**
   * Lần đầu tin cậy theo tài khoản THỰC SỰ có hiệu lực trên máy này (khoá đã lên danh bạ): báo một lần, nói rõ nó là gì, rủi ro, và cho tắt ngay.
   * Bản 0.6.5 bật sẵn nên người cập nhật từ bản trước không được bị đổi mô hình tin cậy mà không hay biết. Không hiện lại sau lần này (kể cả khi bỏ qua thông báo).
   */
  private async announceTrustOnce(): Promise<void> {
    const st = this.d.state;
    if (!st || st.get<boolean>(TRUST_NOTICE_FLAG)) return;
    await st.update(TRUST_NOTICE_FLAG, true);
    const vi = this.vi();
    const keep = vi ? 'Giữ nguyên' : 'Keep it on';
    const off = vi ? 'Tắt tính năng này' : 'Turn it off';
    const pick = await vscode.window.showInformationMessage(
      vi
        ? 'Remote: trình duyệt đăng nhập ĐÚNG tài khoản Locaith của bạn giờ mở được VS Code này từ locaith.ai (điện thoại, máy khác) mà không cần ghép đôi. Ai đăng nhập được tài khoản của bạn thì điều khiển được máy này — hãy giữ tài khoản an toàn. Tắt được bất cứ lúc nào.'
        : 'Remote: a browser signed in to YOUR Locaith account can now open this VS Code from locaith.ai (phone, another computer) without pairing. Anyone who can sign in to your account can control this machine — keep the account safe. You can turn it off any time.',
      keep,
      off,
    );
    if (pick === off) await this.d.config.cfg().update('remote.trustAccount', false, vscode.ConfigurationTarget.Global);
  }

  // ── Remote hiển thị trong khung chat ──────────────────────────────────────
  /** Trạng thái cho khung chat (view.remote). Quá tải thì `relay: 'queued'` + `queue` để giao diện tự đếm ngược tới `retryAt`. */
  view(): RemoteView {
    const st = this.status();
    return buildRemoteView({ enabled: this.d.config.remoteEnabled(), signedIn: this.d.account.usable, relay: st.relay, devices: st.devices.length, streams: st.streams, trust: !!st.relay?.trust && st.relay.keyed });
  }

  /** Bật/tắt Remote từ công tắc trong khung chat (= cài đặt `locaithAgent.remote.enabled`; `apply()` chạy theo sự kiện đổi cài đặt). */
  async setEnabled(on: boolean): Promise<void> {
    await this.d.config.cfg().update('remote.enabled', on, vscode.ConfigurationTarget.Global);
  }

  private notify(): void {
    this.refreshStatusBar();
    this.changed.fire();
  }

  /**
   * Relay (Supabase Realtime) từ chối vì QUÁ TẢI. KHÔNG dùng thông báo hay thanh trạng thái của hệ thống VS Code: hàng chờ + đếm ngược hiện NGAY TRONG khung chat của
   * extension (RemoteStrip, nhờ view.remote) và trong khung QR ghép đôi; máy chủ chỉ báo mốc `retryAt`, giao diện tự đếm ngược. Xem core/remote/queue.ts.
   */
  private onQueue(q: QueueState | null): void {
    if (q) this.qr?.update({ state: 'queued', retryAt: q.retryAt, attempt: q.attempt, trying: q.trying });
    else if (this.relay?.host.status === 'online') this.qr?.update({ state: 'online' });
    this.notify();
  }

  /** Thử vào lại relay ngay thay vì chờ hết giờ (khi đang xếp hàng vì quá tải). false = chưa được phép: không đang xếp hàng, đang thử dở, hoặc vừa thử cách đây dưới 5 giây. */
  retryQueueNow(): boolean {
    return this.relay?.link.retryNow?.() ?? false;
  }

  retryNow(): boolean {
    return this.retryQueueNow();
  }

  onChange(cb: () => void): vscode.Disposable {
    return this.changed.event(cb);
  }

  /** Hộp thoại xác nhận ghép đôi — chặn có chủ đích: đây là cổng duy nhất để một trình duyệt mới có quyền điều khiển máy. */
  private async askApprove(r: PairRequest): Promise<boolean> {
    const vi = this.vi();
    const allow = vi ? 'Cho phép' : 'Allow';
    const pick = await vscode.window.showWarningMessage(
      vi ? `Cho phép thiết bị «${r.label}» điều khiển VS Code này?` : `Allow device “${r.label}” to control this VS Code?`,
      {
        modal: true,
        detail: vi
          ? `Mã xác nhận: ${r.sas}\n\nMã này phải GIỐNG HỆT mã đang hiện trên trình duyệt. Chỉ cho phép nếu chính bạn vừa mở liên kết/mã QR ghép đôi.\n\nThiết bị được ghép làm được mọi việc trợ lý làm được trên máy này (đọc/sửa tệp, chạy lệnh theo chế độ quyền đang bật). Thu hồi bất cứ lúc nào bằng «Remote: thiết bị đã ghép».`
          : `Confirmation code: ${r.sas}\n\nThis code must be IDENTICAL to the one shown in the browser. Only allow it if you just opened the pairing link/QR yourself.\n\nA paired device can do anything the assistant can do on this machine (read/edit files, run commands according to the permission mode in use). Revoke it any time with “Remote: paired devices”.`,
      },
      allow,
    );
    return pick === allow;
  }

  // ── tin host → máy khách ──────────────────────────────────────────────────
  private info(): RemoteHostInfo {
    return { name: os.hostname(), workspace: vscode.workspace.workspaceFolders?.[0]?.name, vscode: vscode.version, ext: this.d.version, platform: process.platform };
  }

  private snapshot(): RemoteState {
    return toRemoteState(this.d.controller.viewState(), this.info(), { canBypass: this.d.config.remoteAllowBypass() && this.d.config.allowBypass() });
  }

  /** Snapshot "làm mới" để mobile thấy tiến độ agent (agent_progress bị lọc khỏi luồng sự kiện); giới hạn nhịp để không nghẽn đường truyền. */
  private agentSnapTimer?: ReturnType<typeof setTimeout>;
  private agentSnapLast = 0;

  /**
   * `agent_progress` không đi trong luồng sự kiện (máy khách cũ có bộ giảm trạng thái `switch` kín, gặp loại lạ sẽ hỏng transcript),
   * nhưng trước đây nó bị BỎ HOÀN TOÀN nên trang remote không thấy agent con đang làm gì cho tới khi có sự kiện khác.
   * Cách tương thích ngược: gửi lại `snapshot` (mọi phiên bản máy khách đều hiểu) tối đa mỗi AGENT_SNAP_MS khi đang có tiến độ agent.
   * `publish` tự không gửi khi không có máy khách nào nghe, nên không cần kiểm ở đây.
   */
  private scheduleAgentSnapshot(): void {
    if (this.agentSnapTimer) return;
    const wait = Math.max(0, AGENT_SNAP_MS - (Date.now() - this.agentSnapLast));
    const timer = setTimeout(() => {
      this.agentSnapTimer = undefined;
      this.agentSnapLast = Date.now();
      if (!this.d.controller.viewState().running) return; // xong rồi thì sự kiện cuối đã mang trạng thái đúng
      this.server.publish('snapshot', { state: this.snapshot() });
    }, wait);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.agentSnapTimer = timer;
  }

  private onHostMessage(m: HostMessage): void {
    switch (m.type) {
      case 'init':
        this.server.publish('snapshot', { state: toRemoteState(m.state, this.info(), { canBypass: this.d.config.remoteAllowBypass() && this.d.config.allowBypass() }) });
        break;
      case 'events': {
        const evs = sanitizeEvents(m.events); // bỏ `agent_progress` (xem sanitizeEvents)
        if (evs.length > 0) this.server.publish('events', { events: evs });
        // Có tiến độ agent → làm mới snapshot (giới hạn nhịp) để mobile thấy agent đang làm gì, như khung chat trong VS Code.
        if (m.events.some((e) => e.t === 'agent_progress')) this.scheduleAgentSnapshot();
        break;
      }
      case 'patch': {
        const p = sanitizePatch(m.patch);
        if (!p) break;
        const v = this.d.controller.viewState();
        if (p.providers) p.providers = remoteProviders(v.providers, v.provider);
        this.server.publish('patch', { patch: p });
        break;
      }
      case 'toast':
        this.server.publish('toast', { level: m.level, text: m.text });
        break;
      case 'image_data':
        this.server.publish('image', { key: m.key, mediaType: m.mediaType, data: m.data }, { ephemeral: true });
        break;
      default:
        break; // files, market_state, draft, insert, focus… chỉ có nghĩa với khung chat trong VS Code
    }
  }

  // ── giao diện trong VS Code ───────────────────────────────────────────────
  private hostUrl(port: number): string {
    return this.d.config.remotePublicUrl() || `http://127.0.0.1:${port}`;
  }

  /** Liên kết ghép đôi một chạm (đường cục bộ): host + mã nằm ở phần sau dấu # nên không bao giờ gửi tới máy chủ web. */
  pairingLink(code: string, port: number): string {
    return `${this.d.config.remoteWebUrl()}/#remote?host=${encodeURIComponent(this.hostUrl(port))}&code=${encodeURIComponent(code)}`;
  }

  /** Bật Remote nếu chưa bật (hỏi xác nhận, nói rõ rủi ro). false = người dùng từ chối. */
  private async ensureEnabled(): Promise<boolean> {
    if (this.d.config.remoteEnabled()) return true;
    const vi = this.vi();
    const trust = this.d.config.remoteTrustAccount();
    const yes = vi ? 'Bật Remote' : 'Turn on Remote';
    const pick = await vscode.window.showWarningMessage(
      vi
        ? `Bật điều khiển từ xa? ${trust ? 'Trình duyệt đăng nhập ĐÚNG tài khoản Locaith của bạn (và thiết bị đã ghép đôi)' : 'Thiết bị đã ghép đôi'} làm được mọi việc trợ lý làm được trên máy này (đọc/sửa tệp, chạy lệnh theo chế độ quyền đang bật). ${trust ? 'Hãy bảo vệ tài khoản Locaith bằng mật khẩu mạnh.' : 'Chỉ ghép đôi thiết bị của chính bạn.'} Đường Internet được mã hoá đầu-cuối; đường cục bộ chỉ mở ở 127.0.0.1.`
        : `Turn on remote control? ${trust ? 'A browser signed in to YOUR Locaith account (and any paired device)' : 'A paired device'} can do anything the assistant can do on this machine (read/edit files, run commands according to the permission mode in use). ${trust ? 'Protect your Locaith account with a strong password.' : 'Only pair your own devices.'} The Internet path is end-to-end encrypted; the local path only listens on 127.0.0.1.`,
      { modal: true },
      yes,
    );
    if (pick !== yes) return false;
    await this.d.config.cfg().update('remote.enabled', true, vscode.ConfigurationTarget.Global);
    return true;
  }

  /**
   * `/remote`: gõ một lệnh là trình duyệt mở thẳng trang Remote trên locaith.ai — không khung QR, không hộp thoại "mở/sao chép", không bước chọn.
   *  • TIN CẬY THEO TÀI KHOẢN (mặc định): đưa khoá tài khoản lên danh bạ NGAY rồi mở `#remote?h=<mã máy>`; trang đăng nhập cùng tài khoản tự vào máy này — không mã, không «Cho phép».
   *  • Không được (đã tắt `remote.trustAccount`, mất mạng tới danh bạ, máy chủ danh bạ chưa nâng cấp): quay về liên kết ghép đôi một lần (bí mật 128 bit sau dấu #, không gửi lên máy chủ nào)
   *    và việc ghép đôi cần bạn bấm «Cho phép» ở VS Code, như trước.
   * Đường Internet được ưu tiên (dùng được cả trên máy này lẫn điện thoại); chỉ khi nó tắt mới dùng đường cục bộ 127.0.0.1 (luôn là liên kết ghép đôi).
   */
  async openWeb(): Promise<OpenWebResult> {
    const vi = this.vi();
    if (!this.d.account.usable) {
      const signIn = vi ? 'Đăng nhập' : 'Sign in';
      if ((await vscode.window.showWarningMessage(vi ? 'Hãy đăng nhập tài khoản Locaith trước khi dùng Remote.' : 'Sign in to your Locaith account before using Remote.', signIn)) === signIn) await this.d.account.signIn();
      return 'none';
    }
    if (!(await this.ensureEnabled())) return 'none';
    const cloud = this.d.config.remoteCloud();
    const local = this.d.config.remoteLocal();
    if (!cloud && !local) {
      void vscode.window.showWarningMessage(vi ? 'Cả hai đường Remote đang tắt trong cài đặt (remote.cloud / remote.local).' : 'Both Remote paths are turned off in settings (remote.cloud / remote.local).');
      return 'none';
    }
    await this.apply();
    if (cloud) {
      const relay = this.relay;
      if (!relay) {
        void vscode.window.showErrorMessage(vi ? 'Không bật được Remote qua Internet.' : 'Could not start Remote over the Internet.');
        return 'none';
      }
      // Chờ vào kênh tối đa 8 giây để trang vừa mở là vào được ngay; relay quá tải thì khỏi chờ (khung chat đã hiện hàng chờ) — liên kết vẫn dùng được khi vào được.
      const t0 = Date.now();
      while (relay.host.status !== 'online' && !relay.link.queue && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
      if (relay.acctKey && (await this.registerHost())) {
        await this.openUrl(accountLink(this.d.config.remoteWebUrl(), relay.hostId));
        return 'account';
      }
      const { psk } = relay.host.startPairing();
      await this.openUrl(makePairingLink(this.d.config.remoteWebUrl(), { hostId: relay.hostId, psk, name: os.hostname() }));
      return 'pairing';
    }
    let started: { code: string; expiresAt: number; port: number };
    try {
      started = await this.server.startPairing();
    } catch (err) {
      void vscode.window.showErrorMessage(`Locaith AI Remote: ${err instanceof Error ? err.message : String(err)}`);
      return 'none';
    }
    this.refreshStatusBar();
    await this.openUrl(this.pairingLink(started.code, started.port));
    return 'local';
  }

  private async openUrl(url: string): Promise<void> {
    if (this.d.openUrl) await this.d.openUrl(url);
    else await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async pair(): Promise<void> {
    const vi = this.vi();
    if (!this.d.account.usable) {
      const signIn = vi ? 'Đăng nhập' : 'Sign in';
      if ((await vscode.window.showWarningMessage(vi ? 'Hãy đăng nhập tài khoản Locaith trước khi dùng Remote.' : 'Sign in to your Locaith account before using Remote.', signIn)) === signIn) await this.d.account.signIn();
      return;
    }
    if (!(await this.ensureEnabled())) return;
    const cloud = this.d.config.remoteCloud();
    const local = this.d.config.remoteLocal();
    let mode: 'cloud' | 'local' | undefined = cloud && !local ? 'cloud' : local && !cloud ? 'local' : undefined;
    if (!cloud && !local) {
      void vscode.window.showWarningMessage(vi ? 'Cả hai đường Remote đang tắt trong cài đặt (remote.cloud / remote.local).' : 'Both Remote paths are turned off in settings (remote.cloud / remote.local).');
      return;
    }
    if (!mode) {
      type Pick = vscode.QuickPickItem & { m: 'cloud' | 'local' };
      const sel = await vscode.window.showQuickPick<Pick>(
        [
          { m: 'cloud', label: vi ? '$(cloud) Qua Internet — điện thoại / máy khác' : '$(cloud) Over the Internet — phone / another computer', description: vi ? 'mã QR, mã hoá đầu-cuối' : 'QR code, end-to-end encrypted' },
          { m: 'local', label: vi ? '$(device-desktop) Trên máy này' : '$(device-desktop) On this machine', description: vi ? 'cục bộ 127.0.0.1, không qua mạng' : 'local 127.0.0.1, no network' },
        ],
        { title: vi ? 'Ghép đôi thiết bị Remote' : 'Pair a Remote device', placeHolder: vi ? 'Chọn cách kết nối' : 'Choose how to connect' },
      );
      if (!sel) return;
      mode = sel.m;
    }
    await this.apply();
    return mode === 'cloud' ? this.pairCloud() : this.pairLocal();
  }

  private async pairCloud(): Promise<void> {
    const vi = this.vi();
    const relay = this.relay;
    if (!relay) {
      void vscode.window.showErrorMessage(vi ? 'Không bật được Remote qua Internet.' : 'Could not start Remote over the Internet.');
      return;
    }
    // Chờ vào kênh (tối đa 8 giây) để trình duyệt ghép đôi được ngay khi người dùng quét mã. Relay báo quá tải thì khỏi chờ: nói thẳng là đang xếp hàng.
    const t0 = Date.now();
    while (relay.host.status !== 'online' && !relay.link.queue && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
    const queue = relay.link.queue;
    if (relay.host.status !== 'online' && !queue) void vscode.window.showWarningMessage(vi ? 'Chưa kết nối được máy chủ relay (kiểm tra mạng). Mã vẫn được tạo; trình duyệt sẽ ghép được khi có mạng.' : 'Could not reach the relay yet (check your network). The code is still created; the browser can pair once you are online.');
    const { psk, expiresAt } = relay.host.startPairing();
    const link = makePairingLink(this.d.config.remoteWebUrl(), { hostId: relay.hostId, psk, name: os.hostname() });
    this.qr?.dispose();
    this.qr = showPairingQr({
      link,
      expiresAt,
      vi,
      initial: queue ? { state: 'queued', retryAt: queue.retryAt, attempt: queue.attempt, trying: queue.trying } : undefined,
      onDispose: () => void (this.qr = undefined),
    });
    const open = vi ? 'Mở trang Remote' : 'Open Remote page';
    const copy = vi ? 'Sao chép liên kết' : 'Copy link';
    // Đang xếp hàng vì relay quá tải: KHÔNG bật hộp thoại của hệ thống — khung QR (có biểu ngữ đếm ngược) và khung chat đã nói rõ; mã dùng được ngay khi vào được.
    if (relay.host.status !== 'online' && queue) return;
    const pick = await vscode.window.showInformationMessage(
      vi
        ? 'Ghép đôi qua Internet: quét mã QR trong khung bên cạnh bằng điện thoại, hoặc mở trang Remote ngay trên máy này. Liên kết hết hạn sau 5 phút và chỉ dùng được một lần; bạn còn phải bấm «Cho phép» ở VS Code.'
        : 'Pair over the Internet: scan the QR code in the side panel with your phone, or open the Remote page on this machine. The link expires in 5 minutes, works once, and you still have to click “Allow” in VS Code.',
      open,
      copy,
    );
    if (pick === open) await vscode.env.openExternal(vscode.Uri.parse(link));
    else if (pick === copy) await vscode.env.clipboard.writeText(link);
  }

  private async pairLocal(): Promise<void> {
    const vi = this.vi();
    let started: { code: string; expiresAt: number; port: number };
    try {
      started = await this.server.startPairing();
    } catch (err) {
      void vscode.window.showErrorMessage(`Locaith AI Remote: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.refreshStatusBar();
    const link = this.pairingLink(started.code, started.port);
    const open = vi ? 'Mở trang Remote' : 'Open Remote page';
    const copyCode = vi ? 'Sao chép mã' : 'Copy code';
    const copyLink = vi ? 'Sao chép liên kết' : 'Copy link';
    const pick = await vscode.window.showInformationMessage(
      vi ? `Mã ghép đôi Remote: ${started.code} (hết hạn sau 5 phút). Mở trang Remote để tự ghép, hoặc nhập mã vào tab Remote.` : `Remote pairing code: ${started.code} (expires in 5 minutes). Open the Remote page to pair automatically, or type the code into the Remote tab.`,
      open,
      copyCode,
      copyLink,
    );
    if (pick === open) await vscode.env.openExternal(vscode.Uri.parse(link));
    else if (pick === copyCode) await vscode.env.clipboard.writeText(started.code);
    else if (pick === copyLink) await vscode.env.clipboard.writeText(link);
  }

  async manage(): Promise<void> {
    const vi = this.vi();
    const st = this.status();
    type Item = vscode.QuickPickItem & { act: 'open' | 'pair' | 'stop' | 'revokeAll' | 'revoke' | 'retry' | 'rotate' | 'noop'; id?: string };
    const trust = !!st.relay?.trust && st.relay.keyed;
    const items: Item[] = [];
    if (trust) items.push({ label: vi ? '$(link-external) Mở trang Remote trên locaith.ai' : '$(link-external) Open the Remote page on locaith.ai', description: vi ? 'vào bằng tài khoản — không cần ghép đôi' : 'signs in with your account — no pairing', act: 'open' });
    items.push({ label: vi ? '$(add) Ghép đôi thiết bị mới' : '$(add) Pair a new device', description: trust ? (vi ? 'chỉ khi thiết bị không đăng nhập tài khoản này' : 'only for a device that is not signed in to this account') : undefined, act: 'pair' });
    if (st.relay?.queue) items.unshift({ label: vi ? '$(sync) Thử vào lại relay ngay' : '$(sync) Retry the relay now', description: vi ? 'máy chủ đang quá tải — đang xếp hàng' : 'the relay is overloaded — you are queued', act: 'retry' });
    if (st.devices.length) items.push({ label: vi ? 'Thiết bị đã ghép (chọn để thu hồi)' : 'Paired devices (select to revoke)', kind: vscode.QuickPickItemKind.Separator, act: 'noop' });
    for (const dev of st.devices) {
      items.push({
        label: `${dev.kind === 'relay' ? '$(cloud)' : '$(device-desktop)'} ${dev.label}`,
        description: `${dev.kind === 'relay' ? (vi ? 'qua Internet' : 'over the Internet') : vi ? 'cục bộ' : 'local'}${dev.connected ? ` · ${vi ? 'đang kết nối' : 'connected'}` : ''}`,
        detail: `${vi ? 'Ghép lúc' : 'Paired'} ${new Date(dev.createdAt).toLocaleString()} · ${vi ? 'dùng lần cuối' : 'last used'} ${new Date(dev.lastSeen).toLocaleString()}`,
        act: 'revoke',
        id: dev.id,
      });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, act: 'noop' });
    if (st.devices.length) items.push({ label: vi ? '$(trash) Thu hồi tất cả thiết bị' : '$(trash) Revoke all devices', act: 'revokeAll' });
    if (trust) items.push({ label: vi ? '$(key) Đổi khoá tài khoản' : '$(key) Change the account key', description: vi ? 'ngắt mọi trình duyệt đang vào bằng tài khoản' : 'cuts every browser that is in through the account', act: 'rotate' });
    if (st.running || st.relay) items.push({ label: vi ? '$(debug-stop) Dừng điều khiển từ xa (giữ thiết bị đã ghép)' : '$(debug-stop) Stop remote control (keep paired devices)', act: 'stop' });
    const relayWord = (r: NonNullable<typeof st.relay>): string =>
      r.queue ? (vi ? `đang xếp hàng, thử lại sau ${fmtCountdown(r.queue.retryAt - Date.now())}` : `queued, retry in ${fmtCountdown(r.queue.retryAt - Date.now())}`) : r.status === 'online' ? (vi ? 'đã kết nối' : 'connected') : vi ? 'đang nối' : 'connecting';
    const where = [st.running ? (vi ? `cục bộ 127.0.0.1:${st.port}` : `local 127.0.0.1:${st.port}`) : '', st.relay ? `Internet (${relayWord(st.relay)})` : ''].filter(Boolean).join(' + ');
    const sel = await vscode.window.showQuickPick(items, {
      title: where ? (vi ? `Locaith AI Remote — đang chạy: ${where} · ${st.streams} kết nối` : `Locaith AI Remote — running: ${where} · ${st.streams} connection(s)`) : vi ? 'Locaith AI Remote — đang tắt' : 'Locaith AI Remote — off',
      placeHolder: vi ? 'Chọn thao tác' : 'Choose an action',
    });
    if (!sel) return;
    if (sel.act === 'open') {
      await this.openWeb();
      return;
    }
    if (sel.act === 'pair') return this.pair();
    if (sel.act === 'rotate') {
      const change = vi ? 'Đổi khoá' : 'Change key';
      const ok =
        (await vscode.window.showWarningMessage(
          vi
            ? 'Đổi khoá tài khoản? Mọi trình duyệt đang vào bằng tài khoản bị ngắt ngay; trang nào còn đăng nhập đúng tài khoản Locaith sẽ tự lấy khoá mới và vào lại. Muốn chặn hẳn thì tắt công tắc Remote.'
            : 'Change the account key? Every browser that is in through the account is cut immediately; a page still signed in to the Locaith account fetches the new key and comes back in. To block access completely, turn the Remote switch off.',
          { modal: true },
          change,
        )) === change;
      if (ok && !(await this.rotateAccountKey())) void vscode.window.showErrorMessage(vi ? 'Không đổi được khoá tài khoản (không ghi được kho bí mật của VS Code hoặc không báo được danh bạ locaith.ai). Khoá cũ vẫn còn hiệu lực — hãy thử lại khi có mạng.' : 'Could not change the account key (VS Code could not write its secret store, or the locaith.ai machine list could not be reached). The old key still works — try again when you are online.');
      return;
    }
    if (sel.act === 'retry') {
      this.retryQueueNow(); // bị từ chối (vừa thử < 5 giây) thì thôi — khung chat đã hiện nút «Thử ngay» tự mở lại sau 5 giây
      this.notify();
      return;
    }
    if (sel.act === 'stop') {
      await this.d.config.cfg().update('remote.enabled', false, vscode.ConfigurationTarget.Global);
      this.server.stop();
      this.stopRelay();
      this.refreshStatusBar();
      return;
    }
    const confirm = vi ? 'Thu hồi' : 'Revoke';
    const name = sel.label.replace(/^\$\([a-z-]+\) /, '');
    if (sel.act === 'revokeAll') {
      if ((await vscode.window.showWarningMessage(vi ? 'Thu hồi mọi thiết bị đã ghép đôi? Các trang đang mở sẽ bị ngắt ngay.' : 'Revoke every paired device? Open pages are disconnected immediately.', { modal: true }, confirm)) === confirm) await this.server.revokeAll();
    } else if (sel.act === 'revoke' && sel.id) {
      if ((await vscode.window.showWarningMessage(vi ? `Thu hồi thiết bị "${name}"?` : `Revoke device "${name}"?`, { modal: true }, confirm)) === confirm) await this.server.revoke(sel.id);
    }
    this.refreshStatusBar();
  }

  /**
   * Remote BẬT SẴN nên thanh trạng thái chỉ hiện khi có việc thật: đã có thiết bị ghép đôi, đang có kết nối, hoặc máy chủ cục bộ đang chạy — người chưa dùng Remote
   * không thấy gì thêm ở đây. Quá tải/hàng chờ KHÔNG hiện ở thanh trạng thái (xem view.remote trong khung chat).
   */
  private refreshStatusBar(): void {
    const st = this.status();
    if (!st.running && st.devices.length === 0 && st.streams === 0) {
      this.status$.hide();
      return;
    }
    const vi = this.vi();
    const online = st.relay?.status === 'online' && !st.relay.queue;
    const cloud = st.relay ? (online ? ' $(cloud)' : ' $(cloud-offline)') : '';
    this.status$.text = st.streams > 0 ? `$(broadcast) Remote · ${st.streams}${cloud}` : `$(broadcast) Remote${cloud}`;
    this.status$.backgroundColor = undefined;
    const lines: string[] = [];
    if (st.running) lines.push(vi ? `Cục bộ: 127.0.0.1:${st.port}` : `Local: 127.0.0.1:${st.port}`);
    if (st.relay) lines.push(vi ? `Internet: ${online ? 'đã kết nối (mã hoá đầu-cuối)' : st.relay.queue ? 'đang xếp hàng (relay quá tải)' : 'đang kết nối…'}` : `Internet: ${online ? 'connected (end-to-end encrypted)' : st.relay.queue ? 'queued (relay overloaded)' : 'connecting…'}`);
    this.status$.tooltip = vi
      ? `Locaith AI Remote\n${lines.join('\n')}\n${st.devices.length} thiết bị đã ghép · ${st.streams} kết nối\nBấm để quản lý`
      : `Locaith AI Remote\n${lines.join('\n')}\n${st.devices.length} paired device(s) · ${st.streams} connection(s)\nClick to manage`;
    this.status$.show();
  }

  dispose(): void {
    this.server.stop();
    this.stopRelay();
    this.changed.dispose();
    for (const s of this.subs) s.dispose();
  }
}
