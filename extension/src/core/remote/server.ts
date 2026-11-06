/**
 * Máy chủ "Điều khiển từ xa": HTTP cục bộ (127.0.0.1) + luồng SSE để một trang web đã ghép đôi xem và điều khiển khung chat của VS Code.
 *
 * ⚠️ Máy khách đã ghép đôi làm được mọi việc mà trợ lý làm được trên máy này (đọc/sửa tệp, chạy lệnh theo chế độ quyền đang bật) —
 * nên mỗi lớp dưới đây đều có test và mặc định KHÔNG mở cổng nào:
 *  • chỉ lắng nghe 127.0.0.1; kiểm tra tiêu đề Host (chống DNS rebinding; tên miền công khai chỉ được nhận khi người dùng cấu hình `publicUrl`);
 *  • trang web gọi vào phải có Origin nằm trong danh sách cho phép (mặc định chỉ locaith.ai); Origin lạ bị từ chối ở MỌI đường dẫn, kể cả /v1/hello;
 *  • ghép đôi bằng mã dùng một lần (8 ký tự, hiệu lực 5 phút, tối đa 5 lần thử sai rồi huỷ mã) hiện ở VS Code; kết quả là token ngẫu nhiên 256 bit
 *    chỉ trả một lần — host chỉ giữ băm SHA-256 của token;
 *  • mọi đường dẫn khác cần `Authorization: Bearer <token>` (so sánh thời gian không đổi); token không dùng quá N ngày thì hết hạn; thu hồi từng thiết bị ngay lập tức;
 *  • chống dò token (quá 30 lần sai trong 1 phút → 429), giới hạn tốc độ lệnh theo thiết bị, thân yêu cầu tối đa 3 MB, mỗi lệnh được kiểm bằng parseCommand
 *    (tập lệnh cho phép rất hẹp — xem protocol.ts).
 * Không import `vscode`.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { REMOTE_API_VERSION, REMOTE_PORTS, parseCommand, type RemoteCommand, type RemoteHostInfo, type RemoteState } from './protocol';

const PAIR_TTL_MS = 5 * 60_000;
const MAX_TRIES = 5;
const MAX_BODY = 3 * 1024 * 1024;
const MAX_DEVICES = 10;
const MAX_STREAMS_PER_DEVICE = 5;
const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED = 8 * 1024 * 1024;
const RING_MESSAGES = 2000;
const RING_BYTES = 6 * 1024 * 1024;
const FAIL_LIMIT = 30;
const CMD_LIMIT_PER_MIN = 120;
const STORE_TTL_MS = 5000;
const SAVE_SEEN_EVERY_MS = 60_000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const DAY_MS = 86_400_000;

export interface RemoteDevice {
  id: string;
  label: string;
  origin?: string;
  /** Thiết bị HTTP cục bộ: SHA-256 (hex) của token. Token thô không bao giờ được lưu. Thiết bị relay không có trường này. */
  tokenHash?: string;
  /** `relay` = trình duyệt ghép đôi qua locaith.ai (mã hoá đầu-cuối, xem relayHost.ts). Mặc định (vắng) = HTTP cục bộ. */
  kind?: 'relay';
  /** Chỉ thiết bị relay: K_dev (32 byte, base64url) — bí mật chung đã thoả thuận lúc ghép đôi; nằm trong SecretStorage. */
  key?: string;
  /** Chỉ thiết bị relay: mã máy (host) mà phiên ghép đôi này thuộc về. */
  hostId?: string;
  createdAt: number;
  lastSeen: number;
}

/** Đầu ra của luồng sự kiện: SSE (HTTP) hoặc phiên relay. `json` là toàn bộ tin `{type, seq, …}` đã tuần tự hoá. */
export interface Sink {
  write(seq: number, type: string, json: string): void;
  /** Đóng đầu ra (tin `bye` đã được ghi trước đó). */
  close(): void;
  /** Số byte đang chờ gửi — quá ngưỡng thì máy chủ ngắt máy khách chậm. */
  buffered(): number;
}

export interface RemoteStore {
  load(): Promise<RemoteDevice[]>;
  save(list: RemoteDevice[]): Promise<void>;
}

export interface RemoteBackend {
  info(): RemoteHostInfo;
  /** Làm mới những phần trạng thái cần nạp bất đồng bộ (danh sách model/lịch sử) trước khi chụp. */
  prepare(): Promise<void>;
  /** Chụp trạng thái hiện tại (đồng bộ — để snapshot và luồng sự kiện không hở nhau). */
  state(): RemoteState;
  /** Thực thi một lệnh đã được kiểm hợp lệ. */
  command(device: { id: string; label: string }, cmd: RemoteCommand): Promise<void>;
}

