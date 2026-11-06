/**
 * (0.6.3) Tìm đường dẫn ảnh / GIF / video / âm thanh / tài liệu mà câu trả lời nhắc tới, để hiện xem trước NGAY DƯỚI khối nhắc tới
 * (đoạn văn, danh sách, bảng). Thuần tuý (không DOM), test được.
 *
 * Nguồn: đích liên kết `[…](out/a.png)`, ảnh `![…](a.gif)`, đoạn mã `` `out/demo.mp4` `` (kể cả đường dẫn có dấu cách khi nằm TRỌN
 * trong đoạn mã) và chữ thường (tách theo khoảng trắng). KHÔNG lấy trong khối mã ``` … ```: đó là lệnh / mã nguồn, không phải kết quả.
 * Webview chỉ đoán; host kiểm từng đường dẫn (có thật không, có nằm trong vùng xem không) trước khi hiện gì.
 */
import { marked, type Token, type Tokens } from 'marked';
import type { MediaKind } from '../../../src/shared/protocol';
import { mediaKindOf } from '../../../src/shared/mediaKinds';
import { decodeEntities } from './entities';

export interface MediaRef {
  path: string;
  kind: MediaKind;
}

/** Tối đa bấy nhiêu tệp xem trước cho một câu trả lời. */
export const MAX_MEDIA_REFS = 12;

