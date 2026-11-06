import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { RealtimeLink, type WsLike } from '../src/core/remote/phoenix';
import { classifyRealtimeFailure, fmtCountdown, queueWaitMs, QUEUE_MIN_RETRY_GAP_MS, type QueueState } from '../src/core/remote/queue';
import { nodeSocket } from '../src/core/remote/wsNode';
import { FakeRealtime } from './helpers/fakeRealtime';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 4000, what = 'điều kiện'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`hết giờ chờ ${what}`);
    await sleep(5);
  }
}

describe('classifyRealtimeFailure: nhận ra "relay quá tải" khác với lỗi thường', () => {
  const cases: [string, unknown, 'connections' | 'rate' | 'channels'][] = [
    ['mã trong tài liệu Supabase', 'too_many_connections', 'connections'],
    ['phx_reply.response.reason', { reason: 'ConnectionRateLimitReached: Too many connected users' }, 'connections'],
    ['thông điệp của bảng mã lỗi', 'The number of connected clients has reached its limit.', 'connections'],
    ['bắt tay HTTP kèm thân JSON', 'HTTP 403: {"error":"too_many_connections"}', 'connections'],
    ['quá nhiều kênh', 'Too many channels', 'channels'],
    ['ChannelRateLimitReached', { reason: 'ChannelRateLimitReached' }, 'channels'],
    ['quá nhiều lượt vào mỗi giây', 'ClientJoinRateLimitReached: Too many joins per second', 'rate'],
    ['too_many_joins', 'too_many_joins', 'rate'],
    ['tenant_events (quá nhiều tin mỗi giây)', 'tenant_events', 'rate'],
    ['HTTP 429', 'HTTP 429: ', 'rate'],
  ];
  for (const [name, input, kind] of cases) {
    it(`${name} → ${kind}`, () => {
      expect(classifyRealtimeFailure(input)?.kind).toBe(kind);
    });
  }

  it('lỗi KHÁC (sai khoá, mất mạng, máy chủ khởi động lại) không bị gọi là quá tải', () => {
    for (const x of ['unauthorized', { reason: 'Unauthorized access to Realtime channel.' }, 'Unexpected server response: 403', 'connect ECONNREFUSED 127.0.0.1:1', 'InvalidJWTToken', 'RealtimeRestarting', 'HTTP 403: forbidden', '', undefined, null, {}]) {
      expect(classifyRealtimeFailure(x), JSON.stringify(x)).toBeNull();
    }
  });

  it('gộp nhiều nguồn: chỉ cần một nguồn mang lý do quá tải', () => {
    expect(classifyRealtimeFailure(undefined, 'whatever', { reason: 'too_many_connections' })?.kind).toBe('connections');
  });

  it('cắt ngắn lý do dài để không tràn nhật ký/giao diện', () => {
    const r = classifyRealtimeFailure('too_many_connections ' + 'x'.repeat(1000))!;
    expect(r.reason.length).toBeLessThanOrEqual(200);
  });
});

describe('queueWaitMs / fmtCountdown', () => {
  it('chờ lâu dần theo từng lần bị từ chối, có trần, xáo trộn ±20%', () => {
    const lo = (a: number, k: 'connections' | 'rate') => queueWaitMs(a, k, () => 0);
    const hi = (a: number, k: 'connections' | 'rate') => queueWaitMs(a, k, () => 1);
    expect(lo(1, 'connections')).toBe(16_000); // 20 s × 0,8
    expect(hi(1, 'connections')).toBe(24_000); // 20 s × 1,2
    expect(lo(2, 'connections')).toBeGreaterThan(lo(1, 'connections'));
    expect(lo(3, 'connections')).toBeGreaterThan(lo(2, 'connections'));
    expect(hi(50, 'connections')).toBe(144_000); // trần 120 s × 1,2
    expect(lo(1, 'rate')).toBeLessThan(lo(1, 'connections')); // quá nhiều lượt/giây chỉ là cơn dồn nhất thời → chờ ngắn hơn
    expect(hi(50, 'rate')).toBe(54_000); // trần 45 s × 1,2
    for (let i = 0; i < 200; i++) {
      const w = queueWaitMs(2, 'connections');
      expect(w).toBeGreaterThanOrEqual(24_000);
      expect(w).toBeLessThanOrEqual(36_000);
    }
  });

  it('lần thử bất thường (0, âm, số lẻ) vẫn cho kết quả hợp lệ', () => {
    for (const a of [0, -3, 1.7, Number.MAX_SAFE_INTEGER]) expect(Number.isFinite(queueWaitMs(a, 'connections'))).toBe(true);
  });

  it('đếm ngược làm tròn LÊN (còn 0,3 giây vẫn hiện 0:01)', () => {
    expect(fmtCountdown(42_000)).toBe('0:42');
    expect(fmtCountdown(300)).toBe('0:01');
    expect(fmtCountdown(0)).toBe('0:00');
    expect(fmtCountdown(-5)).toBe('0:00');
    expect(fmtCountdown(61_000)).toBe('1:01');
    expect(fmtCountdown(120_000)).toBe('2:00');
  });

  it('khoảng tối thiểu giữa hai lần thử là 5 giây', () => {
    expect(QUEUE_MIN_RETRY_GAP_MS).toBe(5000);
  });
});

