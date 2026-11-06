/**
 * Phía HOST của Remote qua relay: nhận ghép đôi và phiên mã hoá đầu-cuối từ trình duyệt (locaith.ai) qua một kênh Realtime công khai,
 * rồi nối chúng vào cùng "trung tâm" với đường HTTP cục bộ (RemoteServer): cùng luồng sự kiện có số thứ tự, cùng bộ lệnh được phép, cùng giới hạn tốc độ.
 *
 * Giao thức và mô hình đe doạ: xem e2e.ts (mật mã) và docs/REMOTE-RELAY.md. Tóm tắt những gì tệp này bảo đảm:
 *  • relay chỉ thấy bản mã — mọi tin nghiệp vụ nằm trong khung `d` AES-256-GCM; tin ghép đôi/bắt tay được xác thực bằng HMAC (psk / K_dev);
 *  • ghép đôi chỉ mở khi NGƯỜI NGỒI Ở MÁY khởi động (psk 128 bit trong liên kết/QR trên màn hình VS Code, hiệu lực 5 phút, một lần)
 *    và còn phải bấm «Cho phép» sau khi so mã SAS. MAC sai bị bỏ im lặng; KHÔNG đóng cửa sổ khi gặp MAC sai (psk 128 bit nên dò vô ích,
 *    còn đóng cửa sổ chỉ giúp kẻ biết tên kênh phá việc ghép đôi của chủ máy) — chỉ giới hạn tốc độ xử lý;
 *  • tin lạ/giả/phát lại bị bỏ im lặng (không phản hồi, không lộ gì): MAC sai, nonce trùng, khung `d` không giải mã được, bộ đếm `q` lùi;
 *  • giới hạn số phiên/thiết bị, phiên chưa xác lập hết hạn 30 giây, phiên im lặng 90 giây bị bỏ;
 *  • thu hồi thiết bị (từ VS Code) ngắt ngay mọi phiên của nó;
 *  • (0.6.5) phiên «tài khoản»: trình duyệt đã đăng nhập ĐÚNG tài khoản Locaith của chủ máy bắt tay thẳng bằng khoá suy ra từ «khoá tài khoản» của máy
 *    (`deriveAccountKey`; khoá này chỉ chủ tài khoản đọc được từ danh bạ máy) — không ghép đôi, không hộp thoại. Gốc tin cậy là tài khoản Locaith (như Claude Remote
 *    Control của Anthropic) chứ không còn là «người ngồi ở máy»; phiên vẫn mã hoá đầu-cuối và có bí mật chuyển tiếp. Đổi khoá hoặc tắt tính năng cắt phiên ngay.
 * Không import `vscode`.
 */

import {
  ACCOUNT_DEV,
  DEV_BYTES,
  PSK_BYTES,
  Reassembler,
  SecureChannel,
  b64u,
  deriveAccountKey,
  derivePairing,
  deriveSession,
  ecdh,
  encodeJson,
  genEcdh,
  hmacVerify,
  lp,
  macHelloOk,
  macPairHello,
  macPairNo,
  macPairOk,
  parseWire,
  randomBytes,
  unb64u,
  type Wire,
} from './e2e';
import type { QueueState } from './queue';
import type { RemoteServer, Sink } from './server';

export type RelayStatus = 'idle' | 'connecting' | 'online' | 'offline';

/** Đường truyền: một kênh quảng bá công khai. Tin là object JSON nhỏ (≤ ~64 KB); `send` trả false khi chưa gửi được. */
export interface RelayLink {
  readonly status: RelayStatus;
  start(): void;
  stop(): void;
  send(msg: object): boolean;
  onMessage(cb: (m: unknown) => void): () => void;
  onStatus(cb: (s: RelayStatus) => void): () => void;
  /** Khai báo hiện diện (siêu dữ liệu KHÔNG bí mật) để trang web biết máy đang trực tuyến. */
  track?(meta: object): void;
  /** Đang xếp hàng vì relay QUÁ TẢI? (xem queue.ts). Đường truyền không có khái niệm này (kiểm thử, cục bộ) thì bỏ qua. */
  readonly queue?: QueueState | null;
  onQueue?(cb: (q: QueueState | null) => void): () => void;
  /** Thử vào lại ngay thay vì chờ hết giờ; false = chưa được phép. */
  retryNow?(): boolean;
}