export interface RemoteServerOptions {
  ports?: readonly number[];
  now?: () => number;
  /** Origin của trang web được phép gọi vào (so khớp chính xác). */
  allowedOrigins: () => string[];
  /** Tên miền công khai (không kèm cổng) ngoài loopback mà tiêu đề Host được phép mang — dùng khi đi qua tunnel. */
  allowedHosts?: () => string[];
  /** Token không dùng quá bấy nhiêu ngày thì hết hạn. */
  idleDays?: () => number;
  /** Cho phép lệnh `set_mode: bypass` từ xa. */
  canBypass?: () => boolean;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  onChange?: () => void;
}

export interface RemoteStatus {
  running: boolean;
  port?: number;
  devices: { id: string; label: string; kind: 'http' | 'relay'; createdAt: number; lastSeen: number; connected: boolean }[];
  pairing?: { code: string; expiresAt: number };
  streams: number;
  error?: string;
}

interface Client {
  id: number;
  deviceId: string;
  sink: Sink;
}

interface RingEntry {
  seq: number;
  type: string;
  json: string;
}

export type CommandOutcome = { ok: true } | { ok: false; status: 400 | 429 | 500; error: string; message?: string };

const safeEq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const cleanLabel = (v: unknown): string => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) : '';
  return s || 'Trình duyệt';
};
const sse = (seq: number, type: string, json: string): string => `id: ${seq}\nevent: ${type}\ndata: ${json}\n\n`;

/** Đầu ra SSE của một yêu cầu HTTP /v1/stream. */
class SseSink implements Sink {
  constructor(private readonly res: http.ServerResponse) {}
  write(seq: number, type: string, json: string): void {
    this.res.write(sse(seq, type, json));
  }
  heartbeat(): void {
    this.res.write(': hb\n\n');
  }
  buffered(): number {
    return this.res.writableLength;
  }
  close(): void {
    this.res.end();
  }
}

export class RemoteServer {
  private server?: http.Server;
  private port = 0;
  private startError?: string;
  private devices: RemoteDevice[] = [];
  private devicesAt = 0;
  private lastSave = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private pairing: { code: string; expiresAt: number; tries: number } | null = null;
  private seq = 0;
  /** Đổi mỗi lần máy chủ khởi động: máy khách nối lại từ lần chạy cũ không được "nối bù" nhầm vào chuỗi sự kiện mới. */
  private epoch = randomBytes(6).toString('hex');
  private ring: RingEntry[] = [];
  private ringBytes = 0;
  private readonly clients = new Map<number, Client>();
  private nextClient = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private authFails: number[] = [];
  private readonly cmdTimes = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly ports: readonly number[];
  private readonly log: NonNullable<RemoteServerOptions['log']>;

  constructor(
    private readonly store: RemoteStore,
    private readonly backend: RemoteBackend,
    private readonly o: RemoteServerOptions,
  ) {
    this.now = o.now ?? Date.now;
    this.ports = o.ports ?? REMOTE_PORTS;
    this.log = o.log ?? (() => {});
  }

  // ── vòng đời ──────────────────────────────────────────────────────────────
  async start(): Promise<number> {
    if (this.server) return this.port;
    await this.refreshDevices(true);
    for (const p of this.ports) {
      const server = http.createServer((req, res) => void this.handle(req, res).catch(() => this.send(res, 500, { error: 'internal' }, req)));
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(p, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        server.on('error', (e) => this.log('warn', `Remote: lỗi máy chủ: ${e.message}`));
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        this.startError = undefined;
        // Làm lại chuỗi sự kiện chỉ khi chưa ai đang nghe (relay đang chạy mà đổi epoch/seq giữa chừng sẽ làm phiên hiện có lệch).
        if (this.clients.size === 0 && this.relayUsers === 0) {
          this.seq = 0;
          this.ring = [];
          this.ringBytes = 0;
          this.epoch = randomBytes(6).toString('hex');
        }
        this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
        this.heartbeat.unref?.();
        this.log('info', `Remote lắng nghe 127.0.0.1:${this.port}`);
        this.o.onChange?.();
        return this.port;
      }
      server.close();
    }
    this.startError = `Không mở được cổng cho Remote (các cổng ${this.ports[0]}–${this.ports[this.ports.length - 1]} đang bận).`;
    throw new Error(this.startError);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    // Chỉ ngắt các luồng SSE của máy chủ HTTP cục bộ — phiên relay thuộc về RelayHost (tắt HTTP không được làm rớt Internet).
    for (const c of [...this.clients.values()]) if (c.sink instanceof SseSink) this.closeClient(c, 'stopped');
    this.server?.closeAllConnections?.();
    this.server?.close();
    this.server = undefined;
    this.port = 0;
    this.pairing = null;
    this.o.onChange?.();
  }