describe('RealtimeLink: hàng chờ khi relay quá tải', () => {
  let fake: FakeRealtime;
  const cleanups: (() => void)[] = [];
  afterEach(async () => {
    while (cleanups.length) cleanups.pop()!();
    await fake?.stop();
  });

  const mk = (o: { queueWait?: number; minGap?: number; sock?: 'ws' | 'node' } = {}) => {
    const l = new RealtimeLink({
      baseUrl: fake.url,
      apikey: fake.apikey,
      topic: 'lcr1:q',
      createSocket: o.sock === 'node' ? nodeSocket : (u) => new WebSocket(u) as unknown as WsLike,
      backoff: () => 30,
      queueWait: () => o.queueWait ?? 120,
      queueMinRetryGapMs: o.minGap ?? 0,
      heartbeatMs: 300,
      connectTimeoutMs: 1500,
    });
    cleanups.push(() => l.stop());
    const events: (QueueState | null)[] = [];
    l.onQueue((q) => events.push(q && { ...q }));
    return { l, events };
  };

  it('bị từ chối vì quá tải → vào hàng chờ (có đếm ngược), thử lại theo lịch, vào được thì ra khỏi hàng', async () => {
    fake = new FakeRealtime();
    await fake.start();
    fake.rejectJoin = true;
    fake.rejectReason = 'too_many_connections';
    const { l, events } = mk({ queueWait: 150 });
    l.start();
    const q1 = await waitFor(() => l.queue ?? undefined, 3000, 'vào hàng chờ');
    expect(q1).toMatchObject({ kind: 'connections', attempt: 1, trying: false });
    expect(q1.retryAt).toBeGreaterThan(Date.now() - 20);
    expect(q1.retryAt - q1.since).toBe(q1.waitMs);
    expect(l.status).toBe('offline');
    // vẫn bị từ chối → lần thứ hai, giữ nguyên mốc bắt đầu xếp hàng
    const q2 = await waitFor(() => (l.queue && l.queue.attempt >= 2 ? l.queue : undefined), 3000, 'lần thử thứ hai');
    expect(q2.since).toBe(q1.since);
    // máy chủ hết quá tải → lần thử kế tiếp vào được
    fake.rejectJoin = false;
    await waitFor(() => l.status === 'online', 3000, 'vào được kênh');
    expect(l.queue).toBeNull();
    expect(events.at(-1)).toBeNull();
    // chuỗi sự kiện hợp lệ: lần 1 → đang thử → lần 2 → đang thử … → null
    expect(events[0]).toMatchObject({ attempt: 1, trying: false });
    expect(events.some((e) => e?.trying === true)).toBe(true);
    expect(events.filter((e) => e === null)).toHaveLength(1);
  });

  it('KHÔNG dội: trong lúc chờ không có kết nối mới (khác với nối lại thường 30 ms)', async () => {
    fake = new FakeRealtime();
    await fake.start();
    fake.rejectJoin = true;
    fake.rejectReason = 'too_many_connections';
    const { l } = mk({ queueWait: 600 });
    l.start();
    await waitFor(() => l.queue ?? undefined, 3000, 'vào hàng chờ');
    const n = fake.connections;
    await sleep(450);
    expect(fake.connections).toBe(n);
    await waitFor(() => fake.connections > n, 3000, 'lần thử kế tiếp sau khi hết giờ chờ');
  });

  it('lỗi KHÔNG phải quá tải (sai khoá) → không vào hàng chờ, vẫn nối lại thường (nhanh)', async () => {
    fake = new FakeRealtime();
    await fake.start();
    fake.rejectJoin = true; // lý do mặc định: unauthorized
    const { l, events } = mk({ queueWait: 5000 });
    l.start();
    await waitFor(() => fake.connections >= 4, 3000, 'nối lại thường nhiều lần');
    expect(l.queue).toBeNull();
    expect(events).toEqual([]);
  });

  it('retryNow: chỉ khi đang xếp hàng, không đang thử dở, và đã quá khoảng tối thiểu giữa hai lần thử', async () => {
    fake = new FakeRealtime();
    await fake.start();
    fake.rejectJoin = true;
    fake.rejectReason = 'too_many_connections';
    const { l } = mk({ queueWait: 60_000, minGap: 250 });
    expect(l.retryNow()).toBe(false); // chưa chạy
    l.start();
    await waitFor(() => l.queue ?? undefined, 3000, 'vào hàng chờ');
    expect(l.retryNow()).toBe(false); // vừa thử xong < 250 ms
    await sleep(300);
    const n = fake.connections;
    fake.rejectJoin = false;
    expect(l.retryNow()).toBe(true); // không phải chờ 60 giây
    await waitFor(() => l.status === 'online', 3000, 'vào được nhờ thử ngay');
    expect(fake.connections).toBeGreaterThan(n);
    expect(l.queue).toBeNull();
    expect(l.retryNow()).toBe(false); // hết hàng chờ
  });

  it('stop() khi đang xếp hàng: ra khỏi hàng ngay và không thử lại nữa', async () => {
    fake = new FakeRealtime();
    await fake.start();
    fake.rejectJoin = true;
    fake.rejectReason = 'too_many_connections';
    const { l, events } = mk({ queueWait: 150 });
    l.start();
    await waitFor(() => l.queue ?? undefined, 3000, 'vào hàng chờ');
    l.stop();
    expect(l.queue).toBeNull();
    expect(events.at(-1)).toBeNull();
    const n = fake.connections;
    await sleep(400);
    expect(fake.connections).toBe(n);
    expect(l.status).toBe('idle');
  });

  it('mất mạng giữa lúc xếp hàng → rời hàng chờ (không gọi mất mạng là quá tải)', async () => {
    fake = new FakeRealtime();
    await fake.start();
    fake.rejectJoin = true;
    fake.rejectReason = 'too_many_connections';
    const { l } = mk({ queueWait: 100 });
    l.start();
    await waitFor(() => l.queue ?? undefined, 3000, 'vào hàng chờ');
    // máy chủ biến mất hẳn: lần thử kế tiếp gặp ECONNREFUSED, không còn lý do quá tải
    await fake.stop();
    await waitFor(() => l.queue === null, 4000, 'rời hàng chờ khi mất kết nối');
    expect(l.status === 'offline' || l.status === 'connecting').toBe(true);
  });

  it('tin hệ thống báo chạm trần ở bước vào kênh cũng đưa vào hàng chờ', async () => {
    // máy chủ giả riêng: nâng cấp WebSocket bình thường rồi gửi thông điệp hệ thống thay cho phx_reply
    const srv = http.createServer();
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ server: srv, path: '/realtime/v1/websocket' });
    wss.on('connection', (ws) => ws.on('message', () => ws.send(JSON.stringify({ topic: 'realtime:lcr1:q', event: 'system', payload: { status: 'error', message: 'ConnectionRateLimitReached: The number of connected clients has reached its limit.', extension: 'system' } }))));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    cleanups.push(() => {
      wss.close();
      srv.closeAllConnections?.();
      srv.close();
    });
    const l = new RealtimeLink({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, apikey: 'k', topic: 'lcr1:q', createSocket: (u) => new WebSocket(u) as unknown as WsLike, queueWait: () => 5000 });
    cleanups.push(() => l.stop());
    l.start();
    const q = await waitFor(() => l.queue ?? undefined, 3000, 'vào hàng chờ do thông điệp hệ thống');
    expect(q.kind).toBe('connections');
  });
});