export interface PairRequest {
  label: string;
  /** Mã so sánh 6 chữ số «123 456» — phải trùng với mã hiện trên trình duyệt. */
  sas: string;
}

export interface RelayHostOptions {
  hostId: string;
  server: RemoteServer;
  link: RelayLink;
  /** Hỏi người ngồi ở máy có cho thiết bị này ghép đôi không (hộp thoại trong VS Code). */
  approve: (req: PairRequest) => Promise<boolean>;
  presence?: () => object;
  /** Diễn biến ghép đôi để giao diện (khung QR…) cập nhật: có người xin → đã ghép / bị từ chối / hết hạn. */
  onPair?: (e: { state: 'requested'; label: string; sas: string } | { state: 'done'; label: string } | { state: 'denied' | 'expired' }) => void;
  now?: () => number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  onChange?: () => void;
  timing?: Partial<Timing>;
  /**
   * Khoá tài khoản hiện hành của máy (base64url 22 ký tự = 16 byte) hoặc null = TẮT tin cậy theo tài khoản (chỉ ghép đôi bằng liên kết/QR như trước).
   * Trình duyệt đã đăng nhập đúng tài khoản lấy khoá này từ danh bạ máy (RPC chỉ trả cho chủ tài khoản) và mở phiên ngay, không ghép đôi, không hộp thoại.
   * Được đọc lại ở mỗi lần bắt tay và mỗi nhịp bảo trì: xoay khoá hoặc tắt tính năng là cắt mọi phiên «tài khoản» ngay.
   */
  accountKey?: () => string | null;
  /** Một phiên «tài khoản» vừa được xác lập — để khung chat báo cho chủ máy biết có thiết bị mới vào. */
  onAccountSession?: (e: { sessions: number }) => void;
}

interface Timing {
  flushMs: number;
  heartbeatMs: number;
  sweepMs: number;
  helloTimeoutMs: number;
  idleMs: number;
  pairTtlMs: number;
}

const DEFAULT_TIMING: Timing = { flushMs: 60, heartbeatMs: 15_000, sweepMs: 5_000, helloTimeoutMs: 30_000, idleMs: 90_000, pairTtlMs: 5 * 60_000 };
const MAX_SESSIONS_PER_DEVICE = 5;
/** Phiên «tài khoản» (mọi trình duyệt đã đăng nhập đúng tài khoản dùng chung một thiết bị ảo): tối đa bấy nhiêu phiên cùng lúc, phiên cũ nhất bị đóng trước. */
const MAX_ACCOUNT_SESSIONS = 10;
const ACCOUNT_LABEL = 'Tài khoản Locaith';
const MAX_SESSIONS = 20;
/**
 * Số nonce hello nhớ lại. Theo SỐ LƯỢNG chứ không theo thời gian: hello không có dấu thời gian nên nếu nonce hết hạn sau vài phút thì một hello ghi lại từ trước có thể được
 * phát lại bất cứ lúc nào sau đó (mở «phiên ma» chiếm chỗ, đuổi phiên thật khi chạm trần, báo «trình duyệt mới vào» giả). Chỉ hello ĐÚNG MAC mới được nhớ nên kẻ lạ không
 * làm tràn bảng này được; host khởi động lại thì bảng rỗng (phiên ma không có khoá phiên nên cũng bị dọn sau `helloTimeoutMs`).
 */
const NONCE_KEEP = 4096;
const PAIR_REQ_PER_MIN = 30;
const HELLO_NO_PER_MIN = 6;
const MAX_BATCH_CHARS = 1_000_000;
const MAX_BUFFERED_CHARS = 16 * 1024 * 1024;
const MAX_BAD_FRAMES = 25;

