/**
 * (lane:ide-context) Giải mã nhắc tệp kèm khoảng dòng (`@src/a.ts#L10-20`) và `@problems` thành nội dung gửi cho model.
 *
 * Tách khỏi userContent.ts để logic mới nằm trong tệp riêng. Mọi đường dẫn đi qua resolveUserPathReal (chống `..`, symlink
 * ra ngoài workspace); số dòng được kiểm tra và có trần; vùng chọn có số dòng kiểu `cat -n` để model tham chiếu chính xác.
 */

import { isSecretFile, resolveUserPathReal } from '../core/fsutil/paths';
import { numberLines } from '../core/tools/textUtil';
import { t, type Lang } from '../core/engine/strings';
import type { ToolHost } from '../core/engine/types';
import { diagnosticsReport } from '../core/ide/diagnosticsText';
import { applyLineMentions, hasProblemsMention, MAX_MENTION_LINES } from '../shared/lineMentions';
import type { AttachmentInfo } from '../shared/protocol';

const MAX_SELECTION_CHARS = 80_000;
/** Trần số chẩn đoán kèm theo `@problems`. */
const PROBLEMS_LIMIT = 100;

function normKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').normalize('NFC').toLowerCase();
}

/**
 * Áp các `@đường/dẫn#L10-20` có trong chữ lên danh sách đính kèm. Mention KHÔNG có chip tương ứng (tin đến từ Remote/Chrome chỉ
 * có chữ) được thêm thành vùng chọn mới; `textOnly` liệt kê khoá đường dẫn của những mention đó để host kiểm tra thêm
 * (tệp bí mật không tự đính kèm từ chữ).
 */
export function resolveLineMentions(text: string, attachments: readonly AttachmentInfo[]): { attachments: AttachmentInfo[]; textOnly: Set<string> } {
  const known = new Set(attachments.filter((a) => a.path && a.kind !== 'image' && a.kind !== 'doc').map((a) => normKey(a.path!)));
  const merged = applyLineMentions(text, attachments, { addMissing: true });
  const textOnly = new Set<string>();
  for (const a of merged) if (a.kind === 'selection' && a.path && !known.has(normKey(a.path))) textOnly.add(normKey(a.path));
  return { attachments: merged, textOnly };
}

export interface SelectionPart {
  part?: string;
  /** Số ký tự của phần nội dung (để trừ ngân sách). */
  chars: number;
  warning?: string;
}

/** Dựng khối `<attached_selection>` cho dòng `start`–`end` (1-based) của `fileText`; ngoài phạm vi → cảnh báo, không đính kèm. */
export function renderSelection(fileText: string, rel: string, range: [number, number], lang: Lang, label?: string): SelectionPart {
  const lines = fileText.split(/\r?\n/);
  // Dấu xuống dòng cuối tệp không tạo thêm một dòng.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const [s, e0] = range;
  const ref = label || `${rel}:${s === e0 ? s : `${s}-${e0}`}`;
  if (!Number.isFinite(s) || s < 1 || s > total) return { chars: 0, warning: t(lang, 'mentionOutOfRange', { ref, start: s, total }) };
  let end = Math.min(Math.max(e0, s), total);
  let note = '';
  if (end - s + 1 > MAX_MENTION_LINES) {
    end = s + MAX_MENTION_LINES - 1;
    note = '\n' + t(lang, 'mentionTruncated', { max: MAX_MENTION_LINES, next: end + 1 });
  }
  let body = numberLines(lines.slice(s - 1, end), s);
  if (body.length > MAX_SELECTION_CHARS) {
    body = body.slice(0, MAX_SELECTION_CHARS);
    // Cắt ở cuối dòng gần nhất để không vỡ giữa số dòng.
    const nl = body.lastIndexOf('\n');
    if (nl > 0) body = body.slice(0, nl);
    const shown = body.split('\n').length;
    note = '\n' + t(lang, 'mentionTruncated', { max: shown, next: s + shown });
    end = s + shown - 1;
  }
  return { part: `<attached_selection path="${rel}" lines="${s}-${end}">\n${body}${note}\n</attached_selection>`, chars: body.length };
}

/** `@problems` → khối chẩn đoán hiện tại của workspace (hoặc cảnh báo nếu host không có IDE). */
export async function problemsPart(text: string, host: ToolHost, lang: Lang): Promise<{ part?: string; warning?: string }> {
  if (!hasProblemsMention(text)) return {};
  if (!host.diagnostics) return { warning: t(lang, 'problemsUnavailable') };
  try {
    const r = await host.diagnostics({ minSeverity: 'warning', limit: PROBLEMS_LIMIT });
    return { part: `<attached_problems>\n${t(lang, 'problemsTitle')}\n${diagnosticsReport(r, lang, { min: 'warning' })}\n</attached_problems>` };
  } catch {
    return { warning: t(lang, 'problemsUnavailable') };
  }
}

/** Mention từ chữ trỏ vào tệp có thể chứa bí mật: không tự đính kèm (người dùng phải chọn bằng nút @). */
export async function isSecretTarget(host: ToolHost, path: string): Promise<boolean> {
  const r = await resolveUserPathReal(host, path);
  return r.zone !== 'outside' && (isSecretFile(r.abs) || isSecretFile(r.real));
}

export { normKey as mentionPathKey };
