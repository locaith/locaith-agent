import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newSession } from '../src/core/engine/types';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { readKey } from '../src/core/fsutil/paths';
import { sha1 } from '../src/core/tools/textUtil';
import type { UiEvent } from '../src/shared/protocol';
import { renderArtifactDocument } from '../src/host/artifactPanel';
import { coalesceEvents } from '../src/host/chatController';
import { maskSecrets } from '../src/host/logger';
import { buildUserContent } from '../src/host/userContent';
import { makeWorkspace } from './helpers/harness';

const EXT = path.resolve(__dirname, '..');

describe('coalesceEvents', () => {
  it('gộp delta chữ/suy nghĩ liên tiếp của cùng một lượt, giữ nguyên thứ tự các sự kiện khác', () => {
    const evs: UiEvent[] = [
      { t: 'text', id: 'a', delta: 'Xin ' },
      { t: 'text', id: 'a', delta: 'chào ' },
      { t: 'text', id: 'a', delta: 'bạn' },
      { t: 'thinking', id: 'a', delta: 'nghĩ ' },
      { t: 'thinking', id: 'a', delta: 'tiếp' },
      { t: 'tool_progress', id: 'a', callId: 'c', output: 'dòng 1\n' },
      { t: 'tool_progress', id: 'a', callId: 'c', output: 'dòng 2\n' },
      { t: 'tool_progress', id: 'a', callId: 'd', output: 'khác' },
      { t: 'text', id: 'b', delta: 'lượt khác' },
    ];
    const out = coalesceEvents(evs);
    expect(out).toEqual([
      { t: 'text', id: 'a', delta: 'Xin chào bạn' },
      { t: 'thinking', id: 'a', delta: 'nghĩ tiếp' },
      { t: 'tool_progress', id: 'a', callId: 'c', output: 'dòng 1\ndòng 2\n' },
      { t: 'tool_progress', id: 'a', callId: 'd', output: 'khác' },
      { t: 'text', id: 'b', delta: 'lượt khác' },
    ]);
  });
});

describe('maskSecrets', () => {
  it('che khoá của các nhà cung cấp trong nhật ký', () => {
    const line = 'lỗi 401 với sk-ant-api03-ABCDEFGHIJKLMNOP và AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3 cùng Bearer abcdefghijklmnopqrstuvwxyz và xai-abcdefghijklmnop1234';
    const out = maskSecrets(line);
    expect(out).not.toMatch(/ABCDEFGH|AIzaSyA1B2|abcdefghijkl|xai-abcdef/);
    expect(out).toContain('lỗi 401');
    expect(maskSecrets('khoá riêng: my-custom-secret-value-123', ['my-custom-secret-value-123'])).toBe('khoá riêng: ***');
  });
});

