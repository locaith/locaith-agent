import { strToU8, zipSync } from 'fflate';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withPluginRoot } from '../src/core/plugins/loader';
import { MARKER, clearZipCache, extractSubdir, fetchMarketplace, githubRepo, installPlugin, installedByMarket, parseMarketplace, parseSource, uninstallPlugin, type MarketplaceEntry } from '../src/core/plugins/marketplace';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nd-pm-'));
const closers: Array<() => unknown> = [];
afterEach(() => {
  clearZipCache();
  while (closers.length) closers.pop()!();
});

const MARKETPLACE = {
  name: 'claude-plugins-official',
  plugins: [
    { name: 'inrepo', description: 'Trong repo marketplace', category: 'development', source: './plugins/inrepo' },
    { name: 'sub', description: 'Thư mục con ở repo khác', category: 'productivity', source: { source: 'git-subdir', url: 'https://github.com/acme/tools.git', path: 'packages/sub', ref: 'v1' } },
    { name: 'whole', description: 'Cả repo', category: 'database', source: { source: 'url', url: 'https://github.com/acme/whole.git' } },
    { name: 'gl', description: 'Ngoài GitHub', source: { source: 'url', url: 'https://gitlab.com/acme/x.git' } },
    { name: 'evil', description: 'đường dẫn thoát', source: '../../etc' },
    { name: 'inrepo', description: 'trùng tên', source: './plugins/other' },
    { description: 'thiếu tên', source: './x' },
  ],
};

