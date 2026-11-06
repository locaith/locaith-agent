import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient, safeEnv, sanitizeServerConfig, type McpServerConfig } from '../src/core/mcp/client';
import { McpManager, mcpToolName, type McpServerEntry } from '../src/core/mcp/manager';
import { ToolRegistry } from '../src/core/engine/toolRegistry';
import { newSession, type ToolContext } from '../src/core/engine/types';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs');
const stdioCfg = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({ command: process.execPath, args: [FAKE], ...extra });
const hooks = { log: () => {} };

const toClose: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (toClose.length) await toClose.pop()!();
});

function ctx(signal = new AbortController().signal): ToolContext {
  return { signal, session: newSession({ id: 's', provider: 'p', model: 'm' }), host: {} as never, callId: 'c1', assistantId: 'a1', emit: () => {}, progress: () => {}, log: () => {} };
}

describe('safeEnv / sanitizeServerConfig', () => {
  it('bỏ biến môi trường giống bí mật, giữ phần còn lại, cộng biến khai báo rõ', () => {
    const env = safeEnv({ CUSTOM_VAR: 'x' }, { PATH: '/bin', OPENAI_API_KEY: 'sk-1', GITHUB_TOKEN: 't', MY_SECRET: 's', DB_PASSWORD: 'p', HOME: '/h' } as NodeJS.ProcessEnv);
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CUSTOM_VAR: 'x' });
  });

  it('chỉ nhận cấu hình có command hoặc url http(s); lọc kiểu', () => {
    expect(sanitizeServerConfig({ command: 'npx', args: ['-y', 1, 'pkg'], env: { A: 'b', C: 5 } })).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { A: 'b' }, cwd: undefined });
    expect(sanitizeServerConfig({ url: 'https://x.test/mcp', headers: { Authorization: 'Bearer z' } })).toEqual({ url: 'https://x.test/mcp', headers: { Authorization: 'Bearer z' } });
    expect(sanitizeServerConfig({ url: 'file:///etc/passwd' })).toBeNull();
    expect(sanitizeServerConfig({ command: '' })).toBeNull();
    expect(sanitizeServerConfig('npx')).toBeNull();
    expect(sanitizeServerConfig(null)).toBeNull();
  });

  it('tên công cụ MCP hợp lệ và ≤ 64 ký tự (cắt kèm băm khi dài)', () => {
    expect(mcpToolName('my server', 'read file')).toBe('mcp__my_server__read_file');
    const long = mcpToolName('s', 'x'.repeat(100));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(mcpToolName('s', 'x'.repeat(100))).toBe(long);
  });
});

describe('McpClient — stdio', () => {
  it('khởi tạo, liệt kê công cụ có phân trang, gọi công cụ', async () => {
    const c = new McpClient('fake', stdioCfg(), hooks);
    toClose.push(() => c.close());
    await c.start(15_000);
    expect(c.status).toBe('running');
    expect(c.serverInfo).toEqual({ name: 'fake', version: '1.2.3' });
    expect(c.tools.map((t) => t.name)).toEqual(['echo', 'boom', 'slow', 'env', 'crash', 'img']);
    const r = await c.callTool('echo', { text: 'xin chào' });
    expect(r).toEqual({ text: 'echo: xin chào', isError: false, images: [] });
    const b = await c.callTool('boom', {});
    expect(b.isError).toBe(true);
    expect(b.text).toBe('hỏng rồi');
    const img = await c.callTool('img', {});
    expect(img.images).toEqual([{ mediaType: 'image/png', data: 'AAAA' }]);
    expect(img.text).toContain('ảnh đây');
  });

  it('KHÔNG đưa khoá API của tiến trình cha cho server con; biến khai báo rõ thì có', async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-should-not-leak';
    try {
      const c = new McpClient('fake', stdioCfg({ env: { CUSTOM_VAR: 'ok' } }), hooks);
      toClose.push(() => c.close());
      await c.start(15_000);
      expect((await c.callTool('env', {})).text).toBe('key=unset;custom=ok');
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it('Dừng giữa chừng huỷ lệnh gọi; hết giờ báo lỗi rõ', async () => {
    const c = new McpClient('fake', stdioCfg(), hooks);
    toClose.push(() => c.close());
    await c.start(15_000);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    await expect(c.callTool('slow', {}, { signal: ctl.signal })).rejects.toThrow('Đã dừng');
    await expect(c.callTool('slow', {}, { timeoutMs: 150 })).rejects.toThrow(/quá 0 giây|không phản hồi/);
    // client vẫn dùng được sau đó
    expect((await c.callTool('echo', { text: 'vẫn sống' })).text).toBe('echo: vẫn sống');
  });

  it('server thoát giữa chừng: lệnh đang chờ bị từ chối, trạng thái chuyển sang error', async () => {
    const c = new McpClient('fake', stdioCfg(), hooks);
    toClose.push(() => c.close());
    await c.start(15_000);
    await expect(c.callTool('crash', {})).rejects.toThrow(/dừng \(mã 3\)/);
    expect(c.status).toBe('error');
  });

  it('lệnh không tồn tại: start() ném lỗi dễ hiểu, trạng thái error', async () => {
    const c = new McpClient('bad', { command: 'khong-co-lenh-nay-12345' }, hooks);
    await expect(c.start(8_000)).rejects.toThrow();
    expect(c.status).toBe('error');
    expect(c.error).toBeTruthy();
  });
});

describe('McpClient — HTTP', () => {
  it('POST JSON-RPC: phản hồi JSON và SSE, giữ mcp-session-id', async () => {
    const seen: { method: string; sid?: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const m = JSON.parse(body);
        seen.push({ method: m.method, sid: req.headers['mcp-session-id'] as string | undefined });
        if (m.method === 'notifications/initialized') {
          res.writeHead(202).end();
        } else if (m.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'http-fake' } } }));
        } else if (m.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'hi', inputSchema: { type: 'object' } }] } })}\n\n`);
        } else if (m.method === 'tools/call') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `hi ${m.params.arguments.who}` }] } }));
        } else res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    toClose.push(() => new Promise((r) => server.close(() => r(null))));
    const port = (server.address() as { port: number }).port;
    const c = new McpClient('h', { url: `http://127.0.0.1:${port}/mcp` }, hooks);
    toClose.push(() => c.close());
    await c.start(10_000);
    expect(c.tools.map((t) => t.name)).toEqual(['hi']);
    expect((await c.callTool('hi', { who: 'Locaith' })).text).toBe('hi Locaith');
    expect(seen.find((s) => s.method === 'tools/list')?.sid).toBe('sess-1');
  });
});

