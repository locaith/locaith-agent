/**
 * Công cụ tệp: read_file, list_dir, glob, grep, edit_file, write_file.
 *
 * Quy tắc an toàn:
 *  - Đường dẫn do model đưa ra luôn được chuẩn hoá và phân vùng; ngoài workspace hoặc tệp chứa bí mật → hỏi.
 *  - Sửa/ghi đè tệp có sẵn đòi phải đọc trước và chặn nếu tệp đã đổi kể từ lúc đọc (không sửa mù, không ghi đè mất dữ liệu).
 *  - Ghi vào nơi có thể dẫn tới thực thi mã ngầm (.git, .vscode/tasks.json, workflow CI, rc shell) → luôn hỏi.
 */

import * as path from 'node:path';
import type { ImageBlock } from '../types';
import { DEFAULT_IGNORE_DIRS } from '../fsutil/walk';
import {
  isSecretFile,
  isSensitiveWritePath,
  normalizeForCompare,
  readKey,
  resolveUserPathReal,
  type ResolvedPath,
} from '../fsutil/paths';
import { NotUtf8Error, type PermissionNeed, type SessionState, type ToolContext, type ToolDef } from '../engine/types';
import { clip, detectEol, makeDiff, numberLines, sha1, withEol } from './textUtil';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Dùng chung
// ─────────────────────────────────────────────────────────────────────────────

/** Đường dẫn thật khác đường dẫn đã gõ — so sánh không phân biệt hoa/thường trên Windows (`c:\x` và `C:\x` là một). */
function differsFromReal(r: ResolvedPath): boolean {
  return normalizeForCompare(r.real) !== normalizeForCompare(r.abs);
}

/** Cho người duyệt thấy đường dẫn THẬT khi nó khác với đường dẫn model gõ (liên kết, tên ngắn, dạng đáng ngờ). */
export function describePath(r: ResolvedPath): string {
  if (r.suspicious) return `${r.abs} (dạng đường dẫn đáng ngờ — luồng dữ liệu thay thế hoặc dấu chấm cuối)`;
  return differsFromReal(r) ? `${r.abs} → đường dẫn thật: ${r.real}` : r.abs;
}

function readPermission(r: ResolvedPath): PermissionNeed | null {
  if (r.zone === 'outside') {
    return {
      kind: 'outside_workspace',
      title: `Đọc tệp ngoài workspace?`,
      detail: describePath(r),
      elevated: true,
    };
  }
  // Kiểm tra cả tên người dùng gõ LẪN đường dẫn thật: symlink/tên ngắn 8.3 có thể trỏ tới .env mà tên bề ngoài vô hại.
  if (isSecretFile(r.abs) || isSecretFile(r.real)) {
    return {
      kind: 'other',
      title: `Tệp này có thể chứa khoá hoặc mật khẩu — gửi nội dung cho nhà cung cấp AI?`,
      detail: describePath(r),
      elevated: true,
    };
  }
  return null;
}

/** Ghi vào vùng nhạy cảm (ngoài workspace, .git, kịch bản build…) hoặc tệp chứa bí mật → luôn hỏi, kể cả khi tự nhận chỉnh sửa. */
function writeIsElevated(r: ResolvedPath): boolean {
  return (
    r.zone !== 'workspace' ||
    isSensitiveWritePath(r.abs) ||
    isSensitiveWritePath(r.real) ||
    isSecretFile(r.abs) ||
    isSecretFile(r.real)
  );
}

function notUtf8Message(rel: string): string {
  return (
    `"${rel}" không phải UTF-8 (có thể là Windows-1258, TCVN3 hoặc UTF-16). Để không làm mất chữ có dấu, công cụ này từ chối đọc/sửa/ghi tệp đó. ` +
    'Hãy chuyển sang UTF-8 bằng run_command (ví dụ PowerShell: Get-Content -Encoding Default tệp | Set-Content -Encoding utf8 tệp.moi) rồi làm việc trên bản mới, hoặc nhờ người dùng chuyển mã.'
  );
}

/** Đọc tệp để sửa/ghi đè; tệp không phải UTF-8 thì từ chối thay vì giải mã lossy rồi ghi lại (mất chữ vĩnh viễn). */
async function readTextForWrite(ctx: ToolContext, r: ResolvedPath): Promise<string | null> {
  try {
    return await ctx.host.readText(r.abs);
  } catch (e) {
    if (e instanceof NotUtf8Error) throw new Error(notUtf8Message(r.rel));
    throw e;
  }
}

