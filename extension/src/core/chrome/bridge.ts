/**
 * Cầu nối VS Code ↔ extension Locaith trên Chrome: một máy chủ HTTP cục bộ (127.0.0.1) mà extension Chrome "gọi vào" bằng long-poll — extension là bên chủ động
 * kết nối nên không cần native messaging hay cài thêm gì trên máy.
 *
 * An toàn (mỗi lớp đều có test):
 *  • chỉ lắng nghe 127.0.0.1; kiểm tra tiêu đề Host (chống DNS rebinding) và Origin: trang web thường gửi Origin https://… nên bị từ chối ở MỌI đường dẫn;
 *    chỉ nhận Origin chrome-extension://<id> (và sau khi ghép đôi: đúng id đã ghép);
 *  • ghép đôi KHÔNG MÃ: extension Chrome xin kết nối (POST /v1/pair/request, chỉ Origin chrome-extension://), VS Code hiện thẻ «Cho phép / Từ chối» ngay trong khung chat;
 *    khi người dùng bấm Cho phép, extension nhận token MỘT lần qua /v1/pair/status (chỉ đúng extension đã xin; tối đa một yêu cầu đang chờ, 6 yêu cầu/phút, hiệu lực 2 phút);
 *  • ghép đôi bằng mã dùng một lần (8 ký tự, hiệu lực 5 phút, tối đa 5 lần thử sai) hiện ở VS Code, người dùng gõ vào extension Chrome; kết quả là một token ngẫu nhiên 256 bit;
 *  • (0.7.20) ghép đôi do ỨNG DỤNG khởi xướng: ứng dụng tạo vé dùng một lần (2 phút, tối đa 3 vé) rồi mở trang /link của chính máy chủ này trong trình duyệt
 *    người dùng đang dùng; trang chuyển vé cho tiện ích (externally_connectable chỉ khớp http://127.0.0.1 / localhost), tiện ích hỏi người dùng MỘT lần
 *    rồi đổi vé lấy token ở POST /v1/pair/ticket (chỉ Origin chrome-extension://). GET /v1/hello cho biết ứng dụng nào giữ cổng (không lộ gì khác);
 *  • mọi đường dẫn khác đều cần `Authorization: Bearer <token>` (so sánh thời gian không đổi); token dùng chung giữa các cửa sổ VS Code qua kho bí mật;
 *  • thân yêu cầu tối đa 8 MB; mỗi lệnh có hạn giờ và huỷ được; huỷ ghép đôi thu hồi token ở mọi cửa sổ.
 * Không import `vscode`.
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LINK_PROTO } from '../../shared/linkProtocol';

export const BRIDGE_PORTS: readonly number[] = [47615, 47616, 47617, 47618, 47619, 47620];
export const BRIDGE_VERSION = 1;
const PAIR_TTL_MS = 5 * 60_000;
const MAX_TRIES = 5;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_WAIT_S = 25;
const CONNECTED_MS = 45_000;
/** Yêu cầu ghép đôi từ phía Chrome (không mã): hiệu lực 2 phút, tối đa 6 yêu cầu mới mỗi phút, tối đa MỘT yêu cầu đang chờ. */
const REQ_TTL_MS = 2 * 60_000;
const REQ_PER_MIN = 6;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** (0.7.18) Giữ GET của tiện ích Chrome bản cũ không trả lời quá 30 giây để Chrome tự dừng dịch vụ nền của nó (rồi mới đóng). */
const OLD_HOLD_MS = 45_000;
/** Giữ cùng lúc tối đa bấy nhiêu yêu cầu như vậy (một trang web không thể dùng việc giữ để chiếm cổng). */
const OLD_HOLD_MAX = 8;
const EXT_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

export interface BridgeCreds {
  token?: string;
  extId?: string;
}
export interface BridgeStore {
  load(): Promise<BridgeCreds>;
  save(c: BridgeCreds): Promise<void>;
}
export interface BridgeStatus {
  running: boolean;
  port?: number;
  paired: boolean;
  connected: boolean;
  extensionId?: string;
  pairing?: { code: string; expiresAt: number };
  /** Extension Chrome đang xin kết nối và chờ người dùng bấm Cho phép (không cần mã). */
  pairRequest?: { id: string; extensionId: string; expiresAt: number };
  /** (0.7.20) Vé ghép đôi mới nhất do ứng dụng tạo («Kết nối trình duyệt này»): trang /link thấy tiện ích chưa, người dùng đã bấm gì. */
  ticket?: LinkTicketInfo;
  error?: string;
}
interface PairReq {
  id: string;
  extId: string;
  expiresAt: number;
  state: 'pending' | 'approved' | 'denied';
  token?: string;
}
export interface BridgeOptions {
  ports?: readonly number[];
  now?: () => number;
  /** Thời gian giữ bản sao thông tin ghép đôi trước khi đọc lại kho (mặc định 5 giây). */
  credTtlMs?: number;
  /** Chờ extension kết nối tối đa bấy lâu trước khi báo "chưa kết nối" (mặc định 10 giây). */
  connectWaitMs?: number;
  /** (0.7.18) Giữ yêu cầu GET của tiện ích Chrome bản cũ (token sai, không `?v=2`) bấy lâu rồi mới đóng (mặc định 45 giây). */
  oldHoldMs?: number;
  /** (0.7.20) Ứng dụng đang giữ máy chủ cầu này — tiện ích dùng để giữ MỖI ỨNG DỤNG MỘT token và để gọi đúng tên. Mặc định VS Code. */
  app?: BridgeApp;
}

