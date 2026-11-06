import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newSession } from '../src/core/engine/types';
import type { ToolContext, ToolDef, ToolResult } from '../src/core/engine/types';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { editFileTool, globTool, grepTool, listDirTool, readFileTool, writeFileTool } from '../src/core/tools/fs';
import { createTerminalTool } from '../src/core/tools/terminal';

/** Thư mục dự án thật của người dùng Việt hay có dấu cách và chữ có dấu: "Dự án Locaith AI/Báo giá/…". */
function vietnameseWorkspace(): { dir: string; ctx: ToolContext; host: NodeToolHost } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Dự án Locaith AI – '));
  fs.mkdirSync(path.join(dir, 'Báo giá', 'Khách hàng Đặng Thị Hồng'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Báo giá', 'Khách hàng Đặng Thị Hồng', 'Hợp đồng ướ ữ ặ.md'), '# Hợp đồng\nGiá: 15.000.000 ₫ (chưa bao gồm VAT 10%)\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'Tài liệu kiến trúc.md'), 'Vòng lặp đơn\n', 'utf8');
  const host = new NodeToolHost({ roots: [dir] });
  const session = newSession({ id: 's', provider: 'p', model: 'm' });
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    session,
    host,
    callId: 'c',
    assistantId: 'a',
    emit: () => undefined,
    progress: () => undefined,
    log: () => undefined,
  };
  return { dir, ctx, host };
}

async function run<I>(tool: ToolDef<I>, input: I, ctx: ToolContext): Promise<ToolResult> {
  const sem = await tool.validate?.(input, ctx);
  if (sem) return { content: sem, isError: true };
  return tool.execute(input, ctx);
}

describe('đường dẫn và tên tệp tiếng Việt có dấu cách', () => {
  it('list_dir, glob, grep, read_file, edit_file, write_file đều làm việc với tên có dấu', async () => {
    const { ctx, dir } = vietnameseWorkspace();
    const ls = await run(listDirTool, { depth: 3 }, ctx);
    expect(ls.content).toContain('Báo giá/');
    expect(ls.content).toContain('Khách hàng Đặng Thị Hồng/');
    expect(ls.content).toContain('Hợp đồng ướ ữ ặ.md');

    const g = await run(globTool, { pattern: '**/*.md' }, ctx);
    expect(g.content.split('\n')).toEqual(expect.arrayContaining(['Báo giá/Khách hàng Đặng Thị Hồng/Hợp đồng ướ ữ ặ.md', 'Tài liệu kiến trúc.md']));

    const gr = await run(grepTool, { pattern: 'VAT 10%' }, ctx);
    expect(gr.content).toContain('Hợp đồng ướ ữ ặ.md:2');

    const rel = 'Báo giá/Khách hàng Đặng Thị Hồng/Hợp đồng ướ ữ ặ.md';
    const rd = await run(readFileTool, { path: rel }, ctx);
    expect(rd.content).toContain('15.000.000 ₫');
    const ed = await run(editFileTool, { path: rel, old_string: '15.000.000', new_string: '18.500.000' }, ctx);
    expect(ed.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, rel), 'utf8')).toContain('18.500.000 ₫');

    const w = await run(writeFileTool, { path: 'Báo giá/Bản nháp mới.md', content: 'Nội dung: ướ ữ ặ ổ ệ\n' }, ctx);
    expect(w.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'Báo giá', 'Bản nháp mới.md'), 'utf8')).toBe('Nội dung: ướ ữ ặ ổ ệ\n');
  });

  it('tên tệp/thư mục ở dạng NFD (macOS/Zalo/Drive) vẫn đọc, sửa, ghi được khi mô hình viết dạng NFC', async () => {
    const { ctx, dir } = vietnameseWorkspace();
    // NTFS coi NFC và NFD là hai tên KHÁC nhau; tệp tải từ Zalo/Drive/macOS thường lưu NFD, model thì luôn viết NFC.
    const nfdDir = 'Thư mục Việt'.normalize('NFD');
    const nfdFile = 'Báo giá khách.md'.normalize('NFD');
    fs.mkdirSync(path.join(dir, nfdDir));
    fs.writeFileSync(path.join(dir, nfdDir, nfdFile), 'nội dung gốc\n', 'utf8');
    expect(nfdDir).not.toBe(nfdDir.normalize('NFC'));

    const rel = `${'Thư mục Việt'.normalize('NFC')}/${'Báo giá khách.md'.normalize('NFC')}`;
    const rd = await run(readFileTool, { path: rel }, ctx);
    expect(rd.isError).toBeFalsy();
    expect(rd.content).toContain('nội dung gốc');

    const ed = await run(editFileTool, { path: rel, old_string: 'nội dung gốc', new_string: 'nội dung mới' }, ctx);
    expect(ed.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, nfdDir, nfdFile), 'utf8')).toContain('nội dung mới');

    // Tạo tệp mới trong thư mục NFD bằng đường dẫn NFC: phải ghi vào thư mục có sẵn, không đẻ ra thư mục trùng tên.
    const w = await run(writeFileTool, { path: `${'Thư mục Việt'.normalize('NFC')}/Ghi chú.md`, content: 'x' }, ctx);
    expect(w.isError).toBeFalsy();
    expect(fs.existsSync(path.join(dir, nfdDir, 'Ghi chú.md'))).toBe(true);
    const dirs = fs.readdirSync(dir).filter((n) => n.normalize('NFC') === 'Thư mục Việt');
    expect(dirs).toHaveLength(1);
  });

  it('khác biệt hoa/thường trong tên thư mục được bỏ qua trên Windows', async () => {
    if (process.platform !== 'win32') return;
    const { ctx } = vietnameseWorkspace();
    const r = await run(readFileTool, { path: 'TÀI LIỆU KIẾN TRÚC.MD' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Vòng lặp đơn');
  });

  it('run_command chạy trong thư mục có tiếng Việt/dấu cách và in ra tên tệp đúng dấu', async () => {
    const { ctx, host } = vietnameseWorkspace();
    const tool = createTerminalTool(host);
    const r = await run(tool, { command: `node -e "console.log(require('fs').readdirSync('.').join('|'))"`, cwd: '.' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Báo giá');
    expect(r.content).toContain('Tài liệu kiến trúc.md');
    const sub = await run(tool, { command: `node -e "console.log(process.cwd())"`, cwd: 'Báo giá/Khách hàng Đặng Thị Hồng' }, ctx);
    expect(sub.content).toContain('Khách hàng Đặng Thị Hồng');
  }, 40_000);
});