async function similarFiles(ctx: ToolContext, wanted: string): Promise<string[]> {
  const base = path.basename(wanted);
  const root = ctx.host.workspaceRoots()[0];
  if (!root || !base) return [];
  try {
    return await ctx.host.glob({ pattern: `**/${base}`, cwd: root, limit: 5, signal: ctx.signal });
  } catch {
    return [];
  }
}

// Khoá theo dạng chuẩn hoá (không phân biệt hoa/thường trên Windows): `C:\ws\a.ts` và `c:\ws\a.ts` là cùng một tệp,
// đọc bằng cách viết này rồi sửa bằng cách viết kia không được bị báo "hãy đọc trước khi sửa".
function rememberRead(session: SessionState, abs: string, text: string): void {
  session.readFiles[readKey(abs)] = sha1(text);
}

function requireFreshRead(session: SessionState, abs: string, rel: string, current: string): void {
  const h = session.readFiles[readKey(abs)];
  if (!h) throw new Error(`Hãy đọc "${rel}" bằng read_file trước khi sửa (để chắc chắn bạn đang sửa đúng nội dung hiện tại).`);
  if (h !== sha1(current)) {
    throw new Error(`"${rel}" đã thay đổi kể từ lần đọc gần nhất (có thể do người dùng hoặc công cụ khác sửa). Hãy read_file lại rồi sửa.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// read_file
// ─────────────────────────────────────────────────────────────────────────────

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export const readFileTool: ToolDef<ReadInput> = {
  name: 'read_file',
  description:
    'Read a text file (or an image) from the workspace. Returns the content with line numbers (the numbers are NOT part of the file). ' +
    'Use offset (1-based line) and limit for large files. Always read a file before editing it. ' +
    'Relative paths resolve against the first workspace folder.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to workspace root, or absolute).' },
      offset: { type: 'integer', minimum: 1, description: 'First line to read (1-based). Default 1.' },
      limit: { type: 'integer', minimum: 1, maximum: 5000, description: `Max lines to return. Default ${DEFAULT_READ_LINES}.` },
    },
    required: ['path'],
  },
  risk: 'read',
  concurrencySafe: true,
  async permission(input, ctx) {
    return readPermission(await resolveUserPathReal(ctx.host, input.path));
  },
  async execute(input, ctx) {
    const r = await resolveUserPathReal(ctx.host, input.path);
    const st = await ctx.host.stat(r.abs);
    if (!st) {
      const sim = await similarFiles(ctx, input.path);
      return {
        content: `Không tìm thấy tệp: ${input.path}` + (sim.length ? `\nCó thể bạn muốn: ${sim.join(', ')}` : ''),
        isError: true,
      };
    }
    if (st.isDirectory) return { content: `"${r.rel}" là thư mục. Dùng list_dir để xem nội dung.`, isError: true };
    if (st.size > MAX_FILE_BYTES) {
      return { content: `Tệp quá lớn (${(st.size / 1048576).toFixed(1)} MB). Dùng grep hoặc run_command để xử lý từng phần.`, isError: true };
    }

    const ext = path.extname(r.abs).toLowerCase();
    if (IMAGE_TYPES[ext]) {
      if (st.size > MAX_IMAGE_BYTES) return { content: 'Ảnh lớn hơn 5 MB, không đọc được.', isError: true };
      const bytes = await ctx.host.readBytes(r.abs);
      const img: ImageBlock = { type: 'image', mediaType: IMAGE_TYPES[ext], data: Buffer.from(bytes).toString('base64') };
      return { content: `Ảnh ${r.rel} (${Math.round(st.size / 1024)} KB) được đính kèm bên dưới.`, images: [img], summary: r.rel };
    }
    if (['.pdf', '.docx', '.xlsx', '.pptx', '.zip', '.exe', '.dll', '.bin'].includes(ext)) {
      return { content: `Định dạng ${ext} không đọc trực tiếp được. Có thể chuyển sang văn bản bằng run_command (ví dụ pdftotext, pandoc) nếu máy đã cài.`, isError: true };
    }

    let text: string | null;
    try {
      text = await ctx.host.readText(r.abs);
    } catch (e) {
      if (e instanceof NotUtf8Error) return { content: notUtf8Message(r.rel), isError: true };
      throw e;
    }
    if (text === null) return { content: `Không đọc được tệp: ${r.rel}`, isError: true };
    if (text.includes('\u0000')) return { content: `"${r.rel}" là tệp nhị phân (${Math.round(st.size / 1024)} KB).`, isError: true };

    rememberRead(ctx.session, r.abs, text);
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const start = Math.max(1, input.offset ?? 1);
    const limit = input.limit ?? DEFAULT_READ_LINES;
    if (total === 0) return { content: `${r.rel}: tệp rỗng.`, summary: '0 dòng' };
    if (start > total) return { content: `"${r.rel}" chỉ có ${total} dòng; offset ${start} vượt quá.`, isError: true };
    const slice = lines.slice(start - 1, start - 1 + limit).map((l) => (l.length > 2000 ? l.slice(0, 2000) + ' …[đã cắt]' : l));
    const end = start + slice.length - 1;
    let out = `${r.rel} (${total} dòng${start > 1 || end < total ? `, hiển thị ${start}–${end}` : ''})\n${numberLines(slice, start)}`;
    if (end < total) out += `\n\n[Còn ${total - end} dòng. Gọi lại với offset=${end + 1} để đọc tiếp.]`;
    return { content: out, summary: `${total} dòng`, display: out.slice(0, 2500) };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// list_dir
// ─────────────────────────────────────────────────────────────────────────────

interface ListInput {
  path?: string;
  depth?: number;
}

export const listDirTool: ToolDef<ListInput> = {
  name: 'list_dir',
  description:
    'List files and folders of a directory (default: workspace root). depth 1–4 expands subfolders. ' +
    'Heavy folders such as node_modules, .git, dist are collapsed.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory (relative or absolute). Default: workspace root.' },
      depth: { type: 'integer', minimum: 1, maximum: 4, description: 'How many levels to expand. Default 1.' },
    },
  },
  risk: 'read',
  concurrencySafe: true,
  async permission(input, ctx) {
    const r = await resolveUserPathReal(ctx.host, input.path ?? '.');
    return r.zone === 'outside' ? { kind: 'outside_workspace', title: 'Liệt kê thư mục ngoài workspace?', detail: describePath(r), elevated: true } : null;
  },
  async execute(input, ctx) {
    const r = await resolveUserPathReal(ctx.host, input.path ?? '.');
    const st = await ctx.host.stat(r.abs);
    if (!st) return { content: `Không tìm thấy thư mục: ${input.path ?? '.'}`, isError: true };
    if (!st.isDirectory) return { content: `"${r.rel}" là tệp, không phải thư mục.`, isError: true };

    const maxDepth = Math.min(4, Math.max(1, input.depth ?? 1));
    const lines: string[] = [];
    let count = 0;
    const CAP = 400;

    async function rec(dir: string, depth: number, indent: string): Promise<void> {
      let entries;
      try {
        entries = await ctx.host.readDir(dir);
      } catch {
        return;
      }
      entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name, 'vi') : a.isDirectory ? -1 : 1));
      for (const e of entries) {
        if (count >= CAP) return;
        count++;
        if (e.isDirectory) {
          if (DEFAULT_IGNORE_DIRS.has(e.name)) {
            lines.push(`${indent}${e.name}/ (đã ẩn)`);
            continue;
          }
          lines.push(`${indent}${e.name}/`);
          if (depth < maxDepth) await rec(path.join(dir, e.name), depth + 1, indent + '  ');
        } else {
          lines.push(`${indent}${e.name}`);
        }
      }
    }
    await rec(r.abs, 1, '');
    const head = `${r.rel === '.' ? '(thư mục gốc)' : r.rel}/`;
    const body = lines.length ? lines.join('\n') : '(trống)';
    const more = count >= CAP ? `\n[… đã cắt ở ${CAP} mục. Chỉ định path cụ thể hơn.]` : '';
    return { content: `${head}\n${body}${more}`, summary: `${count} mục` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// glob
// ─────────────────────────────────────────────────────────────────────────────

interface GlobInput {
  pattern: string;
  path?: string;
}

export const globTool: ToolDef<GlobInput> = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts", "**/*.md"). Respects .gitignore and skips node_modules/.git. Returns paths relative to the search root.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.test.ts".' },
      path: { type: 'string', description: 'Directory to search in. Default: workspace root.' },
    },
    required: ['pattern'],
  },
  risk: 'read',
  concurrencySafe: true,
  async permission(input, ctx) {
    const r = await resolveUserPathReal(ctx.host, input.path ?? '.');
    return r.zone === 'outside' ? { kind: 'outside_workspace', title: 'Tìm tệp ngoài workspace?', detail: describePath(r), elevated: true } : null;
  },
  async execute(input, ctx) {
    const r = await resolveUserPathReal(ctx.host, input.path ?? '.');
    const LIMIT = 200;
    const found = await ctx.host.glob({ pattern: input.pattern, cwd: r.abs, limit: LIMIT + 1, signal: ctx.signal });
    if (found.length === 0) return { content: `Không có tệp nào khớp "${input.pattern}".`, summary: '0 tệp' };
    const shown = found.slice(0, LIMIT);
    const more = found.length > LIMIT ? `\n[… còn nữa, hãy thu hẹp mẫu tìm kiếm.]` : '';
    return { content: shown.join('\n') + more, summary: `${shown.length}${found.length > LIMIT ? '+' : ''} tệp` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// grep
// ─────────────────────────────────────────────────────────────────────────────

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  context?: number;
  output_mode?: 'content' | 'files' | 'count';
  limit?: number;
}

export const grepTool: ToolDef<GrepInput> = {
  name: 'grep',
  description:
    'Search file contents with a regular expression (JavaScript syntax). Returns matching lines as "path:line: text". ' +
    'Filter files with `glob` (e.g. "*.ts"). output_mode: content (default), files (only paths), count.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Directory to search. Default: workspace root.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.tsx" or "src/**/*.ts".' },
      case_insensitive: { type: 'boolean' },
      context: { type: 'integer', minimum: 0, maximum: 5, description: 'Lines of context around each match.' },
      output_mode: { type: 'string', enum: ['content', 'files', 'count'] },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max matches. Default 100.' },
    },
    required: ['pattern'],
  },
  risk: 'read',
  concurrencySafe: true,
  async permission(input, ctx) {
    const r = await resolveUserPathReal(ctx.host, input.path ?? '.');
    return r.zone === 'outside' ? { kind: 'outside_workspace', title: 'Tìm trong thư mục ngoài workspace?', detail: describePath(r), elevated: true } : null;
  },
  async execute(input, ctx) {
    const r = await resolveUserPathReal(ctx.host, input.path ?? '.');
    const limit = input.limit ?? 100;
    const res = await ctx.host.grep({
      pattern: input.pattern,
      cwd: r.abs,
      glob: input.glob,
      ignoreCase: input.case_insensitive ?? false,
      context: input.context ?? 0,
      limit,
      signal: ctx.signal,
    });
    const mode = input.output_mode ?? 'content';
    const notes: string[] = [];
    if (res.regexTimedOut) {
      notes.push('[Biểu thức chính quy chạy quá lâu nên tìm kiếm đã bị dừng — hãy đơn giản hoá mẫu (tránh lồng nhóm lặp như (a+)+ hoặc .* nhiều lần).]');
    }
    if (res.skippedSecret) {
      notes.push(`[Đã bỏ qua ${res.skippedSecret} tệp có thể chứa khoá/mật khẩu (.env, khoá riêng…). Muốn đọc phải dùng read_file — người dùng sẽ được hỏi.]`);
    }
    const tail = notes.length ? '\n' + notes.join('\n') : '';
    if (res.hits.length === 0) {
      return { content: `Không có kết quả cho /${input.pattern}/ (đã quét ${res.filesScanned} tệp).${tail}`, summary: res.regexTimedOut ? 'hết giờ' : '0 kết quả' };
    }

    if (mode === 'files') {
      const files = [...new Set(res.hits.map((h) => h.path))];
      return { content: files.join('\n') + (res.truncated ? '\n[… đã cắt]' : '') + tail, summary: `${files.length} tệp` };
    }
    if (mode === 'count') {
      const counts = new Map<string, number>();
      for (const h of res.hits) counts.set(h.path, (counts.get(h.path) ?? 0) + 1);
      const body = [...counts.entries()].map(([p, n]) => `${p}: ${n}`).join('\n');
      return { content: body + (res.truncated ? '\n[… đã cắt]' : '') + tail, summary: `${res.hits.length} kết quả` };
    }
    const out: string[] = [];
    for (const h of res.hits) {
      h.before?.forEach((l, i) => out.push(`${h.path}-${h.line - h.before!.length + i}- ${l}`));
      out.push(`${h.path}:${h.line}: ${h.text}`);
      h.after?.forEach((l, i) => out.push(`${h.path}-${h.line + 1 + i}- ${l}`));
      if (input.context) out.push('--');
    }
    const note = res.truncated && !res.regexTimedOut ? `\n[… đã dừng ở ${limit} kết quả; thu hẹp bằng glob hoặc path.]` : '';
    return { content: out.join('\n') + note + tail, summary: `${res.hits.length} kết quả` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// edit_file
// ─────────────────────────────────────────────────────────────────────────────

interface EditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface Prepared {
  r: ResolvedPath;
  before: string;
  after: string;
  count: number;
  firstLine: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Tìm mọi vị trí khớp: chính xác trước, nếu không có thì nới lỏng khoảng trắng cuối dòng và kiểu xuống dòng. */
function findSpans(text: string, oldStr: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let from = 0;
  while (true) {
    const i = text.indexOf(oldStr, from);
    if (i < 0) break;
    spans.push({ start: i, end: i + oldStr.length });
    from = i + Math.max(1, oldStr.length);
  }
  if (spans.length > 0) return spans;

  const lines = oldStr.replace(/\r\n/g, '\n').split('\n');
  const pattern = lines.map(escapeRe).join('[ \\t]*\\r?\\n');
  const re = new RegExp(pattern + '[ \\t]*', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return spans;
}

async function prepareEdit(input: EditInput, ctx: ToolContext): Promise<Prepared> {
  if (input.old_string === input.new_string) throw new Error('old_string và new_string giống hệt nhau — không có gì để sửa.');
  if (input.old_string === '') throw new Error('old_string rỗng. Để tạo tệp mới hãy dùng write_file.');
  const r = await resolveUserPathReal(ctx.host, input.path);
  const text = await readTextForWrite(ctx, r);
  if (text === null) throw new Error(`Tệp không tồn tại: ${r.rel}. Dùng write_file để tạo tệp mới.`);
  requireFreshRead(ctx.session, r.abs, r.rel, text);

  const eol = detectEol(text);
  const oldStr = withEol(input.old_string, eol);
  const newStr = withEol(input.new_string, eol);
  const spans = findSpans(text, oldStr);

  if (spans.length === 0) {
    const probe = input.old_string.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 8).sort((a, b) => b.length - a.length)[0];
    let hint = '';
    if (probe) {
      const where: number[] = [];
      text.split(/\r?\n/).forEach((l, i) => {
        if (l.includes(probe) && where.length < 3) where.push(i + 1);
      });
      if (where.length) hint = ` Dòng "${clip(probe, 60)}" có ở dòng ${where.join(', ')} nhưng cả đoạn không khớp — kiểm tra thụt lề/khoảng trắng bằng read_file.`;
    }
    throw new Error(`Không tìm thấy old_string trong ${r.rel}.${hint} Phải khớp chính xác từng ký tự (không kèm số dòng).`);
  }
  if (spans.length > 1 && !input.replace_all) {
    const lines = spans.slice(0, 5).map((s) => lineOf(text, s.start));
    throw new Error(`old_string xuất hiện ${spans.length} lần (dòng ${lines.join(', ')}${spans.length > 5 ? '…' : ''}). Thêm ngữ cảnh xung quanh để duy nhất, hoặc đặt replace_all=true.`);
  }

  const use = input.replace_all ? spans : [spans[0]];
  let after = '';
  let cursor = 0;
  for (const s of use) {
    after += text.slice(cursor, s.start) + newStr;
    cursor = s.end;
  }
  after += text.slice(cursor);
  return { r, before: text, after, count: use.length, firstLine: lineOf(text, use[0].start) };
}

function editPermission(p: Prepared): PermissionNeed {
  return {
    kind: 'edit',
    title: `Sửa ${p.r.rel}?`,
    detail: differsFromReal(p.r) || p.r.suspicious ? describePath(p.r) : undefined,
    diff: makeDiff(p.r.rel, p.before, p.after),
    sessionKey: 'edit',
    sessionLabel: 'Cho phép mọi chỉnh sửa tệp trong phiên này',
    elevated: writeIsElevated(p.r),
  };
}

export const editFileTool: ToolDef<EditInput> = {
  name: 'edit_file',
  description:
    'Replace an exact string in an existing file. old_string must match the file EXACTLY (whitespace included, without line numbers) and be unique, ' +
    'unless replace_all is true. Read the file first. Prefer this over rewriting whole files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text (must differ from old_string).' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  risk: 'write',
  concurrencySafe: false,
  streamsContent: true,
  contentField: 'new_string',
  async validate(input, ctx) {
    try {
      await prepareEdit(input, ctx);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },
  async permission(input, ctx) {
    const p = await prepareEdit(input, ctx);
    ctx.host.recordFileChange?.(ctx.callId, { abs: p.r.abs, rel: p.r.rel, before: p.before, after: p.after });
    return editPermission(p);
  },
  async execute(input, ctx) {
    const p = await prepareEdit(input, ctx);
    ctx.host.recordFileChange?.(ctx.callId, { abs: p.r.abs, rel: p.r.rel, before: p.before, after: p.after });
    await ctx.host.writeText(p.r.abs, p.after);
    rememberRead(ctx.session, p.r.abs, p.after);
    const diff = makeDiff(p.r.rel, p.before, p.after);
    const afterLines = p.after.split(/\r?\n/);
    const from = Math.max(1, p.firstLine - 2);
    const snippet = numberLines(afterLines.slice(from - 1, from - 1 + 12), from);
    return {
      content: `Đã sửa ${p.r.rel} (${p.count} chỗ, +${diff.added} −${diff.removed}). Vùng sau khi sửa:\n${snippet}`,
      summary: `+${diff.added} −${diff.removed}`,
      display: `Đã sửa ${p.r.rel}`,
      diff,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// write_file
// ─────────────────────────────────────────────────────────────────────────────

interface WriteInput {
  path: string;
  content: string;
}

interface PreparedWrite {
  r: ResolvedPath;
  before: string | null;
  after: string;
}

async function prepareWrite(input: WriteInput, ctx: ToolContext): Promise<PreparedWrite> {
  const r = await resolveUserPathReal(ctx.host, input.path);
  const st = await ctx.host.stat(r.abs);
  if (st?.isDirectory) throw new Error(`"${r.rel}" là thư mục.`);
  let before: string | null = null;
  if (st) {
    before = await readTextForWrite(ctx, r);
    if (before === null) throw new Error(`Không đọc được tệp hiện có: ${r.rel}`);
    requireFreshRead(ctx.session, r.abs, r.rel, before);
  }
  const after = before !== null ? withEol(input.content, detectEol(before)) : input.content;
  return { r, before, after };
}

export const writeFileTool: ToolDef<WriteInput> = {
  name: 'write_file',
  description:
    'Create a new file, or completely overwrite an existing one (read it first). Parent folders are created automatically. ' +
    'For small changes to an existing file use edit_file instead. Write complete content — never placeholders like "... rest of file".',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string', description: 'Full file content (UTF-8).' },
    },
    required: ['path', 'content'],
  },
  risk: 'write',
  concurrencySafe: false,
  streamsContent: true,
  contentField: 'content',
  async validate(input, ctx) {
    try {
      await prepareWrite(input, ctx);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },
  async permission(input, ctx) {
    const p = await prepareWrite(input, ctx);
    const isNew = p.before === null;
    ctx.host.recordFileChange?.(ctx.callId, { abs: p.r.abs, rel: p.r.rel, before: p.before, after: p.after });
    return {
      kind: isNew ? 'create' : 'edit',
      title: `${isNew ? 'Tạo' : 'Ghi đè'} ${p.r.rel}?`,
      detail: differsFromReal(p.r) || p.r.suspicious ? describePath(p.r) : undefined,
      diff: makeDiff(p.r.rel, p.before ?? '', p.after, isNew),
      sessionKey: 'edit',
      sessionLabel: 'Cho phép mọi chỉnh sửa tệp trong phiên này',
      elevated: writeIsElevated(p.r),
    };
  },
  async execute(input, ctx) {
    const p = await prepareWrite(input, ctx);
    ctx.host.recordFileChange?.(ctx.callId, { abs: p.r.abs, rel: p.r.rel, before: p.before, after: p.after });
    await ctx.host.writeText(p.r.abs, p.after);
    rememberRead(ctx.session, p.r.abs, p.after);
    const diff = makeDiff(p.r.rel, p.before ?? '', p.after, p.before === null);
    const lines = p.after.split('\n').length;
    return {
      content: `${p.before === null ? 'Đã tạo' : 'Đã ghi đè'} ${p.r.rel} (${lines} dòng).`,
      summary: p.before === null ? `${lines} dòng` : `+${diff.added} −${diff.removed}`,
      diff,
    };
  },
};
