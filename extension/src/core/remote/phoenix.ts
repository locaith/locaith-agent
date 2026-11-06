/**
 * Máy khách tối giản cho Supabase Realtime (giao thức kênh Phoenix, vsn 1.0.0 / JSON) — chỉ đúng phần Remote cần:
 * vào MỘT kênh công khai, gửi/nhận tin quảng bá, tự nối lại, nhịp tim, và (tuỳ chọn) khai báo hiện diện.
 *
 *  • Kênh công khai: bất kỳ ai có khoá anon (công khai) đều vào được MỌI kênh — nên bí mật nằm ở tên kênh (mã máy 128 bit) và ở mã hoá đầu-cuối
 *    (e2e.ts). Relay chỉ chuyển bản mã; không tin gì ở nó ngoài việc chuyển tin.
 *  • Tin vượt ~250 KB bị Realtime bỏ im lặng → bên gọi phải cắt mảnh trước (encodeJson, mảnh ≤ ~56 KB sau mã hoá).
 *
 * Không import `vscode`. Nhận một nhà máy WebSocket để kiểm thử với máy chủ giả; mặc định dùng gói `ws` (Node 20 của VS Code 1.90 chưa có WebSocket toàn cục).
 */

import { classifyRealtimeFailure, queueWaitMs, QUEUE_MIN_RETRY_GAP_MS, type QueueKind, type QueueState } from './queue';
import type { RelayLink, RelayStatus } from './relayHost';

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', cb: (ev: { data?: unknown; code?: number; reason?: string; message?: string; error?: unknown }) => void): void;
}

export interface RealtimeOptions {
  /** Gốc dự án, ví dụ https://xyz.supabase.co (hoặc ws://127.0.0.1:port khi kiểm thử). */
  baseUrl: string;
  apikey: string;
  /** Tên kênh, không kèm tiền tố `realtime:`. */
  topic: string;
  createSocket: (url: string) => WsLike;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  heartbeatMs?: number;
  connectTimeoutMs?: number;
  /** Thời gian chờ nối lại sau `attempt` lần thất bại liên tiếp (ms). */
  backoff?: (attempt: number) => number;
  /** Thời gian chờ trong hàng chờ khi relay QUÁ TẢI (xem queue.ts); mặc định theo lịch tăng dần có xáo trộn. */
  queueWait?: (attempt: number, kind: QueueKind) => number;
  /** Khoảng tối thiểu giữa hai lần thử khi gọi retryNow() (mặc định QUEUE_MIN_RETRY_GAP_MS = 5 giây). */
  queueMinRetryGapMs?: number;
}

const OPEN = 1;
const EVENT = 'm';

