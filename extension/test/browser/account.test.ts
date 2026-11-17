import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountClient } from '../../src/core/account/client';
import { challengeOf, newVerifier } from '../../src/core/account/pkce';
import type { AccountConfig } from '../../src/core/account/config';
import { BrowserAccount, extractDeviceToken, kvMemento, parseSaved } from '../../src/browser/account';
import { MemoryKv } from '../../src/browser/kv';
import { MockAccountServer } from '../helpers/mockAccountServer';

const USER = { id: 'u-1', email: 'a@example.com', name: 'Người A' };
/** Đúng cái trang locaith.ai/#ext-browser làm: ext_auth_approve với đích loopback giả + ext_auth_exchange bằng khoá anon. */
const REDIRECT = 'http://127.0.0.1/ext-browser';

let srv: MockAccountServer;
let cfg: AccountConfig;
let client: AccountClient;

beforeEach(async () => {
  srv = new MockAccountServer();
  srv.addUser(USER);
  await srv.start();
  cfg = { supabaseUrl: srv.url, anonKey: srv.anonKey, webUrl: 'https://locaith.ai' };
  client = new AccountClient(cfg, { timeoutMs: 1500 });
});
afterEach(async () => {
  await srv.stop();
});

/** Cấp một «mã kết nối» như trang web: trả token thiết bị lat_… */
async function mint(label = 'Chrome / Edge'): Promise<string> {
  const v = newVerifier();
  const code = srv.approve(USER.id, challengeOf(v), REDIRECT, label);
  const r = await client.exchange(code, v, { client: 'chrome', platform: 'chrome', app: 'Chrome / Edge' });
  if (!r.ok) throw new Error('không cấp được mã kết nối thử');
  return r.token;
}

function make(over: { kv?: MemoryKv; now?: () => number; client?: AccountClient; graceMs?: number } = {}) {
  const kv = over.kv ?? new MemoryKv();
  const opened: string[] = [];
  const secrets: string[] = [];
  const logs: string[] = [];
  const account = new BrowserAccount({
    kv,
    client: over.client ?? client,
    cfg,
    openUrl: async (u) => void opened.push(u),
    registerSecret: (v) => void secrets.push(v),
    log: (_l, m) => void logs.push(m),
    ...(over.now ? { now: over.now } : {}),
    ...(over.graceMs ? { graceMs: over.graceMs } : {}),
  });
  return { account, kv, opened, secrets, logs };
}

