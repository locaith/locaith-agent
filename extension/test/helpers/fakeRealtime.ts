/**
 * Máy chủ Supabase Realtime giả (giao thức kênh Phoenix vsn 1.0.0, phần quảng bá + hiện diện + nhịp tim) chạy bằng WebSocket thật (`ws`).
 * Dùng để kiểm thử RealtimeLink và cả trang web đầu-cuối mà không cần mạng. Hành vi bám theo máy chủ thật đã dò ngày 04/11/2026:
 *  • khoá apikey trong URL; join `realtime:<tên>` trả phx_reply ok; tin quảng bá chuyển tới MỌI người trong kênh trừ người gửi (self:false);
 *  • tin lớn hơn ~250 KB bị bỏ im lặng; hiện diện: track → presence_diff cho người khác, presence_state khi vừa vào.
 */

import type * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

interface Member {
  ws: WebSocket;
  topic: string;
  presenceKey?: string;
  presence?: unknown;
}

export class FakeRealtime {
  private wss?: WebSocketServer;
  url = '';
  apikey = 'test-anon-key';
  members = new Set<Member>();
  /** Mọi tin quảng bá đã đi qua (đã giải JSON). */
  broadcasts: { topic: string; payload: any }[] = [];
  /** Tin lớn hơn mức này bị bỏ (giống giới hạn gói Free). */
  maxPayload = 250 * 1024;
  /** Đặt true để từ chối lệnh join (mô phỏng lỗi xác thực). */
  rejectJoin = false;
  /** Lý do trả về khi rejectJoin = true (mặc định mô phỏng lỗi xác thực; đặt chuỗi giới hạn của Realtime để mô phỏng quá tải). */
  rejectReason = 'unauthorized';
  /**
   * Mô phỏng giới hạn gói: số kết nối WebSocket đồng thời tối đa (null = không giới hạn). Quá số đó, lệnh join bị từ chối với lý do giống tài liệu Supabase
   * («too_many_connections»). Chuỗi chính xác của Realtime thật khi chạm trần chưa được quan sát — xem core/remote/queue.ts.
   */
  maxConnections: number | null = null;
  /** Từ chối cả bước bắt tay HTTP (mô phỏng hết chỗ ở tầng kết nối): trả mã + thân JSON này thay vì nâng cấp lên WebSocket. */
  rejectUpgrade: { status: number; body: string } | null = null;
  /** Đặt true để không trả lời nhịp tim (mô phỏng kết nối chết). */
  ignoreHeartbeat = false;
  connections = 0;
  /** Số lần máy khách xin nâng cấp lên WebSocket (kể cả khi bị từ chối ở tầng HTTP — `connections` chỉ đếm lần được nhận). */
  upgrades = 0;
  heartbeats = 0;

  async start(): Promise<string> {
    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, cb) => {
        this.upgrades++;
        return this.rejectUpgrade ? cb(false, this.rejectUpgrade.status, this.rejectUpgrade.body) : cb(true);
      },
    });
    await new Promise<void>((r) => this.wss!.once('listening', () => r()));
    this.url = `http://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
    this.init(this.wss);
    return this.url;
  }

  /** Dùng chung một cổng với máy chủ HTTP khác: chỉ nhận yêu cầu nâng cấp lên WebSocket tới /realtime/v1/websocket. */
  attach(server: http.Server): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    this.init(wss);
    server.on('upgrade', (req, socket, head) => {
      if (!/^\/realtime\/v1\/websocket/.test(req.url ?? '')) return void socket.destroy();
      this.upgrades++;
      const rej = this.rejectUpgrade;
      if (rej) {
        // Từ chối ở tầng HTTP với thân JSON — đúng như một máy chủ hết chỗ kết nối.
        const body = rej.body;
        socket.write(`HTTP/1.1 ${rej.status} Rejected\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        return void socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  }

  private init(wss: WebSocketServer): void {
    wss.on('connection', (ws, req) => {
      this.connections++;
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.searchParams.get('apikey') !== this.apikey) return void ws.close(4001, 'bad apikey');
      ws.on('message', (data) => this.onMessage(ws, data.toString()));
      ws.on('close', () => {
        for (const m of [...this.members]) if (m.ws === ws) this.leave(m);
      });
    });
  }

  private leave(m: Member): void {
    this.members.delete(m);
    if (m.presence !== undefined) this.sendPresenceDiff(m, 'leaves');
  }

  private reply(ws: WebSocket, topic: string, ref: string | null, status: 'ok' | 'error', response: unknown = {}): void {
    ws.send(JSON.stringify({ topic, event: 'phx_reply', payload: { status, response }, ref }));
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let m: { topic: string; event: string; payload: any; ref: string | null };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.topic === 'phoenix' && m.event === 'heartbeat') {
      this.heartbeats++;
      if (!this.ignoreHeartbeat) this.reply(ws, 'phoenix', m.ref, 'ok');
      return;
    }
    if (m.event === 'phx_join') {
      if (this.rejectJoin) return this.reply(ws, m.topic, m.ref, 'error', { reason: this.rejectReason });
      if (this.maxConnections !== null && (this.wss?.clients.size ?? 0) > this.maxConnections) return this.reply(ws, m.topic, m.ref, 'error', { reason: 'too_many_connections' });
      this.members.add({ ws, topic: m.topic });
      this.reply(ws, m.topic, m.ref, 'ok', { postgres_changes: [] });
      return;
    }
    const me = [...this.members].find((x) => x.ws === ws && x.topic === m.topic);
    if (!me) return;
    if (m.event === 'broadcast') {
      if (JSON.stringify(m).length > this.maxPayload) return; // bỏ im lặng như Realtime thật
      this.broadcasts.push({ topic: m.topic, payload: m.payload });
      for (const o of this.members) if (o !== me && o.topic === m.topic) o.ws.send(JSON.stringify({ topic: m.topic, event: 'broadcast', payload: m.payload }));
      return;
    }
    if (m.event === 'presence' && m.payload?.event === 'track') {
      me.presence = m.payload.payload;
      me.presenceKey = String(m.ref ?? Math.random());
      this.reply(ws, m.topic, m.ref, 'ok');
      this.sendPresenceDiff(me, 'joins');
      return;
    }
    if (m.event === 'phx_leave') {
      this.leave(me);
      this.reply(ws, m.topic, m.ref, 'ok');
    }
  }

  private sendPresenceDiff(m: Member, kind: 'joins' | 'leaves'): void {
    const body = { [kind]: { [m.presenceKey ?? 'k']: { metas: [m.presence] } }, [kind === 'joins' ? 'leaves' : 'joins']: {} };
    for (const o of this.members) if (o !== m && o.topic === m.topic) o.ws.send(JSON.stringify({ topic: m.topic, event: 'presence_diff', payload: body }));
  }

  /** Số người đang ở trong một kênh. */
  count(topic: string): number {
    return [...this.members].filter((m) => m.topic === `realtime:${topic}`).length;
  }

  /** Cắt mọi kết nối (mô phỏng relay/mạng sập) — máy khách phải tự nối lại. */
  dropAll(): void {
    for (const c of this.wss?.clients ?? []) c.terminate();
  }

  async stop(): Promise<void> {
    const w = this.wss;
    this.wss = undefined;
    if (!w) return;
    for (const c of w.clients) c.terminate();
    await new Promise<void>((r) => w.close(() => r()));
  }
}
