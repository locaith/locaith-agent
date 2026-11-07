/**
 * lane:gateway-client — H01 (401 đúng cách) + H02 (nhãn chẩn đoán) + nhóm thông điệp lỗi cổng.
 * Chạy bộ ghép THẬT: ProviderRegistry → OpenAIChatProvider → withAuthRefresh → máy chủ HTTP giả; người giữ token là GatewayTokenManager thật.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountClient } from '../src/core/account/client';
import { challengeOf } from '../src/core/account/pkce';
import { GatewayTokenManager } from '../src/core/account/gatewayToken';
import { AccountSession, type AccountStore, type PendingLogin, type SavedAccount } from '../src/core/account/session';
import { gatewayErrorText } from '../src/core/engine/gatewayErrors';
import { diagHash, gatewayDiagnosticHeaders, sha256Hex } from '../src/core/providers/gatewayDiagnostics';
import { resetParamMemory } from '../src/core/providers/http';
import { classifyGatewayError } from '../src/core/providers/locaithGateway';
import { ProviderRegistry, type AccountProviderHooks } from '../src/core/providers/registry';
import { ProviderError } from '../src/core/types';
import { LocaithBridge, type LocaithAccountLike } from '../src/host/locaith';
import { MockAccountServer } from './helpers/mockAccountServer';
import { MockServer, type SseEvent } from './helpers/mockServer';
import { req, run, textOfEvents } from './providers/util';

const OLD = `lat_${'O'.repeat(43)}`;
const NEW = `lat_${'N'.repeat(43)}`;
const DEVICE = 'dev-1234-secret-device-id';
const SESSION = 'sess-C:\\Users\\anh\\du-an-bi-mat';

let server: MockServer;
beforeAll(async () => {
  server = await MockServer.start();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => resetParamMemory());
afterEach(() => server.reset());

const chunk = (delta: Record<string, unknown>, finish: string | null = null): SseEvent => ({
  data: { id: 'c1', object: 'chat.completion.chunk', model: 'locaith-v5-flash', choices: [{ index: 0, delta, finish_reason: finish }] },
});
const ok = (text: string) => ({
  sse: [chunk({ role: 'assistant', content: '' }), chunk({ content: text }), chunk({}, 'stop'), { data: { id: 'c1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } } }, { data: '[DONE]' }] as SseEvent[],
});
const unauthorized = { status: 401, json: { error: { message: 'x', type: 'auth', code: 'locaith_unauthorized' } } };
const bearer = (r: { headers: Record<string, unknown> }) => String(r.headers.authorization ?? '');
const chats = () => server.requests.filter((r) => r.path.endsWith('/chat/completions'));

/** Bộ ghép thật: tài khoản giả (token hiện tại + làm mới) → bridge hooks → registry. */
function rig(opts: { refresh?: (stale: string) => Promise<string | undefined>; start?: string; retries?: number } = {}) {
  const acct = {
    token: opts.start ?? OLD,
    usable: true,
    refreshCalls: [] as string[],
    dead: [] as string[],
    userId: () => 'u-1',
    deviceId: () => DEVICE,
    refreshToken: async (stale: string) => {
      acct.refreshCalls.push(stale);
      return opts.refresh ? opts.refresh(stale) : NEW;
    },
    expireToken: (t: string) => {
      acct.dead.push(t);
      if (acct.token === t) acct.usable = false; // như AccountSession.expireToken: phiên khoá
    },
  };
  const like: LocaithAccountLike = {
    get usable() {
      return acct.usable;
    },
    token: () => acct.token,
    userId: acct.userId,
    deviceId: acct.deviceId,
    refreshToken: acct.refreshToken,
    expireToken: acct.expireToken,
  };
  const bridge = new LocaithBridge();
  bridge.attach(like, { accepted: () => true });
  const hooks: AccountProviderHooks = bridge.hooks('0.6.32');
  // Làm mới thành công = từ nay phiên dùng token mới (như AccountSession.refreshToken đọc lại kho).
  const orig = acct.refreshToken;
  acct.refreshToken = async (s) => {
    const r = await orig(s);
    if (r) acct.token = r;
    return r;
  };
  like.refreshToken = acct.refreshToken;
  const registry = new ProviderRegistry({
    resolveApiKey: async () => undefined,
    env: {},
    baseUrlOverrides: { locaith: `${server.url}/api/llm/v1` },
    defaultOptions: { retry: { maxRetries: opts.retries ?? 0, baseDelayMs: 1, maxDelayMs: opts.retries ? 3000 : 5 } },
    account: hooks,
  });
  return { acct, hooks, provider: registry.get('locaith') };
}
const sreq = (over = {}) => req({ model: 'locaith-v5-flash', sessionKey: SESSION, ...over });
const failure = async (p: Promise<unknown>): Promise<ProviderError> => {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('mong đợi lỗi');
};

