import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG, catalogEntry, describeServer, localConfig } from '../src/core/mcp/catalog';
import { McpClient } from '../src/core/mcp/client';
import { discover, parseChallenge } from '../src/core/mcp/oauth';
import { OAuthSession, authorize } from '../src/core/mcp/oauthFlow';
import { ConnectorService, type ConnectorDeps } from '../src/host/connectors';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

/** Một máy chủ giả đóng cả hai vai: MCP (HTTP) cần Bearer + máy chủ OAuth có DCR/PKCE. */
async function fakeService(o: { dcr?: boolean; refreshable?: boolean; issuedTtl?: number } = {}) {
  const seen = { dcr: 0, tokens: [] as Record<string, string>[], mcpAuth: [] as string[], auth: [] as URLSearchParams[] };
  let valid = new Set<string>();
  let n = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (code: number, body: unknown, h: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...h });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (u.pathname === '/.well-known/oauth-protected-resource') return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read'] });
      if (u.pathname === '/.well-known/oauth-authorization-server')
        return send(200, { authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, ...(o.dcr === false ? {} : { registration_endpoint: `${origin}/register` }), code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
      if (u.pathname === '/register') {
        seen.dcr++;
        return send(201, { client_id: 'cid-1', token_endpoint_auth_method: 'none' });
      }
      if (u.pathname === '/authorize') {
        seen.auth.push(u.searchParams);
        const back = new URL(u.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'code-1');
        back.searchParams.set('state', u.searchParams.get('state')!);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (u.pathname === '/token') {
        const p = Object.fromEntries(new URLSearchParams(body));
        seen.tokens.push(p);
        if (p.grant_type === 'authorization_code' && p.code !== 'code-1') return send(400, { error: 'invalid_grant' });
        if (p.grant_type === 'refresh_token' && (!o.refreshable || p.refresh_token !== 'refresh-1')) return send(400, { error: 'invalid_grant' });
        const tok = `access-${++n}`;
        valid = new Set([tok]);
        return send(200, { access_token: tok, refresh_token: 'refresh-1', expires_in: o.issuedTtl ?? 3600, token_type: 'Bearer' });
      }
      if (u.pathname === '/mcp') {
        const auth = String(req.headers.authorization ?? '');
        seen.mcpAuth.push(auth);
        if (!valid.has(auth.replace(/^Bearer /, ''))) return send(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
        const m = JSON.parse(body || '{}');
        if (m.method === 'initialize') return send(200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-remote' }, instructions: 'Dùng công cụ ping để thử.' } });
        if (m.method === 'tools/list') return send(200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } });
        if (m.method === 'tools/call') return send(200, { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } });
        return send(202, '');
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r(null)))));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, seen, invalidate: () => (valid = new Set()) };
}

/** Trình duyệt giả: đi theo chuyển hướng /authorize → loopback của extension. */
const browser = async (url: string) => {
  await fetch(url, { redirect: 'follow' });
};

function mkDeps(over: Partial<ConnectorDeps> = {}) {
  const store = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const deps: ConnectorDeps = {
    memento: { get: <T>(k: string, d: T) => (store.has(k) ? (store.get(k) as T) : d), update: (k, v) => void store.set(k, v) },
    secrets: { get: async (n) => secrets.get(n), set: async (n, v) => void secrets.set(n, v), delete: async (n) => void secrets.delete(n) },
    openExternal: browser,
    githubToken: async () => undefined,
    prompt: async () => undefined,
    workspaceFolder: () => 'C:/du-an',
    homedir: 'C:/Users/x',
    log: () => {},
    ...over,
  };
  return { deps, store, secrets };
}

describe('kho kết nối (catalog)', () => {
  it('mỗi mục hợp lệ: id duy nhất, http có url, stdio có lệnh, unsupported kèm lý do', () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CATALOG) {
      expect(e.description.length).toBeGreaterThan(10);
      if (e.transport === 'http') expect(e.url).toMatch(/^https:\/\//);
      else expect(e.command).toBeTruthy();
    }
    expect(CATALOG.filter((e) => e.unsupported).map((e) => e.id).sort()).toEqual(['asana', 'slack', 'square']);
    expect(catalogEntry('github')?.auth).toBe('github'); // GitHub không cho đăng ký ứng dụng tự động
    expect(catalogEntry('bio-memory-locaith')?.own).toBe(true);
  });

  it('server memory của Anthropic được ghi rõ KHÔNG phải Bio-Memory; nhận diện được cấu hình có sẵn', () => {
    expect(catalogEntry('memory')?.description).toContain('KHÔNG phải Bio-Memory');
    expect(describeServer({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] })).toMatchObject({ label: 'Memory (Anthropic)', catalogId: 'memory' });
    expect(describeServer({ command: 'C:/x/bio-agent-os.exe', args: ['serve-mcp'] })).toMatchObject({ label: 'Bio-Memory-Locaith' });
    expect(describeServer({ url: 'https://mcp.notion.com/mcp/' })).toMatchObject({ catalogId: 'notion' });
    expect(describeServer({ command: 'node', args: ['x.js'] })).toEqual({});
  });

  it('localConfig thay ${workspaceFolder}/${HOME}; thiếu workspace thì từ chối; không cấu hình hoá Bio-Memory', () => {
    expect(localConfig(catalogEntry('filesystem')!, 'C:/du-an', 'C:/Users/x')?.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'C:/du-an']);
    expect(localConfig(catalogEntry('filesystem')!, undefined, 'C:/Users/x')).toBeNull();
    expect(localConfig(catalogEntry('memory')!, undefined, 'C:/Users/x')?.env).toEqual({ MEMORY_FILE_PATH: 'C:/Users/x/.locaith/memory/anthropic-memory.jsonl' });
    expect(localConfig(catalogEntry('bio-memory-locaith')!, 'C:/du-an', 'C:/Users/x')).toBeNull();
  });
});

