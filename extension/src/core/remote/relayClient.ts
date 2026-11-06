/**
 * Phía TRÌNH DUYỆT của Remote qua relay (ghép đôi + phiên mã hoá đầu-cuối), viết độc lập với đường truyền và với React.
 *
 * ⚠️ Tệp này dùng chung: bản sao nguyên văn nằm ở locaith-ai-v2/src/screens/remote/relay/relayClient.ts (cùng e2e.ts). Extension không nạp nó
 * (chỉ kiểm thử dùng, để chạy máy khách thật đối đầu với RelayHost thật qua một relay giả và cả relay Supabase thật).
 * Chỉ phụ thuộc e2e.ts (WebCrypto) nên chạy y hệt trong Node ≥ 20 và trình duyệt.
 */

import {
  DEV_BYTES,
  Reassembler,
  SecureChannel,
  b64u,
  concat,
  derivePairing,
  deriveSession,
  ecdh,
  encodeMessage,
  genEcdh,
  hmacVerify,
  lp,
  macHello,
  macPairReq,
  parseWire,
  randomBytes,
  unb64u,
  utf8,
  type Wire,
} from './e2e';

/** Đường truyền tới kênh của một máy (host). */
export interface ClientLink {
  send(msg: object): boolean;
  onMessage(cb: (m: unknown) => void): () => void;
  /** Đường truyền vừa nối lại (true) hoặc mất (false) — để bắt tay lại ngay thay vì chờ hết giờ. */
  onLink?(cb: (up: boolean) => void): () => void;
}

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
}
const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

// ── ghép đôi ─────────────────────────────────────────────────────────────────
export interface PairOptions {
  link: ClientLink;
  /** psk base64url lấy từ liên kết/QR ghép đôi. */
  psk: string;
  label: string;
  /** Có mã SAS (host đã trả lời): hiện «123 456» để người dùng đối chiếu với hộp thoại trong VS Code. */
  onSas?: (sas: string) => void;
  timeoutMs?: number;
  resendMs?: number;
  timers?: Timers;
  signal?: { aborted: boolean; addEventListener(type: 'abort', cb: () => void): void };
}

export interface PairResult {
  /** Mã thiết bị do host cấp. */
  dev: string;
  /** K_dev (base64url): cất ở nơi an toàn nhất có thể (IndexedDB dạng CryptoKey không xuất được nếu làm được). */
  key: string;
  sas: string;
}

export class PairError extends Error {
  constructor(readonly code: 'denied' | 'expired' | 'timeout' | 'bad_host' | 'aborted') {
    super(code);
  }
}

