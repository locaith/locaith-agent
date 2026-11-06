import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { REMOTE_API_VERSION, type RemoteCommand, type RemoteState } from '../src/core/remote/protocol';
import { RemoteServer, type RemoteBackend, type RemoteDevice, type RemoteStore } from '../src/core/remote/server';

const WEB = 'https://locaith.ai';
const open: RemoteServer[] = [];
afterEach(() => {
  while (open.length) open.pop()!.stop();
});

const STATE: RemoteState = {
  v: REMOTE_API_VERSION,
  host: { name: 'PC-TEST', workspace: 'demo', vscode: '1.90.0', ext: '0.0.0', platform: 'win32' },
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

function memStore(): RemoteStore & { list: RemoteDevice[] } {
  const s = { list: [] as RemoteDevice[], load: async () => s.list.map((d) => ({ ...d })), save: async (l: RemoteDevice[]) => void (s.list = l.map((d) => ({ ...d }))) };
  return s;
}

interface Ctx {
  srv: RemoteServer;
  port: number;
  store: ReturnType<typeof memStore>;
  cmds: { device: { id: string; label: string }; cmd: RemoteCommand }[];
  clock: { t: number };
  origins: string[];
  hosts: string[];
}

async function mk(o: { canBypass?: boolean; idleDays?: number; failCmd?: boolean } = {}): Promise<Ctx> {
  const store = memStore();
  const cmds: Ctx['cmds'] = [];
  const clock = { t: 1_000_000 };
  const origins = [WEB, 'http://localhost:3000'];
  const hosts: string[] = [];
  const backend: RemoteBackend = {
    info: () => STATE.host,
    prepare: async () => {},
    state: () => STATE,
    command: async (device, cmd) => {
      if (o.failCmd) throw new Error('boom');
      cmds.push({ device, cmd });
    },
  };
  const srv = new RemoteServer(store, backend, { ports: [0], now: () => clock.t, allowedOrigins: () => origins, allowedHosts: () => hosts, idleDays: () => o.idleDays ?? 30, canBypass: () => !!o.canBypass });
  open.push(srv);
  const port = await srv.start();
  return { srv, port, store, cmds, clock, origins, hosts };
}

/** Yêu cầu HTTP thô để đặt được Host/Origin tuỳ ý (fetch không cho đổi Host). */
function raw(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...(o.body ? { 'content-type': 'application/json' } : {}), ...o.headers } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => {
        let json: any = null;
        try {
          json = t ? JSON.parse(t) : null;
        } catch {
          /* không phải JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

const pair = async (c: Ctx, label = 'Chrome trên Windows', origin = WEB) => {
  const { code } = await c.srv.startPairing();
  const r = await raw(c.port, 'POST', '/v1/pair', { headers: { origin }, body: JSON.stringify({ code, label }) });
  return { code, r, token: r.json?.token as string };
};
const authH = (token: string, origin = WEB) => ({ authorization: `Bearer ${token}`, origin });
const post = (c: Ctx, token: string, body: unknown) => raw(c.port, 'POST', '/v1/cmd', { headers: authH(token), body: typeof body === 'string' ? body : JSON.stringify(body) });

/** Mở luồng SSE và gom các khung nhận được. */
function openStream(c: Ctx, token: string, query = '') {
  const frames: any[] = [];
  const waiters: (() => void)[] = [];
  let buf = '';
  let ended = false;
  const req = http.request({ host: '127.0.0.1', port: c.port, path: `/v1/stream${query}`, headers: { host: `127.0.0.1:${c.port}`, ...authH(token) } });
  let status = 0;
  const done = new Promise<void>((resolve) => {
    req.on('response', (res) => {
      status = res.statusCode ?? 0;
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data) frames.push(JSON.parse(data));
          for (const w of waiters.splice(0)) w();
        }
      });
      res.on('end', () => {
        ended = true;
        for (const w of waiters.splice(0)) w();
        resolve();
      });
    });
    req.on('error', () => resolve());
  });
  req.end();
  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`hết giờ chờ khung SSE; đã nhận: ${JSON.stringify(frames.map((f) => f.type))}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { frames, waitFor, done, get status() { return status; }, get ended() { return ended; }, close: () => req.destroy() };
}

describe('Remote — Host, Origin, CORS', () => {
  it('hello: Origin của locaith.ai được phép, trả thông tin máy và cờ pairing; có tiêu đề CORS + Private Network', async () => {
    const c = await mk();
    const r = await raw(c.port, 'GET', '/v1/hello', { headers: { origin: WEB } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ app: 'locaith-agent-remote', v: REMOTE_API_VERSION, name: 'PC-TEST', workspace: 'demo', pairing: false, paired: false });
    expect(r.headers['access-control-allow-origin']).toBe(WEB);
    expect(r.headers['access-control-allow-private-network']).toBe('true');
  });

  it('Origin lạ bị từ chối ở MỌI đường dẫn (kể cả hello/pair) và không có tiêu đề CORS; Origin "null" cũng bị từ chối', async () => {
    const c = await mk();
    for (const origin of ['https://evil.example', 'http://localhost:9999', 'null', 'https://locaith.ai.evil.example']) {
      for (const [m, p] of [['GET', '/v1/hello'], ['POST', '/v1/pair'], ['GET', '/v1/state'], ['GET', '/v1/stream']] as const) {
        const r = await raw(c.port, m, p, { headers: { origin }, body: m === 'POST' ? '{}' : undefined });
        expect(r.status, `${origin} ${p}`).toBe(403);
        expect(r.headers['access-control-allow-origin']).toBeUndefined();
      }
    }
  });

  it('chống DNS rebinding: tiêu đề Host lạ bị từ chối; tên miền công khai chỉ được nhận khi đã cấu hình', async () => {
    const c = await mk();
    expect((await raw(c.port, 'GET', '/v1/hello', { headers: { host: 'evil.example:47630', origin: WEB } })).status).toBe(403);
    expect((await raw(c.port, 'GET', '/v1/hello', { headers: { host: 'remote.locaith.ai', origin: WEB } })).status).toBe(403);
    c.hosts.push('remote.locaith.ai');
    expect((await raw(c.port, 'GET', '/v1/hello', { headers: { host: 'remote.locaith.ai', origin: WEB } })).status).toBe(200);
    expect((await raw(c.port, 'GET', '/v1/hello', { headers: { host: 'localhost:1234', origin: WEB } })).status).toBe(200);
  });

  it('preflight OPTIONS: 204 + cho phép Authorization/Content-Type; Origin lạ → 403', async () => {
    const c = await mk();
    const ok = await raw(c.port, 'OPTIONS', '/v1/cmd', { headers: { origin: WEB, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
    expect(ok.status).toBe(204);
    expect(String(ok.headers['access-control-allow-headers'])).toMatch(/authorization/);
    expect(ok.headers['access-control-allow-private-network']).toBe('true');
    expect((await raw(c.port, 'OPTIONS', '/v1/cmd', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('máy khách không phải trình duyệt (không có Origin) vào được hello, nhưng vẫn cần token ở mọi nơi khác', async () => {
    const c = await mk();
    expect((await raw(c.port, 'GET', '/v1/hello')).status).toBe(200);
    expect((await raw(c.port, 'GET', '/v1/state')).status).toBe(401);
  });
});

describe('Remote — ghép đôi', () => {
  it('chưa bắt đầu ghép đôi: 409 no_pairing', async () => {
    const c = await mk();
    const r = await raw(c.port, 'POST', '/v1/pair', { headers: { origin: WEB }, body: JSON.stringify({ code: 'ABCD-EFGH' }) });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('no_pairing');
  });

  it('đúng mã → token lr_…, chỉ lưu BĂM của token; mã dùng một lần; nhãn thiết bị được làm sạch', async () => {
    const c = await mk();
    const { code, r, token } = await pair(c, '  Máy\u0007 của anh \n');
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(r.status).toBe(200);
    expect(token).toMatch(/^lr_[A-Za-z0-9_-]{43}$/);
    expect(c.store.list).toHaveLength(1);
    expect(JSON.stringify(c.store.list)).not.toContain(token);
    expect(c.store.list[0]).toMatchObject({ label: 'Máy của anh', origin: WEB });
    expect(c.store.list[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await raw(c.port, 'POST', '/v1/pair', { headers: { origin: WEB }, body: JSON.stringify({ code }) });
    expect(again.status).toBe(409);
  });

  it('mã nhập thường/thiếu gạch vẫn nhận; sai mã → 401 kèm số lần còn lại; quá 5 lần sai thì huỷ mã (kể cả sau đó nhập đúng)', async () => {
    const c = await mk();
    const { code } = await c.srv.startPairing();
    const sloppy = code.toLowerCase().replace('-', ' ');
    const wrong = (n: number) => raw(c.port, 'POST', '/v1/pair', { headers: { origin: WEB }, body: JSON.stringify({ code: `ZZZZ-ZZZ${n}` }) });
    const first = await wrong(1);
    expect(first.status).toBe(401);
    expect(first.json).toMatchObject({ error: 'bad_code', triesLeft: 4 });
    for (let i = 2; i <= 5; i++) expect((await wrong(i)).status).toBe(401);
    const dead = await raw(c.port, 'POST', '/v1/pair', { headers: { origin: WEB }, body: JSON.stringify({ code: sloppy }) });
    expect(dead.status).toBe(409);
    const { r } = await pair(c);
    expect(r.status).toBe(200);
  });

  it('mã hết hạn sau 5 phút', async () => {
    const c = await mk();
    const { code } = await c.srv.startPairing();
    c.clock.t += 5 * 60_000 + 1;
    const r = await raw(c.port, 'POST', '/v1/pair', { headers: { origin: WEB }, body: JSON.stringify({ code }) });
    expect(r.status).toBe(409);
    expect(c.srv.status().pairing).toBeUndefined();
  });

  it('tối đa 10 thiết bị: thiết bị cũ nhất bị loại', async () => {
    const c = await mk();
    for (let i = 0; i < 11; i++) await pair(c, `Máy ${i}`);
    expect(c.store.list).toHaveLength(10);
    expect(c.store.list[0]!.label).toBe('Máy 1');
  });
});

describe('Remote — xác thực, hết hạn, thu hồi', () => {
  it('không token / token sai → 401 ở state, stream, cmd, unpair; token đúng → 200 kèm snapshot', async () => {
    const c = await mk();
    const { token } = await pair(c);
    for (const [m, p] of [['GET', '/v1/state'], ['GET', '/v1/stream'], ['POST', '/v1/cmd'], ['POST', '/v1/unpair'], ['GET', '/v1/ping']] as const) {
      expect((await raw(c.port, m, p, { headers: { origin: WEB }, body: m === 'POST' ? '{}' : undefined })).status, p).toBe(401);
      expect((await raw(c.port, m, p, { headers: authH(`lr_${'x'.repeat(43)}`), body: m === 'POST' ? '{}' : undefined })).status, p).toBe(401);
    }
    const ok = await raw(c.port, 'GET', '/v1/state', { headers: authH(token) });
    expect(ok.status).toBe(200);
    expect(ok.json.state.host.name).toBe('PC-TEST');
    expect(typeof ok.json.seq).toBe('number');
  });

  it('chống dò token: quá 30 lần sai/phút → 429, nhưng token đúng vẫn dùng được', async () => {
    const c = await mk();
    const { token } = await pair(c);
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await raw(c.port, 'GET', '/v1/state', { headers: authH(`lr_${String(i).padStart(43, 'y')}`) })).status;
    expect(last).toBe(429);
    expect((await raw(c.port, 'GET', '/v1/state', { headers: authH(token) })).status).toBe(200);
    c.clock.t += 61_000;
    expect((await raw(c.port, 'GET', '/v1/state', { headers: authH('lr_' + 'z'.repeat(43)) })).status).toBe(401);
  });

  it('token không dùng quá N ngày thì hết hạn và bị xoá khỏi kho', async () => {
    const c = await mk({ idleDays: 7 });
    const { token } = await pair(c);
    c.clock.t += 6 * 86_400_000;
    expect((await raw(c.port, 'GET', '/v1/state', { headers: authH(token) })).status).toBe(200);
    c.clock.t += 8 * 86_400_000;
    expect((await raw(c.port, 'GET', '/v1/state', { headers: authH(token) })).status).toBe(401);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.store.list).toHaveLength(0);
  });

  it('thu hồi: token hết tác dụng ngay và luồng đang mở bị đóng kèm "bye"', async () => {
    const c = await mk();
    const { token } = await pair(c);
    const s = openStream(c, token);
    await s.waitFor(() => s.frames.some((f) => f.type === 'snapshot'));
    const id = c.srv.status().devices[0]!.id;
    expect(await c.srv.revoke(id)).toBe(true);
    await s.done;
    expect(s.frames.at(-1)).toMatchObject({ type: 'bye', reason: 'revoked' });
    expect((await raw(c.port, 'GET', '/v1/state', { headers: authH(token) })).status).toBe(401);
  });

  it('unpair: thiết bị tự thu hồi token của chính nó', async () => {
    const c = await mk();
    const { token } = await pair(c);
    expect((await raw(c.port, 'POST', '/v1/unpair', { headers: authH(token), body: '{}' })).status).toBe(200);
    expect((await raw(c.port, 'GET', '/v1/state', { headers: authH(token) })).status).toBe(401);
    expect(c.store.list).toHaveLength(0);
  });

  it('nhiều cửa sổ VS Code dùng chung kho: thiết bị ghép ở cửa sổ khác được nhận sau khi kho làm mới', async () => {
    const c = await mk();
    const { token } = await pair(c);
    const other = await mk();
    other.store.list = c.store.list.map((d) => ({ ...d }));
    other.clock.t += 6000;
    expect((await raw(other.port, 'GET', '/v1/state', { headers: authH(token) })).status).toBe(200);
  });
});

describe('Remote — lệnh', () => {
  it('lệnh hợp lệ được chuyển cho backend kèm thiết bị gọi', async () => {
    const c = await mk();
    const { token } = await pair(c, 'Điện thoại');
    const r = await post(c, token, { type: 'send', text: 'xin chào', attachments: [] });
    expect(r.status).toBe(200);
    expect(c.cmds).toHaveLength(1);
    expect(c.cmds[0]!.device.label).toBe('Điện thoại');
    expect(c.cmds[0]!.cmd).toEqual({ type: 'send', text: 'xin chào', attachments: [] });
    expect((await post(c, token, { type: 'permission_response', id: 'p1', decision: 'allow_session' })).status).toBe(200);
    expect((await post(c, token, { type: 'stop' })).status).toBe(200);
  });

  it('chỉ nhận đúng tập lệnh hẹp: xoá lịch sử, khoá API, mở tệp, MCP, slash… đều 400 unknown_command', async () => {
    const c = await mk();
    const { token } = await pair(c);
    for (const type of ['delete_session', 'purge_session', 'empty_trash', 'save_api_key', 'clear_api_key', 'open_file', 'open_external', 'slash', 'apply_code', 'import_backup', 'export_backup', 'mcp_toggle', 'plugin_install', 'set_ui_setting', 'connector_connect', 'chrome_pair_start', 'bio_install', 'parse_document', '__proto__', 'constructor']) {
      const r = await post(c, token, { type, id: 'x', key: 'k', provider: 'p', text: 'a' });
      expect(r.status, type).toBe(400);
      expect(r.json.error, type).toBe('unknown_command');
    }
    expect(c.cmds).toHaveLength(0);
  });

  it('kiểm tra từng trường: thiếu/quá dài/sai kiểu bị 400; JSON hỏng và thân quá lớn bị từ chối', async () => {
    const c = await mk();
    const { token } = await pair(c);
    const cases: [unknown, string][] = [
      [{ type: 'send', text: '' }, 'empty'],
      [{ type: 'send', text: 'x'.repeat(50_001) }, 'text_too_long'],
      [{ type: 'send', text: 'a', attachments: new Array(5).fill({}) }, 'too_many_attachments'],
      [{ type: 'send', text: 'a', attachments: [{ kind: 'file', label: 'a', data: 'AAAA', mediaType: 'image/png' }] }, 'bad_attachment'],
      [{ type: 'send', text: 'a', attachments: [{ kind: 'image', label: 'a', data: 'AAAA', mediaType: 'text/html' }] }, 'bad_attachment'],
      [{ type: 'send', text: 'a', attachments: [{ kind: 'image', label: 'a', data: '<script>', mediaType: 'image/png' }] }, 'bad_attachment'],
      [{ type: 'load_session', id: '../../etc/passwd' }, 'bad_id'],
      [{ type: 'load_session' }, 'bad_id'],
      [{ type: 'rename_session', id: 's1', title: '   ' }, 'bad_title'],
      [{ type: 'set_mode', mode: 'rm -rf' }, 'bad_mode'],
      [{ type: 'set_thinking', level: 'ultra' }, 'bad_level'],
      [{ type: 'set_model', provider: 'a b', model: 'm' }, 'bad_model'],
      [{ type: 'permission_response', id: 'p', decision: 'always' }, 'bad_decision'],
      [{ type: 'get_image', key: '' }, 'bad_key'],
      [[], 'bad_request'],
      ['null', 'bad_request'],
    ];
    for (const [body, err] of cases) {
      const r = await post(c, token, body);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(r.json.error).toBe(err);
    }
    expect((await post(c, token, '{not json')).status).toBe(400);
    expect((await post(c, token, JSON.stringify({ type: 'send', text: 'x'.repeat(3 * 1024 * 1024 + 10) }))).status).toBe(413);
    expect(c.cmds).toHaveLength(0);
  });

  it('chế độ bypass: từ chối mặc định, chỉ nhận khi người dùng bật remote.allowBypass', async () => {
    const off = await mk();
    const t1 = (await pair(off)).token;
    expect((await post(off, t1, { type: 'set_mode', mode: 'bypass' })).json.error).toBe('bypass_not_allowed');
    expect((await post(off, t1, { type: 'set_mode', mode: 'plan' })).status).toBe(200);
    const on = await mk({ canBypass: true });
    const t2 = (await pair(on)).token;
    expect((await post(on, t2, { type: 'set_mode', mode: 'bypass' })).status).toBe(200);
  });

  it('queue_remove luôn ép edit=false (không đẩy nội dung về ô nhập trong VS Code)', async () => {
    const c = await mk();
    const { token } = await pair(c);
    await post(c, token, { type: 'queue_remove', id: 'q1', edit: true });
    expect(c.cmds[0]!.cmd).toEqual({ type: 'queue_remove', id: 'q1', edit: false });
  });

  it('giới hạn tốc độ: quá 120 lệnh/phút → 429; backend lỗi → 500 command_failed', async () => {
    const c = await mk();
    const { token } = await pair(c);
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await post(c, token, { type: 'stop' })).status;
    expect(last).toBe(429);
    const f = await mk({ failCmd: true });
    const t = (await pair(f)).token;
    const r = await post(f, t, { type: 'stop' });
    expect(r.status).toBe(500);
    expect(r.json.error).toBe('command_failed');
  });
});

describe('Remote — luồng SSE', () => {
  it('mở luồng: khung đầu là snapshot (kèm epoch); tin phát sau đó đến theo thứ tự với seq tăng dần', async () => {
    const c = await mk();
    const { token } = await pair(c);
    const s = openStream(c, token);
    await s.waitFor(() => s.frames.length >= 1);
    expect(s.status).toBe(200);
    expect(s.frames[0]).toMatchObject({ type: 'snapshot', seq: 0 });
    expect(typeof s.frames[0].epoch).toBe('string');
    c.srv.publish('events', { events: [{ t: 'run_state', running: true }] });
    c.srv.publish('toast', { level: 'info', text: 'xong' });
    await s.waitFor(() => s.frames.length >= 3);
    expect(s.frames.slice(1).map((f) => [f.type, f.seq])).toEqual([['events', 1], ['toast', 2]]);
    expect(c.srv.status()).toMatchObject({ streams: 1 });
    expect(c.srv.status().devices[0]!.connected).toBe(true);
    s.close();
  });

  it('nối lại bằng since+epoch: chỉ nhận phần còn thiếu, không snapshot; sai epoch / since quá cũ → snapshot mới', async () => {
    const c = await mk();
    const { token } = await pair(c);
    const first = openStream(c, token);
    await first.waitFor(() => first.frames.length >= 1);
    const epoch = first.frames[0].epoch as string;
    for (let i = 0; i < 5; i++) c.srv.publish('events', { events: [{ t: 'text', id: 'a', delta: String(i) }] });
    await first.waitFor(() => first.frames.length >= 6);
    first.close();
    c.srv.publish('events', { events: [{ t: 'text', id: 'a', delta: '5' }] });
    c.srv.publish('events', { events: [{ t: 'text', id: 'a', delta: '6' }] });

    const again = openStream(c, token, `?since=5&epoch=${epoch}`);
    await again.waitFor(() => again.frames.length >= 3);
    expect(again.frames.map((f) => [f.type, f.seq])).toEqual([['resume', 7], ['events', 6], ['events', 7]]);
    again.close();

    const wrongEpoch = openStream(c, token, '?since=5&epoch=deadbeef');
    await wrongEpoch.waitFor(() => wrongEpoch.frames.length >= 1);
    expect(wrongEpoch.frames[0]).toMatchObject({ type: 'snapshot', seq: 7 });
    wrongEpoch.close();

    const future = openStream(c, token, `?since=999&epoch=${epoch}`);
    await future.waitFor(() => future.frames.length >= 1);
    expect(future.frames[0].type).toBe('snapshot');
    future.close();
  });

  it('vòng đệm có hạn: since đã bị đẩy ra khỏi vòng → snapshot; tin "ephemeral" (ảnh) không được lưu để phát lại', async () => {
    const c = await mk();
    const { token } = await pair(c);
    const probe = openStream(c, token);
    await probe.waitFor(() => probe.frames.length >= 1);
    const epoch = probe.frames[0].epoch as string;
    probe.close();
    c.srv.publish('image', { key: 'k', mediaType: 'image/png', data: 'AAAA' }, { ephemeral: true });
    for (let i = 0; i < 2100; i++) c.srv.publish('events', { events: [] });
    const old = openStream(c, token, `?since=1&epoch=${epoch}`);
    await old.waitFor(() => old.frames.length >= 1);
    expect(old.frames[0].type).toBe('snapshot');
    old.close();
    const recent = openStream(c, token, `?since=${c.srv.currentSeq - 3}&epoch=${epoch}`);
    await recent.waitFor(() => recent.frames.length >= 4);
    expect(recent.frames.map((f) => f.type)).toEqual(['resume', 'events', 'events', 'events']);
    expect(recent.frames.some((f) => f.type === 'image')).toBe(false);
    recent.close();
  });

  it('mỗi thiết bị tối đa 5 luồng: luồng thứ 6 đẩy luồng cũ nhất ra (bye too_many_streams)', async () => {
    const c = await mk();
    const { token } = await pair(c);
    const ss = [];
    for (let i = 0; i < 6; i++) {
      const s = openStream(c, token);
      await s.waitFor(() => s.frames.length >= 1);
      ss.push(s);
    }
    await ss[0]!.done;
    expect(ss[0]!.frames.at(-1)).toMatchObject({ type: 'bye', reason: 'too_many_streams' });
    expect(c.srv.status().streams).toBe(5);
    for (const s of ss) s.close();
  });

  it('stop() đóng mọi luồng kèm bye; sau đó không còn nghe cổng', async () => {
    const c = await mk();
    const { token } = await pair(c);
    const s = openStream(c, token);
    await s.waitFor(() => s.frames.length >= 1);
    c.srv.stop();
    await s.done;
    expect(s.frames.at(-1)).toMatchObject({ type: 'bye', reason: 'stopped' });
    await expect(raw(c.port, 'GET', '/v1/hello')).rejects.toBeTruthy();
    expect(c.srv.status().running).toBe(false);
  });
});