describe('H01 — 401 của cổng: làm mới đúng một lần, gửi lại đúng một lần', () => {
  it('401 → làm mới → gửi lại bằng token MỚI → thành công', async () => {
    server.reply(unauthorized).reply(ok('xin chào'));
    const { acct, provider } = rig();
    const r = await run(provider, sreq());
    expect(textOfEvents(r.events)).toBe('xin chào');
    expect(acct.refreshCalls).toEqual([OLD]);
    expect(chats().map(bearer)).toEqual([`Bearer ${OLD}`, `Bearer ${NEW}`]);
    expect(acct.dead).toEqual([]);
  });

  it('401 → làm mới → 401 lần hai ⇒ DỪNG (đúng 2 yêu cầu), lỗi accountAuth, khoá phiên bằng token đã làm mới', async () => {
    server.replyAlways(unauthorized);
    const { acct, provider } = rig();
    const err = await failure(run(provider, sreq()));
    expect(err).toMatchObject({ kind: 'auth', accountAuth: true, retryable: false });
    expect(chats()).toHaveLength(2); // không có lần thứ ba, không vòng lặp vô hạn
    expect(acct.refreshCalls).toHaveLength(1);
    expect(acct.dead).toEqual([NEW]);
  });

  it('làm mới KHÔNG được (mất mạng / đã bị thu hồi) ⇒ chỉ 1 yêu cầu, lỗi hành động được, không gửi lại token hỏng', async () => {
    server.replyAlways(unauthorized);
    const { acct, provider } = rig({ refresh: async () => undefined });
    const err = await failure(run(provider, sreq()));
    expect(err).toMatchObject({ kind: 'auth', accountAuth: true });
    expect(err.message).toMatch(/đăng nhập lại/i);
    expect(chats()).toHaveLength(1);
    expect(acct.refreshCalls).toHaveLength(1);
  });

  it('máy chủ tài khoản xác nhận lại CHÍNH token cũ ⇒ vẫn chỉ gửi lại một lần rồi dừng', async () => {
    server.replyAlways(unauthorized);
    const { acct, provider } = rig({ refresh: async (s) => s });
    await failure(run(provider, sreq()));
    expect(chats()).toHaveLength(2);
    expect(acct.refreshCalls).toHaveLength(1);
  });

  it('401 không mang mã cổng (proxy) vẫn được xử lý như 401 tài khoản', async () => {
    server.reply({ status: 401, text: 'Unauthorized' }).reply(ok('qua proxy'));
    const { provider } = rig();
    expect(textOfEvents((await run(provider, sreq())).events)).toBe('qua proxy');
    expect(chats()).toHaveLength(2);
  });

  it('NHIỀU yêu cầu 401 cùng lúc chỉ gây MỘT lần làm mới; mỗi yêu cầu gửi lại đúng một lần bằng token mới', async () => {
    server.replyAlways((r) => (bearer(r) === `Bearer ${OLD}` ? unauthorized : ok('ok')));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { acct, provider } = rig({
      refresh: async () => {
        await gate; // giữ lần làm mới đang chạy để các 401 còn lại đến trong lúc đó
        return NEW;
      },
    });
    const all = Promise.all([run(provider, sreq()), run(provider, sreq()), run(provider, sreq()), run(provider, sreq())]);
    await new Promise((r) => setTimeout(r, 150));
    release();
    const results = await all;
    expect(results.every((r) => textOfEvents(r.events) === 'ok')).toBe(true);
    expect(acct.refreshCalls).toHaveLength(1);
    expect(chats().filter((r) => bearer(r) === `Bearer ${NEW}`)).toHaveLength(4);
    expect(chats().filter((r) => bearer(r) === `Bearer ${OLD}`)).toHaveLength(4);
  });

  it('token đã đánh dấu hỏng KHÔNG được dùng lại cho yêu cầu kế tiếp (không gửi byte nào tới cổng)', async () => {
    server.replyAlways(unauthorized);
    const { acct, provider } = rig({ refresh: async () => undefined });
    await failure(run(provider, sreq()));
    expect(chats()).toHaveLength(1);
    // Yêu cầu tiếp theo: token vẫn là OLD (đã hỏng), làm mới đang trong thời gian chờ ⇒ không gửi, báo lỗi hành động được ngay.
    const err = await failure(run(provider, sreq()));
    expect(err).toMatchObject({ kind: 'auth', accountAuth: true });
    expect(chats()).toHaveLength(1);
    expect(acct.refreshCalls).toHaveLength(1);
  });

  it('đăng nhập lại (token khác) thì dùng được ngay, không cần làm mới', async () => {
    server.replyAlways(unauthorized);
    const { acct, provider } = rig({ refresh: async () => undefined });
    await failure(run(provider, sreq()));
    const before = chats().length;
    acct.token = NEW; // cửa sổ khác / lần đăng nhập mới
    server.reset();
    server.reply(ok('lại được'));
    expect(textOfEvents((await run(provider, sreq())).events)).toBe('lại được');
    expect(chats()).toHaveLength(1);
    expect(chats().map(bearer)).toEqual([`Bearer ${NEW}`]);
    expect(before).toBe(1);
  });

  it('không làm hỏng retry: 503 bảo trì được thử lại, sau đó 401 → làm mới → gửi lại → thành công (tổng 3 yêu cầu)', async () => {
    server
      .reply({ status: 503, json: { error: { code: 'locaith_unavailable', message: 'bảo trì' } }, headers: { 'retry-after': '0' } })
      .reply(unauthorized)
      .reply(ok('xong'));
    const { acct, provider } = rig({ retries: 2 });
    expect(textOfEvents((await run(provider, sreq())).events)).toBe('xong');
    expect(chats()).toHaveLength(3);
    expect(acct.refreshCalls).toHaveLength(1);
  });

  it('hàng chờ 429 vẫn hoạt động cùng bộ làm mới: xếp hàng → 401 → làm mới → thành công', async () => {
    server
      .reply({ status: 429, headers: { 'retry-after': '1' }, json: { error: { code: 'locaith_queue', message: 'chờ' }, queue: { ticket: 'q_1', position: 2, ahead: 1, retry_after_sec: 1 } } })
      .reply(unauthorized)
      .reply(ok('hết hàng'));
    const { provider } = rig();
    expect(textOfEvents((await run(provider, sreq())).events)).toBe('hết hàng');
    expect(chats()).toHaveLength(3);
  }, 10_000);
});