export async function pairWithHost(o: PairOptions): Promise<PairResult> {
  const T = o.timers ?? realTimers;
  const psk = unb64u(o.psk);
  const eph = await genEcdh();
  const nC = randomBytes(16);
  const nCb = b64u(nC);
  const req = { t: 'pair_req', v: 1, A: b64u(eph.pub), nC: nCb, label: o.label.slice(0, 48), mac: b64u(await macPairReq(psk, eph.pub, nC, o.label.slice(0, 48))) };

  return new Promise<PairResult>((resolve, reject) => {
    let done = false;
    let timer: unknown;
    let resend: unknown;
    let derived: { kDev: Uint8Array; sas: string; params: { A: Uint8Array; B: Uint8Array; nC: Uint8Array; nH: Uint8Array } } | null = null;
    const finish = (err: PairError | null, res?: PairResult) => {
      if (done) return;
      done = true;
      off();
      T.clearTimeout(timer);
      T.clearTimeout(resend);
      if (err) reject(err);
      else resolve(res!);
    };
    const send = () => {
      if (done) return;
      if (!derived) o.link.send(req); // chưa nhận pair_hello: gửi lại (host có thể chưa vào kênh)
      resend = T.setTimeout(send, o.resendMs ?? 3000);
    };
    // pair_ok tới TRƯỚC pair_hello (relay đảo thứ tự khi hai tin đi sát nhau, vd. host cho phép tức thì): giữ lại vài tin để kiểm MAC sau khi đã có khoá.
    // Giới hạn 4 tin để kẻ lạ (biết nonce nC vì nó nằm rõ trong pair_req) không nhét đầy bộ nhớ; tin sai MAC bị loại như thường.
    const earlyOk: Extract<Wire, { t: 'pair_ok' }>[] = [];
    const acceptOk = async (w: Extract<Wire, { t: 'pair_ok' }>) => {
      if (!derived) return;
      const p = derived.params;
      if (!(await hmacVerify(derived.kDev, lp('pair_ok', w.dev, p.A, p.B, p.nC, p.nH), unb64u(w.mac)))) return;
      finish(null, { dev: w.dev, key: b64u(derived.kDev), sas: derived.sas });
    };
    const handle = async (w: Wire) => {
      if (done) return;
      if (w.t === 'pair_hello' && w.r === nCb && !derived) {
        const B = unb64u(w.B);
        const nH = unb64u(w.nH);
        const params = { A: eph.pub, B, nC, nH };
        const okMac = await hmacVerify(psk, lp('pair_hello', params.A, params.B, params.nC, params.nH), unb64u(w.mac));
        if (!okMac) return; // không phải máy mình ghép đôi (không biết psk): bỏ qua
        const z = await ecdh(eph.priv, B).catch(() => null);
        if (!z) return;
        const d = await derivePairing(z, psk, params);
        derived = { ...d, params };
        o.onSas?.(d.sas);
        for (const early of earlyOk.splice(0)) await acceptOk(early);
      } else if (w.t === 'pair_ok' && w.r === nCb) {
        if (derived) await acceptOk(w);
        else if (earlyOk.length < 4) earlyOk.push(w);
      } else if (w.t === 'pair_no' && w.r === nCb) {
        if (!(await hmacVerify(psk, lp('pair_no', nC, w.reason), unb64u(w.mac)))) return;
        finish(new PairError(w.reason === 'expired' ? 'expired' : 'denied'));
      }
    };
    // Xử lý tuần tự: pair_ok có thể tới ngay sau pair_hello (khi host cho phép tức thì) trong lúc khoá còn đang được tính.
    let chain: Promise<void> = Promise.resolve();
    const off = o.link.onMessage((raw) => {
      const w = parseWire(raw);
      if (w) chain = chain.then(() => handle(w)).catch(() => undefined);
    });
    o.signal?.addEventListener('abort', () => finish(new PairError('aborted')));
    if (o.signal?.aborted) return finish(new PairError('aborted'));
    timer = T.setTimeout(() => finish(new PairError(derived ? 'timeout' : 'bad_host')), o.timeoutMs ?? 180_000);
    send();
  });
}

// ── phiên ────────────────────────────────────────────────────────────────────
export type ClientStatus = 'connecting' | 'online' | 'reconnecting' | 'unpaired' | 'revoked' | 'stopped';

