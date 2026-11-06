import { describe, expect, it } from 'vitest';
import { base64url, buildAuthorizeUrl, isSafeOAuthUrl, OAuthError, OAuthManager, OPENROUTER_EXCHANGE_URL, parseRedirect, pkceChallenge, randomToken, validateSpec, type OAuthDeps, type OAuthSpec } from '../../src/browser/oauth';
import type { KeyValueStore } from '../../src/browser/kv';

class MemKv implements KeyValueStore {
  data: Record<string, unknown> = {};
  async get<T>(k: string): Promise<T | undefined> {
    return this.data[k] as T | undefined;
  }
  async set(k: string, v: unknown): Promise<void> {
    this.data[k] = structuredClone(v);
  }
  async remove(k: string): Promise<void> {
    delete this.data[k];
  }
  onChanged(): () => void {
    return () => undefined;
  }
}

const REDIRECT = 'https://abcdefgh.chromiumapp.org/';
const OAUTH2: OAuthSpec = { flow: 'oauth2', authorizeUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token', clientId: 'client-123', scopes: 'openid models.read' };

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, string>;
}

function rig(opts: { responder?: (call: Call) => { status?: number; json: unknown }; launch?: (url: string) => Promise<string>; now?: { t: number } } = {}) {
  const kv = new MemKv();
  const keys = new Map<string, string>();
  const calls: Call[] = [];
  const launched: string[] = [];
  const clock = opts.now ?? { t: 1_000_000 };
  let counter = 0;
  const deps: OAuthDeps = {
    kv,
    ensureIdentity: async () => true,
    redirectUri: () => REDIRECT,
    launch:
      opts.launch ??
      (async (url) => {
        launched.push(url);
        const u = new URL(url);
        const redirect = new URL(u.searchParams.get('redirect_uri') ?? u.searchParams.get('callback_url') ?? REDIRECT);
        redirect.searchParams.set('code', `CODE-${++counter}`);
        if (u.searchParams.get('state')) redirect.searchParams.set('state', u.searchParams.get('state')!);
        return redirect.toString();
      }),
    setKey: async (id, key) => void keys.set(id, key),
    deleteKey: async (id) => void keys.delete(id),
    now: () => clock.t,
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = init.headers && (init.headers as Record<string, string>)['Content-Type'] === 'application/json' ? JSON.parse(String(init.body)) : Object.fromEntries(new URLSearchParams(String(init.body)));
      const call = { url, init, body };
      calls.push(call);
      const r = opts.responder?.(call) ?? { json: {} };
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  };
  return { mgr: new OAuthManager(deps), kv, keys, calls, launched, clock };
}