  get running(): boolean {
    return !!this.server;
  }

  status(): RemoteStatus {
    const live = new Set([...this.clients.values()].map((c) => c.deviceId));
    const pairing = this.pairing && this.pairing.expiresAt > this.now() ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : undefined;
    return {
      running: !!this.server,
      ...(this.port ? { port: this.port } : {}),
      devices: this.devices.map((d) => ({ id: d.id, label: d.label, kind: d.kind === 'relay' ? ('relay' as const) : ('http' as const), createdAt: d.createdAt, lastSeen: d.lastSeen, connected: live.has(d.id) })),
      ...(pairing ? { pairing } : {}),
      streams: this.clients.size,
      ...(this.startError ? { error: this.startError } : {}),
    };
  }

  // ── ghép đôi & thiết bị ───────────────────────────────────────────────────
  async startPairing(): Promise<{ code: string; expiresAt: number; port: number }> {
    const port = await this.start();
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    code = `${code.slice(0, 4)}-${code.slice(4)}`;
    this.pairing = { code, expiresAt: this.now() + PAIR_TTL_MS, tries: 0 };
    this.o.onChange?.();
    return { code, expiresAt: this.pairing.expiresAt, port };
  }

  cancelPairing(): void {
    this.pairing = null;
    this.o.onChange?.();
  }

  async revoke(deviceId: string): Promise<boolean> {
    let found = false;
    await this.mutate((list) => {
      const next = list.filter((d) => d.id !== deviceId);
      found = next.length !== list.length;
      return next;
    });
    for (const c of [...this.clients.values()]) if (c.deviceId === deviceId) this.closeClient(c, 'revoked');
    this.o.onChange?.();
    return found;
  }

  async revokeAll(): Promise<void> {
    await this.mutate(() => []);
    for (const c of [...this.clients.values()]) this.closeClient(c, 'revoked');
    this.o.onChange?.();
  }

  /** Đọc lại danh sách thiết bị khi cần; mọi thay đổi đi qua `mutate` (đọc-sửa-ghi) để nhiều cửa sổ VS Code không ghi đè lẫn nhau. */
  private async refreshDevices(force = false): Promise<void> {
    if (!force && this.now() - this.devicesAt < STORE_TTL_MS) return;
    this.devices = await this.store.load();
    this.devicesAt = this.now();
  }

  private mutate(fn: (list: RemoteDevice[]) => RemoteDevice[]): Promise<void> {
    const run = async (): Promise<void> => {
      const fresh = await this.store.load();
      this.devices = fn(fresh);
      this.devicesAt = this.now();
      this.lastSave = this.now();
      await this.store.save(this.devices);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  // ── luồng sự kiện ─────────────────────────────────────────────────────────
  /** Phát một tin tới mọi máy khách đang nghe (và lưu vào vòng đệm để nối lại bù). `ephemeral` = không lưu (ảnh lớn). */
  publish(type: 'snapshot' | 'events' | 'patch' | 'toast' | 'image', payload: object, opts: { ephemeral?: boolean } = {}): void {
    if (!this.server && this.relayUsers === 0) return;
    const seq = ++this.seq;
    const json = JSON.stringify({ type, seq, ...payload });
    if (!opts.ephemeral) {
      this.ring.push({ seq, type, json });
      this.ringBytes += json.length;
      while (this.ring.length > RING_MESSAGES || this.ringBytes > RING_BYTES) {
        const old = this.ring.shift();
        if (!old) break;
        this.ringBytes -= old.json.length;
      }
    }
    for (const c of [...this.clients.values()]) {
      try {
        c.sink.write(seq, type, json);
      } catch {
        this.clients.delete(c.id); // đầu ra hỏng: bỏ máy khách này, không để nó làm hỏng các máy khác
      }
    }
  }

  get currentSeq(): number {
    return this.seq;
  }

  /** Mã của lần chạy hiện tại; máy khách nối lại từ lần chạy cũ phải nhận snapshot mới. */
  get currentEpoch(): string {
    return this.epoch;
  }

  /** Số kênh relay đang nghe — cho phép `publish` chạy kể cả khi máy chủ HTTP cục bộ không mở (chỉ dùng relay). */
  private relayUsers = 0;
  retainRelay(): () => void {
    this.relayUsers++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.relayUsers--;
      }
    };
  }