const cleanLabel = (v: unknown): string => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) : '';
  return s || 'Trình duyệt';
};

interface Pairing {
  psk: Uint8Array;
  expiresAt: number;
  /** Yêu cầu đang xử lý/chờ người dùng bấm Cho phép (nC của nó). `hello` có sau khi tính xong khoá. */
  active?: { nC: string; hello?: object };
}

class Session {
  readonly sidB64: string;
  readonly createdAt: number;
  lastRx: number;
  established = false;
  badFrames = 0;
  detach?: () => void;
  sink?: RelaySink;
  closed = false;
  /** Phiên «tài khoản»: không có bản ghi thiết bị; `acctGen` = thế hệ khoá tài khoản lúc bắt tay (khoá đổi → phiên bị cắt). */
  acctGen = 0;
  private tx: Promise<void> = Promise.resolve();
  private rx: Promise<void> = Promise.resolve();
  private mid = 0;
  private outbox: string[] = [];
  private outChars = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  readonly rasm: Reassembler;

  constructor(
    private readonly host: RelayHost,
    readonly sid: Uint8Array,
    readonly devId: string,
    readonly label: string,
    readonly ch: SecureChannel,
    now: number,
    readonly account = false,
  ) {
    this.sidB64 = b64u(sid);
    this.createdAt = now;
    this.lastRx = now;
    this.rasm = new Reassembler(() => host.now());
  }

  get pendingChars(): number {
    return this.outChars;
  }

  /** Xếp hàng xử lý tin đến theo đúng thứ tự (giải mã + cập nhật bộ đếm phải tuần tự). */
  enqueueRx(job: () => Promise<void>): void {
    this.rx = this.rx.then(job).catch(() => undefined);
  }

  /** Gửi ngay một tin JSON (đã tuần tự hoá), giữ đúng thứ tự với các tin trước. */
  sendJson(json: string): void {
    if (this.closed) return;
    this.tx = this.tx.then(async () => {
      for (const frame of encodeJson(json, ++this.mid)) {
        const { q, c } = await this.ch.seal(frame);
        this.host.rawSend({ t: 'd', s: this.sidB64, q, c: b64u(c) });
      }
    }).catch(() => undefined);
  }

  /** Gom các sự kiện luồng trong một nhịp ngắn rồi gửi một khung (giảm số tin Realtime/giây). */
  queueEvent(json: string): void {
    if (this.closed) return;
    this.outbox.push(json);
    this.outChars += json.length;
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), this.host.timing.flushMs);
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const items = this.outbox;
    this.outbox = [];
    this.outChars = 0;
    if (!items.length) return;
    let batch: string[] = [];
    let size = 0;
    const emit = () => {
      if (!batch.length) return;
      this.sendJson(batch.length === 1 ? `{"k":"ev","m":${batch[0]}}` : `{"k":"batch","m":[${batch.join(',')}]}`);
      batch = [];
      size = 0;
    };
    for (const j of items) {
      if (size + j.length > MAX_BATCH_CHARS) emit();
      batch.push(j);
      size += j.length;
    }
    emit();
  }

  /** Đóng phiên sau khi gửi hết những gì còn chờ (ví dụ tin `bye`). */
  finish(): void {
    if (this.closed) return;
    this.flush();
    const done = this.tx.then(() => {
      this.closed = true;
      this.host.removeSession(this);
    });
    done.catch(() => undefined);
  }

  /** Đóng ngay, không gửi gì thêm. */
  kill(): void {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.outbox = [];
    this.outChars = 0;
    this.detach?.();
    this.detach = undefined;
    this.host.removeSession(this);
  }
}

/** Đầu ra luồng sự kiện của một phiên relay. */
class RelaySink implements Sink {
  constructor(private readonly s: Session) {}
  write(_seq: number, _type: string, json: string): void {
    this.s.queueEvent(json);
  }
  buffered(): number {
    return this.s.pendingChars > MAX_BUFFERED_CHARS ? MAX_BUFFERED_CHARS + 1 : 0;
  }
  close(): void {
    this.s.finish();
  }
}