describe('OAuth MCP (RFC 9728 + 8414 + 7591 + PKCE) với máy chủ giả', () => {
  it('parseChallenge đọc resource_metadata và scope', () => {
    expect(parseChallenge('Bearer realm="x", resource_metadata="https://a.test/.well-known/oauth-protected-resource", scope="read write"')).toEqual({ resourceMetadata: 'https://a.test/.well-known/oauth-protected-resource', scope: 'read write' });
    expect(parseChallenge(null)).toEqual({});
  });

  it('discover → đăng ký → PKCE S256 + resource → đổi mã lấy token; sai state bị huỷ', async () => {
    const svc = await fakeService();
    const d = await discover(svc.url);
    expect(d.meta.registration_endpoint).toContain('/register');
    expect(d.resource).toBe(svc.url);
    const st = await authorize({ serverUrl: svc.url, redirectUri: 'http://localhost:1/cb', waitForCode: async (u) => { const p = new URL(u).searchParams; return { code: 'code-1', state: p.get('state')! }; } });
    expect(st.tokens.accessToken).toBe('access-1');
    const tokenReq = svc.seen.tokens[0];
    expect(tokenReq.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenReq.resource).toBe(svc.url);
    expect(svc.seen.dcr).toBe(1);
    await expect(authorize({ serverUrl: svc.url, redirectUri: 'http://localhost:1/cb', waitForCode: async () => ({ code: 'code-1', state: 'khac' }) })).rejects.toThrow(/state/);
    await expect(authorize({ serverUrl: svc.url, redirectUri: 'http://localhost:1/cb', waitForCode: async () => ({ error: 'access_denied' }) })).rejects.toThrow(/từ chối/);
  });

  it('máy chủ không có DCR → lỗi rõ ràng, không đăng nhập mù', async () => {
    const svc = await fakeService({ dcr: false });
    await expect(authorize({ serverUrl: svc.url, redirectUri: 'http://localhost:1/cb', waitForCode: async () => ({}) })).rejects.toThrow(/đăng ký ứng dụng tự động/);
  });

  it('OAuthSession: token sắp hết hạn tự làm mới; 401 làm mới đúng MỘT lần dù nhiều yêu cầu cùng lúc', async () => {
    const svc = await fakeService({ refreshable: true });
    const st = await authorize({ serverUrl: svc.url, redirectUri: 'http://localhost:1/cb', waitForCode: async (u) => ({ code: 'code-1', state: new URL(u).searchParams.get('state')! }) });
    let saved = 0;
    let now = Date.now();
    const sess = new OAuthSession({ ...st, tokens: { ...st.tokens, expiresAt: now + 30_000 } }, () => void saved++, undefined, () => now);
    expect((await sess.headers()).authorization).toBe('Bearer access-2'); // còn < 60 giây → đã làm mới trước khi dùng
    expect(saved).toBe(1);
    const [a, b, c] = await Promise.all([sess.refresh(), sess.refresh(), sess.refresh()]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(svc.seen.tokens.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(2); // 1 lần ở trên + 1 lần dùng chung cho ba yêu cầu
    now += 10;
  });

  it('McpClient + OAuthSession: bị 401 → làm mới token → gửi lại, công cụ gọi được', async () => {
    const svc = await fakeService({ refreshable: true });
    const st = await authorize({ serverUrl: svc.url, redirectUri: 'http://localhost:1/cb', waitForCode: async (u) => ({ code: 'code-1', state: new URL(u).searchParams.get('state')! }) });
    const sess = new OAuthSession(st, () => {});
    const c = new McpClient('r', { url: svc.url }, { log: () => {}, auth: sess });
    cleanup.push(() => c.close());
    await c.start(10_000);
    expect(c.instructions).toBe('Dùng công cụ ping để thử.');
    svc.invalidate(); // token bị thu hồi phía máy chủ
    expect((await c.callTool('ping', {})).text).toBe('pong'); // 401 → refresh → thử lại
    expect(svc.seen.mcpAuth.some((h) => h === 'Bearer access-2')).toBe(true);
  });
});

describe('ConnectorService', () => {
  it('addUrl: dò thấy 401 → OAuth qua cổng loopback THẬT → lưu token vào kho bí mật → entries() có xác thực', async () => {
    const svc = await fakeService();
    const { deps, secrets } = mkDeps();
    const cs = new ConnectorService(deps);
    const r = await cs.addUrl(svc.url, 'Dịch vụ thử');
    expect(r).toMatchObject({ ok: true });
    expect(cs.list()).toHaveLength(1);
    expect(cs.list()[0]).toMatchObject({ name: 'Dịch vụ thử', auth: 'oauth', url: svc.url, custom: true });
    expect(cs.list()[0].id).toMatch(/^custom-[a-z0-9-]+$/);
    expect(cs.list()[0].rev).toMatch(/^\d+$/); // đổi mỗi lần kết nối lại → server khởi động lại với phiên đăng nhập mới
    const raw = secrets.get(`mcp.oauth.${cs.list()[0].id}`)!;
    expect(JSON.parse(raw).tokens.accessToken).toBe('access-1');
    const authz = svc.seen.auth[0];
    expect(authz.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(authz.get('code_challenge_method')).toBe('S256');
    const [e] = await cs.entries();
    expect(e).toMatchObject({ scope: 'connector', label: 'Dịch vụ thử', cfg: { url: svc.url } });
    expect((await e.auth!.headers()).authorization).toBe('Bearer access-1');
    expect(JSON.stringify(cs.list())).not.toContain('access-1'); // token KHÔNG nằm trong danh sách kết nối (chỉ trong SecretStorage)
    expect((await cs.disconnect(cs.list()[0].id)).ok).toBe(true);
    expect(secrets.size).toBe(0);
    expect(cs.list()).toEqual([]);
  });

  it('người dùng từ chối trong trình duyệt → báo lỗi, không lưu gì', async () => {
    const svc = await fakeService();
    const { deps, secrets } = mkDeps({
      openExternal: async (url) => {
        const p = new URL(url).searchParams;
        await fetch(`${p.get('redirect_uri')}?error=access_denied&state=${p.get('state')}`);
      },
    });
    const cs = new ConnectorService(deps);
    const r = await cs.addUrl(svc.url, 'x');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/từ chối/);
    expect(cs.list()).toEqual([]);
    expect(secrets.size).toBe(0);
  });

  it('cổng loopback chỉ nhận GET /callback và tự đóng (không còn lắng nghe sau khi xong)', async () => {
    const svc = await fakeService();
    let redirect = '';
    const { deps } = mkDeps({ openExternal: async (url) => { redirect = new URL(url).searchParams.get('redirect_uri')!; const probe = await fetch(new URL('/khac', redirect)); expect(probe.status).toBe(404); await browser(url); } });
    await new ConnectorService(deps).addUrl(svc.url, 'x');
    await expect(fetch(redirect, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
  });

  it('GitHub: dùng phiên đăng nhập của VS Code; chưa đăng nhập thì thông báo; token PAT lưu vào SecretStorage', async () => {
    let signedIn: string | undefined;
    const { deps, secrets } = mkDeps({ githubToken: async () => signedIn, prompt: async () => 'ghp_dummy_token_value' });
    const cs = new ConnectorService(deps);
    expect((await cs.connect('github')).ok).toBe(false);
    signedIn = 'gho_session_token';
    expect((await cs.connect('github')).ok).toBe(true);
    const [e] = await cs.entries();
    expect(e.cfg.url).toBe('https://api.githubcopilot.com/mcp/');
    expect((await e.auth!.headers()).authorization).toBe('Bearer gho_session_token');
    signedIn = undefined;
    await expect(e.auth!.headers()).rejects.toThrow(/Chưa đăng nhập GitHub/);
    expect((await cs.connectToken('github')).ok).toBe(true);
    expect(secrets.get('mcp.token.github')).toBe('ghp_dummy_token_value');
    const [e2] = await cs.entries();
    expect((await e2.auth!.headers()).authorization).toBe('Bearer ghp_dummy_token_value');
  });

  it('mục không hỗ trợ (Slack) trả lý do; mục cục bộ ghi cấu hình đã thay biến; server mở không cần đăng nhập', async () => {
    const { deps } = mkDeps();
    const cs = new ConnectorService(deps);
    expect((await cs.connect('slack')).message).toContain('không cho đăng ký tự động');
    expect((await cs.connect('filesystem')).ok).toBe(true);
    expect((await cs.connect('context7')).ok).toBe(true);
    const es = await cs.entries();
    expect(es.map((e) => e.name).sort()).toEqual(['context7', 'filesystem']);
    expect(es.find((e) => e.name === 'filesystem')?.cfg.args).toContain('C:/du-an');
    expect(es.find((e) => e.name === 'context7')?.auth).toBeUndefined();
  });

  it('địa chỉ không hợp lệ / http thường bị từ chối; địa chỉ lỗi báo rõ', async () => {
    const { deps } = mkDeps();
    const cs = new ConnectorService(deps);
    expect((await cs.addUrl('không phải url')).ok).toBe(false);
    expect((await cs.addUrl('http://example.com/mcp')).message).toContain('https://');
    expect((await cs.addUrl('http://127.0.0.1:1/mcp')).message).toMatch(/Không kết nối được/);
  });
});
