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
  const b = new BrowserBridge(store, () => {}, { ports: [0], credTtlMs: 0, connectWaitMs: 300, ...o });
  open.push(b);
  const port = await b.start();
  return { b, port, store };
}

/** Yêu cầu HTTP thô để đặt được cả Host/Origin tuỳ ý (fetch không cho đổi Host). */
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
const pairWith = async (b: BrowserBridge, port: number, ext = EXT) => {
  const { code } = await b.startPairing();
  const r = await raw(port, 'POST', '/v1/pair', { headers: { origin: `chrome-extension://${ext}` }, body: JSON.stringify({ code }) });
  return { code, r };
};
const auth = (token: string, ext = EXT) => ({ authorization: `Bearer ${token}`, origin: `chrome-extension://${ext}` });

describe('cầu nối Chrome — ghép đôi và chống truy cập trái phép', () => {
  it('chưa ghép đôi: mọi đường dẫn có bảo vệ đều 401', async () => {
    const { port } = await mk();
    for (const [m, p] of [['GET', '/v1/ping'], ['GET', '/v1/poll?wait=0'], ['POST', '/v1/result']] as const) expect((await raw(port, m, p, { headers: { origin: OK_ORIGIN } })).status).toBe(401);
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
    expect((await raw(port, 'GET', '/v1/ping', { headers: auth(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')) })).status).toBe(401);
    expect((await raw(port, 'GET', '/v1/ping', { headers: auth(token, EXT2) })).status).toBe(403);
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
    expect((await raw(A.port, 'GET', '/v1/ping', { headers: auth(token) })).status).toBe(401);
    expect((await raw(B.port, 'GET', '/v1/ping', { headers: auth(token) })).status).toBe(401);
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
    expect((await raw(port, 'GET', '/v1/ping', { headers: auth(first) })).status).toBe(401);
    const got = (await poll(port, q.json.id, EXT2)).json.token as string;
    expect((await raw(port, 'GET', '/v1/ping', { headers: auth(got, EXT2) })).json).toEqual({ ok: true, v: 1 });
  });
});