/** zip kiểu GitHub: mọi tệp nằm dưới thư mục gốc "<repo>-<ref>/". */
const ghZip = (root: string, files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${root}/${k}`, strToU8(v)])));

async function codeload(zips: Record<string, Uint8Array>) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    const z = zips[req.url ?? ''];
    if (!z) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(z.length) });
    res.end(Buffer.from(z));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

describe('đọc marketplace.json', () => {
  it('nhận 3 kiểu nguồn của Claude Code; bỏ mục sai (thiếu tên, đường dẫn thoát, trùng tên)', () => {
    const p = parseMarketplace(MARKETPLACE);
    expect(p.entries.map((e) => e.id)).toEqual(['inrepo', 'sub', 'whole', 'gl']);
    expect(p.skipped).toBe(3);
    expect(p.entries[0].source).toEqual({ kind: 'repo-path', path: 'plugins/inrepo' });
    expect(p.entries[1].source).toEqual({ kind: 'github', owner: 'acme', repo: 'tools', ref: 'v1', subdir: 'packages/sub' });
    expect(p.entries[2].source).toMatchObject({ kind: 'github', owner: 'acme', repo: 'whole' });
    expect(p.entries[3].source).toEqual({ kind: 'other', url: 'https://gitlab.com/acme/x.git' });
  });

  it('githubRepo / parseSource chặt chẽ: chỉ GitHub, sha hợp lệ thắng ref, đường dẫn thoát bị bỏ', () => {
    expect(githubRepo('https://github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(githubRepo('o/r')).toEqual({ owner: 'o', repo: 'r' });
    expect(githubRepo('https://gitlab.com/o/r')).toBeNull();
    expect(parseSource({ source: 'github', repo: 'o/r', sha: 'abcdef1234567', ref: 'main', path: 'a/b' })).toEqual({ kind: 'github', owner: 'o', repo: 'r', ref: 'abcdef1234567', subdir: 'a/b' });
    expect(parseSource({ source: 'github', repo: 'o/r', path: '../x' })).toMatchObject({ subdir: undefined });
    expect(parseSource('/abs')).toEqual({ kind: 'repo-path', path: 'abs' });
    expect(parseSource({})).toBeNull();
  });

  it('fetchMarketplace báo lỗi rõ khi HTTP lỗi hoặc danh sách rỗng', async () => {
    const f404 = (async () => new Response('', { status: 404 })) as typeof fetch;
    await expect(fetchMarketplace(f404)).rejects.toThrow(/HTTP 404/);
    const empty = (async () => new Response('{"plugins":[]}')) as typeof fetch;
    await expect(fetchMarketplace(empty)).rejects.toThrow(/rỗng/);
  });
});

describe('giải nén và cài plugin', () => {
  it('chỉ giải nén đúng thư mục con; chặn ../ và bỏ .git', async () => {
    const dest = tmp();
    const zip = zipSync({ 'r-main/a/skills/x/SKILL.md': strToU8('x'), 'r-main/a/.git/config': strToU8('g'), 'r-main/b/other.txt': strToU8('o'), 'r-main/a/../../escape.txt': strToU8('e') });
    const n = await extractSubdir(zip, 'a', dest);
    expect(n).toBe(1);
    expect(fs.existsSync(path.join(dest, 'skills/x/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'other.txt'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(dest), 'escape.txt'))).toBe(false);
    await expect(extractSubdir(zip, 'khong-co', tmp())).rejects.toThrow(/Không thấy thư mục/);
  });

  it('cài plugin trong repo marketplace: tải zip, giải nén thư mục con, ghi dấu, nhận ra skills + MCP + phần không hỗ trợ', async () => {
    const cl = await codeload({
      '/anthropics/claude-plugins-official/zip/main': ghZip('claude-plugins-official-main', {
        'plugins/inrepo/.claude-plugin/plugin.json': JSON.stringify({ name: 'inrepo', version: '1.0.0', description: 'Thử', hooks: './hooks/hooks.json' }),
        'plugins/inrepo/skills/hello/SKILL.md': '---\nname: hello\ndescription: Chào\n---\nxin chào',
        'plugins/inrepo/.mcp.json': JSON.stringify({ mcpServers: { db: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } } }),
        'plugins/inrepo/hooks/hooks.json': '{}',
        'plugins/other/x.md': 'x',
      }),
    });
    const root = tmp();
    const e = parseMarketplace(MARKETPLACE).entries[0];
    const r = await installPlugin(e, { userRoot: root, codeloadBase: cl.base });
    expect(r.ok, r.message).toBe(true);
    expect(r.unsupported).toEqual(['hooks']);
    expect(r.message).toContain('Plugin đang TẮT');
    expect(r.message).toContain('không chạy hooks');
    const dir = path.join(root, 'inrepo');
    expect(JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'))).toMatchObject({ name: 'inrepo', source: 'anthropics/claude-plugins-official/plugins/inrepo' });
    expect(fs.existsSync(path.join(dir, 'plugins'))).toBe(false); // đã bỏ tiền tố thư mục con
    expect(r.plugin?.skillDirs).toEqual([path.join(dir, 'skills')]);
    // biến ${CLAUDE_PLUGIN_ROOT} được thay bằng thư mục plugin
    expect(Object.values(r.plugin!.mcpServers)[0].args).toEqual([`${dir}/server.js`]);
    expect([...(await installedByMarket(root))]).toEqual(['inrepo']);
  });

  it('git-subdir ở repo khác (có ref), cài lại là cập nhật, bộ nhớ đệm tránh tải lại', async () => {
    const cl = await codeload({ '/acme/tools/zip/v1': ghZip('tools-v1', { 'packages/sub/commands/hi.md': '---\ndescription: chào\n---\nXin chào $ARGUMENTS' }) });
    const root = tmp();
    const e = parseMarketplace(MARKETPLACE).entries[1];
    expect((await installPlugin(e, { userRoot: root, codeloadBase: cl.base })).ok).toBe(true);
    expect((await installPlugin(e, { userRoot: root, codeloadBase: cl.base })).ok).toBe(true);
    expect(cl.hits).toEqual(['/acme/tools/zip/v1']); // lần hai dùng bộ nhớ đệm
    expect(fs.readFileSync(path.join(root, 'sub/commands/hi.md'), 'utf8')).toContain('Xin chào');
  });

  it('không ghi đè thư mục của người dùng; nguồn ngoài GitHub bị từ chối kèm hướng dẫn; zip hỏng/thiếu thư mục báo lỗi và dọn sạch', async () => {
    const cl = await codeload({ '/acme/whole/zip/HEAD': ghZip('whole-main', { 'README.md': 'không có gì dùng được' }) });
    const root = tmp();
    fs.mkdirSync(path.join(root, 'whole'));
    fs.writeFileSync(path.join(root, 'whole/mine.txt'), 'của tôi');
    const entries = parseMarketplace(MARKETPLACE).entries;
    const blocked = await installPlugin(entries[2], { userRoot: root, codeloadBase: cl.base });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain('không do chợ cài');
    expect(fs.readFileSync(path.join(root, 'whole/mine.txt'), 'utf8')).toBe('của tôi');
    const gl = await installPlugin(entries[3], { userRoot: root });
    expect(gl.message).toContain('gitlab.com');
    const root2 = tmp();
    const empty = await installPlugin(entries[2], { userRoot: root2, codeloadBase: cl.base });
    expect(empty.ok).toBe(false);
    expect(empty.message).toContain('không có kỹ năng');
    expect(fs.readdirSync(root2)).toEqual([]); // không để lại thư mục tạm
    const missing = await installPlugin({ ...entries[0], source: { kind: 'github', owner: 'no', repo: 'where' } }, { userRoot: root2, codeloadBase: cl.base });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('HTTP 404');
  });

  it('gỡ chỉ xoá thư mục do chợ cài', async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'mine'));
    expect((await uninstallPlugin('mine', root)).ok).toBe(false);
    expect(fs.existsSync(path.join(root, 'mine'))).toBe(true);
    fs.mkdirSync(path.join(root, 'ours'));
    fs.writeFileSync(path.join(root, 'ours', MARKER), JSON.stringify({ name: 'ours' }));
    expect((await uninstallPlugin('ours', root)).ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'ours'))).toBe(false);
  });

  it('withPluginRoot thay biến ở lệnh/đối số/môi trường/cwd', () => {
    expect(withPluginRoot({ command: '${CLAUDE_PLUGIN_ROOT}/run', args: ['--cfg', '${LOCAITH_PLUGIN_ROOT}/c.json'], env: { A: '${CLAUDE_PLUGIN_ROOT}' }, cwd: '${CLAUDE_PLUGIN_ROOT}' }, '/p')).toEqual({ command: '/p/run', args: ['--cfg', '/p/c.json'], env: { A: '/p' }, cwd: '/p' });
  });
});

describe('ánh xạ dữ liệu thật', () => {
  it('MarketplaceEntry có đủ trường để giao diện hiển thị', () => {
    const e: MarketplaceEntry = parseMarketplace(MARKETPLACE).entries[0];
    expect(e).toMatchObject({ id: 'inrepo', category: 'development', description: 'Trong repo marketplace' });
  });
});