describe('extractDeviceToken', () => {
  const TOKEN = 'lat_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v'; // 43 ký tự sau lat_
  it('mẫu thử có đúng 43 ký tự', () => expect(TOKEN).toMatch(/^lat_[A-Za-z0-9_-]{43}$/));
  it('lấy token từ chuỗi dán (có khoảng trắng, xuống dòng, dấu nháy, cả câu)', () => {
    expect(extractDeviceToken(TOKEN)).toBe(TOKEN);
    expect(extractDeviceToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(extractDeviceToken(`"${TOKEN}"`)).toBe(TOKEN);
    expect(extractDeviceToken(`\`${TOKEN}\``)).toBe(TOKEN);
    expect(extractDeviceToken(`Mã của tôi là ${TOKEN}, cảm ơn`)).toBe(TOKEN);
  });
  it('từ chối: quá ngắn, quá dài, sai tiền tố, ký tự lạ, không phải chuỗi', () => {
    expect(extractDeviceToken(TOKEN.slice(0, -1))).toBeUndefined();
    expect(extractDeviceToken(TOKEN + 'x')).toBeUndefined(); // 44 ký tự: không phải token (không cắt bớt)
    expect(extractDeviceToken(TOKEN.replace('lat_', 'lac_'))).toBeUndefined();
    expect(extractDeviceToken(TOKEN.slice(0, 20) + '!' + TOKEN.slice(21))).toBeUndefined();
    expect(extractDeviceToken('')).toBeUndefined();
    expect(extractDeviceToken(undefined)).toBeUndefined();
    expect(extractDeviceToken(123)).toBeUndefined();
  });
});

describe('parseSaved (dữ liệu trong kho có thể bị sửa tay)', () => {
  const good = { token: 'lat_' + 'x'.repeat(43), verifiedAt: 5, user: { id: 'u', email: 'e@x.vn', name: 'N', avatar: null }, device: { id: 'd', label: 'L', expiresAt: '' } };
  it('nhận dữ liệu đúng, bỏ dữ liệu sai hình dạng', () => {
    expect(parseSaved(good)?.user.id).toBe('u');
    expect(parseSaved(null)).toBeNull();
    expect(parseSaved({ ...good, token: 'sk-ant-xxx' })).toBeNull();
    expect(parseSaved({ ...good, verifiedAt: 'hôm qua' })).toBeNull();
    expect(parseSaved({ ...good, user: { id: '', email: '', name: '' } })).toBeNull();
    expect(parseSaved({ ...good, device: undefined })).toBeNull();
  });
});

describe('kvMemento (kho đồng bộ cho bản ghi đồng ý, nạp sẵn từ chrome.storage)', () => {
  it('đọc giá trị nạp sẵn, ghi nền, null = xoá khoá', async () => {
    const kv = new MemoryKv();
    await kv.set('nd.mem.k', { a: 1 });
    const m = await kvMemento(kv, ['k', 'trống']);
    expect(m.get('k', null)).toEqual({ a: 1 });
    expect(m.get('trống', 'mặc định')).toBe('mặc định');
    await m.update('k', { a: 2 });
    expect(m.get('k', null)).toEqual({ a: 2 });
    expect(await kv.get('nd.mem.k')).toEqual({ a: 2 });
    await m.update('k', null);
    expect(m.get('k', 'đã xoá')).toBe('đã xoá');
    expect(await kv.get('nd.mem.k')).toBeUndefined();
  });
});

describe('BrowserAccount — đăng nhập bằng «mã kết nối»', () => {
  it('lúc đầu: chưa đăng nhập, tuỳ chọn (không chặn), có địa chỉ trang cấp mã; không có token', () => {
    const { account } = make();
    expect(account.usable).toBe(false);
    expect(account.token()).toBeUndefined();
    expect(account.view()).toMatchObject({ status: 'signedOut', optional: true, connectUrl: 'https://locaith.ai/#ext-browser', webUrl: 'https://locaith.ai' });
    expect(account.view().error).toBeUndefined();
  });

  it('signIn mở trang cấp mã và chuyển sang «đang chờ mã»; cancel quay về chưa đăng nhập', async () => {
    const { account, opened } = make();
    const seen: string[] = [];
    account.onChange(() => seen.push(account.view().status));
    await account.signIn();
    expect(opened).toEqual(['https://locaith.ai/#ext-browser']);
    expect(account.view().status).toBe('signingIn');
    account.cancel();
    expect(account.view().status).toBe('signedOut');
    expect(seen).toEqual(['signingIn', 'signedOut']);
  });

  it('dán mã đúng: đăng nhập, token + người dùng + thiết bị lấy từ máy chủ, lưu vào kho, đăng ký với bộ che bí mật', async () => {
    const { account, kv, secrets } = make();
    const token = await mint();
    await account.signIn();
    const r = await account.enterCode(`  ${token}\n`);
    expect(r).toEqual({ ok: true });
    expect(account.usable).toBe(true);
    expect(account.token()).toBe(token);
    expect(account.userId()).toBe('u-1');
    expect(account.deviceId()).toBe('d-1');
    expect(account.view()).toMatchObject({ status: 'signedIn', optional: true, user: { name: 'Người A', email: 'a@example.com' } });
    expect(account.view().error).toBeUndefined();
    const stored = (await kv.get('nd.account')) as { token: string; user: { id: string } };
    expect(stored.token).toBe(token);
    expect(stored.user.id).toBe('u-1');
    expect(secrets).toContain(token);
  });

  it('dán mã SAI định dạng: bad_code, KHÔNG gọi máy chủ, trạng thái không đổi, lý do hiện cạnh ô dán', async () => {
    const { account } = make();
    await account.signIn();
    srv.calls.length = 0;
    const r = await account.enterCode('sk-ant-api03-xxxxxxxxxxxx');
    expect(r).toEqual({ ok: false, error: 'bad_code' });
    expect(srv.calls).toHaveLength(0);
    expect(account.view()).toMatchObject({ status: 'signingIn', error: 'bad_code' });
    // lần thử kế tiếp xoá lỗi cũ trước khi hỏi máy chủ
    const bad = await account.enterCode('lat_' + 'z'.repeat(43)); // đúng hình dạng nhưng máy chủ không biết
    expect(bad).toEqual({ ok: false, error: 'invalid_token' });
    expect(account.view().error).toBe('invalid_token');
    expect(account.usable).toBe(false);
  });

  it('mã đã bị thu hồi ở máy chủ: invalid_token', async () => {
    const { account } = make();
    const token = await mint();
    srv.revokeAll();
    expect(await account.enterCode(token)).toEqual({ ok: false, error: 'invalid_token' });
    expect(account.usable).toBe(false);
  });

  it('mất mạng / máy chủ lỗi: network / server, không đăng nhập, không lưu gì', async () => {
    const { account, kv } = make();
    const token = await mint();
    srv.mode = 'down';
    expect(await account.enterCode(token)).toEqual({ ok: false, error: 'network' });
    srv.mode = 'error';
    expect(await account.enterCode(token)).toEqual({ ok: false, error: 'server' });
    expect(account.usable).toBe(false);
    expect(await kv.get('nd.account')).toBeUndefined();
    srv.mode = undefined;
    expect(await account.enterCode(token)).toEqual({ ok: true }); // thử lại được ngay, mã vẫn còn dùng được
  });

  it('đang đăng nhập rồi thì từ chối mã mới (đổi tài khoản = đăng xuất trước)', async () => {
    const { account } = make();
    expect(await account.enterCode(await mint())).toEqual({ ok: true });
    expect(await account.enterCode(await mint())).toEqual({ ok: false, error: 'already_signed_in' });
  });

  it('cờ «đang kiểm» bật trong lúc hỏi máy chủ rồi tắt; bấm đúp không gửi hai lần', async () => {
    const token = await mint();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new AccountClient(cfg, {
      timeoutMs: 5000,
      fetch: async (...a: Parameters<typeof fetch>) => {
        await gate;
        return fetch(...a);
      },
    });
    const { account } = make({ client: slow });
    const first = account.enterCode(token);
    await new Promise((r) => setTimeout(r, 20));
    expect(account.view().checking).toBe(true);
    expect(await account.enterCode(token)).toMatchObject({ ok: false }); // lần bấm thứ hai bị bỏ qua
    release();
    expect(await first).toEqual({ ok: true });
    expect(account.view().checking).toBeUndefined();
    expect(srv.calls.filter((c) => c.fn === 'ext_auth_whoami')).toHaveLength(1);
  });
});

describe('BrowserAccount — khởi động lại, xác minh, thu hồi, ân hạn', () => {
  async function signedInKv(): Promise<{ kv: MemoryKv; token: string }> {
    const { account, kv } = make();
    const token = await mint();
    await account.enterCode(token);
    return { kv, token };
  }

  it('khung chat mở lại: nạp phiên đã lưu, xác minh với máy chủ, vẫn đăng nhập', async () => {
    const { kv, token } = await signedInKv();
    const { account } = make({ kv });
    await account.reload();
    expect(account.usable).toBe(true); // ngay từ lần nạp đầu, chưa cần mạng
    srv.calls.length = 0;
    await account.init();
    expect(srv.calls.map((c) => c.fn)).toContain('ext_auth_whoami');
    expect(account.token()).toBe(token);
    account.dispose();
  });

  it('máy chủ nói token đã bị thu hồi: xoá khỏi kho, trạng thái hết hiệu lực (revoked), không còn token', async () => {
    const { kv } = await signedInKv();
    const { account } = make({ kv });
    await account.reload();
    srv.revokeAll();
    await account.verify(true);
    expect(account.view()).toMatchObject({ status: 'expired', reason: 'revoked', user: { email: 'a@example.com' } });
    expect(account.usable).toBe(false);
    expect(account.token()).toBeUndefined();
    expect(await kv.get('nd.account')).toBeUndefined();
    // đăng nhập lại bằng mã mới
    expect(await account.enterCode(await mint())).toEqual({ ok: true });
    expect(account.view().status).toBe('signedIn');
  });

  it('mất mạng: vẫn dùng được trong thời gian ân hạn (offline), quá ân hạn thì hết hiệu lực (grace)', async () => {
    const { kv } = await signedInKv();
    let t = Date.now();
    const { account } = make({ kv, now: () => t });
    await account.reload();
    srv.mode = 'down';
    await account.verify(true);
    expect(account.view()).toMatchObject({ status: 'signedIn', offline: true });
    expect(account.usable).toBe(true);
    t += 7 * 86_400_000 + 60_000; // quá 7 ngày kể từ lần xác minh thành công cuối
    await account.verify(true);
    expect(account.view()).toMatchObject({ status: 'expired', reason: 'grace' });
    expect(account.token()).toBeUndefined();
  });

  it('đăng xuất: thu hồi token ở máy chủ, xoá khỏi kho, token cũ không dùng lại được', async () => {
    const { account, kv } = make();
    const token = await mint();
    await account.enterCode(token);
    await account.signOut();
    expect(account.view().status).toBe('signedOut');
    expect(account.token()).toBeUndefined();
    expect(await kv.get('nd.account')).toBeUndefined();
    expect([...srv.devices.values()].every((d) => d.revoked)).toBe(true);
    expect((await client.whoami(token)).ok).toBe(false);
  });

  it('hai khung chat (hai cửa sổ) dùng chung kho: đăng nhập / đăng xuất ở một nơi cập nhật nơi kia', async () => {
    const kv = new MemoryKv();
    const a = make({ kv }).account;
    const b = make({ kv }).account;
    await a.init();
    await b.init();
    const seen: string[] = [];
    b.onChange(() => seen.push(b.view().status));
    await a.enterCode(await mint());
    await new Promise((r) => setTimeout(r, 30));
    expect(b.usable).toBe(true);
    await a.signOut();
    await new Promise((r) => setTimeout(r, 30));
    expect(b.usable).toBe(false);
    expect(seen).toEqual(expect.arrayContaining(['signedIn', 'signedOut']));
    a.dispose();
    b.dispose();
  });
});

describe('BrowserAccount — token cho cổng mô hình (401)', () => {
  it('refreshToken: cửa sổ khác đã đổi token thì dùng token mới; token còn hiệu lực thì xác nhận lại; bị thu hồi thì undefined + hết hiệu lực', async () => {
    const kv = new MemoryKv();
    const { account } = make({ kv });
    const old = await mint();
    await account.enterCode(old);
    // token vẫn còn hiệu lực: máy chủ xác nhận → trả lại chính nó
    expect(await account.refreshToken(old)).toBe(old);
    // cửa sổ khác vừa dán mã mới vào kho
    const other = make({ kv: new MemoryKv() });
    const fresh = await mint();
    await other.account.enterCode(fresh);
    await kv.set('nd.account', await other.kv.get('nd.account'));
    expect(await account.refreshToken(old)).toBe(fresh);
    // thu hồi hẳn
    srv.revokeAll();
    expect(await account.refreshToken(fresh)).toBeUndefined();
    expect(account.view()).toMatchObject({ status: 'expired', reason: 'revoked' });
  });

  it('expireToken: khoá phiên khi cổng vẫn từ chối token đã làm mới; không đụng tới token khác', async () => {
    const { account, kv } = make();
    const token = await mint();
    await account.enterCode(token);
    await account.expireToken('lat_' + 'q'.repeat(43)); // token của cửa sổ khác: bỏ qua
    expect(account.usable).toBe(true);
    await account.expireToken(token);
    expect(account.view()).toMatchObject({ status: 'expired', reason: 'revoked' });
    expect(await kv.get('nd.account')).toBeUndefined();
  });

  it('recheck: hỏi máy chủ ngay, tối đa một lần mỗi 10 giây', async () => {
    const { account } = make();
    await account.enterCode(await mint());
    srv.calls.length = 0;
    await account.recheck();
    await account.recheck();
    await account.recheck();
    expect(srv.calls.filter((c) => c.fn === 'ext_auth_whoami')).toHaveLength(1);
  });

  it('quản lý thiết bị mở trang «VS Code từ xa» của locaith.ai', async () => {
    const { account, opened } = make();
    await account.manage();
    expect(opened).toEqual(['https://locaith.ai/#remote']);
  });
});