  private beat(): void {
    for (const c of [...this.clients.values()]) {
      if (c.sink.buffered() > MAX_BUFFERED) this.closeClient(c, 'slow');
      else if (c.sink instanceof SseSink) c.sink.heartbeat();
    }
  }

  private closeClient(c: Client, reason: string): void {
    if (!this.clients.delete(c.id)) return;
    try {
      c.sink.write(this.seq, 'bye', JSON.stringify({ type: 'bye', seq: this.seq, reason }));
    } catch {
      /* đã đóng */
    }
    c.sink.close();
    this.o.onChange?.();
  }

  /** Ngắt mọi đầu ra của một thiết bị (dùng khi relay phát hiện thiết bị bị thu hồi…). */
  closeDevice(deviceId: string, reason: string): void {
    for (const c of [...this.clients.values()]) if (c.deviceId === deviceId) this.closeClient(c, reason);
  }

  /**
   * Gắn một đầu ra vào luồng sự kiện. Từ lúc đọc ring đến lúc đăng ký là đồng bộ: snapshot/phần bù và luồng trực tiếp không hở nhau.
   * Trả hàm gỡ (không phát `bye`).
   */
  attachSink(deviceId: string, sink: Sink, resume: { since?: number; epoch?: string } = {}): () => void {
    const mine = [...this.clients.values()].filter((c) => c.deviceId === deviceId);
    while (mine.length >= MAX_STREAMS_PER_DEVICE) this.closeClient(mine.shift()!, 'too_many_streams');
    const { since, epoch } = resume;
    const oldest = this.ring[0]?.seq;
    const sameRun = epoch === this.epoch;
    const canResume = sameRun && since !== undefined && since <= this.seq && (since === this.seq || (oldest !== undefined && since >= oldest - 1));
    if (canResume) {
      sink.write(this.seq, 'resume', JSON.stringify({ type: 'resume', seq: this.seq, from: since, epoch: this.epoch }));
      for (const e of this.ring) if (e.seq > since!) sink.write(e.seq, e.type, e.json);
    } else {
      sink.write(this.seq, 'snapshot', JSON.stringify({ type: 'snapshot', seq: this.seq, state: this.backend.state(), epoch: this.epoch }));
    }
    const client: Client = { id: ++this.nextClient, deviceId, sink };
    this.clients.set(client.id, client);
    this.o.onChange?.();
    return () => {
      if (this.clients.delete(client.id)) this.o.onChange?.();
    };
  }

  /** Làm mới phần trạng thái nạp bất đồng bộ trước khi chụp snapshot (gọi trước attachSink). */
  prepareState(): Promise<void> {
    return this.backend.prepare();
  }

  // ── thiết bị relay ──────────────────────────────────────────────────────────
  /** Danh sách thiết bị relay thuộc một máy (host) — đọc lại từ kho để thấy cả thay đổi từ cửa sổ VS Code khác. */
  async relayDevices(hostId: string): Promise<RemoteDevice[]> {
    await this.refreshDevices();
    return this.devices.filter((d) => d.kind === 'relay' && d.hostId === hostId && typeof d.key === 'string');
  }

  async addRelayDevice(d: { id: string; label: string; key: string; hostId: string }): Promise<void> {
    const dev: RemoteDevice = { id: d.id, label: cleanLabel(d.label), kind: 'relay', key: d.key, hostId: d.hostId, createdAt: this.now(), lastSeen: this.now() };
    await this.mutate((list) => [...list, dev].slice(-MAX_DEVICES));
    this.log('info', `Remote: đã ghép đôi thiết bị relay "${dev.label}"`);
    this.o.onChange?.();
  }

  /** Ghi nhận thiết bị relay vừa dùng (gia hạn hạn dùng trượt) — hết hạn thì thu hồi và trả false. */
  async touchRelayDevice(id: string): Promise<boolean> {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return false;
    const idleMs = Math.max(1, this.o.idleDays?.() ?? 30) * DAY_MS;
    if (this.now() - d.lastSeen > idleMs) {
      void this.revoke(id).catch(() => undefined);
      return false;
    }
    d.lastSeen = this.now();
    if (this.now() - this.lastSave > SAVE_SEEN_EVERY_MS) {
      const seen = d.lastSeen;
      void this.mutate((list) => list.map((x) => (x.id === id ? { ...x, lastSeen: seen } : x))).catch(() => undefined);
    }
    return true;
  }