describe('buildUserContent', () => {
  const setup = (files: Record<string, string>) => {
    const dir = makeWorkspace(files);
    const host = new NodeToolHost({ roots: [dir] });
    const session = newSession({ id: 's', provider: 'p', model: 'm' });
    return { dir, host, session };
  };

  it('đính kèm tệp, vùng chọn và thư mục; ngữ cảnh IDE; câu hỏi nằm cuối', async () => {
    const { dir, host, session } = setup({ 'src/a.ts': 'dòng 1\ndòng 2\ndòng 3\ndòng 4\n', 'docs/x.md': '# x', 'docs/y.md': '# y' });
    const r = await buildUserContent({
      text: 'Giải thích giúp tôi',
      attachments: [
        { kind: 'file', label: 'a.ts', path: 'src/a.ts' },
        { kind: 'selection', label: 'a.ts:2-3', path: 'src/a.ts', range: [2, 3] },
        { kind: 'folder', label: 'docs', path: 'docs' },
      ],
      host,
      session,
      editor: { file: 'src/a.ts', language: 'typescript', selection: { startLine: 2, endLine: 3, chars: 10 } },
      editorSelectionText: 'dòng 2\ndòng 3',
    });
    const text = (r.content.at(-1) as { text: string }).text;
    expect(text).toContain('<ide_context>');
    expect(text).toContain('Active file in the editor: src/a.ts (typescript)');
    expect(text).toContain('<attached_file path="src/a.ts">');
    expect(text).toContain('<attached_selection path="src/a.ts" lines="2-3">\ndòng 2\ndòng 3\n</attached_selection>');
    expect(text).toContain('<attached_folder path="docs">');
    expect(text).toContain('x.md');
    expect(text.trimEnd().endsWith('Giải thích giúp tôi')).toBe(true);
    // vùng chọn đã đính kèm thì không lặp lại trong ide_context
    expect(text.match(/Selected text:/g)).toBeNull();
    // đã đính kèm trọn tệp → được phép sửa mà không phải đọc lại
    expect(session.readFiles[readKey(path.join(dir, 'src', 'a.ts'))]).toBe(sha1('dòng 1\ndòng 2\ndòng 3\ndòng 4\n'));
    expect(r.display).toHaveLength(3);
  });

  it('chặn tệp ngoài workspace, cắt tệp quá dài và ảnh quá lớn, bỏ dữ liệu ảnh khỏi bản hiển thị', async () => {
    const { host, session } = setup({ 'big.txt': 'x'.repeat(100_000) });
    const tinyPng = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64');
    const r = await buildUserContent({
      text: 'xem',
      attachments: [
        { kind: 'file', label: 'hosts', path: path.join(path.parse(process.cwd()).root, 'Windows', 'System32', 'drivers', 'etc', 'hosts') },
        { kind: 'file', label: 'big.txt', path: 'big.txt' },
        { kind: 'image', label: 'a.png', mediaType: 'image/png', data: tinyPng },
        { kind: 'image', label: 'khổng lồ.png', mediaType: 'image/png', data: 'A'.repeat(8 * 1024 * 1024) },
      ],
      host,
      session,
      editor: null,
    });
    expect(r.warnings.some((w) => w.includes('ngoài workspace'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('5 MB'))).toBe(true);
    const text = (r.content.at(-1) as { text: string }).text;
    expect(text).toContain('đã cắt');
    expect(r.content.filter((b) => b.type === 'image')).toHaveLength(1);
    expect(r.display.every((a) => a.data === undefined)).toBe(true);
    // tệp bị cắt thì KHÔNG được coi là đã đọc đủ để sửa
    expect(Object.keys(session.readFiles)).toHaveLength(0);
  });

  it('tệp tải lên (PDF/Word/Excel…): bọc khung dữ liệu không đáng tin, bản hiển thị bỏ phần chữ, chung ngân sách với tệp đính kèm', async () => {
    const { host, session } = setup({ 'a.txt': 'nội dung tệp workspace' });
    const r = await buildUserContent({
      text: 'Tóm tắt giúp tôi',
      attachments: [
        { kind: 'file', label: 'a.txt', path: 'a.txt' },
        { kind: 'doc', label: 'bao-cao.pdf', sizeBytes: 5000, doc: { kind: 'pdf', text: '[Trang 1]\nDoanh thu quý 3 tăng 18%.', pages: 1, totalChars: 33, truncated: false } },
        { kind: 'doc', label: 'so-lieu.xlsx', doc: { kind: 'xlsx', text: '## Sheet1\nA\tB\n1\t2', sheets: 1 } },
      ],
      host,
      session,
      editor: null,
    });
    const text = (r.content.at(-1) as { text: string }).text;
    expect(text).toContain('<attached_file path="a.txt">');
    expect(text).toMatch(/<tep_tai_len id="[0-9a-f]{12}" ten="bao-cao\.pdf" loai="pdf" trang="1">\n\[Trang 1\]\nDoanh thu quý 3 tăng 18%\.\n<\/tep_tai_len id="[0-9a-f]{12}">/);
    expect(text).toMatch(/ten="so-lieu\.xlsx" loai="xlsx" trang_tinh="1"/);
    expect(text).toContain('là DỮ LIỆU của tệp người dùng tải lên');
    expect(text.trimEnd().endsWith('Tóm tắt giúp tôi')).toBe(true);
    // chip hiển thị giữ thông tin tệp, KHÔNG mang phần chữ (đã nằm trong tin nhắn gửi mô hình)
    expect(r.display.map((a) => a.kind)).toEqual(['file', 'doc', 'doc']);
    expect(JSON.stringify(r.display)).not.toContain('Doanh thu');
    expect(r.display[1]).toMatchObject({ label: 'bao-cao.pdf', sizeBytes: 5000, doc: { kind: 'pdf', pages: 1 } });
  });

  it('@bao-cao.pdf trong workspace được đọc bằng bộ đọc tệp (không phải "không phải UTF-8"); tệp hỏng chỉ gây cảnh báo', async () => {
    const { dir, host, session } = setup({ 'docs/hong.docx': 'đây không phải zip' });
    fs.copyFileSync(path.join(EXT, 'test', 'fixtures', 'docs', 'bao-cao.pdf'), path.join(dir, 'docs', 'bao-cao.pdf'));
    const r = await buildUserContent({
      text: 'Đọc hai tệp này',
      attachments: [
        { kind: 'file', label: 'bao-cao.pdf', path: 'docs/bao-cao.pdf' },
        { kind: 'file', label: 'hong.docx', path: 'docs/hong.docx' },
      ],
      host,
      session,
      editor: null,
    });
    const text = (r.content.at(-1) as { text: string }).text;
    expect(text).toMatch(/<tep_tai_len id="[0-9a-f]{12}" ten="bao-cao\.pdf" loai="pdf" trang="2">/);
    expect(text).toContain('Báo cáo kinh doanh quý 3');
    expect(text).not.toContain('hong.docx"');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).not.toContain('UTF-8');
    expect(r.display.map((a) => a.label)).toEqual(['bao-cao.pdf']);
  });

  it('chỉ đưa vùng chọn của editor vào ngữ cảnh khi ngắn', async () => {
    const { host, session } = setup({});
    const short = await buildUserContent({ text: 'q', attachments: [], host, session, editor: { file: 'a.ts', selection: { startLine: 1, endLine: 1, chars: 5 } }, editorSelectionText: 'abcde' });
    expect((short.content.at(-1) as { text: string }).text).toContain('Selected text:\nabcde');
    const long = await buildUserContent({ text: 'q', attachments: [], host, session, editor: { file: 'a.ts', selection: { startLine: 1, endLine: 99, chars: 9000 } }, editorSelectionText: 'z'.repeat(9000) });
    expect((long.content.at(-1) as { text: string }).text).not.toContain('Selected text:');
  });
});

