import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { b64u, randomBytes } from '../src/core/remote/e2e';
import { RealtimeLink, realtimeUrl, type WsLike } from '../src/core/remote/phoenix';
import { REMOTE_API_VERSION, type RemoteState } from '../src/core/remote/protocol';
import { RelayClient, pairWithHost, type ClientStatus } from '../src/core/remote/relayClient';
import { RelayHost } from '../src/core/remote/relayHost';
import { RemoteServer, type RemoteDevice, type RemoteStore } from '../src/core/remote/server';
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

let fake: FakeRealtime;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  while (cleanups.length) cleanups.pop()!();
  await fake?.stop();
});

const mk = (topic: string, o: { heartbeatMs?: number } = {}) => {
  const l = new RealtimeLink({ baseUrl: fake.url, apikey: fake.apikey, topic, createSocket: (u) => new WebSocket(u) as unknown as WsLike, backoff: () => 30, heartbeatMs: o.heartbeatMs ?? 200, connectTimeoutMs: 1500 });
  cleanups.push(() => l.stop());
  return l;
};

describe('realtimeUrl', () => {
  it('đổi http→ws, thêm đường dẫn và mã hoá khoá', () => {
    expect(realtimeUrl('https://x.supabase.co/', 'a b')).toBe('wss://x.supabase.co/realtime/v1/websocket?apikey=a%20b&vsn=1.0.0');
    expect(realtimeUrl('http://127.0.0.1:1', 'k')).toBe('ws://127.0.0.1:1/realtime/v1/websocket?apikey=k&vsn=1.0.0');
  });
});

describe('RealtimeLink ↔ máy chủ Realtime giả', () => {
  it('hai đầu vào cùng kênh: tin đi hai chiều, người gửi không nhận lại tin của mình, kênh khác không nghe thấy', async () => {
    fake = new FakeRealtime();
    await fake.start();
    const a = mk('lcr1:abc');
    const b = mk('lcr1:abc');
    const other = mk('lcr1:khac');
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    const gotO: unknown[] = [];
    a.onMessage((m) => gotA.push(m));
    b.onMessage((m) => gotB.push(m));
    other.onMessage((m) => gotO.push(m));
    expect(a.send({ x: 1 })).toBe(false); // chưa vào kênh
    a.start();
    b.start();
    other.start();
    await waitFor(() => a.status === 'online' && b.status === 'online' && other.status === 'online', 4000, 'online');
    expect(a.send({ hello: 'b', n: 1 })).toBe(true);
    expect(b.send({ hello: 'a', n: 2 })).toBe(true);
    await waitFor(() => gotA.length === 1 && gotB.length === 1, 3000, 'tin hai chiều');
    expect(gotB).toEqual([{ hello: 'b', n: 1 }]);
    expect(gotA).toEqual([{ hello: 'a', n: 2 }]);
    expect(gotO).toEqual([]);
  });

  it('tự nối lại sau khi máy chủ cắt kết nối, rồi tin vẫn đi được; onLink báo mất/có', async () => {
    fake = new FakeRealtime();
    await fake.start();
    const a = mk('lcr1:t');
    const b = mk('lcr1:t');
    const ev: boolean[] = [];
    b.onLink((up) => ev.push(up));
    const got: unknown[] = [];
    b.onMessage((m) => got.push(m));
    a.start();
    b.start();
    await waitFor(() => a.status === 'online' && b.status === 'online', 4000, 'online');
    const before = fake.connections;
    fake.dropAll();
    await waitFor(() => fake.connections >= before + 2 && a.status === 'online' && b.status === 'online', 5000, 'nối lại');
    expect(ev).toEqual([true, false, true]);
    expect(a.send({ sau: 'khi nối lại' })).toBe(true);
    await waitFor(() => got.length === 1, 3000, 'tin sau khi nối lại');
  });

  it('nhịp tim được gửi định kỳ; máy chủ không trả lời → nối lại', async () => {
    fake = new FakeRealtime();
    await fake.start();
    const a = mk('lcr1:hb', { heartbeatMs: 60 });
    a.start();
    await waitFor(() => fake.heartbeats >= 2, 3000, 'nhịp tim');
    const conns = fake.connections;
    fake.ignoreHeartbeat = true;
    await waitFor(() => fake.connections > conns, 4000, 'nối lại do mất nhịp tim');
  });

  it('join bị từ chối → thử lại cho tới khi được', async () => {
    fake = new FakeRealtime();
    await fake.start();
    fake.rejectJoin = true;
    const a = mk('lcr1:j');
    a.start();
    await waitFor(() => fake.connections >= 3, 3000, 'thử lại');
    expect(a.status).not.toBe('online');
    fake.rejectJoin = false;
    await waitFor(() => a.status === 'online', 3000, 'online sau khi hết lỗi');
  });

  it('sai khoá apikey: không bao giờ online nhưng vẫn tiếp tục thử (không treo, không ném)', async () => {
    fake = new FakeRealtime();
    await fake.start();
    const l = new RealtimeLink({ baseUrl: fake.url, apikey: 'sai', topic: 't', createSocket: (u) => new WebSocket(u) as unknown as WsLike, backoff: () => 30, connectTimeoutMs: 500 });
    cleanups.push(() => l.stop());
    l.start();
    await waitFor(() => fake.connections >= 3, 3000, 'thử lại');
    expect(l.status).not.toBe('online');
  });

  it('hiện diện được khai báo và khai lại sau khi nối lại; stop() ngắt hẳn và không nối lại nữa', async () => {
    fake = new FakeRealtime();
    await fake.start();
    const a = mk('lcr1:p');
    a.track({ name: 'PC' });
    a.start();
    await waitFor(() => [...fake.members].some((m) => m.presence), 3000, 'track');
    fake.dropAll();
    await waitFor(() => a.status === 'online' && [...fake.members].some((m) => (m.presence as any)?.name === 'PC'), 5000, 'track lại');
    a.stop();
    expect(a.status).toBe('idle');
    const c = fake.connections;
    await sleep(200);
    expect(fake.connections).toBe(c);
  });

  it('tin lớn hơn giới hạn Realtime bị bỏ (đúng như máy chủ thật) — nên bên trên phải cắt mảnh', async () => {
    fake = new FakeRealtime();
    await fake.start();
    const a = mk('lcr1:big');
    const b = mk('lcr1:big');
    const got: unknown[] = [];
    b.onMessage((m) => got.push(m));
    a.start();
    b.start();
    await waitFor(() => a.status === 'online' && b.status === 'online', 4000, 'online');
    a.send({ d: 'x'.repeat(300_000) });
    a.send({ d: 'nhỏ' });
    await waitFor(() => got.length >= 1, 3000, 'tin nhỏ');
    await sleep(100);
    expect(got).toEqual([{ d: 'nhỏ' }]);
  });
});

