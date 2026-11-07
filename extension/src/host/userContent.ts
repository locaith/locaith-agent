/**
 * Dựng nội dung tin nhắn người dùng gửi cho model: văn bản + tệp/vùng chọn/thư mục/ảnh đính kèm + ngữ cảnh editor.
 * Nội dung tệp đính kèm bị giới hạn kích thước để một cú kéo-thả không làm nổ ngữ cảnh.
 */

import * as path from 'node:path';
import type { ContentBlock, ImageBlock } from '../core/types';
import { readKey, resolveUserPathReal } from '../core/fsutil/paths';
import { sha1 } from '../core/tools/textUtil';
import type { SessionState, ToolHost } from '../core/engine/types';
import { imageKey } from '../shared/transcriptRebuild';
import { docKindOf, type DocKind } from '../shared/docKinds';
import { DocError, extractDocument } from '../shared/docExtract';
import { buildDocParts, wrapUploaded } from '../shared/docWrap';
import type { AttachmentInfo, EditorContextInfo } from '../shared/protocol';
import { hostLang } from '../core/tools/diagnostics'; // (lane:ide-context)
import { mentionPathKey, problemsPart, renderSelection, resolveLineMentions } from './ideMentions'; // (lane:ide-context)
import { isSecretFile } from '../core/fsutil/paths'; // (lane:ide-context)
import { t } from '../core/engine/strings'; // (lane:ide-context)

const MAX_FILE_CHARS = 80_000;
const MAX_TOTAL_CHARS = 240_000;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SELECTION_AUTO = 4_000;
/** Ngân sách chữ cho các tệp tải lên của một tin nhắn khi bên gọi không nêu (theo cửa sổ ngữ cảnh: xem docCharBudget). */
const DEFAULT_DOC_BUDGET = 200_000;
/** Tệp nhị phân trong workspace mà `@` đính kèm sẽ đọc bằng bộ đọc tệp (còn HTML/CSV/TXT… là văn bản, giữ đường cũ để trợ lý còn sửa được). */
const BINARY_DOC_KINDS: ReadonlySet<DocKind> = new Set(['pdf', 'docx', 'xlsx']);

export interface BuildInput {
  text: string;
  attachments: AttachmentInfo[];
  host: ToolHost;
  session: Pick<SessionState, 'readFiles'>;
  editor: EditorContextInfo | null;
  /** Nội dung vùng chọn hiện tại của editor (đưa vào ngữ cảnh khi người dùng không tự đính kèm). */
  editorSelectionText?: string;
  /** Số ký tự tối đa cho chữ của TẤT CẢ tệp tải lên trong tin nhắn này. */
  docBudget?: number;
}

export interface BuiltContent {
  content: ContentBlock[];
  /** Bản sao đính kèm để hiển thị (đã bỏ dữ liệu ảnh base64). */
  display: AttachmentInfo[];
  warnings: string[];
}

async function listTree(host: ToolHost, abs: string, depth: number, indent = '', out: string[] = []): Promise<string[]> {
  if (out.length > 200) return out;
  let entries;
  try {
    entries = await host.readDir(abs);
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name, 'vi') : a.isDirectory ? -1 : 1));
  for (const e of entries) {
    if (out.length > 200) break;
    if (['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__'].includes(e.name)) continue;
    out.push(`${indent}${e.name}${e.isDirectory ? '/' : ''}`);
    if (e.isDirectory && depth > 1) await listTree(host, path.join(abs, e.name), depth - 1, indent + '  ', out);
  }
  return out;
}