describe('GatewayTokenManager — đơn vị', () => {
  const mk = (over: Partial<ConstructorParameters<typeof GatewayTokenManager>[0]> = {}) => {
    const st = { cur: OLD as string | undefined, t: 1_000, refreshes: 0, dead: [] as string[] };
    const m = new GatewayTokenManager({
      current: () => st.cur,
      refresh: async () => {
        st.refreshes++;
        return NEW;
      },
      onDead: (t) => st.dead.push(t),
      now: () => st.t,
      ...over,
    });
    return { m, st };
  };

  it('acquire: token tốt trả nguyên; chưa đăng nhập → undefined', async () => {
    const { m, st } = mk();
    expect(await m.acquire()).toBe(OLD);
    st.cur = undefined;
    expect(await m.acquire()).toBeUndefined();
  });

  it('sau 401 token cũ bị đánh dấu hỏng và không bao giờ được acquire() trả lại, kể cả khi làm mới thất bại', async () => {
    const { m, st } = mk({ refresh: async () => undefined });
    expect(await m.onUnauthorized(OLD)).toBeUndefined();
    expect(m.isInvalid(OLD)).toBe(true);
    for (let i = 0; i < 5; i++) expect(await m.acquire()).toBeUndefined();
    expect(st.dead).toEqual([]);
  });

  it('thất bại thì chờ hết thời gian nghỉ mới thử làm mới lại (không dội máy chủ)', async () => {
    let n = 0;
    const { m, st } = mk({
      refresh: async () => {
        n++;
        return undefined;
      },
    });
    await m.onUnauthorized(OLD);
    await m.acquire();
    await m.acquire();
    expect(n).toBe(1);
    st.t += 31_000;
    await m.acquire();
    expect(n).toBe(2);
  });

  it('làm mới thành công bằng token mới: token mới dùng được, token cũ vẫn hỏng', async () => {
    const { m, st } = mk();
    expect(await m.onUnauthorized(OLD)).toBe(NEW);
    st.cur = NEW;
    expect(await m.acquire()).toBe(NEW);
    expect(m.isInvalid(OLD)).toBe(true);
  });

  it('máy chủ xác nhận chính token cũ → gỡ cờ hỏng (làm mới thành công)', async () => {
    const { m } = mk({ refresh: async (s) => s });
    expect(await m.onUnauthorized(OLD)).toBe(OLD);
    expect(m.isInvalid(OLD)).toBe(false);
    expect(await m.acquire()).toBe(OLD);
  });

  it('10 lời gọi đồng thời → 1 lần làm mới; lời gọi đến muộn trong 5 giây dùng lại kết quả', async () => {
    const { m, st } = mk();
    const rs = await Promise.all(Array.from({ length: 10 }, () => m.onUnauthorized(OLD)));
    expect(new Set(rs)).toEqual(new Set([NEW]));
    expect(st.refreshes).toBe(1);
    st.cur = OLD; // tình huống xấu: phiên vẫn chưa đổi
    await m.onUnauthorized(OLD);
    expect(st.refreshes).toBe(1);
  });

  it('onRetryRejected: gọi onDead đúng token, rồi acquire() không trả token đó', async () => {
    const { m, st } = mk({ refresh: async (s) => s });
    await m.onUnauthorized(OLD);
    m.onRetryRejected(OLD);
    expect(st.dead).toEqual([OLD]);
    expect(await m.acquire()).toBeUndefined();
  });

  it('refresh ném lỗi được coi như thất bại (không làm vỡ luồng gọi)', async () => {
    const { m } = mk({
      refresh: async () => {
        throw new Error('boom');
      },
    });
    expect(await m.onUnauthorized(OLD)).toBeUndefined();
  });
});

