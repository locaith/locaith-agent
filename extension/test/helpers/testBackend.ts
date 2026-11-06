/**
 * "Máy chủ locaith.ai" giả cho kiểm thử tích hợp (VS Code thật, trình duyệt thật): MỘT cổng HTTP phục vụ
 *  • PostgREST RPC của tài khoản (MockAccountServer): /rest/v1/rpc/ext_*
 *  • Realtime (FakeRealtime): WebSocket /realtime/v1/websocket
 *  • cổng mô hình Locaith (MockGateway): /api/llm/v1/* — danh sách model, đồng ý thông báo dữ liệu theo tài khoản, /chat/completions, hàng chờ
 *  • điều khiển cho bài kiểm thử: /__admin/* (thêm người dùng, bấm «Cho phép» thay người dùng, thu hồi, ngắt Realtime, đọc dấu vết trên dây…).
 * Giống đúng cách extension thật nói chuyện với Supabase (một origin cho cả REST và WebSocket).
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeRealtime } from './fakeRealtime';
import { MockAccountServer } from './mockAccountServer';
import { MockGateway, type GatewayMode } from './mockGateway';

export class TestBackend {
  readonly account = new MockAccountServer();
  readonly realtime = new FakeRealtime();
  /** Cổng mô hình Locaith giả; nhận biết người gọi qua token thiết bị của máy chủ tài khoản giả. */
  readonly gateway = new MockGateway((token) => this.account.userIdForToken(token));
  private server?: http.Server;
  url = '';
  readonly anonKey = 'test-anon-key';

  async start(port = 0): Promise<string> {
    this.account.anonKey = this.anonKey;
    this.realtime.apikey = this.anonKey;
    this.server = http.createServer((req, res) => {
      if (req.url?.startsWith('/__admin/')) return void this.admin(req, res);
      if (this.gateway.handle(req, res)) return;
      this.account.handle(req, res);
    });
    this.realtime.attach(this.server);
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  private async admin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let b: any = {};
    try {
      b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      /* rỗng */
    }
    const send = (code: number, body: unknown): void => void res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(body));
    const path = (req.url ?? '').replace(/\?.*$/, '');
    try {
      switch (path) {
        case '/__admin/user':
          return send(200, this.account.addUser({ id: String(b.id), email: String(b.email), name: String(b.name ?? b.email) }));
        case '/__admin/approve':
          // Giống ext_auth_approve: người dùng (đã đăng nhập trên web) bấm «Cho phép».
          return send(200, { code: this.account.approve(String(b.userId), String(b.challenge), String(b.redirect), String(b.label ?? 'Máy thử')) });
        case '/__admin/revoke':
          this.account.revokeAll();
          return send(200, { ok: true });
        case '/__admin/expire-codes':
          this.account.expireCodes();
          return send(200, { ok: true });
        case '/__admin/mode':
          this.account.mode = b.mode === 'down' || b.mode === 'error' ? b.mode : undefined;
          return send(200, { ok: true });
        case '/__admin/state':
          return send(200, {
            devices: [...this.account.devices.values()].map((d) => ({ id: d.id, userId: d.userId, label: d.label, revoked: d.revoked })),
            hosts: [...this.account.hosts.values()],
            calls: this.account.calls.map((c) => c.fn),
            realtime: { connections: this.realtime.connections, members: this.realtime.members.size, broadcasts: this.realtime.broadcasts.length },
          });
        // Cổng mô hình Locaith giả: đặt hành vi (queue / quota / consentRequired…), đọc yêu cầu đã ghi, xoá sạch.
        case '/__admin/locaith/mode':
          this.gateway.mode = b as GatewayMode;
          return send(200, { ok: true });
        case '/__admin/locaith/state':
          return send(200, this.gateway.state());
        case '/__admin/locaith/reset':
          this.gateway.reset();
          return send(200, { ok: true });
        case '/__admin/realtime/drop':
          this.realtime.dropAll();
          return send(200, { ok: true });
        case '/__admin/realtime/limits': {
          // Mô phỏng quá tải: maxConnections (null = bỏ giới hạn), rejectJoin + lý do, rejectUpgrade {status, body}.
          if ('maxConnections' in b) this.realtime.maxConnections = b.maxConnections === null ? null : Number(b.maxConnections);
          if ('rejectJoin' in b) this.realtime.rejectJoin = !!b.rejectJoin;
          if ('rejectReason' in b) this.realtime.rejectReason = String(b.rejectReason);
          if ('rejectUpgrade' in b) this.realtime.rejectUpgrade = b.rejectUpgrade ? { status: Number(b.rejectUpgrade.status), body: String(b.rejectUpgrade.body ?? '') } : null;
          return send(200, { ok: true });
        }
        case '/__admin/wire-contains':
          // "Relay có thấy chữ này không?" — tìm trong MỌI tin quảng bá đã đi qua kênh Realtime.
          return send(200, { found: JSON.stringify(this.realtime.broadcasts).includes(String(b.text)), count: this.realtime.broadcasts.length });
        default:
          return send(404, { error: 'unknown admin route' });
      }
    } catch (err) {
      send(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async stop(): Promise<void> {
    await this.realtime.stop().catch(() => undefined);
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
}
