import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/core/engine/types';
import { newSession } from '../src/core/engine/types';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { buildSystemPrompt } from '../src/core/engine/context';
import { MEMORY_BLOCK_MAX, formatMemoryBlock, hasMemory, memoryLine } from '../src/core/engine/memory';
import { memoryIndexPath } from '../src/core/engine/memory';
import { rememberTool } from '../src/core/tools/meta';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locaith-mem-'));
});

function ctxFor(root: string): ToolContext {
  const host = new NodeToolHost({ roots: [root] });
  return {
    signal: new AbortController().signal,
    session: newSession({ id: 's', provider: 'fake', model: 'm' }),
    host,
    callId: 'c1',
    assistantId: 'a1',
    emit: () => undefined,
    progress: () => undefined,
    log: () => undefined,
  };
}

const memFile = (root: string) => path.join(root, '.locaith', 'memory', 'MEMORY.md');
const read = (root: string) => fs.readFileSync(memFile(root), 'utf8');

describe('formatMemoryBlock — ký ức vào system prompt', () => {
  it('chưa có ký ức → không thêm gì (không chiếm ngữ cảnh)', () => {
    expect(formatMemoryBlock(null)).toBeNull();
    expect(formatMemoryBlock({})).toBeNull();
    expect(formatMemoryBlock({ project: { index: '  ', topics: [], where: 'x' } })).toBeNull();
    expect(hasMemory({})).toBe(false);
  });

  it('có chỉ mục dự án → khối <memory> nêu đúng đường dẫn và nội dung', () => {
    const block = formatMemoryBlock({ project: { index: '- [2026-11-07] (user) thích tiếng Việt', topics: [], where: '.locaith/memory/MEMORY.md' } }, 'vi')!;
    expect(block.startsWith('<memory>')).toBe(true);
    expect(block).toContain('.locaith/memory/MEMORY.md');
    expect(block).toContain('thích tiếng Việt');
    expect(block).toContain('remember');
  });

  it('liệt kê tệp chủ đề nhưng KHÔNG nhồi nội dung chúng vào ngữ cảnh', () => {
    const block = formatMemoryBlock({ project: { index: 'a', topics: ['auth.md', 'build.md'], where: 'p' } })!;
    expect(block).toContain('auth.md, build.md');
    expect(block).toContain('read_file');
  });

  it('cả hai phạm vi: dự án và cá nhân, có nhãn phân biệt', () => {
    const block = formatMemoryBlock(
      { project: { index: 'quy ước A', topics: [], where: '.locaith/memory/MEMORY.md' }, user: { index: 'thích ngắn gọn', topics: [], where: '~/.locaith/memory/MEMORY.md' } },
      'en',
    )!;
    expect(block).toMatch(/Project memory/);
    expect(block).toMatch(/Personal memory/);
    expect(block).toContain('quy ước A');
    expect(block).toContain('thích ngắn gọn');
  });

  it('chỉ mục khổng lồ bị cắt, khối không vượt trần', () => {
    const huge = 'x'.repeat(40_000);
    const block = formatMemoryBlock({ project: { index: huge, topics: [], where: 'p' } })!;
    expect(block.length).toBeLessThanOrEqual(MEMORY_BLOCK_MAX);
    expect(block).toContain('đã cắt bớt');
  });

  it('ký ức nằm trong system prompt sau chỉ dẫn dự án (quy ước dự án thắng ghi chú)', () => {
    const host = { workspaceRoots: () => [], extraReadRoots: () => [], platform: { os: 'windows', shell: 'pwsh', shellLabel: 'PowerShell' } } as never;
    const system = buildSystemPrompt({
      host,
      model: 'm',
      providerLabel: 'p',
      mode: 'default',
      language: 'vi',
      projectInstructions: { file: 'LOCAITH.md', text: 'QUY-UOC-DU-AN' },
      memory: '<memory>KY-UC-CA-NHAN</memory>',
    });
    expect(system.indexOf('QUY-UOC-DU-AN')).toBeLessThan(system.indexOf('KY-UC-CA-NHAN'));
  });
});

describe('memoryLine', () => {
  it('một dòng đúng định dạng, có ngày tuyệt đối và loại', () => {
    expect(memoryLine('  Người dùng thích tiếng Việt  ', { date: '2026-11-07', type: 'user' })).toBe('- [2026-11-07] (user) Người dùng thích tiếng Việt');
  });
});

describe('remember — ghi ký ức bền', () => {
  it('tạo tệp + tiêu đề khi chưa có, ghi đúng dòng', async () => {
    const ctx = ctxFor(dir);
    const r = await rememberTool.execute({ text: 'Người dùng muốn commit viết tiếng Việt. Vì sao: cả nhóm đọc tiếng Việt.', type: 'feedback' }, ctx);
    expect(r.isError).toBeUndefined();
    const text = read(dir);
    expect(text).toContain('# Ký ức');
    expect(text).toContain('(feedback) Người dùng muốn commit viết tiếng Việt');
    expect(text).toMatch(/- \[\d{4}-\d{2}-\d{2}\]/);
  });

  it('ghi nối vào tệp có sẵn, không ghi đè ký ức cũ', async () => {
    fs.mkdirSync(path.dirname(memFile(dir)), { recursive: true });
    fs.writeFileSync(memFile(dir), '# Ký ức\n\n- [2026-11-01] (user) ký ức cũ\n', 'utf8');
    await rememberTool.execute({ text: 'ký ức mới' }, ctxFor(dir));
    const text = read(dir);
    expect(text).toContain('ký ức cũ');
    expect(text.indexOf('ký ức cũ')).toBeLessThan(text.indexOf('ký ức mới'));
  });

  it('không ghi lặp cùng một nội dung', async () => {
    const ctx = ctxFor(dir);
    await rememberTool.execute({ text: 'thích bảng biểu' }, ctx);
    const r = await rememberTool.execute({ text: 'thích bảng biểu' }, ctx);
    expect(r.content).toContain('đã có');
    expect(read(dir).split('thích bảng biểu').length - 1).toBe(1);
  });

  it('từ chối khoá API / mật khẩu', async () => {
    const r = await rememberTool.execute({ text: 'API key là sk-abcdefghijklmnopqrstuvwx' }, ctxFor(dir));
    expect(r.isError).toBe(true);
    expect(fs.existsSync(memFile(dir))).toBe(false);
  });

  it('thiếu nội dung → lỗi rõ ràng, không tạo tệp', async () => {
    const r = await rememberTool.execute({ text: '   ' }, ctxFor(dir));
    expect(r.isError).toBe(true);
    expect(fs.existsSync(memFile(dir))).toBe(false);
  });

  it('chưa mở workspace → báo rõ, không ném lỗi', async () => {
    const ctx = ctxFor(dir);
    const host = { ...ctx.host, workspaceRoots: () => [] } as unknown as ToolContext['host'];
    const r = await rememberTool.execute({ text: 'nhớ điều này' }, { ...ctx, host });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('thư mục dự án');
  });

  it('phạm vi cá nhân dùng thư mục home của host', () => {
    const home = path.join(dir, 'home');
    const t = memoryIndexPath({ workspaceRoots: () => [dir], homeDir: home }, 'user')!;
    expect(t.label).toContain('~/.locaith/memory');
    // joinPath dùng `/` (bundle trình duyệt không có node:path); Node và VS Code nhận `/` trên Windows.
    expect(t.abs).toBe(`${home.replace(/\\/g, '/')}/.locaith/memory/MEMORY.md`);
    expect(memoryIndexPath({ workspaceRoots: () => [] }, 'project')).toBeNull();
  });
});