export interface ClientOptions {
  link: ClientLink;
  dev: string;
  /** K_dev base64url. */
  key: string;
  /** Mỗi tin luồng (snapshot/events/patch/toast/image/resume/bye) đã giải mã. */
  onStream: (m: Record<string, unknown> & { type: string; seq: number }) => void;
  onStatus: (s: ClientStatus) => void;
  timers?: Timers;
  helloTimeoutMs?: number;
  /** Quá thời gian này không nhận được gì từ host thì coi như mất kết nối. */
  watchdogMs?: number;
  pingMs?: number;
  cmdTimeoutMs?: number;
}

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export class RelayClient {
  private readonly T: Timers;
  private kDev: Uint8Array;
  private stopped = true;
  private status: ClientStatus = 'stopped';
  private ch?: SecureChannel;
  private rasm?: Reassembler;
  private sid = '';
  private epoch: string | undefined;
  private lastSeq = 0;
  private replayUntil = -1;
  /** Đã có nền (snapshot/resume) cho phiên hiện tại chưa. Tin sự kiện tới TRƯỚC nền (relay có thể đảo thứ tự) được giữ lại, không bỏ. */
  private haveBase = false;
  private early: { seq: number; msg: Record<string, unknown> & { type: string; seq: number } }[] = [];
  /** Tin đến sớm hơn số thứ tự mong đợi (hở số tạm thời do đảo thứ tự): chờ ngắn cho lấp chỗ trống rồi mới xin bù. */
  private ahead = new Map<number, Record<string, unknown> & { type: string; seq: number }>();
  private aheadTimer?: unknown;
  private helloN = '';
  private pending?: { A: Uint8Array; eph: { priv: unknown; pub: Uint8Array }; n1: Uint8Array };
  private helloTimer?: unknown;
  private watchdog?: unknown;
  private pinger?: unknown;
  private behindTimer?: unknown;
  private retries = 0;
  private mid = 0;
  private tx: Promise<void> = Promise.resolve();
  private rx: Promise<void> = Promise.resolve();
  private readonly offs: (() => void)[] = [];
  private readonly waiters = new Map<string, { resolve: () => void; reject: (e: CommandError) => void; timer: unknown }>();
  private seqCmd = 0;

  constructor(private readonly o: ClientOptions) {
    this.T = o.timers ?? realTimers;
    this.kDev = unb64u(o.key);
  }

  get state(): ClientStatus {
    return this.status;
  }

  private set(s: ClientStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.o.onStatus(s);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.offs.push(this.o.link.onMessage((raw) => this.onRaw(raw)));
    if (this.o.link.onLink) this.offs.push(this.o.link.onLink((up) => up && !this.stopped && this.restart(0)));
    this.set('connecting');
    this.hello();
  }

  stop(): void {
    this.shutdown();
    this.set('stopped');
  }

  /** Dừng hẳn (không còn nối lại) nhưng giữ trạng thái cuối (unpaired/revoked) cho giao diện. */
  private halt(): void {
    this.shutdown();
  }

  private shutdown(): void {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    this.clearTimers();
    for (const [id, w] of this.waiters) {
      this.T.clearTimeout(w.timer);
      w.reject(new CommandError('disconnected'));
      this.waiters.delete(id);
    }
    this.ch = undefined;
  }

  private clearTimers(): void {
    for (const t of [this.helloTimer, this.watchdog, this.pinger, this.behindTimer, this.aheadTimer]) this.T.clearTimeout(t);
    this.helloTimer = this.watchdog = this.pinger = this.behindTimer = this.aheadTimer = undefined;
  }

  /** Bắt tay lại sau `delay` ms (mất đường truyền, host báo reset, im lặng quá lâu…). */
  private restart(delay: number): void {
    if (this.stopped) return;
    this.clearTimers();
    this.ch = undefined;
    this.rasm = undefined;
    this.haveBase = false;
    this.early = [];
    this.ahead.clear();
    if (this.status === 'online') this.set('reconnecting');
    this.helloTimer = this.T.setTimeout(() => this.hello(), delay);
  }

  private async hello(): Promise<void> {
    if (this.stopped) return;
    const eph = await genEcdh();
    if (this.stopped) return;
    const n1 = randomBytes(16);
    this.helloN = b64u(n1);
    this.pending = { A: eph.pub, eph, n1 };
    const mac = await macHello(this.kDev, { dev: this.o.dev, A: eph.pub, n1 });
    this.o.link.send({ t: 'hello', v: 1, dev: this.o.dev, A: b64u(eph.pub), n: this.helloN, mac: b64u(mac) });
    const wait = this.o.helloTimeoutMs ?? 6000;
    this.helloTimer = this.T.setTimeout(() => {
      // Không ai trả lời: host đang tắt/ngoại tuyến. Thử lại với khoảng chờ tăng dần (tối đa 20 giây).
      this.retries++;
      if (this.status !== 'unpaired' && this.status !== 'revoked') this.set('reconnecting');
      this.restart(Math.min(20_000, 1000 * 2 ** Math.min(this.retries, 4)));
    }, wait);
  }

  private onRaw(raw: unknown): void {
    if (this.stopped) return;
    const w = parseWire(raw);
    if (!w) return;
    if (w.t === 'hello_ok' && w.r === this.helloN && this.pending) return void this.handleHelloOk(w).catch(() => undefined);
    if (w.t === 'hello_no' && w.r === this.helloN) {
      this.T.clearTimeout(this.helloTimer);
      if (w.reason === 'unknown_device' || w.reason === 'expired') {
        this.set('unpaired');
        this.halt();
      } else this.restart(5000);
      return;
    }
    if (w.t === 'reset' && w.s === this.sid) return this.restart(0);
    if (w.t === 'd' && w.s === this.sid && this.ch && this.rasm) {
      const ch = this.ch;
      const rasm = this.rasm;
      this.rx = this.rx
        .then(async () => {
          const plain = await ch.open(w.q, unb64u(w.c));
          if (!plain || this.ch !== ch) return;
          this.armWatchdog();
          const msg = rasm.push(plain);
          if (msg !== null) this.onApp(msg);
        })
        .catch(() => undefined);
    }
  }

  private async handleHelloOk(w: Extract<Wire, { t: 'hello_ok' }>): Promise<void> {
    const p = this.pending;
    if (!p) return;
    const B = unb64u(w.B);
    const n2 = unb64u(w.n);
    const sid = unb64u(w.sid);
    const params = { dev: this.o.dev, A: p.A, B, n1: p.n1, n2, sid, epoch: w.e };
    if (!(await hmacVerify(this.kDev, lp('hello_ok', params.dev, params.sid, params.A, params.B, params.n1, params.n2, params.epoch), unb64u(w.mac)))) return; // không phải host thật của ta
    const z = await ecdh(p.eph.priv, B).catch(() => null);
    if (!z || this.pending !== p) return;
    const keys = await deriveSession(z, this.kDev, params);
    this.ch = await SecureChannel.create('client', sid, keys);
    this.rasm = new Reassembler(this.T.now);
    this.sid = w.sid;
    this.pending = undefined;
    this.T.clearTimeout(this.helloTimer);
    this.retries = 0;
    if (this.epoch !== w.e) {
      this.epoch = w.e; // host khởi động lại: chuỗi sự kiện cũ vô nghĩa → xin snapshot mới
      this.lastSeq = 0;
    }
    this.armWatchdog();
    this.send({ k: 'sub', since: this.lastSeq > 0 ? this.lastSeq : undefined, epoch: this.epoch });
    this.pinger = this.T.setTimeout(() => this.ping(), this.o.pingMs ?? 20_000);
  }

  private armWatchdog(): void {
    this.T.clearTimeout(this.watchdog);
    this.watchdog = this.T.setTimeout(() => this.restart(0), this.o.watchdogMs ?? 45_000);
  }

  private ping(): void {
    if (this.stopped || !this.ch) return;
    this.send({ k: 'ping', t: this.T.now() });
    this.pinger = this.T.setTimeout(() => this.ping(), this.o.pingMs ?? 20_000);
  }

  private send(obj: unknown): void {
    const ch = this.ch;
    if (!ch) return;
    this.tx = this.tx
      .then(async () => {
        for (const frame of encodeMessage(obj, ++this.mid)) {
          const { q, c } = await ch.seal(frame);
          this.o.link.send({ t: 'd', s: this.sid, q, c: b64u(c) });
        }
      })
      .catch(() => undefined);
  }

  // ── tin ứng dụng từ host ──────────────────────────────────────────────────
  private onApp(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as Record<string, unknown>;
    switch (m.k) {
      case 'ev':
        return this.onStream(m.m);
      case 'batch':
        if (Array.isArray(m.m)) for (const x of m.m) this.onStream(x);
        return;
      case 'res': {
        const id = typeof m.id === 'string' ? m.id : '';
        const w = this.waiters.get(id);
        if (!w) return;
        this.waiters.delete(id);
        this.T.clearTimeout(w.timer);
        if (m.ok === true) w.resolve();
        else w.reject(new CommandError(typeof m.error === 'string' ? m.error : 'failed', typeof m.message === 'string' ? m.message : undefined));
        return;
      }
      case 'hb': {
        const s = typeof m.s === 'number' ? m.s : 0;
        // Host đã đi xa hơn những gì ta nhận được mà không có tin nào tới sau 1,5 giây → có tin bị rớt, xin bù.
        if (s > this.lastSeq && !this.behindTimer && this.replayUntil < 0) {
          const at = this.lastSeq;
          this.behindTimer = this.T.setTimeout(() => {
            this.behindTimer = undefined;
            if (this.lastSeq === at && !this.stopped) this.send({ k: 'sub', since: this.lastSeq, epoch: this.epoch });
          }, 1500);
        }
        return;
      }
      default:
        return;
    }
  }

  private onStream(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as { type?: unknown; seq?: unknown; epoch?: unknown; from?: unknown };
    if (typeof m.type !== 'string' || typeof m.seq !== 'number') return;
    const msg = m as Record<string, unknown> & { type: string; seq: number };
    if (msg.type === 'snapshot') {
      this.lastSeq = msg.seq;
      this.replayUntil = -1;
      if (typeof m.epoch === 'string') this.epoch = m.epoch;
      this.haveBase = true;
      this.ahead.clear();
      this.set('online');
      this.o.onStream(msg);
      this.drainEarly();
      return;
    }
    if (msg.type === 'resume') {
      this.replayUntil = msg.seq; // các tin bù kế tiếp có thể thiếu số (ảnh tạm không lưu); hết bù khi lastSeq ≥ seq của host lúc gắn
      this.lastSeq = typeof m.from === 'number' ? m.from : this.lastSeq;
      if (this.lastSeq >= this.replayUntil) this.replayUntil = -1;
      this.haveBase = true;
      this.ahead.clear();
      this.set('online');
      this.o.onStream(msg);
      this.drainEarly();
      return;
    }
    if (msg.type === 'bye') {
      if (msg.reason === 'revoked') {
        this.set('revoked');
        this.o.onStream(msg);
        this.halt();
        return;
      }
      this.o.onStream(msg);
      return;
    }
    if (!this.haveBase) {
      // Tin sự kiện tới trước snapshot (relay có thể đảo thứ tự): giữ lại, áp sau khi có nền.
      if (this.early.length < 500) this.early.push({ seq: msg.seq, msg });
      return;
    }
    this.applyLive(msg);
  }

  /** Áp các tin đã giữ lại sau khi có nền: chỉ những tin mới hơn nền, theo thứ tự `seq`. */
  private drainEarly(): void {
    const list = this.early.sort((x, y) => x.seq - y.seq);
    this.early = [];
    for (const e of list) if (e.seq > this.lastSeq || this.replayUntil >= 0) this.applyLive(e.msg);
  }

  private applyLive(msg: Record<string, unknown> & { type: string; seq: number }): void {
    if (msg.seq <= this.lastSeq) return; // tin cũ/trùng
    if (this.replayUntil < 0 && msg.seq > this.lastSeq + 1) {
      // Hở số ở luồng trực tiếp: hoặc tin bị rớt, hoặc chỉ là relay đảo thứ tự. Giữ tin này và chờ ngắn cho chỗ trống được lấp; quá hạn mới xin bù.
      this.ahead.set(msg.seq, msg);
      if (!this.aheadTimer) {
        const at = this.lastSeq;
        this.aheadTimer = this.T.setTimeout(() => {
          this.aheadTimer = undefined;
          if (!this.stopped && this.lastSeq === at && this.ahead.size) {
            this.ahead.clear();
            this.send({ k: 'sub', since: this.lastSeq, epoch: this.epoch });
          }
        }, 400);
      }
      return;
    }
    this.lastSeq = msg.seq;
    if (this.replayUntil >= 0 && this.lastSeq >= this.replayUntil) this.replayUntil = -1;
    this.o.onStream(msg);
    // tin đang đợi ngay sau chỗ vừa lấp
    for (let next = this.ahead.get(this.lastSeq + 1); next; next = this.ahead.get(this.lastSeq + 1)) {
      this.ahead.delete(next.seq);
      this.lastSeq = next.seq;
      this.o.onStream(next);
    }
    for (const k of [...this.ahead.keys()]) if (k <= this.lastSeq) this.ahead.delete(k);
    if (!this.ahead.size && this.aheadTimer) {
      this.T.clearTimeout(this.aheadTimer);
      this.aheadTimer = undefined;
    }
  }

  /** Gửi một lệnh; hoàn tất khi host xác nhận (lệnh dài như `send` trả về ngay — tiến độ tới qua luồng). */
  command(cmd: object): Promise<void> {
    if (!this.ch || this.stopped) return Promise.reject(new CommandError('not_connected'));
    const id = `c${++this.seqCmd}-${b64u(randomBytes(4))}`;
    return new Promise<void>((resolve, reject) => {
      const timer = this.T.setTimeout(() => {
        this.waiters.delete(id);
        reject(new CommandError('timeout'));
      }, this.o.cmdTimeoutMs ?? 20_000);
      this.waiters.set(id, { resolve, reject, timer });
      this.send({ k: 'cmd', id, cmd });
    });
  }

  /** Thu hồi chính thiết bị này ở host (đăng xuất khỏi máy). */
  unpair(): void {
    this.send({ k: 'unpair' });
  }
}

export const DEV_ID_BYTES = DEV_BYTES;
export const _internal = { concat, utf8 };