describe('PKCE (RFC 7636)', () => {
  it('khớp vector kiểm thử của RFC 7636 Phụ lục B', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('base64url không có +, /, =; randomToken đủ dài và khác nhau', () => {
    expect(base64url(new Uint8Array([251, 255, 254, 253]))).toBe('-__-_Q');
    const a = randomToken(48);
    expect(a).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(randomToken(48)).not.toBe(a);
  });
});

describe('cấu hình & địa chỉ xác thực', () => {
  it('chỉ nhận https (hoặc http tới localhost), không tên đăng nhập', () => {
    expect(isSafeOAuthUrl('https://auth.example.com/authorize')).toBe(true);
    expect(isSafeOAuthUrl('http://localhost:8080/token')).toBe(true);
    expect(isSafeOAuthUrl('http://auth.example.com/authorize')).toBe(false);
    expect(isSafeOAuthUrl('https://u:p@auth.example.com/')).toBe(false);
    expect(isSafeOAuthUrl('javascript:alert(1)')).toBe(false);
  });
  it('validateSpec bắt các lỗi cấu hình thường gặp', () => {
    expect(validateSpec({ flow: 'openrouter' })).toBeNull();
    expect(validateSpec(OAUTH2)).toBeNull();
    expect(validateSpec({ ...OAUTH2, authorizeUrl: 'http://evil.example.com/a' })).toMatch(/authorize/);
    expect(validateSpec({ ...OAUTH2, tokenUrl: 'ftp://x/y' })).toMatch(/token/);
    expect(validateSpec({ ...OAUTH2, clientId: 'có khoảng trắng' })).toMatch(/Client ID/);
    expect(validateSpec({ ...OAUTH2, clientId: '' })).toMatch(/Client ID/);
  });
  it('buildAuthorizeUrl: OpenRouter dùng callback_url; OAuth 2.0 tổng quát đủ tham số PKCE S256', () => {
    const o = new URL(buildAuthorizeUrl({ flow: 'openrouter' }, { redirectUri: REDIRECT, challenge: 'CH', state: 'ST' }));
    expect(o.origin + o.pathname).toBe('https://openrouter.ai/auth');
    expect(Object.fromEntries(o.searchParams)).toEqual({ callback_url: REDIRECT, code_challenge: 'CH', code_challenge_method: 'S256', state: 'ST' });
    const g = new URL(buildAuthorizeUrl(OAUTH2, { redirectUri: REDIRECT, challenge: 'CH', state: 'ST' }));
    expect(Object.fromEntries(g.searchParams)).toEqual({ response_type: 'code', client_id: 'client-123', redirect_uri: REDIRECT, state: 'ST', code_challenge: 'CH', code_challenge_method: 'S256', scope: 'openid models.read' });
  });
});

describe('parseRedirect', () => {
  it('lấy mã khi đúng địa chỉ và state', () => {
    expect(parseRedirect(`${REDIRECT}?code=abc&state=ST`, REDIRECT, 'ST', true)).toEqual({ code: 'abc' });
  });
  it('từ chối: sai state, thiếu state (khi bắt buộc), sai địa chỉ nhận, người dùng từ chối, lỗi nhà cung cấp, thiếu mã', () => {
    expect(parseRedirect(`${REDIRECT}?code=abc&state=KHAC`, REDIRECT, 'ST', true)).toMatchObject({ error: expect.stringContaining('state') });
    expect(parseRedirect(`${REDIRECT}?code=abc`, REDIRECT, 'ST', true)).toMatchObject({ error: expect.stringContaining('state') });
    expect(parseRedirect(`${REDIRECT}?code=abc`, REDIRECT, 'ST', false)).toEqual({ code: 'abc' }); // OpenRouter: thiếu state vẫn được (PKCE bảo vệ)
    expect(parseRedirect(`${REDIRECT}?code=abc&state=KHAC`, REDIRECT, 'ST', false)).toMatchObject({ error: expect.any(String) }); // nhưng có mà sai thì không
    expect(parseRedirect('https://evil.example/?code=abc&state=ST', REDIRECT, 'ST', true)).toMatchObject({ error: expect.stringContaining('không đúng') });
    expect(parseRedirect(`${REDIRECT}?error=access_denied`, REDIRECT, 'ST', true)).toMatchObject({ error: expect.stringContaining('từ chối') });
    expect(parseRedirect(`${REDIRECT}?error=server_error&error_description=${'x'.repeat(500)}`, REDIRECT, 'ST', true)).toMatchObject({ error: expect.stringMatching(/^.{0,260}$/) });
    expect(parseRedirect(`${REDIRECT}?state=ST`, REDIRECT, 'ST', true)).toMatchObject({ error: expect.stringContaining('mã xác thực') });
  });
});

describe('OAuthManager — luồng OpenRouter (kết quả là khoá API)', () => {
  it('đăng nhập: đổi mã lấy khoá, gửi code_verifier S256 khớp challenge, lưu khoá như khoá thường; đăng xuất xoá khoá', async () => {
    const r = rig({ responder: () => ({ json: { key: 'sk-or-v1-abcdef0123456789', user_id: 'u1' } }) });
    await r.mgr.register('openrouter', { flow: 'openrouter' });
    expect(await r.mgr.summary('openrouter')).toEqual({ flow: 'openrouter', signedIn: false });
    await r.mgr.login('openrouter');
    // trang đăng nhập được mở với callback_url + challenge
    const authUrl = new URL(r.launched[0]);
    expect(authUrl.searchParams.get('callback_url')).toBe(REDIRECT);
    // POST đổi mã
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe(OPENROUTER_EXCHANGE_URL);
    expect(r.calls[0].body).toMatchObject({ code: 'CODE-1', code_challenge_method: 'S256' });
    expect(await pkceChallenge(r.calls[0].body.code_verifier)).toBe(authUrl.searchParams.get('code_challenge'));
    expect(r.calls[0].init.credentials).toBe('omit');
    expect(r.keys.get('openrouter')).toBe('sk-or-v1-abcdef0123456789');
    expect(await r.mgr.summary('openrouter')).toEqual({ flow: 'openrouter', signedIn: true });
    expect(await r.mgr.accessToken('openrouter')).toBeUndefined(); // khoá nằm ở kho khoá, không phải token
    await r.mgr.logout('openrouter');
    expect(r.keys.has('openrouter')).toBe(false);
    expect(await r.mgr.summary('openrouter')).toEqual({ flow: 'openrouter', signedIn: false });
  });

  it('lỗi: người dùng đóng cửa sổ; máy chủ từ chối; khoá rỗng — thông điệp tiếng Việt, không lộ nội dung phản hồi', async () => {
    const closed = rig({ launch: async () => Promise.reject(new Error('The user did not approve access.')) });
    await closed.mgr.register('or', { flow: 'openrouter' });
    await expect(closed.mgr.login('or')).rejects.toThrow(/đóng|không đồng ý/);

    const denied = rig({ responder: () => ({ status: 403, json: { error: { code: 'forbidden', message: 'tài khoản bị khoá' }, leaked: 'sk-SECRET-DO-NOT-ECHO' } }) });
    await denied.mgr.register('or', { flow: 'openrouter' });
    const err = (await denied.mgr.login('or').catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.message).toContain('HTTP 403');
    expect(err.message).not.toContain('SECRET');
    expect(denied.keys.size).toBe(0);

    const empty = rig({ responder: () => ({ json: { key: '' } }) });
    await empty.mgr.register('or', { flow: 'openrouter' });
    await expect(empty.mgr.login('or')).rejects.toThrow(/khoá hợp lệ/);
  });
});

describe('OAuthManager — OAuth 2.0 + PKCE tổng quát', () => {
  const tokenReply = (extra: Record<string, unknown> = {}) => ({ json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer', ...extra } });

  it('đăng nhập: gửi đủ tham số dạng form, lưu token; accessToken trả token còn hạn', async () => {
    const r = rig({ responder: () => tokenReply() });
    await r.mgr.register('gw', OAUTH2);
    await r.mgr.login('gw');
    expect(r.calls[0].url).toBe(OAUTH2.tokenUrl);
    expect(r.calls[0].body).toMatchObject({ grant_type: 'authorization_code', code: 'CODE-1', redirect_uri: REDIRECT, client_id: 'client-123' });
    const authUrl = new URL(r.launched[0]);
    expect(await pkceChallenge(r.calls[0].body.code_verifier)).toBe(authUrl.searchParams.get('code_challenge'));
    expect(await r.mgr.accessToken('gw')).toBe('at-1');
    expect(await r.mgr.summary('gw')).toEqual({ flow: 'oauth2', signedIn: true });
    expect(r.keys.size).toBe(0); // token không lẫn vào kho khoá API
  });

  it('state sai từ nhà cung cấp → huỷ trước khi đổi mã (không POST nào)', async () => {
    const r = rig({
      launch: async (url) => {
        const u = new URL(url);
        return `${u.searchParams.get('redirect_uri')}?code=EVIL&state=do-ke-tan-cong-chen`;
      },
      responder: () => tokenReply(),
    });
    await r.mgr.register('gw', OAUTH2);
    await expect(r.mgr.login('gw')).rejects.toThrow(/state/);
    expect(r.calls).toHaveLength(0);
    expect(await r.mgr.accessToken('gw')).toBeUndefined();
  });

  it('tự làm mới khi sắp hết hạn; refresh token xoay vòng được lưu; nhiều lời gọi đồng thời chỉ làm mới MỘT lần', async () => {
    let n = 0;
    const clock = { t: 1_000_000 };
    const r = rig({
      now: clock,
      responder: (call) => (call.body.grant_type === 'refresh_token' ? tokenReply({ access_token: `at-${++n + 1}`, refresh_token: `rt-${n + 1}` }) : tokenReply({ expires_in: 120 })),
    });
    await r.mgr.register('gw', OAUTH2);
    await r.mgr.login('gw');
    expect(await r.mgr.accessToken('gw')).toBe('at-1'); // còn 120 s > 60 s đệm
    clock.t += 90_000; // còn 30 s < 60 s đệm → phải làm mới
    const [a, b, c] = await Promise.all([r.mgr.accessToken('gw'), r.mgr.accessToken('gw'), r.mgr.accessToken('gw')]);
    expect([a, b, c]).toEqual(['at-2', 'at-2', 'at-2']);
    expect(r.calls.filter((x) => x.body.grant_type === 'refresh_token')).toHaveLength(1);
    expect(r.calls.at(-1)!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'client-123' });
    clock.t += 3_600_000;
    await r.mgr.accessToken('gw');
    expect(r.calls.at(-1)!.body.refresh_token).toBe('rt-2'); // dùng refresh token mới nhất
  });

  it('refresh token bị thu hồi (400/401) → coi là đã đăng xuất; lỗi mạng tạm thời → giữ nguyên để thử lại', async () => {
    const clock = { t: 1_000_000 };
    let mode: 'ok' | 'revoked' | 'net' = 'ok';
    const r = rig({
      now: clock,
      responder: (call) => {
        if (call.body.grant_type === 'refresh_token') {
          if (mode === 'revoked') return { status: 400, json: { error: 'invalid_grant', error_description: 'refresh token revoked' } };
          if (mode === 'net') throw new TypeError('Failed to fetch');
        }
        return tokenReply({ expires_in: 60 });
      },
    });
    await r.mgr.register('gw', OAUTH2);
    await r.mgr.login('gw');
    clock.t += 120_000;
    mode = 'net';
    expect(await r.mgr.accessToken('gw')).toBeUndefined();
    expect(await r.mgr.summary('gw')).toEqual({ flow: 'oauth2', signedIn: true }); // chưa mất đăng nhập
    mode = 'revoked';
    expect(await r.mgr.accessToken('gw')).toBeUndefined();
    expect(await r.mgr.summary('gw')).toEqual({ flow: 'oauth2', signedIn: false });
  });

  it('thiếu quyền identity / thiếu quyền tới máy chủ cấp token → báo rõ, không mở cửa sổ đăng nhập', async () => {
    const r = rig({ responder: () => tokenReply() });
    (r.mgr as unknown as { d: OAuthDeps }).d.ensureIdentity = async () => false;
    await r.mgr.register('gw', OAUTH2);
    await expect(r.mgr.login('gw')).rejects.toThrow(/identity/);
    expect(r.launched).toHaveLength(0);

    const r2 = rig({ responder: () => tokenReply() });
    (r2.mgr as unknown as { d: OAuthDeps }).d.ensureOrigin = async () => false;
    await r2.mgr.register('gw', OAUTH2);
    await expect(r2.mgr.login('gw')).rejects.toThrow(/auth\.example\.com/);
    expect(r2.launched).toHaveLength(0);
  });

  it('không cho hai phiên đăng nhập song song; register từ chối cấu hình sai; forget xoá hẳn', async () => {
    let release: ((u: string) => void) | undefined;
    const r = rig({ launch: () => new Promise<string>((res) => (release = res)), responder: () => tokenReply() });
    await r.mgr.register('gw', OAUTH2);
    const first = r.mgr.login('gw');
    // Chờ tới khi `login` thật sự gọi `launch` (trước đây chỉ chờ đúng một nhịp setTimeout(0): lúc máy bận thì `release` còn chưa được gán → "release is not a function").
    for (let i = 0; i < 400 && !release; i++) await new Promise((x) => setTimeout(x, 5));
    expect(release).toBeTypeOf('function');
    await expect(r.mgr.login('gw')).rejects.toThrow(/phiên đăng nhập khác/);
    release!(`${REDIRECT}?error=access_denied`);
    await expect(first).rejects.toThrow(/từ chối/);

    await expect(r.mgr.register('bad', { ...OAUTH2, tokenUrl: 'http://evil.example/token' })).rejects.toThrow(/token/);
    await r.mgr.forget('gw');
    expect(await r.mgr.summary('gw')).toBeUndefined();
  });
});