/** (0.7.20) Danh tính ứng dụng của máy chủ cầu: `kind` cố định theo loại ứng dụng (mọi cửa sổ VS Code dùng chung một token), `name` để hiện cho người dùng. */
export interface BridgeApp {
  kind: string;
  name: string;
}

/** (0.7.20) Vé ghép đôi do ỨNG DỤNG khởi xướng: dùng một lần, ngắn hạn, gắn với máy chủ cầu đã tạo nó. */
interface LinkTicket {
  t: string;
  expiresAt: number;
  state: 'pending' | 'paired' | 'denied';
  /** Trang /link báo nó thấy gì: tiện ích đã trả lời (`asked`) hay không có tiện ích nào đủ mới (`missing`). */
  page?: 'asked' | 'missing';
}
/** (0.7.20) Trạng thái vé mới nhất, cho ứng dụng hiện lời đúng («xác nhận trong trình duyệt» / «cài hoặc cập nhật tiện ích»). */
export interface LinkTicketInfo {
  state: 'pending' | 'paired' | 'denied' | 'expired';
  page?: 'asked' | 'missing';
  expiresAt: number;
}
const TICKET_TTL_MS = 2 * 60_000;
const TICKET_MAX = 3;
const TICKET_RE = /^[A-Za-z0-9_-]{24}$/;
/** Mã tiện ích trên Chrome Web Store (Edge cài từ cửa hàng Chrome cũng mang mã này) — trang /link gửi tin tới đó. */
export const STORE_EXTENSION_ID = 'amngiccgboohakecgdiadjkdfcablkjc';
const APP_KIND_RE = /^[a-z][a-z0-9-]{0,23}$/;

