import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserBridge, type BridgeCreds, type BridgeStore } from '../src/core/chrome/bridge';

const EXT = 'a'.repeat(32);
const EXT2 = 'b'.repeat(32);
const OK_ORIGIN = `chrome-extension://${EXT}`;
const open: BrowserBridge[] = [];
afterEach(() => {
  while (open.length) open.pop()!.stop();
});

function memStore(): BridgeStore & { v: BridgeCreds } {
  const s = { v: {} as BridgeCreds, load: async () => ({ ...s.v }), save: async (c: BridgeCreds) => void (s.v = { ...c }) };
  return s;
}
async function mk(store = memStore(), o: ConstructorParameters<typeof BrowserBridge>[2] = {}) {
  const b = new BrowserBridge(store, () => {}, { ports: [0], credTtlMs: 0, connectWaitMs: 300, oldHoldMs: 200, ...o });
  open.push(b);
  const port = await b.start();
  return { b, port, store };
}

/** Yêu cầu HTTP thô để đặt được cả Host/Origin tuỳ ý (fetch không cho đổi Host). */
function raw(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any; text: string }>((resolve, reject) => {
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
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text: t });
      });
    });
    req.on('error', reject);
    req.end(o.body);
  });
}
const pairWith = async (b: BrowserBridge, port: number, ext = EXT) => {
  const { code } = await b.startPairing();
  const r = await raw(port, 'POST', '/v1/pair', { headers: { origin: `chrome-extension://${ext}` }, body: JSON.stringify({ code }) });
  return { code, r };
};
const auth = (token: string, ext = EXT) => ({ authorization: `Bearer ${token}`, origin: `chrome-extension://${ext}` });