const LEAD = /^[([{<«“‘"']+/;
const TRAIL = /[)\]}>»”’"'.,;:!?…]+$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const PSEUDO_SCHEME = /^(?:data|blob|javascript|mailto|vscode[a-z-]*):/i;
const DRIVE = /^[A-Za-z]:[\\/]/;

/** Một chuỗi có giống đường dẫn tệp xem trước được không. `spaced`: cho phép dấu cách (chỉ khi chuỗi là TRỌN một đoạn mã / đích liên kết). */
export function looksLikeMediaPath(s: string, spaced = false): boolean {
  if (s.length < 3 || s.length > 400 || /[\r\n\t]/.test(s)) return false;
  if (/^file:\/\//i.test(s)) s = s.replace(/^file:\/\/\/?/i, '/');
  else if (URL_SCHEME.test(s) || PSEUDO_SCHEME.test(s) || s.includes('://')) return false;
  if (/[*?<>|"]/.test(s) || s.startsWith('-')) return false;
  if (/\s/.test(s)) {
    if (!spaced) return false;
    // Có dấu cách: phải trông như một đường dẫn (có dấu phân cách thư mục hoặc ổ đĩa), không phải câu lệnh (cờ `-x`, `&&`, `;`).
    if (!/[\\/]/.test(s) && !DRIVE.test(s)) return false;
    if (/\s-{1,2}[A-Za-z]|&&|;|\s>\s?/.test(s)) return false;
  }
  if (!mediaKindOf(s)) return false;
  const base = s.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  return /[\p{L}\p{N}]/u.test(stem);
}

/** Chữ tự do → các "từ" trông như đường dẫn tệp xem trước được (theo thứ tự xuất hiện). */
export function pathsInText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    // «Video:out/a.mp4», «Ảnh：C:\x\b.png»: tách ở dấu hai chấm không phải của ổ đĩa (`C:\`) và không phải của URL.
    for (const part of raw.split(/(?<=^.{2,}?)[:：](?![\\/])/)) {
      const tok = part.replace(LEAD, '').replace(TRAIL, '');
      if (looksLikeMediaPath(tok)) out.push(tok);
    }
  }
  return out;
}

function cleanTarget(href: string): string {
  let s = href.trim().replace(/^<|>$/g, '');
  // Đích liên kết hay bị mã hoá dấu cách; host tự thử cả hai dạng — ở đây chỉ cần kiểm được đuôi tệp.
  if (/%[0-9a-f]{2}/i.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* giữ nguyên */
    }
  }
  return s;
}

/** Các đường dẫn trong MỘT khối cấp cao của marked (đoạn văn, danh sách, bảng, trích dẫn…), theo thứ tự. */
export function pathsInBlock(token: Token): string[] {
  const out: string[] = [];
  if (token.type === 'code' || token.type === 'html' || token.type === 'space' || token.type === 'def' || token.type === 'hr') return out;
  let buf = '';
  const flush = () => {
    if (buf) out.push(...pathsInText(decodeEntities(buf)));
    buf = '';
  };
  const visit = (tk: Token): void => {
    switch (tk.type) {
      case 'code':
      case 'html':
        flush();
        return;
      case 'codespan': {
        flush();
        const c = decodeEntities((tk as Tokens.Codespan).text).trim();
        if (looksLikeMediaPath(c, true)) out.push(c);
        return;
      }
      case 'link':
      case 'image': {
        // Chỉ lấy ĐÍCH của liên kết; nhãn chỉ là chữ hiển thị (`[mandelbrot.jpg](out/mandelbrot.jpg)` không được thành hai tệp).
        flush();
        const href = cleanTarget((tk as Tokens.Link | Tokens.Image).href ?? '');
        if (looksLikeMediaPath(href, true)) out.push(href);
        return;
      }
      case 'text':
      case 'escape': {
        const t = tk as Tokens.Text;
        if (tk.type === 'text' && t.tokens && t.tokens.length) t.tokens.forEach(visit);
        else buf += t.text;
        return;
      }
      case 'br':
        buf += ' ';
        return;
      case 'list':
        for (const it of (tk as Tokens.List).items) {
          flush();
          it.tokens.forEach(visit);
        }
        flush();
        return;
      case 'table': {
        const tb = tk as Tokens.Table;
        for (const cell of tb.header) {
          flush();
          cell.tokens.forEach(visit);
        }
        for (const row of tb.rows)
          for (const cell of row) {
            flush();
            cell.tokens.forEach(visit);
          }
        flush();
        return;
      }
      default: {
        const g = tk as Tokens.Generic;
        if (g.tokens && g.tokens.length) {
          // Khối con (đoạn văn trong trích dẫn, mục danh sách…) là ranh giới chữ; định dạng nội dòng (đậm, nghiêng) thì không.
          const block = tk.type === 'paragraph' || tk.type === 'heading' || tk.type === 'blockquote';
          if (block) flush();
          g.tokens.forEach(visit);
          if (block) flush();
        } else if (typeof g.text === 'string' && tk.type !== 'space') buf += g.text;
      }
    }
  };
  visit(token);
  flush();
  return out;
}

const keyOf = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/**
 * Tệp xem trước của từng khối (cùng thứ tự với `tokens`; null = khối không nhắc tới tệp nào). Một tệp chỉ hiện MỘT lần, ở khối nhắc tới
 * nó đầu tiên; cả câu trả lời tối đa MAX_MEDIA_REFS tệp.
 */
export function mediaRefsByBlock(tokens: readonly Token[]): (MediaRef[] | null)[] {
  const seen = new Set<string>();
  let total = 0;
  return tokens.map((tk) => {
    if (total >= MAX_MEDIA_REFS) return null;
    const refs: MediaRef[] = [];
    for (const p of pathsInBlock(tk)) {
      const k = keyOf(p);
      const kind = mediaKindOf(p);
      if (!kind || seen.has(k)) continue;
      seen.add(k);
      refs.push({ path: p, kind });
      if (++total >= MAX_MEDIA_REFS) break;
    }
    return refs.length ? refs : null;
  });
}

/** Mọi tệp xem trước trong một đoạn Markdown (phẳng, đã bỏ trùng). */
export function findMediaRefs(text: string): MediaRef[] {
  let tokens: Token[];
  try {
    tokens = marked.lexer(text, { gfm: true, breaks: false });
  } catch {
    return [];
  }
  return mediaRefsByBlock(tokens).flatMap((r) => r ?? []);
}