interface Job {
  id: string;
  op: string;
  args: unknown;
  claimed: boolean;
  settle(ok: boolean, v: unknown): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const safeEq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class BrowserBridge {
  private server?: http.Server;
  private port = 0;
  private creds: BridgeCreds = {};
  private credsAt = 0;
  private pairing: { code: string; expiresAt: number; tries: number } | null = null;
  private lastPoll = 0;
  private startError?: string;
  private readonly jobs = new Map<string, Job>();
  private readonly waiters = new Set<(j: Job | null) => void>();
  private readonly now: () => number;
  private readonly ports: readonly number[];
  private readonly credTtl: number;
  private readonly connectWait: number;
  private seq = 0;
  private oldRefused = 0;
  private oldRefusedLogAt = 0;
  private readonly held = new Set<http.ServerResponse>();
  private readonly oldHoldMs: number;
  private readonly app: BridgeApp;
  private readonly tickets = new Map<string, LinkTicket>();
  private lastTicketRef?: LinkTicket;
  /** Trạng thái «đã kết nối» và trạng thái vé lần cuối đã báo ra ngoài — để phát sự kiện khi chúng đổi (kể cả vé tự hết hạn). */
  private lastConnected = false;
  private lastTicketState?: string;
  private connTimer?: ReturnType<typeof setInterval>;
  private readonly reqs = new Map<string, PairReq>();
  private reqTimes: number[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: BridgeStore,
    private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void = () => {},
    o: BridgeOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.ports = o.ports ?? BRIDGE_PORTS;
    this.credTtl = o.credTtlMs ?? 5000;
    this.connectWait = o.connectWaitMs ?? 10_000;
    this.oldHoldMs = o.oldHoldMs ?? OLD_HOLD_MS;
    const a = o.app;
    this.app = a && APP_KIND_RE.test(a.kind) && typeof a.name === 'string' && a.name.trim() ? { kind: a.kind, name: a.name.trim().slice(0, 40) } : { kind: 'vscode', name: 'VS Code' };
  }

  /** (0.7.20) Ứng dụng của máy chủ cầu này. */
  appInfo(): BridgeApp {
    return { ...this.app };
  }

  /**
   * (0.7.20) Ghép đôi do ỨNG DỤNG khởi xướng: tạo một vé dùng một lần (2 phút) và trả địa chỉ trang `/link` của chính máy chủ cầu này.
   * Ứng dụng mở địa chỉ đó trong trình duyệt người dùng đang dùng; trang gửi vé cho tiện ích (externally_connectable), tiện ích hỏi người dùng
   * MỘT lần rồi đổi vé lấy token ở `POST /v1/pair/ticket`. Cú bấm «Kết nối» trong ứng dụng (tạo vé) + cú bấm «Kết nối» trong trình duyệt = đủ, không cần thẻ Cho phép.
   */
  async linkTicket(): Promise<{ url: string; expiresAt: number }> {
    await this.start();
    this.gcTickets();
    while (this.tickets.size >= TICKET_MAX) this.tickets.delete(this.tickets.keys().next().value as string);
    const t = randomBytes(18).toString('base64url');
    const expiresAt = this.now() + TICKET_TTL_MS;
    const k: LinkTicket = { t, expiresAt, state: 'pending' };
    this.tickets.set(t, k);
    this.lastTicketRef = k;
    this.emit();
    return { url: `http://127.0.0.1:${this.port}/link?t=${t}`, expiresAt };
  }

  private gcTickets(): void {
    const n = this.now();
    for (const [k, v] of this.tickets) if (v.expiresAt <= n) this.tickets.delete(k);
  }

  /** (0.7.20) Vé mới nhất (kể cả vừa hết hạn trong lần tạo gần nhất), hoặc undefined nếu chưa tạo vé nào. */
  lastTicket(): LinkTicketInfo | undefined {
    const k = this.lastTicketRef;
    if (!k) return undefined;
    const expired = k.state === 'pending' && k.expiresAt <= this.now();
    return { state: expired ? 'expired' : k.state, ...(k.page ? { page: k.page } : {}), expiresAt: k.expiresAt };
  }

  // ── vòng đời ──
  async start(): Promise<number> {
    if (this.server) return this.port;
    this.creds = await this.store.load();
    this.credsAt = this.now();
    for (const p of this.ports) {
      const server = http.createServer((req, res) => void this.handle(req, res).catch(() => this.send(res, 500, { error: 'internal' }, req)));
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(p, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        this.startError = undefined;
        // (0.7.20) báo ra ngoài khi kết nối với trình duyệt bật / tắt (ứng dụng hiện «đã nối trình duyệt» mà không phải hỏi liên tục)
        this.connTimer = setInterval(() => this.checkConnected(), 5000);
        this.connTimer.unref?.();
        this.log('info', `Cầu nối Chrome lắng nghe 127.0.0.1:${this.port}`);
        return this.port;
      }
      server.close();
    }
    this.startError = 'Không mở được cổng cho cầu nối Chrome (các cổng 47615–47620 đang bận).';
    throw new Error(this.startError);
  }

  stop(): void {
    for (const r of [...this.held]) r.destroy(); // yêu cầu của tiện ích bản cũ đang bị giữ: đóng luôn
    this.held.clear();
    if (this.connTimer) clearInterval(this.connTimer);
    this.connTimer = undefined;
    this.server?.closeAllConnections?.();
    this.server?.close();
    this.server = undefined;
    this.port = 0;
    this.rejectAll(new Error('Cầu nối Chrome đã dừng.'));
    for (const w of [...this.waiters]) w(null);
    this.waiters.clear();
  }

  private rejectAll(err: Error): void {
    for (const j of [...this.jobs.values()]) j.settle(false, err);
  }

  /** Báo cho giao diện khi trạng thái ghép đôi đổi (có yêu cầu mới, đã duyệt/từ chối, hết hạn). Trả về hàm huỷ đăng ký. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private emit(): void {
    this.lastConnected = this.connected();
    this.lastTicketState = this.lastTicket()?.state;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        /* một người nghe lỗi không được làm hỏng cầu nối */
      }
    }
  }

  private gcReqs(): void {
    const t = this.now();
    for (const [id, r] of this.reqs) if (r.expiresAt <= t) this.reqs.delete(id);
  }

  /** Yêu cầu ghép đôi (không mã) đang chờ người dùng bấm Cho phép, nếu có. */
  pairRequest(): { id: string; extensionId: string; expiresAt: number } | undefined {
    this.gcReqs();
    for (const r of this.reqs.values()) if (r.state === 'pending') return { id: r.id, extensionId: r.extId, expiresAt: r.expiresAt };
    return undefined;
  }

  /** Người dùng bấm Cho phép: tạo token, lưu (dùng chung mọi cửa sổ VS Code) và để extension nhận nó MỘT lần ở lần hỏi kế tiếp. */
  async approvePair(id: string): Promise<boolean> {
    this.gcReqs();
    const r = this.reqs.get(id);
    if (!r || r.state !== 'pending') return false;
    const token = randomBytes(32).toString('base64url');
    this.creds = { token, extId: r.extId };
    this.credsAt = this.now();
    this.pairing = null;
    await this.store.save(this.creds);
    r.state = 'approved';
    r.token = token;
    this.log('info', `Đã ghép đôi (người dùng cho phép) với extension Chrome ${r.extId}`);
    this.emit();
    return true;
  }

  denyPair(id: string): boolean {
    this.gcReqs();
    const r = this.reqs.get(id);
    if (!r || r.state !== 'pending') return false;
    r.state = 'denied';
    this.emit();
    return true;
  }

  status(): BridgeStatus {
    const pairing = this.pairing && this.pairing.expiresAt > this.now() ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : undefined;
    const req = this.pairRequest();
    const ticket = this.lastTicket();
    return {
      running: !!this.server,
      ...(this.port ? { port: this.port } : {}),
      paired: !!this.creds.token,
      connected: this.connected(),
      ...(this.creds.extId ? { extensionId: this.creds.extId } : {}),
      ...(pairing ? { pairing } : {}),
      ...(req ? { pairRequest: req } : {}),
      ...(ticket ? { ticket } : {}),
      ...(this.startError ? { error: this.startError } : {}),
    };
  }

  connected(): boolean {
    return !!this.server && this.now() - this.lastPoll < CONNECTED_MS;
  }

  /** (0.7.20) Nhịp 5 giây + mỗi lần tiện ích hỏi lệnh: báo ra ngoài khi «đã kết nối» bật / tắt hoặc vé vừa tự hết hạn. */
  private checkConnected(): void {
    if (this.connected() !== this.lastConnected || this.lastTicket()?.state !== this.lastTicketState) this.emit();
  }

  async startPairing(): Promise<{ code: string; expiresAt: number }> {
    await this.start();
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    code = `${code.slice(0, 4)}-${code.slice(4)}`;
    this.pairing = { code, expiresAt: this.now() + PAIR_TTL_MS, tries: 0 };
    return { code, expiresAt: this.pairing.expiresAt };
  }

  async unpair(): Promise<void> {
    this.creds = {};
    this.pairing = null;
    await this.store.save({});
    this.rejectAll(new Error('Đã huỷ ghép đôi với Chrome.'));
    for (const w of [...this.waiters]) w(null);
  }

  // ── gọi lệnh sang Chrome ──
  async call(op: string, args: unknown, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    await this.refreshCreds(true);
    if (!this.creds.token) throw new Error('Chrome chưa được ghép đôi. Mở Chợ → Chrome và làm theo hướng dẫn ghép đôi.');
    if (!this.server) await this.start();
    const deadline = this.now() + this.connectWait;
    while (!this.connected() && this.now() < deadline && !o.signal?.aborted) await sleep(100);
    if (!this.connected()) throw new Error('Extension Locaith trên Chrome chưa kết nối (Chrome đang tắt, hoặc extension chưa được bật cầu nối).');
    const timeoutMs = o.timeoutMs ?? 90_000;
    return new Promise<unknown>((resolve, reject) => {
      const id = `j${(++this.seq).toString(36)}${randomBytes(4).toString('hex')}`;
      let done = false;
      const timer = setTimeout(() => settle(false, new Error(`Chrome không phản hồi sau ${Math.round(timeoutMs / 1000)} giây.`)), timeoutMs);
      const onAbort = () => settle(false, new Error('Đã dừng.'));
      const settle = (ok: boolean, v: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        this.jobs.delete(id);
        if (ok) resolve(v);
        else reject(v instanceof Error ? v : new Error(String(v)));
      };
      if (o.signal?.aborted) return settle(false, new Error('Đã dừng.'));
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const job: Job = { id, op, args, claimed: false, settle };
      this.jobs.set(id, job);
      this.dispatch();
    });
  }

  /** Giao việc chưa nhận cho một yêu cầu poll đang chờ. */
  private dispatch(): void {
    for (const j of this.jobs.values()) {
      if (j.claimed) continue;
      const w = this.waiters.values().next().value as ((j: Job | null) => void) | undefined;
      if (!w) return;
      this.waiters.delete(w);
      j.claimed = true;
      w(j);
    }
  }

  // ── HTTP ──
  private async refreshCreds(force = false): Promise<void> {
    if (!force && this.now() - this.credsAt < this.credTtl) return;
    this.creds = await this.store.load();
    this.credsAt = this.now();
  }

  private send(res: http.ServerResponse, code: number, body: unknown, req?: http.IncomingMessage): void {
    const origin = String(req?.headers.origin ?? '');
    const h: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Origin' };
    if (EXT_ORIGIN.test(origin) && code !== 403) {
      h['access-control-allow-origin'] = origin;
      h['access-control-allow-private-network'] = 'true';
    }
    res.writeHead(code, h);
    res.end(code === 204 ? undefined : JSON.stringify(body));
  }

  /**
   * Từ chối một yêu cầu cần token.
   *
   * Tiện ích Chrome bản cũ (≤ 0.7.16: gọi từ trình duyệt mà KHÔNG gắn `?v=2`, xem shared/linkProtocol.ts) bỏ quên thân câu trả lời lỗi: mỗi 401 nó
   * rò một vùng nhớ 2 MB và hỏi lại mỗi 7 giây mãi mãi. Với nó, KHÔNG đưa câu trả lời nào:
   *  • GET (ping / poll): GIỮ yêu cầu không trả lời tối đa `oldHoldMs` (45 giây) rồi đóng. Chrome tự dừng dịch vụ nền có fetch chờ quá 30 giây,
   *    nên bản cũ ngừng hẳn và Chrome áp được bản cập nhật đang treo (vòng gọi cũ giữ dịch vụ nền thức mãi nên Chrome không bao giờ áp được);
   *  • yêu cầu khác, hoặc đã giữ đủ `OLD_HOLD_MAX` yêu cầu: đóng kết nối ngay.
   * «Từ trình duyệt» = có Origin của tiện ích HOẶC có tiêu đề Sec-Fetch-*: Chrome KHÔNG gắn Origin vào GET gửi từ tiện ích (đo trên Chrome và Edge
   * 18/11 và 25/11/2026) — bản 0.7.17 chỉ xét Origin nên ping / poll của bản cũ lọt qua và vẫn nhận 401 kèm thân (máy thật 25/11: 3,9 GB).
   * Bản mới (có dấu) và tiến trình cục bộ (không Origin, không Sec-Fetch-*) vẫn nhận mã lỗi rõ ràng.
   */
  private refuse(req: http.IncomingMessage, res: http.ServerResponse, url: URL, em: RegExpExecArray | null, code: 401 | 403, error: string): void {
    const fromBrowser = !!em || typeof req.headers['sec-fetch-mode'] === 'string' || typeof req.headers['sec-fetch-site'] === 'string';
    if (fromBrowser && url.searchParams.get('v') !== LINK_PROTO) {
      this.oldRefused++;
      const t = this.now();
      if (t - this.oldRefusedLogAt > 10 * 60_000) {
        this.oldRefusedLogAt = t;
        this.log(
          'warn',
          `Cầu nối Chrome: tiện ích Chrome bản cũ dùng token không còn hiệu lực — không trả lời để nó không rò bộ nhớ (${this.oldRefused} lần). Khởi động lại Chrome để nhận bản tiện ích mới, rồi ghép đôi lại nếu cần.`,
        );
      }
      if (req.method === 'GET' && this.held.size < OLD_HOLD_MAX) {
        this.held.add(res);
        const timer = setTimeout(() => res.destroy(), this.oldHoldMs);
        res.on('close', () => {
          clearTimeout(timer);
          this.held.delete(res);
        });
        return;
      }
      res.destroy();
      return;
    }
    return this.send(res, code, { error }, req);
  }

  /** Số yêu cầu của tiện ích bản cũ đang bị giữ không trả lời (chẩn đoán / test). */
  heldOldClients(): number {
    return this.held.size;
  }

  /** Số lần đã đóng kết nối của tiện ích Chrome bản cũ dùng token sai (chẩn đoán / test). */
  oldClientRefusals(): number {
    return this.oldRefused;
  }

  private async readBody(req: http.IncomingMessage): Promise<unknown | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) return undefined;
      chunks.push(c as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return null;
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!HOST_OK.test(String(req.headers.host ?? ''))) return this.send(res, 403, { error: 'host' }, req);
    const origin = req.headers.origin === undefined ? undefined : String(req.headers.origin);
    const em = origin === undefined ? null : EXT_ORIGIN.exec(origin);
    if (origin !== undefined && !em) return this.send(res, 403, { error: 'origin' }, req); // trang web (https://…) không được chạm vào cầu nối
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST');
      res.setHeader('access-control-max-age', '600');
      return this.send(res, 204, null, req);
    }
    await this.refreshCreds();
    // (0.7.20) Danh tính ứng dụng (không token): tiện ích biết cổng nào là VS Code, cổng nào là Locaith Work… để dùng đúng token của ứng dụng đó.
    if (req.method === 'GET' && url.pathname === '/v1/hello') return this.send(res, 200, { v: 2, app: this.app }, req);
    // (0.7.20) Ghép đôi do ứng dụng khởi xướng: trang /link (người dùng mở trong trình duyệt của mình) + script của nó + trạng thái vé.
    if (req.method === 'GET' && url.pathname === '/link') return this.linkPage(res, url.searchParams.get('t') ?? '');
    if (req.method === 'GET' && url.pathname === '/link.js') return this.linkScript(res);
    if (req.method === 'GET' && url.pathname === '/link/state') return this.linkState(req, res, url.searchParams.get('t') ?? '', url.searchParams.get('page') ?? '');
    if (url.pathname === '/link' || url.pathname === '/link.js' || url.pathname === '/link/state') return this.send(res, 405, { error: 'method' }, req);
    if (req.method === 'POST' && url.pathname === '/v1/pair/ticket') return this.ticketRedeem(req, res, em?.[1]);
    if (req.method === 'POST' && url.pathname === '/v1/pair/ticket/deny') return this.ticketDeny(req, res, em?.[1]);
    if (req.method === 'POST' && url.pathname === '/v1/pair') return this.pair(req, res, em?.[1]);
    // Ghép đôi KHÔNG MÃ — không cần token (chưa có), nhưng chỉ extension (Origin chrome-extension://) và cần người dùng bấm Cho phép trong VS Code.
    if (url.pathname === '/v1/pair/request' && req.method === 'POST') return this.pairRequestHttp(req, res, em?.[1]);
    if (url.pathname === '/v1/pair/status' && req.method === 'GET') return this.pairStatusHttp(req, res, em?.[1], url.searchParams.get('id') ?? '');
    // Bản POST (từ bản Chrome 0.7.12): Chrome không gắn Origin vào GET gửi từ extension nên GET ở trên không bao giờ biết extension nào đang hỏi; POST luôn có Origin.
    if (url.pathname === '/v1/pair/status' && req.method === 'POST') {
      const b = (await this.readBody(req)) as { id?: unknown } | null | undefined;
      return this.pairStatusHttp(req, res, em?.[1], typeof b?.id === 'string' ? b.id : '');
    }
    if (url.pathname === '/v1/pair/cancel' && req.method === 'POST') return this.pairCancelHttp(req, res, em?.[1]);

    const auth = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!this.creds.token || !auth || !safeEq(auth, this.creds.token)) return this.refuse(req, res, url, em, 401, 'unauthorized');
    if (em && this.creds.extId && em[1] !== this.creds.extId) return this.refuse(req, res, url, em, 403, 'origin');

    if (req.method === 'GET' && url.pathname === '/v1/ping') return this.send(res, 200, { ok: true, v: BRIDGE_VERSION }, req);
    if (req.method === 'GET' && url.pathname === '/v1/poll') {
      this.lastPoll = this.now();
      this.checkConnected();
      const wait = Math.max(0, Math.min(MAX_WAIT_S, Number(url.searchParams.get('wait') ?? 20) || 0));
      const job = await new Promise<Job | null>((resolve) => {
        const first = [...this.jobs.values()].find((j) => !j.claimed);
        if (first) {
          first.claimed = true;
          return resolve(first);
        }
        const w = (j: Job | null) => {
          clearTimeout(t);
          this.waiters.delete(w);
          resolve(j);
        };
        const t = setTimeout(() => w(null), wait * 1000);
        this.waiters.add(w);
        req.on('close', () => {
          if (this.waiters.has(w)) w(null);
        });
      });
      this.lastPoll = this.now();
      return this.send(res, 200, job ? { job: { id: job.id, op: job.op, args: job.args } } : {}, req);
    }
    if (req.method === 'POST' && url.pathname === '/v1/result') {
      const b = (await this.readBody(req)) as { id?: unknown; ok?: unknown; data?: unknown; error?: unknown } | null | undefined;
      if (b === undefined) return this.send(res, 413, { error: 'too_large' }, req);
      if (!b || typeof b.id !== 'string') return this.send(res, 400, { error: 'bad_request' }, req);
      const job = this.jobs.get(b.id);
      if (job?.claimed) job.settle(b.ok === true, b.ok === true ? b.data : new Error(typeof b.error === 'string' ? b.error.slice(0, 2000) : 'Lỗi từ Chrome'));
      return this.send(res, 200, { ok: !!job }, req);
    }
    return this.send(res, 404, { error: 'not_found' }, req);
  }

  private pairRequestHttp(req: http.IncomingMessage, res: http.ServerResponse, extId: string | undefined): void {
    if (!extId) return this.send(res, 403, { error: 'origin' }, req);
    this.gcReqs();
    for (const r of this.reqs.values()) {
      if (r.state !== 'pending') continue;
      if (r.extId === extId) return this.send(res, 200, { id: r.id, expiresAt: r.expiresAt }, req); // xin lại: trả lại đúng yêu cầu đang chờ
      return this.send(res, 429, { error: 'busy' }, req); // đang chờ người dùng quyết định cho extension khác
    }
    const t = this.now();
    this.reqTimes = this.reqTimes.filter((x) => t - x < 60_000);
    if (this.reqTimes.length >= REQ_PER_MIN) return this.send(res, 429, { error: 'rate_limited' }, req);
    this.reqTimes.push(t);
    const id = randomBytes(12).toString('base64url');
    const r: PairReq = { id, extId, expiresAt: t + REQ_TTL_MS, state: 'pending' };
    this.reqs.set(id, r);
    this.log('info', `Extension Chrome ${extId} xin kết nối — chờ người dùng bấm Cho phép`);
    this.emit();
    return this.send(res, 200, { id, expiresAt: r.expiresAt }, req);
  }

  private pairStatusHttp(req: http.IncomingMessage, res: http.ServerResponse, extId: string | undefined, id: string): void {
    if (!extId) return this.send(res, 403, { error: 'origin' }, req);
    this.gcReqs();
    const r = this.reqs.get(id);
    if (!r || r.extId !== extId) return this.send(res, 200, { state: 'expired' }, req); // không lộ yêu cầu của extension khác
    if (r.state === 'pending') return this.send(res, 200, { state: 'pending', expiresAt: r.expiresAt }, req);
    this.reqs.delete(id); // đã quyết định: giao kết quả MỘT lần rồi quên
    this.emit();
    if (r.state === 'approved') return this.send(res, 200, { state: 'approved', token: r.token, v: BRIDGE_VERSION, app: this.app }, req);
    return this.send(res, 200, { state: 'denied' }, req);
  }

  // ── (0.7.20) ghép đôi do ứng dụng khởi xướng ─────────────────────────────────

  private sendRaw(res: http.ServerResponse, code: number, type: string, body: string): void {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  }

  private linkPage(res: http.ServerResponse, t: string): void {
    this.gcTickets();
    const live = TICKET_RE.test(t) && this.tickets.get(t)?.state === 'pending';
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
    const app = esc(this.app.name);
    const store = `https://chromewebstore.google.com/detail/${STORE_EXTENSION_ID}`;
    const title = live ? `Kết nối trình duyệt này với ${app}` : 'Liên kết kết nối trình duyệt';
    const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:#0f1115;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:520px;padding:28px 32px;border:1px solid #2a2f3a;border-radius:14px;background:#161a22}h1{font-size:18px;margin:0 0 10px}p{margin:8px 0;color:#c6cad2}.en{color:#8a909c;font-size:13px}a.btn{display:inline-block;margin-top:10px;padding:8px 14px;border-radius:8px;background:#3b6cf6;color:#fff;text-decoration:none}[hidden]{display:none}</style></head>
<body data-state="${live ? 'pending' : 'expired'}" data-store="${esc(STORE_EXTENSION_ID)}"><main>
<h1>${title}</h1>
<section id="s-try"><p>Đang gọi tiện ích Locaith AI trong trình duyệt…</p><p class="en">Asking the Locaith AI extension in this browser…</p></section>
<section id="s-ask" hidden><p>Tiện ích Locaith AI vừa mở một cửa sổ nhỏ: bấm <b>«Kết nối»</b> ở đó để ${app} điều khiển được các trang bạn cho phép (mỗi trang vẫn hỏi bạn trước).</p><p class="en">Click <b>Connect</b> in the small Locaith AI window that just opened.</p></section>
<section id="s-done" hidden><p><b>Đã kết nối.</b> Bạn có thể đóng tab này.</p><p class="en">Connected. You can close this tab.</p></section>
<section id="s-denied" hidden><p>Bạn đã không kết nối. Bấm «Kết nối» trong ${app} nếu muốn thử lại.</p><p class="en">Not connected. Use Connect in ${app} to try again.</p></section>
<section id="s-expired" hidden><p>Liên kết này đã hết hạn hoặc đã dùng. Bấm «Kết nối» lại trong ứng dụng để lấy liên kết mới.</p><p class="en">This link has expired or was already used. Use Connect in the app again.</p></section>
<section id="s-consent" hidden><p>Mở tiện ích Locaith AI một lần và bấm «Đồng ý» ở thông báo dữ liệu, rồi tải lại trang này.</p><p class="en">Open the Locaith AI extension once, accept its data notice, then reload this page.</p></section>
<section id="s-missing" hidden><p>Chưa thấy tiện ích Locaith AI (bản 0.7.20 trở lên) trong trình duyệt này.</p><p><a class="btn" href="${store}" target="_blank" rel="noopener noreferrer">Cài từ Chrome Web Store</a></p><p>Đã cài rồi? Cập nhật tiện ích lên bản mới rồi tải lại trang này.</p><p class="en">The Locaith AI extension (0.7.20 or later) was not found. Install or update it, then reload this page.</p></section>
</main><script src="/link.js"></script></body></html>`;
    return this.sendRaw(res, 200, 'text/html; charset=utf-8', html);
  }

  private linkScript(res: http.ServerResponse): void {
    const js = `(() => {
  const q = new URLSearchParams(location.search);
  const t = q.get('t') || '';
  const ids = [document.body.dataset.store, ...(q.get('ext') || '').split(',')].filter((x) => /^[a-p]{32}$/.test(x || ''));
  const all = ['s-try', 's-ask', 's-done', 's-denied', 's-expired', 's-consent', 's-missing'];
  const show = (id) => all.forEach((s) => { document.getElementById(s).hidden = s !== id; });
  if (document.body.dataset.state !== 'pending') return show('s-expired');
  let answered = false;
  const report = (page) => fetch('/link/state?t=' + encodeURIComponent(t) + '&page=' + page, { cache: 'no-store' }).catch(() => undefined);
  const rt = window.chrome && chrome.runtime && chrome.runtime.sendMessage ? chrome.runtime : null;
  if (rt) for (const id of [...new Set(ids)]) {
    try {
      rt.sendMessage(id, { type: 'nd-link-ticket', t, v: 2 }, (r) => {
        void (chrome.runtime && chrome.runtime.lastError);
        if (!r) return;
        answered = true;
        show(r.ok ? 's-ask' : r.reason === 'consent' ? 's-consent' : 's-missing');
        if (r.ok) report('asked');
      });
    } catch (e) { /* tiện ích này không có ở đây */ }
  }
  setTimeout(() => { if (!answered) { show('s-missing'); report('missing'); } }, 3000);
  const poll = async () => {
    try {
      const j = await (await fetch('/link/state?t=' + encodeURIComponent(t), { cache: 'no-store' })).json();
      if (j.state === 'paired') return show('s-done');
      if (j.state === 'denied') return show('s-denied');
      if (j.state === 'expired') return show('s-expired');
    } catch (e) { /* thử lại */ }
    setTimeout(poll, 1000);
  };
  setTimeout(poll, 800);
})();`;
    return this.sendRaw(res, 200, 'text/javascript; charset=utf-8', js);
  }

  private linkState(req: http.IncomingMessage, res: http.ServerResponse, t: string, page: string): void {
    this.gcTickets();
    const k = TICKET_RE.test(t) ? this.tickets.get(t) : undefined;
    // trang báo nó thấy gì; «asked» (tiện ích đã trả lời) không bị «missing» đến muộn ghi đè
    if (k && (page === 'asked' || (page === 'missing' && k.page !== 'asked')) && k.page !== page) {
      k.page = page;
      this.emit();
    }
    return this.send(res, 200, { state: k ? k.state : 'expired' }, req);
  }

  /** Tiện ích (Origin chrome-extension://…, sau khi người dùng bấm «Kết nối» trong trình duyệt) đổi vé lấy token — MỘT lần. */
  private async ticketRedeem(req: http.IncomingMessage, res: http.ServerResponse, extId: string | undefined): Promise<void> {
    if (!extId) return this.send(res, 403, { error: 'origin' }, req);
    const b = (await this.readBody(req)) as { t?: unknown } | null | undefined;
    if (b === undefined) return this.send(res, 413, { error: 'too_large' }, req);
    this.gcTickets();
    const t = typeof b?.t === 'string' && TICKET_RE.test(b.t) ? b.t : '';
    const k = t ? this.tickets.get(t) : undefined;
    if (!k || k.state !== 'pending') return this.send(res, 410, { error: 'expired' }, req);
    const token = randomBytes(32).toString('base64url');
    this.creds = { token, extId };
    this.credsAt = this.now();
    await this.store.save(this.creds);
    k.state = 'paired';
    this.log('info', `Đã ghép đôi (vé do ${this.app.name} tạo, người dùng bấm Kết nối trong trình duyệt) với extension Chrome ${extId}`);
    this.emit();
    return this.send(res, 200, { token, v: BRIDGE_VERSION, app: this.app }, req);
  }

  private async ticketDeny(req: http.IncomingMessage, res: http.ServerResponse, extId: string | undefined): Promise<void> {
    if (!extId) return this.send(res, 403, { error: 'origin' }, req);
    const b = (await this.readBody(req)) as { t?: unknown } | null | undefined;
    const t = typeof b?.t === 'string' && TICKET_RE.test(b.t) ? b.t : '';
    const k = t ? this.tickets.get(t) : undefined;
    if (k && k.state === 'pending') {
      k.state = 'denied';
      this.emit();
    }
    return this.send(res, 200, { ok: true }, req);
  }

  private async pairCancelHttp(req: http.IncomingMessage, res: http.ServerResponse, extId: string | undefined): Promise<void> {
    if (!extId) return this.send(res, 403, { error: 'origin' }, req);
    const b = (await this.readBody(req)) as { id?: unknown } | null | undefined;
    const r = typeof b?.id === 'string' ? this.reqs.get(b.id) : undefined;
    if (r && r.extId === extId && r.state === 'pending') {
      this.reqs.delete(r.id);
      this.emit();
    }
    return this.send(res, 200, { ok: true }, req);
  }

  private async pair(req: http.IncomingMessage, res: http.ServerResponse, extId: string | undefined): Promise<void> {
    const p = this.pairing;
    if (!extId) return this.send(res, 403, { error: 'origin' }, req);
    if (!p || p.expiresAt <= this.now()) return this.send(res, 403, { error: 'no_pairing' }, req);
    const b = (await this.readBody(req)) as { code?: unknown } | null | undefined;
    if (b === undefined) return this.send(res, 413, { error: 'too_large' }, req);
    const code = typeof b?.code === 'string' ? b.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (!code || !safeEq(code, p.code.replace('-', ''))) {
      if (++p.tries >= MAX_TRIES) this.pairing = null; // thử sai quá nhiều: huỷ mã
      return this.send(res, 403, { error: 'bad_code' }, req);
    }
    const token = randomBytes(32).toString('base64url');
    this.creds = { token, extId };
    this.credsAt = this.now();
    this.pairing = null;
    await this.store.save(this.creds);
    this.log('info', `Đã ghép đôi với extension Chrome ${extId}`);
    return this.send(res, 200, { token, v: BRIDGE_VERSION, app: this.app }, req);
  }
}