describe('cầu nối Chrome — ghép đôi và chống truy cập trái phép', () => {
  it('chưa ghép đôi: mọi đường dẫn có bảo vệ đều 401 (tiện ích bản mới, có ?v=2)', async () => {
    const { port } = await mk();
    for (const [m, p] of [['GET', '/v1/ping?v=2'], ['GET', '/v1/poll?wait=0&v=2'], ['POST', '/v1/result?v=2']] as const) expect((await raw(port, m, p, { headers: { origin: OK_ORIGIN } })).status).toBe(401);
  });

  it('ghép đôi: đúng mã + Origin extension → token 256 bit, lưu vào kho cùng id extension; mã dùng một lần', async () => {
    const { b, port, store } = await mk();
    const { r } = await pairWith(b, port);
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.v).toEqual({ token: r.json.token, extId: EXT });
    expect(b.status()).toMatchObject({ paired: true, extensionId: EXT });
    expect(b.status().pairing).toBeUndefined();
    expect((await raw(port, 'GET', '/v1/ping', { headers: auth(r.json.token) })).json).toEqual({ ok: true, v: 1 });
    const again = await raw(port, 'POST', '/v1/pair', { headers: { origin: OK_ORIGIN }, body: JSON.stringify({ code: 'ABCD-EFGH' }) });
    expect(again.status).toBe(403); // không còn mã đang chờ
  });

  it('mã sai 5 lần thì huỷ mã (kể cả khi lần sau đúng); mã hết hạn thì từ chối; thiếu Origin thì từ chối', async () => {
    const { b, port } = await mk();
    const { code } = await b.startPairing();
    for (let i = 0; i < 5; i++) expect((await raw(port, 'POST', '/v1/pair', { headers: { origin: OK_ORIGIN }, body: JSON.stringify({ code: 'XXXX-XXXX' }) })).json.error).toMatch(/bad_code|no_pairing/);
    expect((await raw(port, 'POST', '/v1/pair', { headers: { origin: OK_ORIGIN }, body: JSON.stringify({ code }) })).json.error).toBe('no_pairing');
    let t = 1000;
    const c2 = await mk(memStore(), { now: () => t });
    const p2 = await c2.b.startPairing();
    t += 6 * 60_000;
    expect((await raw(c2.port, 'POST', '/v1/pair', { headers: { origin: OK_ORIGIN }, body: JSON.stringify({ code: p2.code }) })).json.error).toBe('no_pairing');
    const c3 = await mk();
    const p3 = await c3.b.startPairing();
    expect((await raw(c3.port, 'POST', '/v1/pair', { body: JSON.stringify({ code: p3.code }) })).json.error).toBe('origin'); // curl/tiến trình khác: không có Origin extension
  });

  it('trang web KHÔNG chạm được cầu nối: Origin https://… bị từ chối ở mọi đường dẫn (kể cả có token); Host lạ (DNS rebinding) bị từ chối', async () => {
    const { b, port } = await mk();
    const { r } = await pairWith(b, port);
    const token = r.json.token as string;
    for (const [m, p] of [['GET', '/v1/ping'], ['GET', '/v1/poll?wait=0'], ['POST', '/v1/pair'], ['POST', '/v1/result'], ['OPTIONS', '/v1/poll']] as const) {
      const x = await raw(port, m, p, { headers: { origin: 'https://evil.example', authorization: `Bearer ${token}` } });
      expect(x.status, `${m} ${p}`).toBe(403);
      expect(x.headers['access-control-allow-origin']).toBeUndefined();
    }
    const rebind = await raw(port, 'GET', '/v1/ping', { headers: { host: 'evil.example', ...auth(token) } });
    expect(rebind.status).toBe(403);
    expect((await raw(port, 'GET', '/v1/ping', { headers: { host: `localhost:${port}`, ...auth(token) } })).status).toBe(200);
  });

  it('token sai → 401; extension KHÁC (id khác) dù có token → 403; không Origin nhưng đúng token → vào được (tiến trình cục bộ đã có bí mật)', async () => {
    const { b, port } = await mk();
    const token = ((await pairWith(b, port)).r.json.token as string);
    expect((await raw(port, 'GET', '/v1/ping?v=2', { headers: auth(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')) })).status).toBe(401);
    expect((await raw(port, 'GET', '/v1/ping?v=2', { headers: auth(token, EXT2) })).status).toBe(403);
    expect((await raw(port, 'GET', '/v1/ping', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('CORS: preflight từ extension → 204 có cho phép Authorization và mạng riêng; Origin khác không có tiêu đề CORS', async () => {
    const { port } = await mk();
    const ok = await raw(port, 'OPTIONS', '/v1/poll', { headers: { origin: OK_ORIGIN, 'access-control-request-method': 'GET' } });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(OK_ORIGIN);
    expect(ok.headers['access-control-allow-headers']).toContain('authorization');
    expect(ok.headers['access-control-allow-private-network']).toBe('true');
  });

  it('thân yêu cầu quá 8 MB bị từ chối (413)', async () => {
    const { b, port } = await mk();
    const token = ((await pairWith(b, port)).r.json.token as string);
    const big = Buffer.alloc(9 * 1024 * 1024, 97);
    const r = await raw(port, 'POST', '/v1/result', { headers: auth(token), body: big });
    expect(r.status).toBe(413);
  });

  it('huỷ ghép đôi thu hồi token ngay, kể cả ở cửa sổ khác dùng chung kho', async () => {
    const store = memStore();
    const A = await mk(store);
    const B = await mk(store);
    const token = ((await pairWith(A.b, A.port)).r.json.token as string);
    expect((await raw(B.port, 'GET', '/v1/ping', { headers: auth(token) })).status).toBe(200); // B thấy token mới nhờ đọc lại kho
    await A.b.unpair();
    expect((await raw(A.port, 'GET', '/v1/ping?v=2', { headers: auth(token) })).status).toBe(401);
    expect((await raw(B.port, 'GET', '/v1/ping?v=2', { headers: auth(token) })).status).toBe(401);
  });
});

/**
 * (0.7.17) Tiện ích Chrome 0.7.12 (bản cửa hàng) bỏ quên thân câu trả lời lỗi: mỗi 401 nó giữ một vùng nhớ dùng chung 2 MB không bao giờ trả
 * và hỏi lại mỗi 7 giây mãi mãi (máy thật 25/11/2026: 2,7 GB trong một tiến trình, ~4 GB/giờ). Máy chủ cầu không sửa được mã của bản cũ,
 * nhưng có thể không đưa cho nó thân câu trả lời nào: yêu cầu từ tiện ích KHÔNG gắn `?v=2` mà token sai thì bị ĐÓNG kết nối.
 */
describe('cầu nối Chrome — không để tiện ích Chrome bản cũ rò bộ nhớ (0.7.17)', () => {
  it('bản cũ (không ?v=2) dùng token sai → đóng kết nối, KHÔNG trả lời, ở cả /v1/ping, /v1/poll, /v1/result; đếm được số lần', async () => {
    const { b, port } = await mk();
    const token = (await pairWith(b, port)).r.json.token as string;
    const bad = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    for (const [m, p] of [['GET', '/v1/ping'], ['GET', '/v1/poll?wait=20'], ['POST', '/v1/result']] as const) {
      await expect(raw(port, m, p, { headers: auth(bad), ...(m === 'POST' ? { body: '{}' } : {}) }), `${m} ${p}`).rejects.toThrow(/socket hang up|ECONNRESET/);
    }
    expect(b.oldClientRefusals()).toBe(3);
    // chưa ghép đôi (token rỗng ở VS Code) cũng vậy — đúng trường hợp «đã ghép với hồ sơ khác rồi huỷ»
    await b.unpair();
    await expect(raw(port, 'GET', '/v1/poll?wait=20', { headers: auth(token) })).rejects.toThrow(/socket hang up|ECONNRESET/);
    expect(b.oldClientRefusals()).toBe(4);
  });

  it('bản cũ với token ĐÚNG vẫn chạy như trước (không cần ?v=2); bản mới token sai nhận 401 có thân JSON; tiến trình cục bộ không Origin vẫn nhận 401', async () => {
    const { b, port } = await mk();
    const token = (await pairWith(b, port)).r.json.token as string;
    expect((await raw(port, 'GET', '/v1/ping', { headers: auth(token) })).json).toEqual({ ok: true, v: 1 });
    const bad = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const fresh = await raw(port, 'GET', '/v1/poll?wait=20&v=2', { headers: auth(bad) });
    expect(fresh.status).toBe(401);
    expect(fresh.json).toEqual({ error: 'unauthorized' });
    expect((await raw(port, 'GET', '/v1/ping', { headers: { authorization: `Bearer ${bad}` } })).status).toBe(401); // curl/tiến trình khác: không phải tiện ích → không đóng
    expect(b.oldClientRefusals()).toBe(0);
  });

  /** Tiêu đề Chrome / Edge THẬT gửi kèm fetch từ dịch vụ nền của tiện ích (đo 25/11/2026): GET KHÔNG có Origin, POST có; cả hai có Sec-Fetch-*. */
  const chromeGet = (token: string) => ({ authorization: `Bearer ${token}`, 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'empty' });
  const chromePost = (token: string) => ({ ...chromeGet(token), origin: OK_ORIGIN });
  const until = async (f: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!f()) {
      if (Date.now() > end) throw new Error('quá hạn chờ điều kiện');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('(0.7.18) bản cũ: GET y như Chrome gửi (KHÔNG Origin, có Sec-Fetch-*) với token sai → GIỮ không trả lời rồi đóng — không có câu trả lời nào để rò (đây là lỗ của 0.7.17)', async () => {
    const { b, port } = await mk(memStore(), { oldHoldMs: 400 });
    const token = (await pairWith(b, port)).r.json.token as string;
    const bad = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    for (const p of ['/v1/ping', '/v1/poll?wait=20']) {
      const t0 = Date.now();
      await expect(raw(port, 'GET', p, { headers: chromeGet(bad) }), p).rejects.toThrow(/socket hang up|ECONNRESET/);
      expect(Date.now() - t0, `${p}: phải bị giữ ~400 ms rồi mới đóng`).toBeGreaterThanOrEqual(350);
    }
    expect(b.oldClientRefusals()).toBe(2);
    await until(() => b.heldOldClients() === 0); // máy chủ nhận «close» sau khi phía khách đã thấy kết nối đứt
  });

  it('(0.7.18) bản cũ: POST (có Origin) token sai → đóng NGAY; đang giữ GET mà VS Code dừng cầu nối thì đóng luôn', async () => {
    const { b, port } = await mk(memStore(), { oldHoldMs: 60_000 });
    const token = (await pairWith(b, port)).r.json.token as string;
    const bad = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const t0 = Date.now();
    await expect(raw(port, 'POST', '/v1/result', { headers: chromePost(bad), body: '{}' })).rejects.toThrow(/socket hang up|ECONNRESET/);
    expect(Date.now() - t0).toBeLessThan(1000);
    const held = expect(raw(port, 'GET', '/v1/poll?wait=20', { headers: chromeGet(bad) })).rejects.toThrow(/socket hang up|ECONNRESET/);
    await until(() => b.heldOldClients() === 1);
    b.stop();
    await held;
  });

  it('(0.7.18) giữ tối đa 8 yêu cầu cùng lúc; yêu cầu thứ 9 bị đóng ngay (một trang web không chiếm được cổng)', async () => {
    const { b, port } = await mk(memStore(), { oldHoldMs: 60_000 });
    const held = Array.from({ length: 8 }, () => raw(port, 'GET', '/v1/poll?wait=20', { headers: chromeGet('sai') }).catch((e: unknown) => e));
    await until(() => b.heldOldClients() === 8);
    const t0 = Date.now();
    await expect(raw(port, 'GET', '/v1/ping', { headers: chromeGet('sai') })).rejects.toThrow(/socket hang up|ECONNRESET/);
    expect(Date.now() - t0).toBeLessThan(1000);
    b.stop();
    await Promise.all(held);
    expect(b.heldOldClients()).toBe(0);
  });

  it('(0.7.18) bản mới (?v=2) GET y như Chrome gửi: token sai → 401 có thân JSON, token đúng → 200; bản cũ token ĐÚNG vẫn chạy; curl token sai → 401', async () => {
    const { b, port } = await mk();
    const token = (await pairWith(b, port)).r.json.token as string;
    const bad = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const fresh = await raw(port, 'GET', '/v1/poll?wait=20&v=2', { headers: chromeGet(bad) });
    expect(fresh.status).toBe(401);
    expect(fresh.json).toEqual({ error: 'unauthorized' });
    expect((await raw(port, 'GET', '/v1/ping?v=2', { headers: chromeGet(token) })).json).toEqual({ ok: true, v: 1 });
    expect((await raw(port, 'GET', '/v1/ping', { headers: chromeGet(token) })).json).toEqual({ ok: true, v: 1 });
    expect((await raw(port, 'GET', '/v1/ping', { headers: { authorization: `Bearer ${bad}` } })).status).toBe(401);
    expect(b.oldClientRefusals()).toBe(0);
  });

  it('extension KHÁC id: bản cũ bị đóng kết nối, bản mới nhận 403; preflight CORS không bị ảnh hưởng', async () => {
    const { b, port } = await mk();
    const token = (await pairWith(b, port)).r.json.token as string;
    await expect(raw(port, 'GET', '/v1/ping', { headers: auth(token, EXT2) })).rejects.toThrow(/socket hang up|ECONNRESET/);
    expect((await raw(port, 'GET', '/v1/ping?v=2', { headers: auth(token, EXT2) })).status).toBe(403);
    expect((await raw(port, 'OPTIONS', '/v1/poll', { headers: { origin: OK_ORIGIN, 'access-control-request-method': 'GET' } })).status).toBe(204);
  });
});

describe('cầu nối Chrome — gọi lệnh', () => {
  async function paired() {
    const x = await mk();
    const token = ((await pairWith(x.b, x.port)).r.json.token as string);
    const poll = (wait = 2) => raw(x.port, 'GET', `/v1/poll?wait=${wait}`, { headers: auth(token) });
    const reply = (id: string, body: object) => raw(x.port, 'POST', '/v1/result', { headers: auth(token), body: JSON.stringify({ id, ...body }) });
    return { ...x, token, poll, reply };
  }

  it('chưa ghép đôi / extension chưa kết nối → lỗi tiếng Việt rõ ràng', async () => {
    const { b } = await mk();
    await expect(b.call('tabs.list', {})).rejects.toThrow(/chưa được ghép đôi/);
    const x = await paired();
    await expect(x.b.call('tabs.list', {})).rejects.toThrow(/chưa kết nối/);
  });

  it('vòng đầy đủ: call → poll nhận việc → result trả dữ liệu; lỗi từ Chrome thành lỗi; việc được giao đúng một lần', async () => {
    const x = await paired();
    const p0 = x.poll(0);
    await p0; // ghi nhận "đã kết nối"
    const call = x.b.call('page.read', { tabId: 7 });
    const got = (await x.poll(3)).json.job;
    expect(got).toMatchObject({ op: 'page.read', args: { tabId: 7 } });
    expect((await x.poll(0)).json).toEqual({}); // không giao lần hai
    await x.reply(got.id, { ok: true, data: { title: 'Trang thử' } });
    await expect(call).resolves.toEqual({ title: 'Trang thử' });

    const call2 = x.b.call('page.click', {});
    const failed = expect(call2).rejects.toThrow('không thấy phần tử'); // gắn bộ xử lý TRƯỚC khi trả lỗi (tránh "unhandled rejection")
    const j2 = (await x.poll(3)).json.job;
    await x.reply(j2.id, { ok: false, error: 'không thấy phần tử' });
    await failed;
  });

  it('poll đang chờ nhận việc ngay khi call được gọi; kết quả cho id lạ hoặc việc chưa giao bị bỏ qua', async () => {
    const x = await paired();
    const waiting = x.poll(5);
    await new Promise((r) => setTimeout(r, 80));
    const call = x.b.call('tabs.list', {});
    const j = (await waiting).json.job;
    expect(j.op).toBe('tabs.list');
    expect((await x.reply('khong-co', { ok: true })).json).toEqual({ ok: false });
    await x.reply(j.id, { ok: true, data: [] });
    await expect(call).resolves.toEqual([]);
  });

  it('hạn giờ và huỷ bằng AbortSignal; sau khi huỷ ghép đôi các việc đang chờ bị từ chối', async () => {
    const x = await paired();
    await x.poll(0);
    await expect(x.b.call('slow', {}, { timeoutMs: 150 })).rejects.toThrow(/không phản hồi/);
    const ctl = new AbortController();
    const c = x.b.call('slow', {}, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 60);
    await expect(c).rejects.toThrow('Đã dừng');
    const c2 = x.b.call('slow', {});
    setTimeout(() => void x.b.unpair(), 60);
    await expect(c2).rejects.toThrow(/huỷ ghép đôi/);
  });

  it('trạng thái: connected phản ánh lần poll gần nhất', async () => {
    let t = 1_000_000;
    const x = await mk(memStore(), { now: () => t });
    const token = ((await pairWith(x.b, x.port)).r.json.token as string);
    expect(x.b.status()).toMatchObject({ running: true, paired: true, connected: false });
    await raw(x.port, 'GET', '/v1/poll?wait=0', { headers: auth(token) });
    expect(x.b.status().connected).toBe(true);
    t += 46_000;
    expect(x.b.status().connected).toBe(false);
  });
});

describe('cầu nối Chrome — ghép đôi KHÔNG MÃ (Chrome xin, VS Code hiện thẻ Cho phép / Từ chối)', () => {
  const ask = (port: number, ext = EXT) => raw(port, 'POST', '/v1/pair/request', { headers: { origin: `chrome-extension://${ext}` }, body: '{}' });
  const poll = (port: number, id: string, ext = EXT) => raw(port, 'GET', `/v1/pair/status?id=${encodeURIComponent(id)}`, { headers: { origin: `chrome-extension://${ext}` } });

  it('xin → chờ → người dùng Cho phép → extension nhận token ĐÚNG MỘT LẦN, token dùng được ngay và được lưu vào kho chung', async () => {
    const { b, port, store } = await mk();
    let changes = 0;
    b.onChange(() => void changes++);
    const q = await ask(port);
    expect(q.status).toBe(200);
    expect(q.json.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(b.pairRequest()).toMatchObject({ id: q.json.id, extensionId: EXT });
    expect(b.status().pairRequest).toMatchObject({ id: q.json.id, extensionId: EXT });
    expect(changes).toBe(1);
    expect((await poll(port, q.json.id)).json.state).toBe('pending'); // chưa quyết định: chưa có token
    expect(await b.approvePair(q.json.id)).toBe(true);
    expect(b.pairRequest()).toBeUndefined();
    expect(b.status()).toMatchObject({ paired: true, extensionId: EXT });
    const got = await poll(port, q.json.id);
    expect(got.json.state).toBe('approved');
    expect(got.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.v).toEqual({ token: got.json.token, extId: EXT });
    expect((await raw(port, 'GET', '/v1/ping', { headers: auth(got.json.token) })).json).toEqual({ ok: true, v: 1 });
    expect((await poll(port, q.json.id)).json).toEqual({ state: 'expired' }); // token đã giao một lần, không giao lại
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('hỏi kết quả bằng POST /v1/pair/status (Chrome không gắn Origin vào GET từ extension): cùng quy tắc như GET — đúng extension, token giao MỘT lần', async () => {
    const { b, port } = await mk();
    const post = (id: string, ext = EXT, origin = true) => raw(port, 'POST', '/v1/pair/status', { headers: origin ? { origin: `chrome-extension://${ext}` } : {}, body: JSON.stringify({ id }) });
    const q = await ask(port);
    expect((await post(q.json.id)).json.state).toBe('pending');
    expect((await post(q.json.id, EXT2)).json).toEqual({ state: 'expired' }); // extension khác không đọc được
    expect((await post(q.json.id, EXT, false)).status).toBe(403); // thiếu Origin (như GET từ Chrome): không biết ai hỏi → từ chối, KHÔNG lộ trạng thái
    expect(await b.approvePair(q.json.id)).toBe(true);
    expect((await post(q.json.id, EXT2)).json).toEqual({ state: 'expired' }); // vẫn không lấy được token của người khác
    const got = await post(q.json.id);
    expect(got.json.state).toBe('approved');
    expect(got.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await post(q.json.id)).json).toEqual({ state: 'expired' }); // giao một lần
    expect((await raw(port, 'POST', '/v1/pair/status', { headers: { origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
  });

  it('Từ chối: extension nhận "denied" một lần, không có token, chưa ghép đôi', async () => {
    const { b, port, store } = await mk();
    const q = await ask(port);
    expect(b.denyPair(q.json.id)).toBe(true);
    expect((await poll(port, q.json.id)).json).toEqual({ state: 'denied' });
    expect(store.v).toEqual({});
    expect(b.status().paired).toBe(false);
    expect(await b.approvePair(q.json.id)).toBe(false); // đã quyết định thì không đổi ý được bằng yêu cầu cũ
  });

  it('chỉ extension mới xin được: trang web (Origin https://…), thiếu Origin hay Host lạ đều bị từ chối — và không tạo thẻ nào', async () => {
    const { b, port } = await mk();
    expect((await raw(port, 'POST', '/v1/pair/request', { headers: { origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await raw(port, 'POST', '/v1/pair/request', { body: '{}' })).status).toBe(403);
    expect((await raw(port, 'POST', '/v1/pair/request', { headers: { host: 'evil.example', origin: OK_ORIGIN }, body: '{}' })).status).toBe(403);
    expect((await raw(port, 'GET', '/v1/pair/status?id=x', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect(b.pairRequest()).toBeUndefined();
  });

  it('tối đa MỘT yêu cầu đang chờ: extension khác nhận 429 "busy"; cùng extension xin lại thì nhận lại đúng yêu cầu đó; extension khác không đọc được yêu cầu của người ta', async () => {
    const { b, port } = await mk();
    const q = await ask(port);
    expect((await ask(port)).json.id).toBe(q.json.id);
    const other = await ask(port, EXT2);
    expect(other.status).toBe(429);
    expect(other.json.error).toBe('busy');
    expect((await poll(port, q.json.id, EXT2)).json).toEqual({ state: 'expired' }); // không lộ
    expect(await b.approvePair(q.json.id)).toBe(true);
    expect((await poll(port, q.json.id, EXT2)).json).toEqual({ state: 'expired' }); // extension khác không lấy được token
    expect((await poll(port, q.json.id)).json.state).toBe('approved'); // đúng extension thì lấy được
  });

  it('giới hạn 6 yêu cầu mới mỗi phút; sang phút sau xin lại được', async () => {
    let t = 5_000_000;
    const { b, port } = await mk(memStore(), { now: () => t });
    for (let i = 0; i < 6; i++) {
      const q = await ask(port);
      expect(q.status).toBe(200);
      b.denyPair(q.json.id);
      await poll(port, q.json.id); // nhận kết quả → yêu cầu được dọn
    }
    expect((await ask(port)).json.error).toBe('rate_limited');
    t += 61_000;
    expect((await ask(port)).status).toBe(200);
  });

  it('yêu cầu hết hạn sau 2 phút: không còn thẻ, không duyệt được, extension nhận "expired"', async () => {
    let t = 9_000_000;
    const { b, port } = await mk(memStore(), { now: () => t });
    const q = await ask(port);
    t += 121_000;
    expect(b.pairRequest()).toBeUndefined();
    expect(await b.approvePair(q.json.id)).toBe(false);
    expect((await poll(port, q.json.id)).json).toEqual({ state: 'expired' });
  });

  it('extension huỷ yêu cầu (tắt công tắc khi đang chờ) thì thẻ biến mất', async () => {
    const { b, port } = await mk();
    const q = await ask(port);
    const r = await raw(port, 'POST', '/v1/pair/cancel', { headers: { origin: OK_ORIGIN }, body: JSON.stringify({ id: q.json.id }) });
    expect(r.status).toBe(200);
    expect(b.pairRequest()).toBeUndefined();
    // extension khác không huỷ được yêu cầu của người ta
    const q2 = await ask(port);
    await raw(port, 'POST', '/v1/pair/cancel', { headers: { origin: `chrome-extension://${EXT2}` }, body: JSON.stringify({ id: q2.json.id }) });
    expect(b.pairRequest()?.id).toBe(q2.json.id);
  });

  it('ghép lại: Cho phép thay token cũ (token cũ hết tác dụng ngay)', async () => {
    const { b, port } = await mk();
    const first = (await pairWith(b, port)).r.json.token as string;
    const q = await ask(port, EXT2);
    expect(await b.approvePair(q.json.id)).toBe(true);
    expect((await raw(port, 'GET', '/v1/ping?v=2', { headers: auth(first) })).status).toBe(401);
    const got = (await poll(port, q.json.id, EXT2)).json.token as string;
    expect((await raw(port, 'GET', '/v1/ping', { headers: auth(got, EXT2) })).json).toEqual({ ok: true, v: 1 });
  });
});

describe('cầu nối Chrome — (0.7.20) ghép đôi do ỨNG DỤNG khởi xướng (vé + trang /link) và danh tính ứng dụng', () => {
  const redeem = (port: number, t: string, ext: string | null = EXT) =>
    raw(port, 'POST', '/v1/pair/ticket', { headers: ext ? { origin: `chrome-extension://${ext}` } : {}, body: JSON.stringify({ t }) });
  const ticketOf = (url: string) => new URL(url).searchParams.get('t') as string;
  /** Yêu cầu GET như trình duyệt gửi khi người dùng mở trang (cùng nguồn: không Origin). */
  const page = (port: number, path: string) => raw(port, 'GET', path, { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  const check = (b: BrowserBridge) => (b as unknown as { checkConnected(): void }).checkConnected();

  it('GET /v1/hello (không token) cho biết ứng dụng nào giữ cổng; mặc định VS Code; kind sai bị bỏ; trang web / Host lạ vẫn bị chặn', async () => {
    const a = await mk();
    expect((await raw(a.port, 'GET', '/v1/hello', { headers: { origin: OK_ORIGIN } })).json).toEqual({ v: 2, app: { kind: 'vscode', name: 'VS Code' } });
    expect(a.b.appInfo()).toEqual({ kind: 'vscode', name: 'VS Code' });
    const w = await mk(memStore(), { app: { kind: 'work', name: '  Locaith Work  ' } });
    expect((await raw(w.port, 'GET', '/v1/hello')).json).toEqual({ v: 2, app: { kind: 'work', name: 'Locaith Work' } });
    const bad = await mk(memStore(), { app: { kind: 'Bad Kind!', name: 'x' } });
    expect((await raw(bad.port, 'GET', '/v1/hello')).json.app).toEqual({ kind: 'vscode', name: 'VS Code' });
    expect((await raw(a.port, 'GET', '/v1/hello', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await raw(a.port, 'GET', '/v1/hello', { headers: { host: 'evil.example' } })).status).toBe(403);
  });

  it('vé: tạo → trang /link (CSP chặt, có tên ứng dụng) → tiện ích đổi vé lấy token MỘT lần → token dùng được, lưu kho chung, trả kèm app', async () => {
    const { b, port, store } = await mk(memStore(), { app: { kind: 'work', name: 'Locaith Work' } });
    let changes = 0;
    b.onChange(() => void changes++);
    const tk = await b.linkTicket();
    expect(tk.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/link\\?t=[A-Za-z0-9_-]{24}$`));
    expect(tk.expiresAt).toBeGreaterThan(Date.now() + 100_000);
    expect(b.lastTicket()).toMatchObject({ state: 'pending' });
    expect(changes).toBe(1);
    const t = ticketOf(tk.url);

    const html = await page(port, `/link?t=${t}`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/^text\/html/);
    expect(html.headers['content-security-policy']).toMatch(/default-src 'none'; script-src 'self'/);
    expect(html.headers['referrer-policy']).toBe('no-referrer');
    expect(html.headers['cache-control']).toBe('no-store');
    expect(html.headers['access-control-allow-origin']).toBeUndefined();
    expect(html.text).toContain('data-state="pending"');
    expect(html.text).toContain('Kết nối trình duyệt này với Locaith Work');
    expect(html.text).toContain('<script src="/link.js"></script>');
    expect(html.text).not.toMatch(/<script>/); // không có script nội tuyến (CSP script-src 'self')
    const js = await page(port, '/link.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    expect(js.text).toContain("type: 'nd-link-ticket'");

    expect((await page(port, `/link/state?t=${t}`)).json).toEqual({ state: 'pending' });
    const got = await redeem(port, t);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ v: 1, app: { kind: 'work', name: 'Locaith Work' } });
    expect(got.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.v).toEqual({ token: got.json.token, extId: EXT });
    expect(b.status()).toMatchObject({ paired: true, extensionId: EXT });
    expect(b.lastTicket()).toMatchObject({ state: 'paired' });
    expect((await raw(port, 'GET', '/v1/ping?v=2', { headers: auth(got.json.token) })).json).toEqual({ ok: true, v: 1 });
    // dùng một lần: đổi lại → 410; trang báo đã ghép; trang mở lại thấy «hết hạn hoặc đã dùng»
    expect((await redeem(port, t)).status).toBe(410);
    expect((await page(port, `/link/state?t=${t}`)).json).toEqual({ state: 'paired' });
    expect((await page(port, `/link?t=${t}`)).text).toContain('data-state="expired"');
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('đổi vé cần Origin của tiện ích: không Origin / trang web / Host lạ đều bị từ chối và vé vẫn còn nguyên', async () => {
    const { b, port } = await mk();
    const t = ticketOf((await b.linkTicket()).url);
    expect((await redeem(port, t, null)).status).toBe(403);
    expect((await raw(port, 'POST', '/v1/pair/ticket', { headers: { origin: 'https://evil.example' }, body: JSON.stringify({ t }) })).status).toBe(403);
    expect((await raw(port, 'POST', '/v1/pair/ticket', { headers: { origin: OK_ORIGIN, host: 'evil.example' }, body: JSON.stringify({ t }) })).status).toBe(403);
    expect((await raw(port, 'POST', '/v1/pair/ticket/deny', { body: JSON.stringify({ t }) })).status).toBe(403);
    expect(b.status().paired).toBe(false);
    expect(b.lastTicket()?.state).toBe('pending');
    expect((await redeem(port, 'x'.repeat(24))).status).toBe(410); // vé lạ
    expect((await redeem(port, 'short')).status).toBe(410);
    expect((await redeem(port, t)).status).toBe(200); // vé thật vẫn dùng được
  });

  it('trang web không đọc được trang /link: Origin https://… bị từ chối; chỉ GET; vé lạ → trang «hết hạn» không nhắc tên ứng dụng', async () => {
    const { b, port } = await mk(memStore(), { app: { kind: 'work', name: 'Locaith Work' } });
    const t = ticketOf((await b.linkTicket()).url);
    expect((await raw(port, 'GET', `/link?t=${t}`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await raw(port, 'GET', `/link/state?t=${t}`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await raw(port, 'POST', `/link?t=${t}`, { body: '{}' })).status).toBe(405);
    const other = await page(port, `/link?t=${'z'.repeat(24)}`);
    expect(other.text).toContain('data-state="expired"');
    expect(other.text).not.toContain('<h1>Kết nối trình duyệt này với Locaith Work</h1>');
    expect((await page(port, `/link/state?t=${'z'.repeat(24)}`)).json).toEqual({ state: 'expired' });
  });

  it('người dùng bấm «Không kết nối» (tiện ích báo deny) → vé bị huỷ, không ghép đôi; deny sau khi đã ghép không gỡ được gì', async () => {
    const { b, port, store } = await mk();
    const t = ticketOf((await b.linkTicket()).url);
    expect((await raw(port, 'POST', '/v1/pair/ticket/deny', { headers: { origin: OK_ORIGIN }, body: JSON.stringify({ t }) })).status).toBe(200);
    expect(b.lastTicket()?.state).toBe('denied');
    expect((await page(port, `/link/state?t=${t}`)).json).toEqual({ state: 'denied' });
    expect((await redeem(port, t)).status).toBe(410);
    expect(store.v).toEqual({});
    const t2 = ticketOf((await b.linkTicket()).url);
    const ok = await redeem(port, t2);
    expect(ok.status).toBe(200);
    await raw(port, 'POST', '/v1/pair/ticket/deny', { headers: { origin: OK_ORIGIN }, body: JSON.stringify({ t: t2 }) });
    expect(b.lastTicket()?.state).toBe('paired');
    expect(store.v.token).toBe(ok.json.token);
  });

  it('vé hết hạn sau 2 phút (trạng thái «expired», có sự kiện một lần); tối đa 3 vé — vé cũ nhất bị bỏ', async () => {
    let t = 7_000_000;
    const { b, port } = await mk(memStore(), { now: () => t });
    let changes = 0;
    b.onChange(() => void changes++);
    const first = ticketOf((await b.linkTicket()).url);
    t += 121_000;
    expect(b.lastTicket()).toMatchObject({ state: 'expired' });
    expect((await redeem(port, first)).status).toBe(410);
    expect((await page(port, `/link/state?t=${first}`)).json).toEqual({ state: 'expired' });
    const before = changes;
    check(b); // nhịp 5 giây: báo ra ngoài khi vé tự hết hạn
    expect(changes).toBe(before + 1);
    check(b);
    expect(changes).toBe(before + 1); // không báo lặp
    const v: string[] = [];
    for (let i = 0; i < 4; i++) v.push(ticketOf((await b.linkTicket()).url));
    expect((await redeem(port, v[0])).status).toBe(410); // bị đẩy ra (giữ tối đa 3)
    expect((await redeem(port, v[3])).status).toBe(200);
  });

  it('trang /link báo nó thấy gì (asked / missing) cho ứng dụng; «missing» đến muộn không ghi đè «asked»; giá trị lạ bị bỏ', async () => {
    const { b, port } = await mk();
    const t = ticketOf((await b.linkTicket()).url);
    await page(port, `/link/state?t=${t}&page=missing`);
    expect(b.lastTicket()).toMatchObject({ state: 'pending', page: 'missing' });
    await page(port, `/link/state?t=${t}&page=asked`);
    expect(b.lastTicket()?.page).toBe('asked');
    await page(port, `/link/state?t=${t}&page=missing`);
    expect(b.lastTicket()?.page).toBe('asked');
    await page(port, `/link/state?t=${t}&page=evil`);
    expect(b.lastTicket()?.page).toBe('asked');
  });

  it('ghép đôi kiểu cũ (POST /v1/pair/status, mã) cũng trả kèm app để tiện ích giữ đúng token theo ứng dụng', async () => {
    const { b, port } = await mk(memStore(), { app: { kind: 'work', name: 'Locaith Work' } });
    const q = await raw(port, 'POST', '/v1/pair/request', { headers: { origin: OK_ORIGIN }, body: '{}' });
    await b.approvePair(q.json.id);
    const got = await raw(port, 'POST', '/v1/pair/status', { headers: { origin: OK_ORIGIN }, body: JSON.stringify({ id: q.json.id }) });
    expect(got.json).toMatchObject({ state: 'approved', app: { kind: 'work', name: 'Locaith Work' } });
    expect((await pairWith(b, port)).r.json.app).toEqual({ kind: 'work', name: 'Locaith Work' });
  });

  it('sự kiện khi «đã kết nối» bật / tắt (ứng dụng không phải hỏi liên tục)', async () => {
    let t = 3_000_000;
    const { b, port } = await mk(memStore(), { now: () => t });
    const token = (await pairWith(b, port)).r.json.token as string;
    let changes = 0;
    b.onChange(() => void changes++);
    await raw(port, 'GET', '/v1/poll?wait=0&v=2', { headers: auth(token) });
    expect(changes).toBe(1); // vừa nối
    await raw(port, 'GET', '/v1/poll?wait=0&v=2', { headers: auth(token) });
    expect(changes).toBe(1);
    t += 46_000;
    check(b);
    expect(changes).toBe(2); // mất nối
  });
});