export async function buildUserContent(inp: BuildInput): Promise<BuiltContent> {
  const parts: string[] = [];
  const images: ImageBlock[] = [];
  const display: AttachmentInfo[] = [];
  const warnings: string[] = [];
  let budget = MAX_TOTAL_CHARS;
  let selectionAttached = false;
  // (lane:ide-context) `@tệp#L10-20` trong chữ → vùng chọn có khoảng dòng (chip từ ô nhập hoặc chỉ-có-chữ từ Remote/Chrome).
  const lang = hostLang(inp.host);
  const mentioned = resolveLineMentions(inp.text, inp.attachments);

  for (const a of mentioned.attachments) {
    if (a.kind === 'image') {
      if (!a.data || images.length >= MAX_IMAGES) {
        warnings.push(`Bỏ qua ảnh "${a.label}" (quá nhiều ảnh hoặc không có dữ liệu).`);
        continue;
      }
      if (Math.floor((a.data.length * 3) / 4) > MAX_IMAGE_BYTES) {
        warnings.push(`Bỏ qua ảnh "${a.label}" vì lớn hơn 5 MB.`);
        continue;
      }
      images.push({ type: 'image', mediaType: a.mediaType || 'image/png', data: a.data });
      display.push({ ...a, data: undefined, imgKey: a.imgKey ?? imageKey(a.data) });
      continue;
    }
    if (a.kind === 'doc') continue; // tệp tải lên: gom riêng sau vòng lặp (chung một ngân sách)
    if (!a.path) continue;
    const r = await resolveUserPathReal(inp.host, a.path);
    if (r.zone === 'outside') {
      warnings.push(`Bỏ qua "${a.label}": nằm ngoài workspace.`);
      continue;
    }

    // PDF/Word/Excel trong workspace (`@bao-cao.pdf`, kéo từ Explorer): không phải UTF-8 nên đọc bằng bộ đọc tệp thay vì readText.
    const docKind = a.kind === 'file' ? docKindOf(a.path) : null;
    if (docKind && BINARY_DOC_KINDS.has(docKind)) {
      if (budget < 2_000) {
        warnings.push(`Bỏ qua "${a.label}": vượt giới hạn tổng dung lượng đính kèm.`);
        continue;
      }
      try {
        const doc = await extractDocument(await inp.host.readBytes(r.abs), r.rel, { maxChars: Math.min(budget, inp.docBudget ?? DEFAULT_DOC_BUDGET) });
        budget -= doc.text.length;
        parts.push(wrapUploaded(a.label || r.rel, doc.kind, doc.text, { pages: doc.pages, sheets: doc.sheets, truncated: doc.truncated, totalChars: doc.totalChars }));
        display.push({ ...a, data: undefined });
      } catch (err) {
        warnings.push(err instanceof DocError ? err.message : `Không đọc được "${a.label}".`);
      }
      continue;
    }

    if (a.kind === 'folder') {
      const tree = await listTree(inp.host, r.abs, 2);
      parts.push(`<attached_folder path="${r.rel}">\n${tree.join('\n')}\n</attached_folder>`);
      display.push({ ...a, data: undefined });
      continue;
    }

    let text: string | null;
    try {
      text = await inp.host.readText(r.abs);
    } catch {
      warnings.push(`"${a.label}" không phải UTF-8 nên không đính kèm được (tránh gửi chữ bị vỡ).`);
      continue;
    }
    if (text === null) {
      warnings.push(`Không đọc được "${a.label}".`);
      continue;
    }
    if (a.kind === 'selection' && a.range) {
      // (lane:ide-context) mention chỉ có chữ: chỉ nhận tệp trong workspace và không phải tệp bí mật.
      if (mentioned.textOnly.has(mentionPathKey(a.path)) && (r.zone !== 'workspace' || isSecretFile(r.abs) || isSecretFile(r.real))) {
        warnings.push(t(lang, 'mentionSecret', { ref: a.label }));
        continue;
      }
      const sel = renderSelection(text, r.rel, a.range, lang, a.label);
      if (!sel.part) {
        if (sel.warning) warnings.push(sel.warning);
        continue;
      }
      // (lane:ide-context) cùng trần tổng như nhánh tệp thường: nhiều `@tệp#L…` không được đẩy tin vượt MAX_TOTAL_CHARS.
      if (budget - sel.chars < 0) {
        warnings.push(`Bỏ qua "${a.label}": vượt giới hạn tổng dung lượng đính kèm.`);
        continue;
      }
      budget -= sel.chars;
      parts.push(sel.part);
      selectionAttached = true;
    } else {
      const body = text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) + `\n[… đã cắt, tệp dài ${text.length.toLocaleString('en-US')} ký tự; dùng read_file để đọc phần còn lại]` : text;
      if (budget - body.length < 0) {
        warnings.push(`Bỏ qua "${a.label}": vượt giới hạn tổng dung lượng đính kèm.`);
        continue;
      }
      budget -= body.length;
      parts.push(`<attached_file path="${r.rel}">\n${body}\n</attached_file>`);
      // Model đã thấy toàn bộ nội dung → cho phép sửa mà không bắt đọc lại.
      if (text.length <= MAX_FILE_CHARS) inp.session.readFiles[readKey(r.abs)] = sha1(text);
    }
    display.push({ ...a, data: undefined });
  }

  // Tệp người dùng tải lên (PDF, Word, Excel, HTML, CSV, TXT): chữ đã được đọc sẵn ở bước chọn tệp, ở đây chỉ bọc khung dữ liệu và tính ngân sách chung.
  const docs = buildDocParts(inp.attachments, Math.min(budget, inp.docBudget ?? DEFAULT_DOC_BUDGET));
  parts.push(...docs.parts);
  display.push(...docs.display);
  warnings.push(...docs.warnings);

  // (lane:ide-context) `@problems`: chẩn đoán hiện tại của VS Code.
  const prob = await problemsPart(inp.text, inp.host, lang);
  if (prob.part) parts.push(prob.part);
  if (prob.warning) warnings.push(prob.warning);

  const ctx: string[] = [];
  // (lane:ide-context) `off`: người dùng tắt chip «Đang xem» → không gửi tệp/vùng chọn của editor.
  if (inp.editor?.file && !inp.editor.off) {
    ctx.push(`Active file in the editor: ${inp.editor.file}${inp.editor.language ? ` (${inp.editor.language})` : ''}`);
    if (inp.editor.selection) {
      const s = inp.editor.selection;
      ctx.push(`Selected lines: ${s.startLine}-${s.endLine}`);
      if (!selectionAttached && inp.editorSelectionText && inp.editorSelectionText.length <= MAX_SELECTION_AUTO) {
        ctx.push(`Selected text:\n${inp.editorSelectionText}`);
      }
    }
  }

  const head = [ctx.length ? `<ide_context>\n${ctx.join('\n')}\n</ide_context>` : '', ...parts].filter(Boolean);
  const text = head.length ? `${head.join('\n\n')}\n\n${inp.text}` : inp.text;
  const content: ContentBlock[] = [...images, { type: 'text', text }];
  return { content, display, warnings };
}