describe('AccountSession.refreshToken / expireToken (máy chủ tài khoản giả)', () => {
  class Store implements AccountStore {
    saved: SavedAccount | null = null;
    async load() {
      return this.saved ? structuredClone(this.saved) : null;
    }
    async save(a: SavedAccount | null) {
      this.saved = a ? structuredClone(a) : null;
    }
    async loadPending(): Promise<PendingLogin | null> {
      return null;
    }
    async savePending() {}
  }
  let srv: MockAccountServer;
  const USER = { id: 'u-1', email: 'a@example.com', name: 'A' };
  beforeEach(async () => {
    srv = new MockAccountServer();
    srv.addUser(USER);
    await srv.start();
  });
  afterEach(async () => srv.stop());

  async function signedIn() {
    const client = new AccountClient({ supabaseUrl: srv.url, anonKey: srv.anonKey, webUrl: 'https://locaith.ai' }, { timeoutMs: 1500 });
    const store = new Store();
    const s = new AccountSession({ client, store, webUrl: 'https://locaith.ai', redirectUri: () => 'vscode://locaithai.locaith-agent/auth', deviceLabel: () => 'Máy thử', meta: () => ({ client: 'vscode' }), openUrl: async () => {} });
    const verifier = 'v'.repeat(43);
    const code = srv.approve(USER.id, challengeOf(verifier), 'vscode://locaithai.locaith-agent/auth');
    const r = await client.exchange(code, verifier, {});
    if (!r.ok) throw new Error('đăng nhập giả thất bại');
    store.saved = { token: r.token, device: r.device, user: r.user, verifiedAt: Date.now() };
    await s.init();
    return { s, store, token: r.token };
  }

  it('token còn hiệu lực → trả chính nó (máy chủ xác nhận); deviceId có khi đã đăng nhập', async () => {
    const { s, token } = await signedIn();
    expect(await s.refreshToken(token)).toBe(token);
    expect(s.deviceId).toMatch(/\S/);
  });

  it('bị thu hồi → undefined và phiên chuyển expired (giao diện hiện nút đăng nhập)', async () => {
    const { s, token } = await signedIn();
    srv.revokeAll();
    expect(await s.refreshToken(token)).toBeUndefined();
    expect(s.state.status).toBe('expired');
    expect(s.deviceId).toBeUndefined();
  });

  it('mất mạng → undefined (không xác minh được thì không coi là làm mới), phiên vẫn giữ', async () => {
    const { s, token } = await signedIn();
    srv.mode = 'down';
    expect(await s.refreshToken(token)).toBeUndefined();
    expect(s.usable).toBe(true);
  });

  it('cửa sổ khác đã đăng nhập lại (kho có token khác) → dùng token mới, không hỏi máy chủ', async () => {
    const { s, store, token } = await signedIn();
    const calls = srv.calls.length;
    store.saved = { ...store.saved!, token: NEW };
    expect(await s.refreshToken(token)).toBe(NEW);
    expect(srv.calls.length).toBe(calls);
  });

  it('expireToken: xoá đúng token đã bị cổng từ chối và chuyển expired; token khác thì giữ nguyên', async () => {
    const { s, store, token } = await signedIn();
    await s.expireToken(NEW); // không phải token của phiên
    expect(s.usable).toBe(true);
    await s.expireToken(token);
    expect(s.state.status).toBe('expired');
    expect(store.saved).toBeNull();
    expect(s.token).toBeUndefined();
  });
});

