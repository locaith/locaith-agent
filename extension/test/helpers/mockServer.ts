/**
 * Máy chủ HTTP giả (127.0.0.1, cổng ngẫu nhiên) để test các adapter mà không chạm API thật.
 * - Trả lời theo hàng đợi kịch bản (FIFO), ghi lại mọi yêu cầu (header + body) để kiểm tra.
 * - Hỗ trợ SSE, JSON, cắt khúc theo byte, trễ giữa các khúc, giữ kết nối mở (test hủy), ngắt kết nối giữa chừng.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Body đã parse JSON (nếu hợp lệ). */
  json: any;
  /** Máy khách đã đóng kết nối trước khi máy chủ kết thúc phản hồi. */
  clientClosed: boolean;
}

export interface SseEvent {
  event?: string;
  data: unknown;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  /** Danh sách sự kiện SSE; `data` là object sẽ được JSON.stringify, là string thì ghi nguyên. */
  sse?: SseEvent[];
  /** Văn bản SSE ghi nguyên văn (để test CRLF, comment…). */
  rawSse?: string;
  /** Cắt phần byte đã mã hoá thành các khúc có kích thước này. */
  chunkBytes?: number;
  chunkDelayMs?: number;
  /** Không kết thúc phản hồi sau khi ghi xong (test hủy). */
  keepOpen?: boolean;
  /** Ngắt kết nối sau N khúc (mô phỏng lỗi giữa chừng). */
  dropAfterChunks?: number;
  /** Trễ trước khi trả lời. */
  delayMs?: number;
}

export function sseText(events: SseEvent[]): string {
  return events
    .map((e) => {
      const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      return `${e.event ? `event: ${e.event}\n` : ''}${data
        .split('\n')
        .map((l) => `data: ${l}`)
        .join('\n')}\n\n`;
    })
    .join('');
}

type ReplyFactory = MockReply | ((req: RecordedRequest) => MockReply);

export class MockServer {
  readonly requests: RecordedRequest[] = [];
  private queue: ReplyFactory[] = [];
  private fallback: ReplyFactory | undefined;
  private server: http.Server;
  private sockets = new Set<import('node:net').Socket>();
  url = '';

  private constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  static async start(): Promise<MockServer> {
    const m = new MockServer();
    await new Promise<void>((resolve) => m.server.listen(0, '127.0.0.1', resolve));
    const { port } = m.server.address() as AddressInfo;
    m.url = `http://127.0.0.1:${port}`;
    return m;
  }

  /** Thêm một phản hồi vào hàng đợi (mỗi yêu cầu lấy một phản hồi). */
  reply(r: ReplyFactory): this {
    this.queue.push(r);
    return this;
  }

  /** Phản hồi dùng khi hàng đợi trống. */
  replyAlways(r: ReplyFactory): this {
    this.fallback = r;
    return this;
  }

  reset(): void {
    this.queue = [];
    this.fallback = undefined;
    this.requests.length = 0;
  }

  get lastRequest(): RecordedRequest {
    const r = this.requests[this.requests.length - 1];
    if (!r) throw new Error('Chưa có yêu cầu nào tới máy chủ giả.');
    return r;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    let json: any;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    const rec: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      path: (req.url ?? '/').split('?')[0],
      headers: req.headers,
      body,
      json,
      clientClosed: false,
    };
    this.requests.push(rec);
    res.on('close', () => {
      if (!res.writableEnded) rec.clientClosed = true;
    });

    const factory = this.queue.shift() ?? this.fallback;
    if (!factory) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Máy chủ giả: chưa có kịch bản cho yêu cầu này.' } }));
      return;
    }
    const reply = typeof factory === 'function' ? factory(rec) : factory;
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));

    const status = reply.status ?? 200;
    const headers: Record<string, string> = { ...(reply.headers ?? {}) };

    if (reply.json !== undefined) {
      headers['content-type'] ??= 'application/json';
      res.writeHead(status, headers);
      res.end(JSON.stringify(reply.json));
      return;
    }
    if (reply.text !== undefined && reply.sse === undefined && reply.rawSse === undefined) {
      res.writeHead(status, headers);
      res.end(reply.text);
      return;
    }

    headers['content-type'] ??= 'text/event-stream';
    headers['cache-control'] ??= 'no-cache';
    res.writeHead(status, headers);
    const text = reply.rawSse ?? sseText(reply.sse ?? []);
    const bytes = Buffer.from(text, 'utf8');
    const size = reply.chunkBytes && reply.chunkBytes > 0 ? reply.chunkBytes : bytes.length || 1;
    let sent = 0;
    for (let i = 0; i < bytes.length; i += size) {
      if (res.destroyed) return;
      if (reply.dropAfterChunks !== undefined && sent >= reply.dropAfterChunks) {
        res.socket?.destroy();
        return;
      }
      res.write(bytes.subarray(i, i + size));
      sent++;
      if (reply.chunkDelayMs) await new Promise((r) => setTimeout(r, reply.chunkDelayMs));
    }
    if (reply.dropAfterChunks !== undefined && sent >= reply.dropAfterChunks) {
      res.socket?.destroy();
      return;
    }
    if (!reply.keepOpen) res.end();
  }
}

/** Đọc toàn bộ luồng sự kiện của provider vào một mảng. */
export async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