  /** Chạy một lệnh đã nhận từ máy khách (HTTP hoặc relay): giới hạn tốc độ → kiểm hợp lệ → thi hành. */
  async execCommand(device: { id: string; label: string }, body: unknown): Promise<CommandOutcome> {
    const t = this.now();
    const times = (this.cmdTimes.get(device.id) ?? []).filter((x) => t - x < 60_000);
    if (times.length >= CMD_LIMIT_PER_MIN) return { ok: false, status: 429, error: 'rate_limited' };
    times.push(t);
    this.cmdTimes.set(device.id, times);
    // Phiên «tài khoản» mỗi lần nối lại là một mã mới (ACCOUNT_DEV:<sid>) nên bảng này sẽ phình dần nếu không dọn: bỏ các mã đã im quá một phút.
    if (this.cmdTimes.size > 256) for (const [id, ts] of this.cmdTimes) if (id !== device.id && (ts.length === 0 || t - ts[ts.length - 1]! >= 60_000)) this.cmdTimes.delete(id);
    const parsed = parseCommand(body, { canBypass: this.o.canBypass?.() ?? false });
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    try {
      await this.backend.command({ id: device.id, label: device.label }, parsed.cmd);
      return { ok: true };
    } catch (err) {
      this.log('warn', `Remote: lệnh ${parsed.cmd.type} lỗi: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, status: 500, error: 'command_failed', message: err instanceof Error ? err.message.slice(0, 300) : 'error' };
    }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  private corsHeaders(req?: http.IncomingMessage): Record<string, string> {
    const origin = String(req?.headers.origin ?? '');
    return origin && this.o.allowedOrigins().includes(origin)
      ? { 'access-control-allow-origin': origin, 'access-control-allow-private-network': 'true', vary: 'Origin' }
      : { vary: 'Origin' };
  }

  /** CORS chỉ được thêm khi Origin nằm trong danh sách cho phép — nên 403 vì Origin/Host lạ không bao giờ đọc được từ trang web. */
  private send(res: http.ServerResponse, code: number, body: unknown, req?: http.IncomingMessage, extra: Record<string, string> = {}): void {
    if (res.headersSent) return;
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...this.corsHeaders(req), ...extra });
    res.end(code === 204 ? undefined : JSON.stringify(body));
  }

  private hostAllowed(host: string): boolean {
    if (LOOPBACK_HOST.test(host)) return true;
    const name = host.replace(/:\d+$/, '').toLowerCase();
    return (this.o.allowedHosts?.() ?? []).some((h) => h.toLowerCase() === name);
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

  private failedAuth(): void {
    this.authFails.push(this.now());
  }

  private lockedOut(): boolean {
    const t = this.now();
    this.authFails = this.authFails.filter((x) => t - x < 60_000);
    return this.authFails.length >= FAIL_LIMIT;
  }

  private async authenticate(req: http.IncomingMessage): Promise<RemoteDevice | null> {
    const m = /^Bearer (\S{20,200})$/.exec(String(req.headers.authorization ?? ''));
    if (!m) return null;
    await this.refreshDevices();
    const h = sha256(m[1]!);
    const d = this.devices.find((x) => x.kind !== 'relay' && typeof x.tokenHash === 'string' && safeEq(h, x.tokenHash));
    if (!d) return null;
    const idleMs = Math.max(1, this.o.idleDays?.() ?? 30) * DAY_MS;
    if (this.now() - d.lastSeen > idleMs) {
      void this.revoke(d.id).catch(() => undefined);
      return null;
    }
    d.lastSeen = this.now();
    if (this.now() - this.lastSave > SAVE_SEEN_EVERY_MS) {
      const id = d.id;
      const seen = d.lastSeen;
      void this.mutate((list) => list.map((x) => (x.id === id ? { ...x, lastSeen: seen } : x))).catch(() => undefined);
    }
    return d;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.hostAllowed(String(req.headers.host ?? ''))) return this.send(res, 403, { error: 'host' }, req);
    const origin = req.headers.origin === undefined ? undefined : String(req.headers.origin);
    if (origin !== undefined && !this.o.allowedOrigins().includes(origin)) return this.send(res, 403, { error: 'origin' }, req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      return this.send(res, 204, null, req, {
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '600',
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/hello') {
      await this.refreshDevices();
      const pairing = !!this.pairing && this.pairing.expiresAt > this.now();
      return this.send(res, 200, { app: 'locaith-agent-remote', v: REMOTE_API_VERSION, ...this.backend.info(), pairing, paired: this.devices.length > 0 }, req);
    }
    if (req.method === 'POST' && url.pathname === '/v1/pair') return this.pair(req, res, origin);

    // Xác thực trước, chặn sau: token đúng không bao giờ bị khoá ngoài chỉ vì người lạ đang dò (token 256 bit nên dò vô ích, giới hạn chỉ để giảm tải).
    const device = await this.authenticate(req);
    if (!device) {
      if (this.lockedOut()) return this.send(res, 429, { error: 'too_many_attempts' }, req, { 'retry-after': '60' });
      this.failedAuth();
      return this.send(res, 401, { error: 'unauthorized' }, req);
    }

    if (req.method === 'GET' && url.pathname === '/v1/ping') return this.send(res, 200, { ok: true, v: REMOTE_API_VERSION }, req);
    if (req.method === 'GET' && url.pathname === '/v1/state') {
      await this.backend.prepare();
      return this.send(res, 200, { seq: this.seq, state: this.backend.state() }, req);
    }
    if (req.method === 'GET' && url.pathname === '/v1/stream') return this.stream(req, res, device, url);
    if (req.method === 'POST' && url.pathname === '/v1/cmd') return this.command(req, res, device);
    if (req.method === 'POST' && url.pathname === '/v1/unpair') {
      await this.revoke(device.id);
      return this.send(res, 200, { ok: true }, req);
    }
    return this.send(res, 404, { error: 'not_found' }, req);
  }

  private async pair(req: http.IncomingMessage, res: http.ServerResponse, origin: string | undefined): Promise<void> {
    const p = this.pairing;
    if (!p || p.expiresAt <= this.now()) return this.send(res, 409, { error: 'no_pairing' }, req);
    const b = (await this.readBody(req)) as { code?: unknown; label?: unknown } | null | undefined;
    if (b === undefined) return this.send(res, 413, { error: 'too_large' }, req);
    const code = typeof b?.code === 'string' ? b.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (!code || !safeEq(code, p.code.replace('-', ''))) {
      if (++p.tries >= MAX_TRIES) this.pairing = null; // thử sai quá nhiều: huỷ mã
      return this.send(res, 401, { error: 'bad_code', triesLeft: this.pairing ? MAX_TRIES - p.tries : 0 }, req);
    }
    const token = `lr_${randomBytes(32).toString('base64url')}`;
    const device: RemoteDevice = { id: randomBytes(9).toString('base64url'), label: cleanLabel(b?.label), ...(origin ? { origin } : {}), tokenHash: sha256(token), createdAt: this.now(), lastSeen: this.now() };
    this.pairing = null;
    await this.mutate((list) => [...list, device].slice(-MAX_DEVICES));
    this.log('info', `Remote: đã ghép đôi thiết bị "${device.label}"${origin ? ` (${origin})` : ''}`);
    this.o.onChange?.();
    return this.send(res, 200, { token, deviceId: device.id, v: REMOTE_API_VERSION, host: this.backend.info() }, req);
  }

  private async command(req: http.IncomingMessage, res: http.ServerResponse, device: RemoteDevice): Promise<void> {
    const body = await this.readBody(req);
    if (body === undefined) return this.send(res, 413, { error: 'too_large' }, req);
    const out = await this.execCommand({ id: device.id, label: device.label }, body);
    if (out.ok) return this.send(res, 200, { ok: true }, req);
    return this.send(res, out.status, { error: out.error, ...(out.message ? { message: out.message } : {}) }, req, out.status === 429 ? { 'retry-after': '10' } : {});
  }

  private async stream(req: http.IncomingMessage, res: http.ServerResponse, device: RemoteDevice, url: URL): Promise<void> {
    await this.backend.prepare();
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw !== null && /^\d{1,12}$/.test(sinceRaw) ? Number(sinceRaw) : undefined;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...this.corsHeaders(req),
    });
    res.write(': ok\n\n');
    const sink = new SseSink(res);
    const detach = this.attachSink(device.id, sink, { since, epoch: url.searchParams.get('epoch') ?? undefined });
    res.on('error', detach);
    req.on('close', detach);
  }
}