// ── toàn bộ ngăn xếp qua WebSocket thật ─────────────────────────────────────
const STATE: RemoteState = {
  v: REMOTE_API_VERSION,
  host: { name: 'PC-TEST', workspace: 'demo', vscode: '1.90.0', ext: '0.5.2', platform: 'win32' },
  sessionId: 's1',
  title: 'Phiên thử',
  transcript: [],
  omitted: 0,
  todos: [],
  running: false,
  queued: [],
  provider: 'demo',
  model: 'demo-1',
  mode: 'default',
  thinkingLevel: 'medium',
  providers: [],
  sessions: [],
  context: null,
  allowBypass: false,
  remoteCanBypass: false,
};

describe('RelayHost + RelayClient qua RealtimeLink (WebSocket thật)', () => {
  it('ghép đôi → bắt tay → snapshot → lệnh → sự kiện; sau khi relay sập và nối lại, phiên tự hồi phục', async () => {
    fake = new FakeRealtime();
    await fake.start();
    const store: RemoteStore & { list: RemoteDevice[] } = { list: [], load: async () => store.list.map((d) => ({ ...d })), save: async (l) => void (store.list = l.map((d) => ({ ...d }))) };
    const cmds: unknown[] = [];
    const srv = new RemoteServer(store, { info: () => STATE.host, prepare: async () => {}, state: () => STATE, command: async (_d, c) => void cmds.push(c) }, { ports: [0], allowedOrigins: () => [] });
    const hostId = b64u(randomBytes(16));
    const hostLink = mk(`lcr1:${hostId}`);
    const host = new RelayHost({ hostId, server: srv, link: hostLink, approve: async () => true, presence: () => ({ name: 'PC-TEST' }), timing: { flushMs: 5, heartbeatMs: 100, sweepMs: 100 } });
    host.start();
    cleanups.push(() => {
      host.stop();
      srv.stop();
    });

    const { psk } = host.startPairing();
    const pairLink = mk(`lcr1:${hostId}`);
    pairLink.start();
    await waitFor(() => pairLink.status === 'online' && hostLink.status === 'online', 4000, 'cả hai vào kênh');
    const p = await pairWithHost({ link: pairLink, psk, label: 'Chrome', resendMs: 150, timeoutMs: 8000 });
    pairLink.stop();

    const webLink = mk(`lcr1:${hostId}`);
    const got: any[] = [];
    const statuses: ClientStatus[] = [];
    const rc = new RelayClient({ link: webLink, dev: p.dev, key: p.key, onStream: (m) => got.push(m), onStatus: (s) => statuses.push(s), helloTimeoutMs: 600, pingMs: 150, watchdogMs: 3000 });
    cleanups.push(() => rc.stop());
    webLink.start();
    rc.start();
    await waitFor(() => rc.state === 'online', 6000, 'online');
    expect(got[0].type).toBe('snapshot');
    await rc.command({ type: 'send', text: 'qua WebSocket thật' });
    expect(cmds).toEqual([{ type: 'send', text: 'qua WebSocket thật', attachments: [] }]);
    srv.publish('toast', { level: 'info', text: 'xin chào' });
    await waitFor(() => got.some((m) => m.type === 'toast'), 3000, 'toast');

    // relay sập → mọi bên tự nối lại → phiên hồi phục, không mất sự kiện kế tiếp
    fake.dropAll();
    await waitFor(() => statuses.includes('reconnecting'), 4000, 'báo đang nối lại');
    await waitFor(() => rc.state === 'online' && hostLink.status === 'online', 10_000, 'hồi phục');
    srv.publish('toast', { level: 'info', text: 'sau sập' });
    await waitFor(() => got.some((m) => m.type === 'toast' && m.text === 'sau sập'), 5000, 'sự kiện sau khi hồi phục');
    // và dữ liệu thật trên dây (đầu của relay) không chứa bản rõ
    const text = JSON.stringify(fake.broadcasts);
    expect(text).not.toContain('qua WebSocket thật');
    expect(text).not.toContain('Phiên thử');
    expect(text).not.toContain(p.key);
    expect(text).not.toContain(psk);
  }, 40_000);
});