describe('H02 — nhãn chẩn đoán X-Locaith-*', () => {
  it('sha256Hex khớp node:crypto (rỗng, ASCII, tiếng Việt, biên khối 55/56/64 byte, dài)', () => {
    for (const s of ['', 'abc', 'Xin chào — Việt Nam', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(1000), '😀 emoji']) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  it('diagHash: 16 hex, xác định, tách theo miền, không chứa giá trị thô', () => {
    expect(diagHash('device', 'abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(diagHash('device', 'abc')).toBe(diagHash('device', 'abc'));
    expect(diagHash('device', 'abc')).not.toBe(diagHash('session', 'abc'));
    expect(diagHash('device', 'abc')).toBe(createHash('sha256').update('locaith-device:abc').digest('hex').slice(0, 16));
  });

  it('gatewayDiagnosticHeaders: chỉ client/device/session; giá trị sạch; không có thiết bị thì không gửi tiêu đề thiết bị', () => {
    const h = gatewayDiagnosticHeaders({ family: 'vscode', version: '0.6.32', deviceId: DEVICE, sessionKey: SESSION });
    expect(Object.keys(h).sort()).toEqual(['x-locaith-client', 'x-locaith-device', 'x-locaith-session']);
    expect(h['x-locaith-client']).toBe('vscode/0.6.32');
    expect(h['x-locaith-device']).toMatch(/^[0-9a-f]{16}$/);
    expect(h['x-locaith-session']).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(h)).not.toContain(DEVICE);
    expect(JSON.stringify(h)).not.toMatch(/Users|du-an|sess-/);
    expect(Object.keys(gatewayDiagnosticHeaders({ family: 'cli', version: '0.3.4' }))).toEqual(['x-locaith-client']);
    expect(gatewayDiagnosticHeaders({ family: 'browser', version: '1.2.3\r\nx-evil: 1' })['x-locaith-client']).toBe('browser/1.2.3x-evil1');
  });

  it('mọi yêu cầu trò chuyện THẬT tới cổng mang ba tiêu đề; không có mã thiết bị thô, email, token trong tiêu đề nào ngoài authorization', async () => {
    server.reply(ok('hi'));
    const { provider } = rig();
    await run(provider, sreq());
    const r = chats()[0]!;
    expect(r.headers['x-locaith-client']).toBe('vscode/0.6.32');
    expect(r.headers['x-locaith-device']).toBe(diagHash('device', DEVICE));
    expect(r.headers['x-locaith-session']).toBe(diagHash('session', SESSION));
    for (const [k, v] of Object.entries(r.headers)) {
      if (k === 'authorization') continue;
      const val = String(v);
      expect(val).not.toContain(DEVICE);
      expect(val).not.toContain(SESSION);
      expect(val).not.toMatch(/@|lat_|Users/);
    }
  });

  it('cùng một phiên chat luôn cho cùng mã băm (cổng nối được các dòng log của một phiên)', () => {
    expect(gatewayDiagnosticHeaders({ family: 'vscode', version: '1', sessionKey: 's1' })['x-locaith-session']).toBe(
      gatewayDiagnosticHeaders({ family: 'vscode', version: '1', sessionKey: 's1' })['x-locaith-session'],
    );
    expect(gatewayDiagnosticHeaders({ family: 'vscode', version: '1', sessionKey: 's1' })['x-locaith-session']).not.toBe(
      gatewayDiagnosticHeaders({ family: 'vscode', version: '1', sessionKey: 's2' })['x-locaith-session'],
    );
  });
});

describe('Thông điệp lỗi cổng theo nhóm (vi/en, kèm hành động)', () => {
  const gw = (code: string, status: number, message = 'Lời của cổng.', retryAfter?: number) =>
    classifyGatewayError('locaith', status, JSON.stringify({ error: { code, message } }), retryAfter)!;

  it('hạn mức ngày: vi giữ lời cổng, en dùng câu chuẩn', () => {
    const e = gw('locaith_quota', 429, 'Hết hạn mức hôm nay.', 3_600_000);
    expect(gatewayErrorText(e, 'vi')).toBe('Hết hạn mức hôm nay.');
    expect(gatewayErrorText(e, 'en')).toMatch(/quota/i);
  });
  it('giới hạn tốc độ → nhắc chờ rồi «Thử lại» / “Retry”', () => {
    const e = gw('locaith_rate_limited', 429, '');
    expect(gatewayErrorText(e, 'vi')).toMatch(/thử lại/i);
    expect(gatewayErrorText(e, 'en')).toMatch(/Retry/);
  });
  it('quá tải / bảo trì / hàng chờ → nhóm quá tải', () => {
    expect(gatewayErrorText(gw('locaith_unavailable', 503, ''), 'en')).toMatch(/overloaded|maintenance/i);
    expect(gatewayErrorText(gw('locaith_queue', 429, ''), 'vi')).toMatch(/quá tải|bảo trì/);
  });
  it('model không còn → nhắc chọn model khác', () => {
    expect(gatewayErrorText(gw('locaith_model_not_found', 404, ''), 'vi')).toMatch(/model khác/);
  });
  it('mất mạng / hết giờ của nhà cung cấp Locaith → kiểm tra mạng + Thử lại; nhà cung cấp khác không bị đụng', () => {
    const net = new ProviderError('Không kết nối được (ENOTFOUND).', { kind: 'network', providerId: 'locaith' });
    expect(gatewayErrorText(net, 'vi')).toMatch(/kiểm tra mạng.*Thử lại/);
    expect(gatewayErrorText(net, 'en')).toMatch(/network.*Retry/i);
    expect(gatewayErrorText(new ProviderError('x', { kind: 'network', providerId: 'openai' }), 'vi')).toBeUndefined();
  });
  it('401 tài khoản KHÔNG đi đường này (đã có thông điệp «hết hạn — đăng nhập lại» riêng)', () => {
    expect(gatewayErrorText(gw('locaith_unauthorized', 401), 'vi')).toBeUndefined();
  });
});
