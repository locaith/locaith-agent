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
 *  • mọi đường dẫn khác đều cần `Authorization: Bearer <token>` (so sánh thời gian không đổi); token dùng chung giữa các cửa sổ VS Code qua kho bí mật;
 *  • thân yêu cầu tối đa 8 MB; mỗi lệnh có hạn giờ và huỷ được; huỷ ghép đôi thu hồi token ở mọi cửa sổ.
 * Không import `vscode`.
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

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
}

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
        this.log('info', `Cầu nối Chrome lắng nghe 127.0.0.1:${this.port}`);
        return this.port;
      }
      server.close();
    }
    this.startError = 'Không mở được cổng cho cầu nối Chrome (các cổng 47615–47620 đang bận).';
    throw new Error(this.startError);
  }

  stop(): void {
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
    return {
      running: !!this.server,
      ...(this.port ? { port: this.port } : {}),
      paired: !!this.creds.token,
      connected: this.connected(),
      ...(this.creds.extId ? { extensionId: this.creds.extId } : {}),
      ...(pairing ? { pairing } : {}),
      ...(req ? { pairRequest: req } : {}),
      ...(this.startError ? { error: this.startError } : {}),
    };
  }

  connected(): boolean {
    return !!this.server && this.now() - this.lastPoll < CONNECTED_MS;
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
    if (req.method === 'POST' && url.pathname === '/v1/pair') return this.pair(req, res, em?.[1]);
    // Ghép đôi KHÔNG MÃ — không cần token (chưa có), nhưng chỉ extension (Origin chrome-extension://) và cần người dùng bấm Cho phép trong VS Code.
    if (url.pathname === '/v1/pair/request' && req.method === 'POST') return this.pairRequestHttp(req, res, em?.[1]);
    if (url.pathname === '/v1/pair/status' && req.method === 'GET') return this.pairStatusHttp(req, res, em?.[1], url.searchParams.get('id') ?? '');
    if (url.pathname === '/v1/pair/cancel' && req.method === 'POST') return this.pairCancelHttp(req, res, em?.[1]);

    const auth = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!this.creds.token || !auth || !safeEq(auth, this.creds.token)) return this.send(res, 401, { error: 'unauthorized' }, req);
    if (em && this.creds.extId && em[1] !== this.creds.extId) return this.send(res, 403, { error: 'origin' }, req);

    if (req.method === 'GET' && url.pathname === '/v1/ping') return this.send(res, 200, { ok: true, v: BRIDGE_VERSION }, req);
    if (req.method === 'GET' && url.pathname === '/v1/poll') {
      this.lastPoll = this.now();
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
    if (r.state === 'approved') return this.send(res, 200, { state: 'approved', token: r.token, v: BRIDGE_VERSION }, req);
    return this.send(res, 200, { state: 'denied' }, req);
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
    return this.send(res, 200, { token, v: BRIDGE_VERSION }, req);
  }
}
