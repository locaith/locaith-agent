import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { expandEnv, mcpFeature, mcpServiceOf, mcpStateFile } from '../../../src/cli/runtime/features/mcp';
import type { ToolDef } from '../../../src/core/engine/types';
import { FakeFeatureContext, mkTmp, rmTmp, writeFile } from './helpers';

const SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.cjs', import.meta.url));
let ctx: FakeFeatureContext;
const extra: string[] = [];

afterEach(async () => {
  await ctx?.dispose();
  ctx?.cleanup();
  for (const d of extra.splice(0)) rmTmp(d);
});

const serverCfg = (env: Record<string, string> = {}) => ({ command: process.execPath, args: [SERVER], env });
const toolCtx = () => ({ signal: new AbortController().signal }) as never;
const toolNames = () => ctx.contributedTools().map((t) => t.name).sort();
const find = (name: string): ToolDef => {
  const t = ctx.contributedTools().find((x) => x.name === name);
  if (!t) throw new Error(`thiếu công cụ ${name}: ${toolNames().join(',')}`);
  return t;
};

async function boot(over: ConstructorParameters<typeof FakeFeatureContext>[0] = {}, files: Record<string, unknown> = {}) {
  ctx = new FakeFeatureContext(over);
  for (const [rel, val] of Object.entries(files)) writeFile(rel.startsWith('~') ? path.join(ctx.home, rel.slice(2)) : path.join(ctx.cwd, rel), JSON.stringify(val));
  await ctx.attach(mcpFeature);
  await mcpServiceOf(ctx)!.ready();
}