export class RelayHost {
  readonly timing: Timing;
  private pairing: Pairing | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly nonces = new Map<string, number>();
  /** Nonce của các hello đang được xử lý dở (chưa kiểm xong MAC): hai bản GIỐNG HỆT đến cùng lúc không được cùng thành công. */
  private readonly nonceBusy = new Set<string>();
  private helloNoTimes: number[] = [];
  private known = new Set<string>();
  private readonly offs: (() => void)[] = [];
  private release?: () => void;
  private sweeper?: ReturnType<typeof setInterval>;
  private beater?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly clock: () => number;
  private readonly log: NonNullable<RelayHostOptions['log']>;

  constructor(private readonly o: RelayHostOptions) {
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.clock = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  now(): number {
    return this.clock();
  }

  get hostId(): string {
    return this.o.hostId;
  }

  get status(): RelayStatus {
    return this.running ? this.o.link.status : 'idle';
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get pairingState(): { expiresAt: number } | null {
    return this.pairing && this.pairing.expiresAt > this.now() ? { expiresAt: this.pairing.expiresAt } : null;
  }

  // ── vòng đời ──────────────────────────────────────────────────────────────
  start(): void {
    if (this.running) return;
    this.running = true;
    this.release = this.o.server.retainRelay();
    this.offs.push(
      this.o.link.onMessage((m) => this.onMessage(m)),
      this.o.link.onStatus((s) => {
        if (s === 'online') this.o.link.track?.(this.o.presence?.() ?? {});
        this.o.onChange?.();
      }),
    );
    this.o.link.start();
    this.sweeper = setInterval(() => void this.sweep(), this.timing.sweepMs);
    this.beater = setInterval(() => this.heartbeat(), this.timing.heartbeatMs);
    this.sweeper.unref?.();
    this.beater.unref?.();
    void this.refreshKnown();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.beater) clearInterval(this.beater);
    this.sweeper = this.beater = undefined;
    for (const off of this.offs.splice(0)) off();
    for (const s of [...this.sessions.values()]) {
      s.sendJson('{"k":"ev","m":{"type":"bye","seq":0,"reason":"stopped"}}');
      s.finish();
    }
    this.pairing = null;
    // Cho khung `bye` kịp đi trước khi đóng đường truyền.
    const link = this.o.link;
    const release = this.release;
    this.release = undefined;
    setTimeout(() => {
      link.stop();
      for (const s of [...this.sessions.values()]) s.kill();
      release?.();
    }, 50).unref?.();
    this.o.onChange?.();
  }

  /** Cập nhật hiện diện khi tên máy/thư mục thay đổi. */
  refreshPresence(): void {
    if (this.running && this.o.link.status === 'online') this.o.link.track?.(this.o.presence?.() ?? {});
  }

  // ── ghép đôi ──────────────────────────────────────────────────────────────
  /** Mở cửa sổ ghép đôi 5 phút: trả psk (base64url) để đưa vào liên kết/QR. Phải gọi từ thao tác của người ngồi ở máy. */
  startPairing(): { psk: string; expiresAt: number } {
    const psk = randomBytes(PSK_BYTES);
    this.pairing = { psk, expiresAt: this.now() + this.timing.pairTtlMs };
    this.o.onChange?.();
    return { psk: b64u(psk), expiresAt: this.pairing.expiresAt };
  }

  cancelPairing(): void {
    this.pairing = null;
    this.o.onChange?.();
  }

  private pairReqTimes: number[] = [];

  private async handlePairReq(w: Extract<Wire, { t: 'pair_req' }>): Promise<void> {
    const p = this.pairing;
    if (!p || p.expiresAt <= this.now()) return;
    const t = this.now();
    this.pairReqTimes = this.pairReqTimes.filter((x) => t - x < 60_000);
    if (this.pairReqTimes.length >= PAIR_REQ_PER_MIN) return; // quá nhiều yêu cầu/phút: bỏ qua (chống làm tốn tài nguyên)
    this.pairReqTimes.push(t);
    // Cùng một yêu cầu gửi lại (tin trước bị rớt): phát lại pair_hello đã tạo, không bắt đầu lại.
    if (p.active) {
      if (p.active.nC === w.nC && p.active.hello) this.o.link.send(p.active.hello);
      return;
    }
    const A = unb64u(w.A);
    const nC = unb64u(w.nC);
    const label = cleanLabel(w.label);
    if (!(await hmacVerify(p.psk, lp('pair_req', A, nC, w.label), unb64u(w.mac)))) return; // MAC sai: im lặng, cửa sổ vẫn mở
    if (this.pairing !== p || p.active) return; // trong lúc kiểm MAC đã bị huỷ / có yêu cầu khác chen vào
    p.active = { nC: w.nC }; // đặt cờ ĐỒNG BỘ ngay: các bước tính khoá bên dưới là bất đồng bộ, không để yêu cầu thứ hai lọt vào
    const eph = await genEcdh();
    const nH = randomBytes(16);
    const z = await ecdh(eph.priv, A).catch(() => null);
    if (!z) {
      this.pairing = null; // khoá công khai của trình duyệt không hợp lệ
      this.o.onChange?.();
      return;
    }
    const params = { A, B: eph.pub, nC, nH };
    const { kDev, sas } = await derivePairing(z, p.psk, params);
    const hello = { t: 'pair_hello', r: w.nC, B: b64u(eph.pub), nH: b64u(nH), mac: b64u(await macPairHello(p.psk, params)) };
    p.active.hello = hello;
    this.o.link.send(hello);
    this.log('info', `Remote relay: «${label}» yêu cầu ghép đôi — chờ người dùng xác nhận.`);
    this.o.onPair?.({ state: 'requested', label, sas });

    let approved = false;
    try {
      approved = await this.o.approve({ label, sas });
    } catch {
      approved = false;
    }
    const still = this.pairing === p; // chưa bị huỷ / thay bằng một cửa sổ ghép đôi khác trong lúc chờ bấm
    if (still) this.pairing = null; // một lần dùng, dù kết quả thế nào
    this.o.onChange?.();
    if (!approved || !still) {
      this.o.onPair?.({ state: approved ? 'expired' : 'denied' });
      this.o.link.send({ t: 'pair_no', r: w.nC, reason: approved ? 'expired' : 'denied', mac: b64u(await macPairNo(p.psk, nC, approved ? 'expired' : 'denied')) });
      return;
    }
    const dev = b64u(randomBytes(DEV_BYTES));
    await this.o.server.addRelayDevice({ id: dev, label, key: b64u(kDev), hostId: this.o.hostId });
    this.known.add(dev);
    this.o.link.send({ t: 'pair_ok', r: w.nC, dev, mac: b64u(await macPairOk(kDev, dev, params)) });
    this.log('info', `Remote relay: đã ghép đôi «${label}».`);
    this.o.onPair?.({ state: 'done', label });
  }

  // ── bắt tay phiên ─────────────────────────────────────────────────────────
  // Không khoá theo thiết bị khi MAC sai: dev id nằm trong tin hello ở dạng rõ nên bất kỳ ai biết tên kênh đều có thể gửi hello giả mang dev id
  // của người khác để KHOÁ OAN thiết bị thật. Kiểm MAC chỉ tốn vài micro-giây và im lặng (không phản hồi), còn Realtime tự giới hạn tốc độ.
  private sayNo(w: Extract<Wire, { t: 'hello' }>, reason: string): void {
    const t = this.now();
    this.helloNoTimes = this.helloNoTimes.filter((x) => t - x < 60_000);
    if (this.helloNoTimes.length >= HELLO_NO_PER_MIN) return; // không để kênh bị biến thành bộ khuếch đại phản hồi
    this.helloNoTimes.push(t);
    this.o.link.send({ t: 'hello_no', r: w.n, dev: w.dev, reason });
  }

  private async handleHello(w: Extract<Wire, { t: 'hello' }>): Promise<void> {
    if (this.nonces.has(w.n) || this.nonceBusy.has(w.n)) return; // phát lại (hoặc đang xử lý chính hello này): im lặng
    this.nonceBusy.add(w.n);
    try {
      await this.doHello(w);
    } finally {
      this.nonceBusy.delete(w.n);
    }
  }

  private async doHello(w: Extract<Wire, { t: 'hello' }>): Promise<void> {
    const t = this.now();
    // Thiết bị «tài khoản»: không có bản ghi, K_dev suy ra từ khoá tài khoản hiện hành. Tắt tính năng / chưa có khoá → trả lời như thiết bị lạ
    // (trình duyệt hiểu là phải ghép đôi bằng liên kết hoặc đợi VS Code báo khoá).
    const acct = w.dev === ACCOUNT_DEV;
    let kDev: Uint8Array;
    let devLabel: string;
    let genAtHello = 0; // thế hệ khoá lúc xác thực: nếu khoá bị xoay trong lúc còn tính mật mã dở thì phiên này đã «cũ» ngay khi sinh ra và bị nhịp bảo trì cắt
    if (acct) {
      const key = this.accountKeyBytes();
      if (!key) {
        this.sayNo(w, 'unknown_device');
        return;
      }
      genAtHello = this.acctGen;
      kDev = await deriveAccountKey(key, this.o.hostId);
      devLabel = ACCOUNT_LABEL;
    } else {
      const dev = (await this.o.server.relayDevices(this.o.hostId)).find((d) => d.id === w.dev);
      if (!dev || !dev.key) {
        this.sayNo(w, 'unknown_device');
        return;
      }
      kDev = unb64u(dev.key);
      devLabel = dev.label;
    }
    const A = unb64u(w.A);
    const n1 = unb64u(w.n);
    if (!(await hmacVerify(kDev, lp('hello', w.dev, A, n1), unb64u(w.mac)))) return; // MAC sai: im lặng
    this.nonces.set(w.n, t);
    while (this.nonces.size > NONCE_KEEP) this.nonces.delete(this.nonces.keys().next().value as string);
    if (!acct && !(await this.o.server.touchRelayDevice(w.dev))) {
      this.sayNo(w, 'expired');
      return;
    }
    const eph = await genEcdh();
    const n2 = randomBytes(16);
    const sid = randomBytes(8);
    const params = { dev: w.dev, A, B: eph.pub, n1, n2, sid, epoch: this.o.server.currentEpoch };
    const z = await ecdh(eph.priv, A).catch(() => null);
    if (!z) return;
    const keys = await deriveSession(z, kDev, params);
    const ch = await SecureChannel.create('host', sid, keys);
    // Giới hạn phiên: kiểm NGAY trước khi đăng ký phiên (không còn `await` nào ở giữa) — nếu kiểm sớm hơn thì nhiều hello đến cùng lúc đều thấy «còn chỗ» rồi cùng đăng ký, vượt trần.
    if (acct) {
      const mine = [...this.sessions.values()].filter((s) => s.account);
      while (mine.length >= MAX_ACCOUNT_SESSIONS) mine.shift()!.kill();
    } else {
      const mine = [...this.sessions.values()].filter((s) => s.devId === w.dev);
      while (mine.length >= MAX_SESSIONS_PER_DEVICE) mine.shift()!.kill();
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      this.sayNo(w, 'busy');
      return;
    }
    // Phiên «tài khoản» có mã riêng theo phiên: giới hạn tốc độ lệnh và số luồng tính theo từng phiên, không dồn chung một «thiết bị».
    const s = new Session(this, sid, acct ? `${ACCOUNT_DEV}:${b64u(sid)}` : w.dev, devLabel, ch, this.now(), acct);
    if (acct) s.acctGen = genAtHello;
    this.sessions.set(s.sidB64, s);
    this.o.link.send({ t: 'hello_ok', r: w.n, dev: w.dev, sid: s.sidB64, B: b64u(eph.pub), n: b64u(n2), e: params.epoch, mac: b64u(await macHelloOk(kDev, params)) });
    this.o.onChange?.();
  }

  private acctSeen: string | null = null;
  private acctGen = 0;

  /** Khoá tài khoản hiện hành (16 byte) hoặc null. Phát hiện đổi khoá (xoay / tắt) và tăng `acctGen` để phiên cũ bị cắt ở nhịp bảo trì kế tiếp. */
  private accountKeyBytes(): Uint8Array | null {
    const k = this.o.accountKey?.() ?? null;
    if (k !== this.acctSeen) {
      this.acctSeen = k;
      this.acctGen++;
    }
    if (!k) return null;
    try {
      const b = unb64u(k);
      return b.length === PSK_BYTES ? b : null;
    } catch {
      return null;
    }
  }

  /** Cắt NGAY mọi phiên «tài khoản» (đổi khoá / tắt tin cậy theo tài khoản): máy khách thấy «revoked» rồi tự lấy khoá mới nếu vẫn đúng tài khoản. */
  closeAccountSessions(): void {
    this.accountKeyBytes();
    for (const s of [...this.sessions.values()]) {
      if (!s.account) continue;
      this.o.server.closeDevice(s.devId, 'revoked');
      s.sendJson('{"k":"ev","m":{"type":"bye","seq":0,"reason":"revoked"}}');
      s.finish();
    }
  }

  // ── khung dữ liệu ─────────────────────────────────────────────────────────
  private lastReset = new Map<string, number>();
  private resetTimes: number[] = [];

  private async handleData(w: Extract<Wire, { t: 'd' }>): Promise<void> {
    const s = this.sessions.get(w.s);
    if (!s) {
      // Máy khách đang nói chuyện với một phiên mà ta không biết (VS Code vừa khởi động lại…): báo để nó bắt tay lại ngay thay vì chờ hết giờ.
      const t = this.now();
      this.resetTimes = this.resetTimes.filter((x) => t - x < 60_000);
      if (t - (this.lastReset.get(w.s) ?? 0) > 5000 && this.resetTimes.length < 20) {
        this.lastReset.set(w.s, t);
        this.resetTimes.push(t);
        if (this.lastReset.size > 200) this.lastReset.clear();
        this.o.link.send({ t: 'reset', s: w.s });
      }
      return;
    }
    s.enqueueRx(async () => {
      if (s.closed) return;
      const plain = await s.ch.open(w.q, unb64u(w.c));
      if (!plain) {
        if (++s.badFrames > MAX_BAD_FRAMES) {
          this.log('warn', 'Remote relay: phiên nhận quá nhiều khung không hợp lệ — đóng.');
          s.kill();
        }
        return;
      }
      s.lastRx = this.now();
      const first = !s.established;
      s.established = true;
      // Báo chủ máy khi phiên «tài khoản» THỰC SỰ có người dùng (đã giải mã được khung đầu tiên) — hello bị phát lại chỉ tạo «phiên ma» không có khoá phiên nên không bao giờ tới đây.
      if (first && s.account) {
        this.log('info', 'Remote relay: một trình duyệt đăng nhập cùng tài khoản vừa mở phiên.');
        this.o.onAccountSession?.({ sessions: [...this.sessions.values()].filter((x) => x.account).length });
      }
      const msg = s.rasm.push(plain);
      if (msg !== null) await this.handleApp(s, msg);
    });
  }

  private async handleApp(s: Session, raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const m = raw as Record<string, unknown>;
    switch (m.k) {
      case 'sub': {
        const since = typeof m.since === 'number' && Number.isSafeInteger(m.since) && m.since >= 0 ? m.since : undefined;
        const epoch = typeof m.epoch === 'string' && m.epoch.length <= 32 ? m.epoch : undefined;
        await this.o.server.prepareState();
        if (s.closed) return;
        s.detach?.();
        s.sink = new RelaySink(s);
        s.detach = this.o.server.attachSink(s.devId, s.sink, { since, epoch });
        return;
      }
      case 'cmd': {
        const id = typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 64 ? m.id : undefined;
        if (!id) return;
        const out = await this.o.server.execCommand({ id: s.devId, label: s.label }, m.cmd);
        s.sendJson(JSON.stringify(out.ok ? { k: 'res', id, ok: true } : { k: 'res', id, ok: false, error: out.error, ...(out.message ? { message: out.message } : {}) }));
        return;
      }
      case 'ping':
        s.sendJson(JSON.stringify({ k: 'pong', t: typeof m.t === 'number' ? m.t : 0 }));
        return;
      case 'unpair':
        // Phiên «tài khoản» không có bản ghi thiết bị để huỷ: chỉ kết thúc phiên (muốn cắt hẳn thì xoay khoá tài khoản ở VS Code) — nhưng PHẢI gỡ đầu ra của nó khỏi máy chủ
        // (nếu không «Client» mồ côi nằm lại và số kết nối đang mở không bao giờ về 0).
        if (!s.account) {
          await this.o.server.revoke(s.devId);
          this.known.delete(s.devId);
        } else this.o.server.closeDevice(s.devId, 'revoked');
        s.sendJson('{"k":"ev","m":{"type":"bye","seq":0,"reason":"revoked"}}');
        s.finish();
        return;
      default:
        return;
    }
  }

  private onMessage(raw: unknown): void {
    const w = parseWire(raw);
    if (!w) return;
    const run = (p: Promise<void>) => void p.catch((err) => this.log('warn', `Remote relay: ${err instanceof Error ? err.message : String(err)}`));
    switch (w.t) {
      case 'pair_req':
        return run(this.handlePairReq(w));
      case 'hello':
        return run(this.handleHello(w));
      case 'd':
        return run(this.handleData(w));
      default:
        return; // tin của phía trình duyệt (pair_hello, hello_ok…) — host không quan tâm
    }
  }

  // ── bảo trì ───────────────────────────────────────────────────────────────
  removeSession(s: Session): void {
    if (this.sessions.get(s.sidB64) === s) {
      this.sessions.delete(s.sidB64);
      this.o.onChange?.();
    }
  }

  rawSend(msg: object): void {
    this.o.link.send(msg);
  }

  private async refreshKnown(): Promise<void> {
    try {
      this.known = new Set((await this.o.server.relayDevices(this.o.hostId)).map((d) => d.id));
    } catch {
      /* lần sau */
    }
  }

  private async sweep(): Promise<void> {
    const t = this.now();
    await this.refreshKnown();
    this.accountKeyBytes(); // cập nhật thế hệ khoá trước khi xét phiên «tài khoản»
    for (const s of [...this.sessions.values()]) {
      // Phiên «tài khoản» hết quyền khi khoá bị xoay hoặc tính năng bị tắt; phiên thường khi thiết bị không còn trong kho.
      const revoked = s.account ? this.acctSeen === null || s.acctGen !== this.acctGen : !this.known.has(s.devId);
      if (revoked) {
        this.o.server.closeDevice(s.devId, 'revoked');
        s.sendJson('{"k":"ev","m":{"type":"bye","seq":0,"reason":"revoked"}}');
        s.finish();
      } else if (!s.established && t - s.createdAt > this.timing.helloTimeoutMs) s.kill();
      else if (t - s.lastRx > this.timing.idleMs) s.kill();
    }
    if (this.pairing && this.pairing.expiresAt <= t && !this.pairing.active) {
      this.pairing = null;
      this.o.onChange?.();
    }
  }

  private heartbeat(): void {
    // `s` = số thứ tự sự kiện mới nhất của host: máy khách thấy mình đang thiếu thì xin bù (relay có thể làm rớt tin khi mạng chập chờn).
    for (const s of this.sessions.values()) if (s.established && s.sink) s.sendJson(`{"k":"hb","s":${this.o.server.currentSeq}}`);
  }
}