describe('McpManager', () => {
  function mkManager(initial: string[] = []) {
    let approved = initial;
    return {
      get approved() {
        return approved;
      },
      mgr: new McpManager({ log: () => {}, approvals: { get: () => approved, set: (v) => void (approved = v) } }),
    };
  }
  const entry = (scope: McpServerEntry['scope'], name = 'fake', cfg = stdioCfg()): McpServerEntry => ({ name, cfg, scope });

  it('server của người dùng tự chạy; công cụ đăng ký vào kho và gọi được; Dừng/Tắt gỡ công cụ', async () => {
    const { mgr } = mkManager();
    toClose.push(() => mgr.dispose());
    const reg = new ToolRegistry();
    mgr.attach(reg);
    await mgr.configure([entry('user')]);
    expect(reg.get('mcp__fake__echo')).toBeTruthy();
    expect(reg.get('mcp__fake__echo')!.risk).toBe('exec');
    const res = await reg.get('mcp__fake__echo')!.execute({ text: 'a' }, ctx());
    expect(res.content).toBe('echo: a');
    const need = await reg.get('mcp__fake__echo')!.permission!({ text: 'a' }, ctx());
    expect(need).toMatchObject({ kind: 'other', sessionKey: 'mcp:fake:echo' });
    expect(mgr.status()[0]).toMatchObject({ name: 'fake', status: 'running', approved: true });
    await mgr.disable('fake');
    expect(reg.get('mcp__fake__echo')).toBeUndefined();
  });

  it('server từ workspace/plugin KHÔNG tự chạy; chỉ chạy sau khi bật và nhớ duyệt theo băm cấu hình', async () => {
    const st = mkManager();
    toClose.push(() => st.mgr.dispose());
    const reg = new ToolRegistry();
    st.mgr.attach(reg);
    await st.mgr.configure([entry('workspace')]);
    expect(reg.get('mcp__fake__echo')).toBeUndefined();
    expect(st.mgr.status()[0]).toMatchObject({ status: 'stopped', approved: false });
    await st.mgr.enable('fake');
    expect(reg.get('mcp__fake__echo')).toBeTruthy();
    expect(st.approved).toHaveLength(1);
    // Đổi cấu hình (lệnh khác) → phải duyệt lại, server cũ bị dừng
    await st.mgr.configure([entry('workspace', 'fake', stdioCfg({ args: [FAKE, '--khac'] }))]);
    expect(reg.get('mcp__fake__echo')).toBeUndefined();
    expect(st.mgr.status()[0].approved).toBe(false);
  });

  it('workspace chưa được tin cậy thì không chạy dù đã duyệt', async () => {
    const mgr = new McpManager({ log: () => {}, workspaceTrusted: () => false, approvals: { get: () => ['workspace:fake:x'], set: () => {} } });
    toClose.push(() => mgr.dispose());
    await mgr.configure([entry('workspace')]);
    expect(mgr.status()[0].status).toBe('stopped');
  });

  it('khởi động lỗi: trạng thái error kèm thông điệp, không làm hỏng server khác', async () => {
    const { mgr } = mkManager();
    toClose.push(() => mgr.dispose());
    const reg = new ToolRegistry();
    mgr.attach(reg);
    await mgr.configure([entry('user', 'bad', { command: 'khong-co-lenh-12345' }), entry('user', 'ok')]);
    const st = Object.fromEntries(mgr.status().map((s) => [s.name, s]));
    expect(st.bad.status).toBe('error');
    expect(st.bad.error).toBeTruthy();
    expect(st.ok.status).toBe('running');
    expect(reg.get('mcp__ok__echo')).toBeTruthy();
  });
});