describe('nodeSocket: đọc lý do khi máy chủ từ chối bước bắt tay HTTP', () => {
  let fake: FakeRealtime;
  const cleanups: (() => void)[] = [];
  afterEach(async () => {
    while (cleanups.length) cleanups.pop()!();
    await fake?.stop();
  });

  const run = async (rej: { status: number; body: string } | null) => {
    fake = new FakeRealtime();
    await fake.start();
    fake.rejectUpgrade = rej;
    const l = new RealtimeLink({ baseUrl: fake.url, apikey: fake.apikey, topic: 'lcr1:h', createSocket: nodeSocket, backoff: () => 40, queueWait: () => 5000, queueMinRetryGapMs: 0, connectTimeoutMs: 1500 });
    cleanups.push(() => l.stop());
    l.start();
    return l;
  };

  it('HTTP 403 kèm thân "too_many_connections" → hàng chờ kiểu connections, lý do giữ mã HTTP', async () => {
    const l = await run({ status: 403, body: '{"error":"too_many_connections"}' });
    const q = await waitFor(() => l.queue ?? undefined, 4000, 'vào hàng chờ');
    expect(q.kind).toBe('connections');
    expect(q.reason).toContain('HTTP 403');
    expect(q.reason).toContain('too_many_connections');
  });

  it('HTTP 429 → hàng chờ kiểu rate (quá nhiều yêu cầu)', async () => {
    const l = await run({ status: 429, body: 'Too Many Requests' });
    const q = await waitFor(() => l.queue ?? undefined, 4000, 'vào hàng chờ');
    expect(q.kind).toBe('rate');
  });

  it('HTTP 403 không nêu lý do quá tải (vd. sai khoá) → KHÔNG vào hàng chờ, nối lại thường', async () => {
    const l = await run({ status: 403, body: 'forbidden' });
    await waitFor(() => fake.upgrades >= 3, 4000, 'nối lại thường');
    expect(l.queue).toBeNull();
  });

  it('hết từ chối thì vào được kênh bình thường (ổ cắm Node vẫn dùng tốt khi không bị từ chối)', async () => {
    const l = await run(null);
    await waitFor(() => l.status === 'online', 4000, 'online');
    expect(l.queue).toBeNull();
  });
});
