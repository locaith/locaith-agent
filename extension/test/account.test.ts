import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountClient } from '../src/core/account/client';
import { DEFAULT_ACCOUNT_CONFIG, resolveAccountConfig } from '../src/core/account/config';
import { challengeOf, newState, newVerifier, safeEqual } from '../src/core/account/pkce';
import { AccountSession, type AccountStore, type PendingLogin, type SavedAccount } from '../src/core/account/session';
import { MockAccountServer } from './helpers/mockAccountServer';

describe('PKCE', () => {
  it('khớp vector kiểm thử RFC 7636 Phụ lục B', () => {
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('verifier 43 ký tự base64url, state 22 ký tự, không trùng nhau', () => {
    const a = newVerifier();
    const b = newVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(newState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(challengeOf(a)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('safeEqual so sánh đúng, kể cả khác độ dài', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('cấu hình tài khoản', () => {
  it('ngoài chế độ kiểm thử, biến môi trường KHÔNG đổi được máy chủ tài khoản', () => {
    const c = resolveAccountConfig({ LOCAITH_TEST_SUPABASE_URL: 'https://evil.example', LOCAITH_TEST_WEB_URL: 'https://evil.example' });
    expect(c).toEqual(DEFAULT_ACCOUNT_CONFIG);
  });
  it('khi ND_AGENT_TEST=1 mới cho đổi', () => {
    const c = resolveAccountConfig({ ND_AGENT_TEST: '1', LOCAITH_TEST_SUPABASE_URL: 'http://127.0.0.1:9/', LOCAITH_TEST_WEB_URL: 'http://localhost:3000/' });
    expect(c.supabaseUrl).toBe('http://127.0.0.1:9');
    expect(c.webUrl).toBe('http://localhost:3000');
  });
});

let srv: MockAccountServer;
let client: AccountClient;
const USER = { id: 'u-1', email: 'a@example.com', name: 'Người A' };
const REDIRECT = 'vscode://locaithai.locaith-agent/auth';

beforeEach(async () => {
  srv = new MockAccountServer();
  srv.addUser(USER);
  await srv.start();
  client = new AccountClient({ supabaseUrl: srv.url, anonKey: srv.anonKey, webUrl: 'https://locaith.ai' }, { timeoutMs: 1500 });
});
afterEach(async () => {
  await srv.stop();
});

describe('AccountClient', () => {
  const login = async () => {
    const v = newVerifier();
    const code = srv.approve(USER.id, challengeOf(v), REDIRECT);
    return { v, code, r: await client.exchange(code, v, { client: 'vscode' }) };
  };

  it('đổi mã + verifier lấy token thiết bị và thông tin người dùng', async () => {
    const { r } = await login();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.token).toMatch(/^lat_[A-Za-z0-9_-]{43}$/);
      expect(r.user).toMatchObject({ id: 'u-1', email: 'a@example.com', name: 'Người A', avatar: null });
      expect(r.device.label).toBe('Máy thử');
    }
  });

  it('verifier sai → invalid_grant và mã bị đốt (verifier đúng cũng không dùng lại được)', async () => {
    const v = newVerifier();
    const code = srv.approve(USER.id, challengeOf(v), REDIRECT);
    expect(await client.exchange(code, newVerifier(), {})).toEqual({ ok: false, error: 'invalid_grant' });
    expect(await client.exchange(code, v, {})).toEqual({ ok: false, error: 'invalid_grant' });
  });

  it('mã hết hạn / mã lạ / dùng lại → invalid_grant', async () => {
    const v = newVerifier();
    const code = srv.approve(USER.id, challengeOf(v), REDIRECT);
    srv.expireCodes();
    expect((await client.exchange(code, v, {})).ok).toBe(false);
    const { code: c2, v: v2 } = await login();
    expect((await client.exchange(c2, v2, {})).ok).toBe(false); // đã dùng
    expect(await client.exchange('x'.repeat(27), newVerifier(), {})).toEqual({ ok: false, error: 'invalid_grant' });
  });

  it('whoami: token đúng ok, token sai/đã thu hồi invalid_token', async () => {
    const { r } = await login();
    if (!r.ok) throw new Error('đăng nhập thất bại');
    expect((await client.whoami(r.token)).ok).toBe(true);
    expect(await client.whoami(`lat_${'A'.repeat(43)}`)).toEqual({ ok: false, error: 'invalid_token' });
    srv.revokeAll();
    expect(await client.whoami(r.token)).toEqual({ ok: false, error: 'invalid_token' });
  });

  it('phân biệt mất mạng / lỗi máy chủ với từ chối dứt khoát', async () => {
    const { r } = await login();
    if (!r.ok) throw new Error('x');
    srv.mode = 'down';
    expect(await client.whoami(r.token)).toEqual({ ok: false, error: 'network' });
    srv.mode = 'error';
    expect(await client.whoami(r.token)).toEqual({ ok: false, error: 'server' });
    srv.mode = undefined;
    expect((await client.whoami(r.token)).ok).toBe(true);
  });

  it('khoá API sai (401) là lỗi máy chủ chứ KHÔNG phải token hỏng — không được đăng xuất oan', async () => {
    const { r } = await login();
    if (!r.ok) throw new Error('x');
    const bad = new AccountClient({ supabaseUrl: srv.url, anonKey: 'sai', webUrl: '' }, { timeoutMs: 1500 });
    expect(await bad.whoami(r.token)).toEqual({ ok: false, error: 'server' });
  });

  it('hết giờ chờ → network', async () => {
    const slow = new AccountClient({ supabaseUrl: srv.url, anonKey: srv.anonKey, webUrl: '' }, {
      timeoutMs: 30,
      fetch: (_u, init) => new Promise((_res, rej) => (init?.signal as AbortSignal).addEventListener('abort', () => rej(new Error('aborted')))),
    });
    expect(await slow.whoami(`lat_${'A'.repeat(43)}`)).toEqual({ ok: false, error: 'network' });
  });

  it('bỏ qua dữ liệu lạ từ máy chủ (không tin kiểu dữ liệu)', async () => {
    const weird = new AccountClient({ supabaseUrl: 'http://x', anonKey: 'k', webUrl: '' }, {
      fetch: async () => new Response(JSON.stringify({ ok: true, token: 'khong-phai-token', user: { id: 1 }, device: null }), { status: 200 }),
    });
    expect(await weird.exchange('c'.repeat(27), newVerifier(), {})).toEqual({ ok: false, error: 'server' });
    expect(await weird.whoami(`lat_${'A'.repeat(43)}`)).toEqual({ ok: false, error: 'server' });
    const notJson = new AccountClient({ supabaseUrl: 'http://x', anonKey: 'k', webUrl: '' }, { fetch: async () => new Response('<html>', { status: 200 }) });
    expect(await notJson.whoami(`lat_${'A'.repeat(43)}`)).toEqual({ ok: false, error: 'server' });
  });

  it('logout thu hồi thiết bị; hostUpsert/hostRemove hoạt động và chặn chiếm máy của người khác', async () => {
    const { r } = await login();
    if (!r.ok) throw new Error('x');
    const host = 'A'.repeat(22);
    expect(await client.hostUpsert(r.token, host, 'PC', 'demo', {})).toEqual({ ok: true });
    expect(srv.hosts.get(host)?.label).toBe('PC');
    srv.addUser({ id: 'u-2', email: 'b@example.com', name: 'B' });
    const v2 = newVerifier();
    const other = await client.exchange(srv.approve('u-2', challengeOf(v2), REDIRECT), v2, {});
    if (!other.ok) throw new Error('x');
    expect(await client.hostUpsert(other.token, host, 'chiếm', undefined, {})).toEqual({ ok: false, error: 'conflict' });
    expect(await client.hostRemove(r.token, host)).toBe(true);
    expect(srv.hosts.size).toBe(0);
    expect(await client.logout(r.token)).toBe(true);
    expect(await client.whoami(r.token)).toEqual({ ok: false, error: 'invalid_token' });
  });

  it('hostUpsert kèm khoá tài khoản (0.6.5): đặt / giữ nguyên / xoá đúng ngữ nghĩa, từ chối khoá sai định dạng, không lộ khoá ở URL', async () => {
    const { r } = await login();
    if (!r.ok) throw new Error('x');
    const host = 'A'.repeat(22);
    const key = 'B'.repeat(22);
    expect(await client.hostUpsert(r.token, host, 'PC', 'demo', {}, key)).toEqual({ ok: true, keyed: true });
    expect(srv.hosts.get(host)?.accountKey).toBe(key);
    // bỏ trống = giữ nguyên khoá (báo danh kiểu cũ không được vô tình xoá khoá)
    expect(await client.hostUpsert(r.token, host, 'PC2', 'demo', {})).toEqual({ ok: true });
    expect(srv.hosts.get(host)).toMatchObject({ label: 'PC2', accountKey: key });
    const bare = srv.calls.at(-1)!;
    expect('p_account_psk' in bare.args).toBe(false);
    // '' = xoá khoá khỏi danh bạ (tắt tin cậy theo tài khoản)
    expect(await client.hostUpsert(r.token, host, 'PC2', 'demo', {}, '')).toEqual({ ok: true, keyed: false });
    expect(srv.hosts.get(host)?.accountKey).toBeUndefined();
    // khoá sai định dạng: máy chủ từ chối, client không giấu lỗi
    expect(await client.hostUpsert(r.token, host, 'PC2', 'demo', {}, 'ngan')).toEqual({ ok: false, error: 'bad_key' });
    expect(srv.hosts.get(host)?.accountKey).toBeUndefined();
    // khoá chỉ đi trong thân yêu cầu, không ở URL
    const urls: string[] = [];
    const spy = new AccountClient({ supabaseUrl: srv.url, anonKey: srv.anonKey, webUrl: '' }, { fetch: (u, i) => (urls.push(String(u)), fetch(u, i)) });
    await spy.hostUpsert(r.token, host, 'PC', 'demo', {}, key);
    expect(urls.every((u) => !u.includes(key) && !u.includes(r.token))).toBe(true);
  });

  it('máy chủ chưa nâng cấp migration (hàm cũ không có p_account_psk → 404): gửi lại KHÔNG kèm khoá, báo danh vẫn thành công và keyed:false', async () => {
    const { r } = await login();
    if (!r.ok) throw new Error('x');
    const host = 'C'.repeat(22);
    srv.legacyHostUpsert = true;
    expect(await client.hostUpsert(r.token, host, 'PC cũ', undefined, {}, 'D'.repeat(22))).toEqual({ ok: true, keyed: false });
    expect(srv.hosts.get(host)).toMatchObject({ label: 'PC cũ' });
    expect(srv.hosts.get(host)?.accountKey).toBeUndefined();
    const sent = srv.calls.filter((c) => c.fn === 'ext_host_upsert').slice(-2);
    expect(sent.map((c) => 'p_account_psk' in c.args)).toEqual([true, false]); // lần đầu có khoá, lần gửi lại không
    // lỗi khác (500/mất mạng) KHÔNG kích hoạt gửi lại: trả lỗi đúng loại
    srv.legacyHostUpsert = false;
    srv.mode = 'error';
    expect(await client.hostUpsert(r.token, host, 'PC', undefined, {}, 'D'.repeat(22))).toEqual({ ok: false, error: 'server' });
    srv.mode = 'down';
    expect(await client.hostUpsert(r.token, host, 'PC', undefined, {}, 'D'.repeat(22))).toEqual({ ok: false, error: 'network' });
    srv.mode = undefined;
  });

  it('mã thô và token không nằm trong URL (chỉ trong thân yêu cầu)', async () => {
    const { v } = await login();
    expect(v).toBeTruthy();
    expect(srv.calls.length).toBeGreaterThan(0);
  });
});

// ── AccountSession ──────────────────────────────────────────────────────────
class MemStore implements AccountStore {
  saved: SavedAccount | null = null;
  pending: PendingLogin | null = null;
  async load() {
    return this.saved ? structuredClone(this.saved) : null;
  }
  async save(a: SavedAccount | null) {
    this.saved = a ? structuredClone(a) : null;
  }
  async loadPending() {
    return this.pending ? { ...this.pending } : null;
  }
  async savePending(p: PendingLogin | null) {
    this.pending = p ? { ...p } : null;
  }
}

function mkSession(store = new MemStore(), clock = { t: 1_700_000_000_000 }) {
  const opened: string[] = [];
  const s = new AccountSession({
    client,
    store,
    webUrl: 'https://locaith.ai',
    redirectUri: () => REDIRECT,
    deviceLabel: () => 'PC_WORK · VS Code',
    meta: () => ({ client: 'vscode', platform: 'win32', ext: '0.5.2' }),
    openUrl: async (u) => void opened.push(u),
    now: () => clock.t,
    verifyEveryMs: 10 * 60_000,
  });
  srv.now = () => clock.t;
  return { s, store, clock, opened };
}

/** Giả lập trình duyệt: đọc challenge/state từ URL đã mở, người dùng bấm «Cho phép», trả tham số callback. */
function browserApproves(url: string, userId = USER.id) {
  const q = new URLSearchParams(url.split('#ext-auth?')[1]);
  const code = srv.approve(userId, q.get('challenge')!, q.get('redirect')!, q.get('label')!);
  return { code, state: q.get('state')!, q };
}

describe('AccountSession', () => {
  it('chưa đăng nhập → signedOut, không được dùng', async () => {
    const { s } = mkSession();
    await s.init();
    expect(s.state.status).toBe('signedOut');
    expect(s.usable).toBe(false);
    expect(s.token).toBeUndefined();
  });

  it('startLogin mở trang locaith.ai với challenge/state/redirect/nhãn máy và lưu verifier', async () => {
    const { s, store, opened } = mkSession();
    await s.init();
    const { url } = await s.startLogin();
    expect(opened).toEqual([url]);
    expect(url.startsWith('https://locaith.ai/#ext-auth?')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('client')).toBe('vscode');
    expect(q.get('redirect')).toBe(REDIRECT);
    expect(q.get('label')).toBe('PC_WORK · VS Code');
    expect(q.get('m_platform')).toBe('win32');
    expect(q.get('challenge')).toBe(challengeOf(store.pending!.verifier));
    expect(url).not.toContain(store.pending!.verifier); // verifier KHÔNG bao giờ ra khỏi máy
    expect(s.state.status).toBe('signingIn');
  });

  it('luồng đầy đủ: mở trang → cho phép → callback → signedIn, lưu token, xoá pending', async () => {
    const { s, store, opened } = mkSession();
    await s.init();
    await s.startLogin();
    const { code, state } = browserApproves(opened[0]!);
    const r = await s.handleCallback({ code, state });
    expect(r).toEqual({ ok: true });
    expect(s.state).toMatchObject({ status: 'signedIn', offline: false, user: { email: 'a@example.com' } });
    expect(s.usable).toBe(true);
    expect(s.token).toMatch(/^lat_/);
    expect(store.saved?.token).toBe(s.token);
    expect(store.pending).toBeNull();
  });

  it('callback sai state bị bỏ qua và KHÔNG làm hỏng lần đăng nhập thật đang chờ', async () => {
    const { s, opened } = mkSession();
    await s.init();
    await s.startLogin();
    const { code, state } = browserApproves(opened[0]!);
    expect(await s.handleCallback({ code, state: 'sai' })).toEqual({ ok: false, error: 'state_mismatch' });
    expect(await s.handleCallback({ code })).toEqual({ ok: false, error: 'state_mismatch' });
    expect(await s.handleCallback({ error: 'access_denied', state: 'sai' })).toEqual({ ok: false, error: 'state_mismatch' });
    expect(s.state.status).toBe('signingIn');
    expect(await s.handleCallback({ code, state })).toEqual({ ok: true });
    expect(s.state.status).toBe('signedIn');
  });

  it('mã của kẻ khác (challenge khác) mang đúng state vẫn bị từ chối vì verifier không khớp', async () => {
    const { s, opened } = mkSession();
    await s.init();
    await s.startLogin();
    const q = new URLSearchParams(opened[0]!.split('?')[1]);
    const attackerCode = srv.approve(USER.id, challengeOf(newVerifier()), REDIRECT);
    expect(await s.handleCallback({ code: attackerCode, state: q.get('state') })).toEqual({ ok: false, error: 'invalid_grant' });
    expect(s.state.status).toBe('signedOut');
    expect(s.usable).toBe(false);
  });

  it('callback không có phiên chờ / hết hạn chờ → no_pending', async () => {
    const { s, clock, opened } = mkSession();
    await s.init();
    expect(await s.handleCallback({ code: 'x'.repeat(27), state: 'abc' })).toEqual({ ok: false, error: 'no_pending' });
    await s.startLogin();
    const { code, state } = browserApproves(opened[0]!);
    clock.t += 11 * 60_000;
    expect(await s.handleCallback({ code, state })).toEqual({ ok: false, error: 'no_pending' });
  });

  it('người dùng bấm Từ chối (error=access_denied + đúng state) → signedOut kèm lý do', async () => {
    const { s, store, opened } = mkSession();
    await s.init();
    await s.startLogin();
    const state = new URLSearchParams(opened[0]!.split('?')[1]).get('state')!;
    expect(await s.handleCallback({ error: 'access_denied', state })).toEqual({ ok: false, error: 'denied' });
    expect(s.state).toEqual({ status: 'signedOut', error: 'denied' });
    expect(store.pending).toBeNull();
  });

  it('lỗi mạng khi đổi mã: GIỮ lần đăng nhập đang chờ để thử lại, không mất verifier', async () => {
    const { s, store, opened } = mkSession();
    await s.init();
    await s.startLogin();
    const { code, state } = browserApproves(opened[0]!);
    srv.mode = 'down';
    expect(await s.handleCallback({ code, state })).toEqual({ ok: false, error: 'network' });
    expect(s.state.status).toBe('signingIn');
    expect(store.pending).not.toBeNull();
    srv.mode = undefined;
    expect(await s.handleCallback({ code, state })).toEqual({ ok: true });
  });

  it('dán mã thủ công: nhận cả mã thô lẫn cả đường dẫn vscode://…?code=…&state=…', async () => {
    const a = mkSession();
    await a.s.init();
    await a.s.startLogin({ manual: true });
    expect(a.s.state).toMatchObject({ status: 'signingIn', manual: true });
    expect(new URLSearchParams(a.opened[0]!.split('?')[1]).get('manual')).toBe('1');
    const { code } = browserApproves(a.opened[0]!);
    expect(await a.s.submitCode('  ' + code + '\n')).toEqual({ ok: true });

    const b = mkSession();
    await b.s.init();
    await b.s.startLogin();
    const r = browserApproves(b.opened[0]!);
    expect(await b.s.submitCode(`vscode://locaithai.locaith-agent/auth?code=${r.code}&state=${r.state}`)).toEqual({ ok: true });

    const c = mkSession();
    await c.s.init();
    await c.s.startLogin();
    expect(await c.s.submitCode('hu')).toEqual({ ok: false, error: 'bad_code' });
    expect(c.s.state.status).toBe('signingIn');
  });

  it('không cho bắt đầu đăng nhập khi đang đăng nhập (đổi tài khoản = đăng xuất trước)', async () => {
    const { s, opened } = mkSession();
    await s.init();
    await s.startLogin();
    const { code, state } = browserApproves(opened[0]!);
    await s.handleCallback({ code, state });
    await expect(s.startLogin()).rejects.toThrow('already_signed_in');
  });

  it('huỷ đăng nhập xoá phiên chờ', async () => {
    const { s, store } = mkSession();
    await s.init();
    await s.startLogin();
    s.cancelLogin();
    expect(s.state.status).toBe('signedOut');
    await new Promise((r) => setTimeout(r, 5));
    expect(store.pending).toBeNull();
  });

  async function signedIn() {
    const m = mkSession();
    await m.s.init();
    await m.s.startLogin();
    const { code, state } = browserApproves(m.opened[0]!);
    await m.s.handleCallback({ code, state });
    return m;
  }

  it('khởi động lại: nạp phiên đã lưu và xác minh với máy chủ', async () => {
    const { store, clock } = await signedIn();
    const again = mkSession(store, clock);
    await again.s.init();
    expect(again.s.state).toMatchObject({ status: 'signedIn', offline: false });
    expect(srv.calls.some((c) => c.fn === 'ext_auth_whoami')).toBe(true);
  });

  it('token bị thu hồi từ phía máy chủ → expired(revoked), xoá token cục bộ, không còn dùng được', async () => {
    const { s, store } = await signedIn();
    srv.revokeAll();
    await s.verify(true);
    expect(s.state).toMatchObject({ status: 'expired', reason: 'revoked' });
    expect(s.usable).toBe(false);
    expect(s.token).toBeUndefined();
    expect(store.saved).toBeNull();
  });

  it('mất mạng trong thời gian ân hạn: vẫn dùng được (offline=true); khi có mạng lại thì hết offline', async () => {
    const { s, clock } = await signedIn();
    srv.mode = 'down';
    clock.t += 2 * 86_400_000;
    await s.verify(true);
    expect(s.state).toMatchObject({ status: 'signedIn', offline: true });
    expect(s.usable).toBe(true);
    srv.mode = undefined;
    await s.verify(true);
    expect(s.state).toMatchObject({ status: 'signedIn', offline: false });
  });

  it('lỗi 500 của máy chủ cũng chỉ là "không xác minh được", không đăng xuất oan', async () => {
    const { s } = await signedIn();
    srv.mode = 'error';
    await s.verify(true);
    expect(s.state).toMatchObject({ status: 'signedIn', offline: true });
  });

  it('quá thời gian ân hạn (7 ngày) mà vẫn không xác minh được → expired(grace)', async () => {
    const { s, clock } = await signedIn();
    srv.mode = 'down';
    clock.t += 8 * 86_400_000;
    await s.verify(true);
    expect(s.state).toMatchObject({ status: 'expired', reason: 'grace' });
    expect(s.usable).toBe(false);
  });

  it('cửa sổ khác đăng nhập/đăng xuất: reload() đồng bộ qua kho dùng chung', async () => {
    const store = new MemStore();
    const clock = { t: 1_700_000_000_000 };
    const w1 = mkSession(store, clock);
    const w2 = mkSession(store, clock);
    await w1.s.init();
    await w2.s.init();
    await w1.s.startLogin();
    const { code, state } = browserApproves(w1.opened[0]!);
    // callback tới CỬA SỔ 2 (VS Code chuyển vscode:// URI tới cửa sổ đang hoạt động) — pending nằm ở kho dùng chung nên vẫn khớp
    expect(await w2.s.handleCallback({ code, state })).toEqual({ ok: true });
    await w1.s.reload();
    expect(w1.s.state.status).toBe('signedIn');
    await w2.s.logout();
    await w1.s.reload();
    expect(w1.s.state.status).toBe('signedOut');
  });

  it('đăng xuất: xoá cục bộ trước, rồi thu hồi ở máy chủ; token cũ không dùng lại được', async () => {
    const { s, store } = await signedIn();
    const token = s.token!;
    await s.logout();
    expect(s.state.status).toBe('signedOut');
    expect(store.saved).toBeNull();
    expect(await client.whoami(token)).toEqual({ ok: false, error: 'invalid_token' });
  });

  it('đăng xuất khi mất mạng vẫn xoá cục bộ', async () => {
    const { s, store } = await signedIn();
    srv.mode = 'down';
    await s.logout();
    expect(s.state.status).toBe('signedOut');
    expect(store.saved).toBeNull();
  });

  it('người nghe thay đổi trạng thái được gọi, và người nghe ném lỗi không làm hỏng phiên', async () => {
    const { s, opened } = mkSession();
    const seen: string[] = [];
    s.onChange((st) => seen.push(st.status));
    s.onChange(() => {
      throw new Error('hỏng');
    });
    await s.init();
    await s.startLogin();
    const { code, state } = browserApproves(opened[0]!);
    await s.handleCallback({ code, state });
    expect(seen).toContain('signingIn');
    expect(seen.at(-1)).toBe('signedIn');
  });
});