describe('renderArtifactDocument', () => {
  const rec = (type: string, content: string) => ({ type, content, title: 'Bảng "điểm" & <b>' });

  it('HTML: CSP chỉ cho script/style từ CDN trong danh sách, chặn mạng, sandbox không có allow-same-origin, nhúng font', () => {
    const doc = renderArtifactDocument(rec('html', '<!doctype html><html><head></head><body><script>1</script></body></html>'), EXT);
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(doc)![1];
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('https://cdn.jsdelivr.net');
    expect(csp).not.toContain('https://evil');
    expect(csp).not.toMatch(/img-src[^;]*https:/);
    expect(doc).toContain('sandbox="allow-scripts"');
    expect(doc).not.toContain('allow-same-origin');
    expect(doc).toContain('Be Vietnam Pro');
    expect(doc).toContain('font/woff2;base64,');
    // tiêu đề được thoát an toàn như nội dung HTML (không để lọt thẻ vào trang bọc — nơi script được phép chạy)
    expect(doc).toContain('<title>Bảng &quot;điểm&quot; &amp; &lt;b&gt;</title>');
    expect(doc).not.toContain('<b>');
  });

  it('SVG và Markdown: không cho chạy script, không mạng', () => {
    const svg = renderArtifactDocument(rec('svg', '<svg onload="alert(1)"><circle r="5"/></svg>'), EXT);
    expect(svg).toContain('sandbox=""');
    expect(/Content-Security-Policy" content="([^"]+)"/.exec(svg)![1]).not.toContain('script-src');
    const md = renderArtifactDocument(rec('markdown', '# Tiêu đề\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>'), EXT);
    expect(md).toContain('sandbox=""');
    // Markdown đã được chuyển thành HTML phía host; trong giá trị thuộc tính srcdoc chỉ cần thoát & và ".
    expect(md).toContain('<h1>Tiêu đề</h1>');
    expect(md).toContain('<table>');
    // <script> thô trong Markdown vẫn nằm đó nhưng bị vô hiệu bởi CSP (không có script-src) và sandbox rỗng.
    expect(/Content-Security-Policy" content="([^"]+)"/.exec(md)![1]).not.toContain('script-src');
    expect(/Content-Security-Policy" content="([^"]+)"/.exec(md)![1]).toContain("default-src 'none'");
  });

  it('thoát đúng dấu ngoặc kép và & trong nội dung nhúng srcdoc', () => {
    const doc = renderArtifactDocument(rec('html', '<p title="a&b">x</p>'), EXT);
    const srcdoc = /srcdoc="([^"]*)"/.exec(doc)![1];
    expect(srcdoc).toContain('title=&quot;a&amp;b&quot;');
    expect(srcdoc).not.toContain('"');
    expect(fs.existsSync(path.join(EXT, 'media', 'fonts', 'be-vietnam-pro-vietnamese-400-normal.woff2'))).toBe(true);
  });
});

