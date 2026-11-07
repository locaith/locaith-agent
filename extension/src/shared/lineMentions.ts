/**
 * (lane:ide-context) Nhắc tệp kèm khoảng dòng trong ô nhập: `@src/a.ts#L10-20`, `@src/a.ts#L10`, `@src/a.ts#L10-L20`,
 * và `@problems` (đính kèm chẩn đoán hiện tại của VS Code).
 *
 * Dùng chung cho webview (chip `a.ts:10-20` khi đang gõ, đổi chip tệp thành chip vùng chọn lúc gửi) và host (giải mã tin
 * đến từ Remote/Chrome chỉ có chữ). Không import gì của môi trường.
 */

import type { AttachmentInfo } from './protocol';

export interface LineMention {
  /** Đường dẫn như người dùng gõ (tương đối theo workspace, dấu '/' hoặc '\'). */
  path: string;
  start: number;
  end: number;
  /** Nguyên văn `@…#L…` trong tin nhắn. */
  raw: string;
}

/** Trần số dòng một mention được phép kéo vào (phần dư bị cắt kèm ghi chú). */
export const MAX_MENTION_LINES = 2000;
/** Trần số mention khoảng dòng trong một tin nhắn. */
export const MAX_LINE_MENTIONS = 20;

const LINE_MENTION_RE = /(^|[\s(\[])@([^\s#@"'`<>|]+)#L(\d{1,7})(?:-L?(\d{1,7}))?(?=$|[\s,.;:!?)\]])/gi;
const PROBLEMS_RE = /(^|[\s(\[])@problems(?=$|[\s,.;:!?)\]])/i;

/** Đường dẫn giả của mục `@problems` trong menu `@` (không thể trùng tệp thật: tệp thật không bắt đầu bằng `@`). */
export const PROBLEMS_HIT_PATH = '@problems';

export function hasProblemsMention(text: string): boolean {
  return PROBLEMS_RE.test(text ?? '');
}

export function parseLineMentions(text: string): LineMention[] {
  const out: LineMention[] = [];
  if (!text) return out;
  for (const m of text.matchAll(LINE_MENTION_RE)) {
    if (out.length >= MAX_LINE_MENTIONS) break;
    let start = Number(m[3]);
    let end = m[4] ? Number(m[4]) : start;
    if (end < start) [start, end] = [end, start];
    start = Math.max(1, start);
    end = Math.max(start, end);
    out.push({ path: m[2], start, end, raw: m[0].slice(m[1].length) });
  }
  return out;
}

/** "src/a.ts#L10-2" → { path: 'src/a.ts', frag: '#L10-2' } — để menu `@` tìm theo phần đường dẫn mà vẫn giữ phần dòng. */
export function splitMentionQuery(query: string): { path: string; frag: string } {
  const i = (query ?? '').indexOf('#');
  return i < 0 ? { path: query ?? '', frag: '' } : { path: query.slice(0, i), frag: query.slice(i) };
}

/** Phần `#L…` người dùng đang gõ dở có giữ lại khi chọn tệp không (chỉ nhận dạng `#`, `#L`, `#L12`, `#L12-`, `#L12-30`). */
export function keepableFrag(frag: string): string {
  return /^#(?:L(?:\d{1,7}(?:-L?\d{0,7})?)?)?$/i.test(frag) ? frag : '';
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').normalize('NFC');
  return n(a) === n(b);
}

function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export function lineLabel(path: string, start: number, end: number): string {
  return start === end ? `${baseName(path)}:${start}` : `${baseName(path)}:${start}-${end}`;
}

/**
 * Áp các mention khoảng dòng trong `text` lên danh sách đính kèm:
 *  - chip tệp (`kind: 'file'`) cùng đường dẫn → thành chip vùng chọn `a.ts:10-20` (giữ vị trí);
 *  - `addMissing`: mention chưa có chip nào → thêm chip vùng chọn mới (host dùng cho tin đến từ Remote/Chrome).
 * Không bao giờ nhân đôi một vùng chọn đã có (cùng đường dẫn + khoảng dòng).
 */
export function applyLineMentions(text: string, attachments: readonly AttachmentInfo[], opts: { addMissing?: boolean } = {}): AttachmentInfo[] {
  const mentions = parseLineMentions(text);
  if (mentions.length === 0) return [...attachments];
  const out = [...attachments];
  for (const m of mentions) {
    const exists = out.some((a) => a.kind === 'selection' && a.path && samePath(a.path, m.path) && a.range?.[0] === m.start && a.range?.[1] === m.end);
    if (exists) continue;
    const sel: AttachmentInfo = { kind: 'selection', label: lineLabel(m.path, m.start, m.end), path: m.path, range: [m.start, m.end] };
    const i = out.findIndex((a) => a.kind === 'file' && a.path && samePath(a.path, m.path));
    if (i >= 0) out[i] = { ...sel, path: out[i].path };
    else if (opts.addMissing) out.push(sel);
  }
  return out;
}

/** Chữ ký ngắn của các mention (để giao diện chỉ vẽ lại chip khi phần `#L…` thật sự đổi). */
export function lineMentionSig(text: string): string {
  return parseLineMentions(text)
    .map((m) => `${m.path}#${m.start}-${m.end}`)
    .join('|');
}

/**
 * Khoảng dòng 1-based của một vùng chọn trong editor. Vùng chọn kết thúc ở cột 0 của dòng kế (bôi cả dòng bằng ba lần bấm,
 * hoặc Shift+↓) không thật sự chứa dòng đó → lùi về dòng trước, để chip hiện đúng số dòng đã chọn.
 */
export function selectionLineRange(startLine: number, endLine: number, endCharacter: number): [number, number] {
  const start = startLine + 1;
  let end = endLine + 1;
  if (endCharacter === 0 && endLine > startLine) end = endLine;
  return [start, Math.max(start, end)];
}