describe('MCP', () => {
  it('server stdio giả: công cụ xuất hiện, gọi được, chỉ dẫn vào prompt, status không chặn', async () => {
    await boot({}, { '~/.locaith/mcp.json': { mcpServers: { fake: serverCfg({ FAKE_TOKEN: 'abc' }) } } });
    expect(toolNames()).toEqual(['mcp__fake__get_echo', 'mcp__fake__write_thing']);
    const r = await find('mcp__fake__get_echo').execute({ text: 'xin chào' }, toolCtx());
    expect(r.content).toBe('get_echo:xin chào:abc');
    expect(ctx.promptText()).toContain('Dùng echo để lặp lại chữ.');
    expect(ctx.promptText()).toContain('bên thứ ba');
    const list = await ctx.runSlash('mcp');
    expect(list).toContain('fake');
    expect(list).toContain('2 công cụ');
    const detail = await ctx.runSlash('mcp', 'fake');
    expect(detail).toContain('get_echo');
    expect(detail).toContain('[read/ask]');
    expect(ctx.slashNamed('mcp').needsIdle).toBe(false);
  });

  it('bị tắt thì công cụ biến mất và không gọi được; bật lại thì có lại (bền qua nạp lại)', async () => {
    await boot({}, { '~/.locaith/mcp.json': { fake: serverCfg() } });
    expect(toolNames()).toHaveLength(2);
    const held = find('mcp__fake__get_echo'); // người giữ tham chiếu cũ cũng không gọi được nữa
    await ctx.runSlash('mcp', 'disable fake');
    expect(toolNames()).toEqual([]);
    expect(await ctx.runSlash('mcp')).toContain('đã tắt');
    const r = await held.execute({ text: 'x' }, toolCtx());
    expect(r.isError).toBe(true);
    expect(JSON.parse(fs.readFileSync(mcpStateFile(ctx.home), 'utf8')).disabled).toEqual(['fake']);
    await mcpServiceOf(ctx)!.reload(); // nạp lại cấu hình: vẫn tắt
    expect(toolNames()).toEqual([]);
    await ctx.runSlash('mcp', 'enable fake');
    expect(toolNames()).toHaveLength(2);
    expect((await find('mcp__fake__get_echo').execute({ text: 'lại' }, toolCtx())).content).toContain('lại');
  });

  it('quyền theo công cụ: deny → trả lỗi, không gọi server; group read allow → chạy không hỏi', async () => {
    await boot({}, { '~/.locaith/mcp.json': { fake: serverCfg() } });
    expect(find('mcp__fake__get_echo').risk).toBe('exec'); // mặc định hỏi
    await ctx.runSlash('mcp', 'tool fake get_echo deny');
    const denied = await find('mcp__fake__get_echo').execute({ text: 'x' }, toolCtx());
    expect(denied.isError).toBe(true);
    expect(denied.content).toMatch(/tắt công cụ/);
    await ctx.runSlash('mcp', 'tool fake get_echo ask');
    await ctx.runSlash('mcp', 'group fake read allow');
    const read = find('mcp__fake__get_echo');
    expect(read.risk).toBe('read');
    expect(read.permission).toBeUndefined();
    expect(find('mcp__fake__write_thing').risk).toBe('exec'); // nhóm ghi vẫn hỏi
    expect(await ctx.runSlash('mcp', 'tool fake x maybe')).toMatch(/allow, ask hoặc deny/);
  });

  it('server của DỰ ÁN chưa duyệt không chạy khi không tương tác', async () => {
    const mark = path.join(os.tmpdir(), `mcp-mark-${Date.now()}.log`);
    await boot({ interactive: false }, { '.mcp.json': { mcpServers: { proj: serverCfg({ MARK_FILE: mark }) } } });
    expect(toolNames()).toEqual([]);
    expect(fs.existsSync(mark)).toBe(false);
    expect(ctx.asks).toHaveLength(0);
    expect(await ctx.runSlash('mcp')).toMatch(/chờ duyệt/);
  });

  it('thư mục chưa tin cậy: không đọc .mcp.json của dự án, không hỏi', async () => {
    const mark = path.join(os.tmpdir(), `mcp-mark2-${Date.now()}.log`);
    await boot({ trusted: false }, { '.mcp.json': { mcpServers: { proj: serverCfg({ MARK_FILE: mark }) } } });
    expect(toolNames()).toEqual([]);
    expect(fs.existsSync(mark)).toBe(false);
    expect(ctx.asks).toHaveLength(0);
  });

  it('server dự án: người dùng duyệt từng server → chạy + nhớ; từ chối → không chạy và không hỏi lại khi nạp lại', async () => {
    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { proj: serverCfg(), other: serverCfg() } }));
    ctx.askFn = (req) => (req.kind === 'confirm' && req.title.includes('«proj»') ? true : false);
    await ctx.attach(mcpFeature);
    const svc = mcpServiceOf(ctx)!;
    await svc.ready();
    expect(ctx.asks).toHaveLength(2);
    const ask = ctx.asks.find((a) => a.title.includes('proj')) as { detail?: string; danger?: boolean };
    expect(ask.detail).toContain('.mcp.json');
    expect(ask.detail).toContain(SERVER); // thấy đúng lệnh sẽ chạy
    expect(ask.danger).toBe(true);
    expect(toolNames().filter((n) => n.startsWith('mcp__proj__'))).toHaveLength(2);
    expect(toolNames().some((n) => n.startsWith('mcp__other__'))).toBe(false);
    await svc.reload();
    expect(ctx.asks).toHaveLength(2); // đã duyệt / đã từ chối thì không hỏi lại
    const st = JSON.parse(fs.readFileSync(mcpStateFile(ctx.home), 'utf8'));
    expect(st.approved).toHaveLength(1);
    expect(st.declined).toHaveLength(1);
  });

  // (0.7.6) Hộp duyệt từng cắt dòng lệnh ở 200 ký tự không báo (đuôi bị giấu) và không hiện cwd/env dù chúng nằm trong dấu vân tay được duyệt.
  it('hộp duyệt server dự án cho thấy ĐỦ lệnh (đuôi không bị cắt), đối số có dấu cách được bọc nháy, và cwd + env (giá trị bí mật bị che)', async () => {
    ctx = new FakeFeatureContext();
    const longArgs = Array.from({ length: 40 }, (_, i) => `--tuy-chon-${i}=gia-tri-kha-dai`);
    writeFile(
      path.join(ctx.cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { doc: { command: process.execPath, args: [SERVER, ...longArgs, 'đối số có dấu cách', '--phan-duoi-nguy-hiem'], cwd: '..', env: { NODE_OPTIONS: '--require x.js', API_TOKEN: 'bi-mat-that' } } } }),
    );
    ctx.askFn = () => false;
    await ctx.attach(mcpFeature);
    await mcpServiceOf(ctx)!.ready();
    const ask = ctx.asks[0] as { detail?: string };
    expect(ask.detail).toBeDefined();
    expect(ask.detail!.length).toBeGreaterThan(900);
    expect(ask.detail).toContain('--phan-duoi-nguy-hiem');
    expect(ask.detail).toContain('"đối số có dấu cách"');
    expect(ask.detail).toContain('cwd: ..');
    expect(ask.detail).toContain('NODE_OPTIONS="--require x.js"');
    expect(ask.detail).toContain('API_TOKEN=•••');
    expect(ask.detail).not.toContain('bi-mat-that');
  });

  it('lược đồ Claude: ${VAR} mở rộng; --mcp-config là tệp hoặc JSON trực tiếp', async () => {
    expect(expandEnv('${A_B}/x/${C:-mac_dinh}', { A_B: 'v' } as never)).toBe('v/x/mac_dinh');
    expect(expandEnv('${KHONG_CO}', {} as never)).toBe('${KHONG_CO}');
    process.env.FAKE_MCP_TOK = 'bien-moi-truong';
    try {
      const dir = mkTmp('mcp-cfg-');
      extra.push(dir);
      const file = path.join(dir, 'extra.json');
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { viafile: { command: process.execPath, args: [SERVER], env: { FAKE_TOKEN: '${FAKE_MCP_TOK}' } } } }));
      const inline = JSON.stringify({ mcpServers: { inline: serverCfg() } });
      ctx = new FakeFeatureContext({ user: { cli: { mcpConfig: [file, inline] } } });
      await ctx.attach(mcpFeature);
      await mcpServiceOf(ctx)!.ready();
      expect(toolNames()).toEqual(expect.arrayContaining(['mcp__viafile__get_echo', 'mcp__inline__get_echo']));
      expect((await find('mcp__viafile__get_echo').execute({ text: 'x' }, toolCtx())).content).toBe('get_echo:x:bien-moi-truong');
    } finally {
      delete process.env.FAKE_MCP_TOK;
    }
  });

  it('prompt của server thành lệnh gạch chéo nguồn mcp và chạy qua runPrompt', async () => {
    await boot({}, { '~/.locaith/mcp.json': { fake: serverCfg() } });
    await mcpServiceOf(ctx)!.refreshPrompts();
    const defs = ctx.slashSources.get('mcp') ?? [];
    expect(defs.map((d) => d.name)).toEqual(['mcp__fake__greet']);
    expect(defs[0].argHint).toBe('<who>');
    await ctx.runSlash('mcp__fake__greet', 'Tuấn');
    expect(ctx.prompts).toEqual([{ text: 'Xin chào Tuấn', model: undefined }]);
  });

  it('cấu hình hỏng / thiếu thì không làm sập; tắt hết khi đóng', async () => {
    await boot({}, { '~/.locaith/mcp.json': { bad: { command: 123 }, good: serverCfg() } });
    expect(toolNames()).toHaveLength(2);
    const svc = mcpServiceOf(ctx)!;
    await ctx.dispose();
    expect(svc.mgr.status().every((s) => s.status !== 'running')).toBe(true);
  });
});