export function realtimeUrl(base: string, apikey: string): string {
  const u = base.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${u}${/\/realtime\/v1\/websocket$/.test(u) ? '' : '/realtime/v1/websocket'}?apikey=${encodeURIComponent(apikey)}&vsn=1.0.0`;
}

export class RealtimeLink implements RelayLink {
  status: RelayStatus = 'idle';
  private ws?: WsLike;
  private ref = 0;
  private joinRef = '';
  private joined = false;
  private hbPending: string | null = null;
  private hbTimer?: ReturnType<typeof setInterval>;
  private connTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private stopped = true;
  private presence?: object;
  private queueState: QueueState | null = null;
  private lastAttemptAt = 0;
  private readonly msgCbs = new Set<(m: unknown) => void>();
  private readonly stCbs = new Set<(s: RelayStatus) => void>();
  private readonly presenceCbs = new Set<(n: number) => void>();
  private readonly linkCbs = new Set<(up: boolean) => void>();
  private readonly queueCbs = new Set<(q: QueueState | null) => void>();
  private readonly topic: string;
  private readonly hbMs: number;
  private readonly connectMs: number;
  private readonly backoff: (n: number) => number;
  private readonly log: NonNullable<RealtimeOptions['log']>;

  constructor(private readonly o: RealtimeOptions) {
    this.topic = `realtime:${o.topic}`;
    this.hbMs = o.heartbeatMs ?? 25_000;
    this.connectMs = o.connectTimeoutMs ?? 12_000;
    this.backoff = o.backoff ?? ((n) => Math.min(30_000, 1000 * 2 ** Math.min(n, 5)) * (0.75 + Math.random() * 0.5));
    this.log = o.log ?? (() => {});
  }

  onMessage(cb: (m: unknown) => void): () => void {
    this.msgCbs.add(cb);
    return () => void this.msgCbs.delete(cb);
  }
  onStatus(cb: (s: RelayStatus) => void): () => void {
    this.stCbs.add(cb);
    return () => void this.stCbs.delete(cb);
  }
  /** Số máy khách đang hiện diện trên kênh (kể cả mình nếu đã track). */
  onPresence(cb: (n: number) => void): () => void {
    this.presenceCbs.add(cb);
    return () => void this.presenceCbs.delete(cb);
  }

  /** Đường truyền vừa vào kênh (true) hoặc vừa mất (false) — RelayClient dùng để bắt tay lại ngay. */
  onLink(cb: (up: boolean) => void): () => void {
    this.linkCbs.add(cb);
    return () => void this.linkCbs.delete(cb);
  }

  /** Đang xếp hàng vì relay quá tải? (null = không). Xem queue.ts. */
  get queue(): QueueState | null {
    return this.queueState;
  }

  /** Báo mỗi khi trạng thái hàng chờ đổi: vào hàng, sang lần thử kế tiếp, đang thử, hoặc ra khỏi hàng (null). */
  onQueue(cb: (q: QueueState | null) => void): () => void {
    this.queueCbs.add(cb);
    return () => void this.queueCbs.delete(cb);
  }

  private setQueue(q: QueueState | null): void {
    if (q === null && this.queueState === null) return;
    this.queueState = q;
    for (const cb of [...this.queueCbs]) cb(q);
  }

  /**
   * Thử vào lại NGAY thay vì chờ hết giờ. false = chưa được phép: không đang xếp hàng, đang thử dở, hoặc chưa quá QUEUE_MIN_RETRY_GAP_MS kể từ lần thử trước
   * (một nút bấm không được phép biến thành đòn dội vào relay đang quá tải).
   */
  retryNow(): boolean {
    const q = this.queueState;
    if (this.stopped || !q || q.trying) return false;
    if (Date.now() - this.lastAttemptAt < (this.o.queueMinRetryGapMs ?? QUEUE_MIN_RETRY_GAP_MS)) return false;
    this.connect();
    return true;
  }

  /** Relay từ chối vì quá tải: đóng ổ cắm, vào/tiếp tục hàng chờ và hẹn lần thử kế tiếp (có đếm ngược). */
  private enterQueue(ws: WsLike, kind: QueueKind, reason: string): void {
    if (this.ws === ws) {
      this.ws = undefined;
      try {
        ws.close();
      } catch {
        /* đã đóng */
      }
    }
    this.joined = false;
    this.clearTimers();
    const now = Date.now();
    const prev = this.queueState;
    const attempt = (prev?.attempt ?? 0) + 1;
    const waitMs = Math.max(1, Math.round((this.o.queueWait ?? queueWaitMs)(attempt, kind)));
    this.log('warn', `Realtime quá tải (${kind}: ${reason.slice(0, 120)}) — xếp hàng, thử lại sau ${Math.round(waitMs / 1000)} giây (lần ${attempt}).`);
    this.setQueue({ kind, reason, attempt, since: prev?.since ?? now, retryAt: now + waitMs, waitMs, trying: false });
    this.setStatus('offline');
    this.retryTimer = setTimeout(() => this.connect(), waitMs);
  }

  /** Thất bại của ổ cắm đang dùng: quá tải → vào hàng chờ; còn lại → nối lại theo cách thường (và rời hàng chờ nếu đang có). */
  private fail(ws: WsLike, why: unknown[], close = true): void {
    if (this.ws !== ws) return;
    const cap = classifyRealtimeFailure(...why);
    if (cap) return this.enterQueue(ws, cap.kind, cap.reason);
    this.drop(ws, close);
  }

  private setStatus(s: RelayStatus): void {
    if (this.status === s) return;
    const was = this.status;
    this.status = s;
    for (const cb of [...this.stCbs]) cb(s);
    if (s === 'online') for (const cb of [...this.linkCbs]) cb(true);
    else if (was === 'online') for (const cb of [...this.linkCbs]) cb(false);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = undefined;
    this.joined = false;
    try {
      ws?.close(1000, 'bye');
    } catch {
      /* đã đóng */
    }
    this.setQueue(null);
    this.setStatus('idle');
  }

  /** Khai báo hiện diện (siêu dữ liệu KHÔNG bí mật: tên máy, thư mục, phiên bản). Gửi lại mỗi lần nối lại. */
  track(meta: object): void {
    this.presence = meta;
    if (this.joined) this.pushPresence();
  }

  send(msg: object): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN || !this.joined) return false;
    try {
      ws.send(JSON.stringify({ topic: this.topic, event: 'broadcast', payload: { type: 'broadcast', event: EVENT, payload: msg }, ref: String(++this.ref) }));
      return true;
    } catch {
      return false;
    }
  }

  private pushPresence(): void {
    if (!this.presence) return;
    try {
      this.ws?.send(JSON.stringify({ topic: this.topic, event: 'presence', payload: { type: 'presence', event: 'track', payload: this.presence }, ref: String(++this.ref) }));
    } catch {
      /* sẽ gửi lại khi nối lại */
    }
  }

  private clearTimers(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.connTimer) clearTimeout(this.connTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.hbTimer = this.connTimer = this.retryTimer = undefined;
    this.hbPending = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.lastAttemptAt = Date.now();
    if (this.queueState && !this.queueState.trying) this.setQueue({ ...this.queueState, trying: true });
    this.setStatus('connecting');
    let ws: WsLike;
    try {
      ws = this.o.createSocket(realtimeUrl(this.o.baseUrl, this.o.apikey));
    } catch (err) {
      this.log('warn', `Realtime: không tạo được kết nối: ${err instanceof Error ? err.message : String(err)}`);
      this.setQueue(null);
      return this.retry();
    }
    this.ws = ws;
    this.joined = false;
    this.connTimer = setTimeout(() => {
      this.log('warn', 'Realtime: hết giờ chờ kết nối');
      this.drop(ws);
    }, this.connectMs);
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.joinRef = String(++this.ref);
      ws.send(
        JSON.stringify({
          topic: this.topic,
          event: 'phx_join',
          payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, postgres_changes: [], private: false }, access_token: this.o.apikey },
          ref: this.joinRef,
          join_ref: this.joinRef,
        }),
      );
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws === ws) this.onRaw(ev.data);
    });
    // Lý do (nếu máy chủ nêu) đi kèm sự kiện đóng/lỗi — HTTP 4xx lúc bắt tay mang thân JSON như "too_many_connections" (xem wsNode.ts).
    ws.addEventListener('close', (ev) => this.fail(ws, [ev?.reason], false));
    ws.addEventListener('error', (ev) => this.fail(ws, [ev?.message, ev?.error]));
  }

  /** Đóng ổ cắm hiện tại và lên lịch nối lại theo cách THƯỜNG (mất mạng, hết giờ, mất nhịp tim…) — không phải quá tải nên rời hàng chờ nếu đang có. */
  private drop(ws: WsLike, close = true): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.joined = false;
    this.clearTimers();
    this.setQueue(null);
    if (close) {
      try {
        ws.close();
      } catch {
        /* bỏ qua */
      }
    }
    this.retry();
  }

  private retry(): void {
    if (this.stopped) return;
    this.setStatus('offline');
    const wait = this.backoff(this.attempt++);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private onRaw(data: unknown): void {
    let m: { topic?: string; event?: string; payload?: any; ref?: string | null };
    try {
      m = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    switch (m.event) {
      case 'phx_reply':
        if (m.ref && m.ref === this.joinRef) {
          if (m.payload?.status === 'ok') {
            if (this.connTimer) clearTimeout(this.connTimer);
            this.connTimer = undefined;
            this.joined = true;
            this.attempt = 0;
            this.hbTimer = setInterval(() => this.beat(), this.hbMs);
            this.hbTimer.unref?.();
            this.setStatus('online');
            this.setQueue(null); // vào được rồi: ra khỏi hàng chờ (nếu đang xếp hàng) — SAU khi status đã là 'online' để người nghe phân biệt "vào được" với "bị dừng"
            this.pushPresence();
          } else {
            const why = m.payload?.response ?? m.payload;
            this.log('warn', `Realtime: vào kênh thất bại (${JSON.stringify(why).slice(0, 160)})`);
            if (this.ws) this.fail(this.ws, [why]);
          }
        } else if (m.ref && m.ref === this.hbPending) {
          this.hbPending = null;
        }
        return;
      case 'broadcast':
        if (m.topic === this.topic && m.payload?.event === EVENT) for (const cb of [...this.msgCbs]) cb(m.payload.payload);
        return;
      case 'presence_state':
        if (m.topic === this.topic) for (const cb of [...this.presenceCbs]) cb(Object.keys(m.payload ?? {}).length);
        return;
      case 'phx_close':
      case 'phx_error':
        if (m.topic === this.topic && this.ws) {
          this.log('warn', `Realtime: kênh bị ${m.event}`);
          this.drop(this.ws);
        }
        return;
      case 'system':
        if (m.payload?.status === 'error') {
          this.log('warn', `Realtime: ${String(m.payload?.message ?? 'lỗi hệ thống').slice(0, 160)}`);
          // Đang ở bước vào kênh mà máy chủ báo chạm trần → vào hàng chờ ngay (đã vào kênh rồi thì để Realtime tự cắt và ta nối lại theo cách thường).
          if (!this.joined && this.ws) {
            const cap = classifyRealtimeFailure(m.payload?.message, m.payload?.extension);
            if (cap) this.enterQueue(this.ws, cap.kind, cap.reason);
          }
        }
        return;
      default:
        return;
    }
  }

  private beat(): void {
    const ws = this.ws;
    if (!ws) return;
    if (this.hbPending) {
      this.log('warn', 'Realtime: mất nhịp tim, nối lại');
      return this.drop(ws);
    }
    this.hbPending = String(++this.ref);
    try {
      ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: this.hbPending }));
    } catch {
      this.drop(ws);
    }
  }
}
