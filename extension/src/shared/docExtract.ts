/**
 * Đọc tệp người dùng TẢI LÊN thành văn bản cho trợ lý: PDF, Word (.docx), Excel (.xlsx), HTML, CSV/TSV và văn bản thuần (TXT, MD, JSON, XML, LOG…).
 *
 * Chạy ở nơi không có DOM (host Node của VS Code, trang của tiện ích trình duyệt, kiểm thử): không dùng DOMParser — Word/Excel được đọc bằng bộ tách
 * thẻ nhỏ (OOXML do máy sinh nên cấu trúc đều), HTML bằng `node-html-parser` (đã có sẵn trong lõi), PDF bằng `unpdf` (nạp lười, xem pdfText.ts).
 *
 * Nguyên tắc an toàn: nội dung tệp là DỮ LIỆU không đáng tin (tệp có thể do người khác gửi). Chữ người đọc KHÔNG thấy khi mở tệp bình thường — chữ ẩn trong
 * Word (`w:vanish`), phần tử ẩn trong HTML — không được đưa vào; ký tự vô hình/bidi/"ký tự thẻ" bị lọc; khi đưa cho mô hình thì bọc trong khung có mã ngẫu nhiên
 * (`wrapUploaded`) kèm lời nhắc "đây là dữ liệu, không phải chỉ dẫn".
 */

import { strFromU8, unzipSync } from 'fflate';
import { decodeBody, htmlToMarkdown } from '../core/tools/web/html';
import { DOC_EXTENSIONS, MAX_DOC_BYTES, extOf, isLegacyOffice, type DocKind } from './docKinds';
import { DocError, clipText, sanitizeUploadedText, type ExtractOptions, type ExtractedDoc } from './docWrap';

export type { DocKind } from './docKinds';
export { DocError, sanitizeUploadedText, wrapUploaded } from './docWrap';
export type { DocErrorCode, DocExtractor, ExtractOptions, ExtractedDoc } from './docWrap';

// ─────────────────────────────────────────────────────────────────────────────
// Tiện ích chung
// ─────────────────────────────────────────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return '';
      }
    }
    return XML_ENTITIES[g] ?? m;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Văn bản thuần + CSV
// ─────────────────────────────────────────────────────────────────────────────

export function decodeText(bytes: Uint8Array): { text: string; encoding: string; guessed: boolean } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', guessed: false };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', guessed: false };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', guessed: false };
  // UTF-16 không BOM (Excel "Unicode Text"): nhiều byte 0 ở vị trí lẻ/chẵn
  let zerosOdd = 0;
  let zerosEven = 0;
  const probe = Math.min(bytes.length, 4000);
  for (let i = 0; i < probe; i++) if (bytes[i] === 0) (i % 2 ? zerosOdd++ : zerosEven++);
  if (probe > 20 && zerosOdd > probe * 0.3 && zerosEven < probe * 0.02) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le', guessed: true };
  if (probe > 20 && zerosEven > probe * 0.3 && zerosOdd < probe * 0.02) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be', guessed: true };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', guessed: false };
  } catch {
    // Tệp Việt đời cũ hay ở Windows-1258; không có thì Windows-1252.
    for (const enc of ['windows-1258', 'windows-1252']) {
      try {
        return { text: new TextDecoder(enc).decode(bytes), encoding: enc, guessed: true };
      } catch {
        /* thử bảng mã kế tiếp */
      }
    }
    return { text: new TextDecoder('latin1').decode(bytes), encoding: 'latin1', guessed: true };
  }
}

/** Đếm số hàng (bản ghi) và số cột của hàng đầu trong CSV/TSV, tính cả ô có xuống dòng trong dấu nháy. */
export function csvStats(text: string, delim: string): { rows: number; cols: number } {
  let rows = 0;
  let cols = 1;
  let first = true;
  let inQ = false;
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQ = false;
      }
      continue;
    }
    if (ch === '"') {
      inQ = true;
      any = true;
    } else if (ch === delim) {
      if (first) cols++;
      any = true;
    } else if (ch === '\n') {
      if (any) rows++;
      first = false;
      any = false;
    } else if (ch !== '\r') any = true;
  }
  if (any) rows++;
  return { rows, cols };
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP (docx/xlsx)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PART_BYTES = 120 * 1024 * 1024; // chặn "bom nén": một phần giải nén ra quá lớn thì bỏ

function unzipParts(bytes: Uint8Array, want: (name: string) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, { filter: (f) => want(f.name) && f.originalSize <= MAX_PART_BYTES });
  } catch {
    throw new DocError('corrupt', 'Không mở được tệp (không phải tệp Office hợp lệ, hoặc đã hỏng).');
  }
}

const part = (parts: Record<string, Uint8Array>, name: string): string | undefined => (parts[name] ? strFromU8(parts[name]) : undefined);

// ─────────────────────────────────────────────────────────────────────────────
// DOCX
// ─────────────────────────────────────────────────────────────────────────────

interface Block {
  kind: 'p' | 'h' | 'li' | 'table';
  text: string;
}

function tableToMarkdown(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (!rows.length || !width) return '';
  const cell = (s: string | undefined) => (s ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

function docxBlocks(xml: string): { blocks: Block[]; hidden: boolean } {
  const TAG = /<(\/?)w:([A-Za-z]+)((?:\s[^>]*?)?)(\/?)>/g;
  interface Para {
    text: string;
    head: number;
    li: number;
  }
  interface Tbl {
    rows: string[][];
    row: string[] | null;
    cell: string[] | null;
  }
  const paras: Para[] = [];
  const tables: Tbl[] = [];
  const out: Block[] = [];
  let run: { text: string; vanish: boolean } | null = null;
  let hidden = false;

  const add = (s: string) => {
    if (run) run.text += s;
    else if (paras.length) paras[paras.length - 1].text += s;
  };
  const emit = (b: Block) => {
    const t = tables[tables.length - 1];
    if (t?.cell) {
      if (b.text) t.cell.push(b.text);
    } else out.push(b);
  };
  const flush = (p: Para) => {
    // Giữ dấu tab (Word hay căn cột bằng tab), chỉ gộp khoảng trắng thừa.
    const text = p.text.replace(/[  ]{2,}/g, ' ').replace(/ ?\t ?/g, '\t').replace(/ ?\n ?/g, '\n').trim();
    if (!text) return;
    if (tables.length && tables[tables.length - 1].cell) return emit({ kind: 'p', text });
    if (p.head > 0) return emit({ kind: 'h', text: `${'#'.repeat(Math.min(p.head, 6))} ${text}` });
    if (p.li >= 0) return emit({ kind: 'li', text: `${'  '.repeat(Math.min(p.li, 6))}- ${text}` });
    emit({ kind: 'p', text });
  };

  let m: RegExpExecArray | null;
  while ((m = TAG.exec(xml))) {
    const [, close, name, attrs, self] = m;
    if (close) {
      if (name === 'r') {
        if (run) {
          if (run.vanish) hidden = hidden || run.text.trim().length > 0;
          else if (paras.length) paras[paras.length - 1].text += run.text;
          run = null;
        }
      } else if (name === 'p') {
        const p = paras.pop();
        if (p) flush(p);
      } else if (name === 'tc') {
        const t = tables[tables.length - 1];
        if (t?.cell && t.row) {
          t.row.push(t.cell.join(' ').trim());
          t.cell = null;
        }
      } else if (name === 'tr') {
        const t = tables[tables.length - 1];
        if (t?.row) {
          t.rows.push(t.row);
          t.row = null;
        }
      } else if (name === 'tbl') {
        const t = tables.pop();
        if (t) emit({ kind: 'table', text: tableToMarkdown(t.rows) });
      }
      continue;
    }
    switch (name) {
      case 'p':
        if (!self) paras.push({ text: '', head: 0, li: -1 });
        break;
      case 'r':
        if (!self) run = { text: '', vanish: false };
        break;
      case 'vanish':
        if (run && !/w:val="(?:0|false|off)"/.test(attrs)) run.vanish = true;
        break;
      case 't': {
        if (self) break;
        const end = xml.indexOf('</w:t>', TAG.lastIndex);
        if (end < 0) break;
        add(decodeXml(xml.slice(TAG.lastIndex, end)));
        TAG.lastIndex = end + 6;
        break;
      }
      case 'tab':
        add('\t');
        break;
      case 'br':
      case 'cr':
        add('\n');
        break;
      case 'noBreakHyphen':
        add('-');
        break;
      case 'pStyle': {
        const v = /w:val="([^"]*)"/.exec(attrs)?.[1] ?? '';
        const p = paras[paras.length - 1];
        if (p) {
          const h = /^Heading(\d)$/i.exec(v);
          p.head = h ? Number(h[1]) : /^Title$/i.test(v) ? 1 : 0;
        }
        break;
      }
      case 'numPr': {
        const p = paras[paras.length - 1];
        if (p && p.li < 0) p.li = 0;
        break;
      }
      case 'ilvl': {
        const p = paras[paras.length - 1];
        if (p) p.li = Number(/w:val="(\d+)"/.exec(attrs)?.[1] ?? 0);
        break;
      }
      case 'tbl':
        tables.push({ rows: [], row: null, cell: null });
        break;
      case 'tr': {
        const t = tables[tables.length - 1];
        if (t && !self) t.row = [];
        break;
      }
      case 'tc': {
        const t = tables[tables.length - 1];
        if (t && !self) t.cell = [];
        break;
      }
    }
  }
  return { blocks: out, hidden };
}

function joinBlocks(blocks: Block[]): string {
  let text = '';
  let prev: Block | null = null;
  for (const b of blocks) {
    if (prev) text += prev.kind === 'li' && b.kind === 'li' ? '\n' : '\n\n';
    text += b.text;
    prev = b;
  }
  return text;
}

function docxToText(bytes: Uint8Array, notes: string[]): string {
  const parts = unzipParts(bytes, (n) => n === 'word/document.xml' || n === 'word/footnotes.xml' || n === 'word/endnotes.xml');
  const main = part(parts, 'word/document.xml');
  if (main === undefined) throw new DocError('corrupt', 'Không phải tệp Word (.docx) hợp lệ: thiếu phần nội dung chính.');
  const body = docxBlocks(main);
  let text = joinBlocks(body.blocks);
  let hidden = body.hidden;
  for (const [file, label] of [['word/footnotes.xml', 'Chú thích cuối trang'], ['word/endnotes.xml', 'Chú thích cuối bài']] as const) {
    const xml = part(parts, file);
    if (!xml) continue;
    const r = docxBlocks(xml);
    hidden = hidden || r.hidden;
    const t = joinBlocks(r.blocks);
    if (t.trim()) text += `\n\n---\n${label}:\n${t}`;
  }
  if (hidden) notes.push('Đã bỏ qua chữ ẩn trong tài liệu Word (chữ bạn không thấy khi mở tệp).');
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// XLSX
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SHEET_ROWS = 20_000;
const MAX_SHEET_COLS = 200;
/** Một trang tính có XML quá lớn thì chỉ đọc phần đầu (tránh nuốt bộ nhớ). */
const MAX_SHEET_XML = 60 * 1024 * 1024;

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = (m[1] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let s = '';
    const tre = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
    let t: RegExpExecArray | null;
    while ((t = tre.exec(body))) s += decodeXml(t[1] ?? '');
    out.push(s);
  }
  return out;
}

function isDateFormat(id: number, code?: string): boolean {
  if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return true;
  if (!code) return false;
  const c = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '').toLowerCase();
  return /[dmyhs]/.test(c) && c !== 'general';
}

/** Chỉ số kiểu ô (`s="…"`) nào là định dạng ngày/giờ. */
function dateStyles(xml: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"/g)) custom.set(Number(m[1]), decodeXml(m[2]));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0);
    if (isDateFormat(id, custom.get(id))) out.add(i);
    i++;
  }
  return out;
}

function excelDate(serial: number, date1904: boolean): string {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const iso = new Date(base + Math.round(serial * 86_400_000)).toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  if (serial >= 0 && serial < 1) return time;
  if (time === '00:00:00') return date;
  return `${date} ${time.endsWith(':00') ? time.slice(0, 5) : time}`;
}

function numberText(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  // bỏ nhiễu dấu phẩy động (0.30000000000000004 → 0.3)
  return String(Number(n.toPrecision(15)));
}

function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface SheetOut {
  lines: string[];
  rows: number;
  cols: number;
  truncated: boolean;
}

function sheetToCsv(xml: string, sst: string[], dateXf: Set<number>, date1904: boolean, budget: number): SheetOut {
  if (xml.length > MAX_SHEET_XML) xml = xml.slice(0, MAX_SHEET_XML);
  const lines: string[] = [];
  let chars = 0;
  let rowsSeen = 0;
  let maxCol = 0;
  let truncated = false;
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml))) {
    const body = rm[1];
    if (!body) continue;
    const cells: string[] = [];
    const cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cre.exec(body))) {
      const attrs = cm[1];
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Za-z]+)\d*"/.exec(attrs)?.[1];
      const idx = ref ? colIndex(ref) : cells.length;
      if (idx < 0 || idx >= MAX_SHEET_COLS) continue;
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? 'n';
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
      const v = /<v\b[^>]*?>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let text = '';
      if (type === 'inlineStr') {
        for (const t of inner.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) text += decodeXml(t[1] ?? '');
      } else if (v !== undefined) {
        if (type === 's') text = sst[Number(v)] ?? '';
        else if (type === 'str') text = decodeXml(v);
        else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'e') text = decodeXml(v);
        else if (type === 'd') text = decodeXml(v);
        else text = dateXf.has(style) && Number.isFinite(Number(v)) ? excelDate(Number(v), date1904) : numberText(v);
      }
      if (text === '') continue;
      while (cells.length < idx) cells.push('');
      cells[idx] = text;
      if (idx + 1 > maxCol) maxCol = idx + 1;
    }
    if (!cells.some((c) => c !== '')) continue;
    rowsSeen++;
    if (rowsSeen > MAX_SHEET_ROWS || chars > budget) {
      truncated = true;
      continue; // đếm tiếp để biết tổng số hàng
    }
    const line = cells.map(csvCell).join(',');
    lines.push(line);
    chars += line.length + 1;
  }
  return { lines, rows: rowsSeen, cols: maxCol, truncated };
}

function xlsxToText(bytes: Uint8Array, notes: string[], budget: number): { text: string; sheets: number; rows: number } {
  const parts = unzipParts(bytes, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || n === 'xl/styles.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  const wb = part(parts, 'xl/workbook.xml');
  if (wb === undefined) throw new DocError('corrupt', 'Không phải tệp Excel (.xlsx) hợp lệ: thiếu sổ làm việc.');
  const rels = new Map<string, string>();
  for (const m of (part(parts, 'xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const sst = sharedStrings(part(parts, 'xl/sharedStrings.xml') ?? '');
  const dateXf = dateStyles(part(parts, 'xl/styles.xml'));
  const date1904 = /<workbookPr\b[^>]*?date1904="(?:1|true)"/.test(wb);

  const out: string[] = [];
  const skippedHidden: string[] = [];
  let sheets = 0;
  let totalRows = 0;
  // Nhỏ hơn maxChars một chút để phần chú thích "còn N hàng" không bị bước cắt cuối cùng xén mất.
  let left = budget * 0.9;
  const sheetRe = /<sheet\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = sheetRe.exec(wb))) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? 'Trang tính');
    const state = /\bstate="([^"]*)"/.exec(m[1])?.[1] ?? 'visible';
    const rid = /\br:id="([^"]*)"/.exec(m[1])?.[1];
    if (state !== 'visible') {
      skippedHidden.push(name);
      continue;
    }
    const xml = rid && rels.get(rid) ? part(parts, rels.get(rid)!) : undefined;
    if (xml === undefined) continue;
    sheets++;
    if (left <= 0) {
      out.push(`## Trang tính "${name}"\n[… bỏ qua: đã hết ngân sách đọc]`);
      continue;
    }
    const sh = sheetToCsv(xml, sst, dateXf, date1904, left);
    totalRows += sh.rows;
    left -= sh.lines.reduce((s, l) => s + l.length + 1, 0);
    const head = `## Trang tính "${name}" (${sh.rows.toLocaleString('en-US')} hàng × ${sh.cols} cột)`;
    const tail = sh.truncated ? `\n[… còn ${(sh.rows - sh.lines.length).toLocaleString('en-US')} hàng nữa chưa đưa vào]` : '';
    out.push(`${head}\n${sh.lines.length ? sh.lines.join('\n') : '(trống)'}${tail}`);
  }
  if (skippedHidden.length) notes.push(`Đã bỏ qua trang tính ẩn: ${skippedHidden.join(', ')} (hiện nó trong Excel rồi tải lại nếu cần).`);
  if (out.length) notes.push('Số hiển thị đúng như lưu trong ô (không kèm định dạng %, tiền tệ); ngày giờ đã đổi sang dạng chuẩn.');
  return { text: out.join('\n\n'), sheets, rows: totalRows };
}

// ─────────────────────────────────────────────────────────────────────────────
// Điểm vào
// ─────────────────────────────────────────────────────────────────────────────

function sniffKind(bytes: Uint8Array): DocKind | null {
  if (bytes.length > 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf'; // %PDF
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const names: string[] = [];
    try {
      unzipSync(bytes, { filter: (f) => (names.push(f.name), false) });
    } catch {
      return null;
    }
    if (names.includes('word/document.xml')) return 'docx';
    if (names.includes('xl/workbook.xml')) return 'xlsx';
  }
  return null;
}

/**
 * Đọc một tệp tải lên thành chữ. Ném `DocError` (thông điệp tiếng Việt, dùng thẳng cho người dùng) khi không đọc được.
 */
export async function extractDocument(bytes: Uint8Array, name: string, opts: ExtractOptions): Promise<ExtractedDoc> {
  if (bytes.length > MAX_DOC_BYTES) throw new DocError('too_big', `Tệp quá lớn (${(bytes.length / 1048576).toFixed(1)} MB) — tối đa ${MAX_DOC_BYTES / 1048576} MB.`);
  if (isLegacyOffice(name)) throw new DocError('legacy', `"${name}" là định dạng Office đời cũ (${extOf(name)}) nên chưa đọc được. Hãy mở bằng Word/Excel rồi "Lưu thành" .docx/.xlsx (hoặc xuất PDF) và tải lên lại.`);
  const byExt = DOC_EXTENSIONS[extOf(name)] ?? null;
  const kind = byExt ?? sniffKind(bytes);
  if (!kind) throw new DocError('unsupported', `Chưa hỗ trợ tệp "${name}". Hỗ trợ: PDF, Word (.docx), Excel (.xlsx), HTML, CSV, TXT.`);

  const notes: string[] = [];
  let full = '';
  let pages: number | undefined;
  let sheets: number | undefined;
  let rows: number | undefined;

  if (kind === 'pdf') {
    const { pdfToPages, PdfError } = await import('./pdfText');
    try {
      const r = await pdfToPages(bytes, { maxPages: 600, maxChars: opts.maxChars });
      pages = r.totalPages;
      const bodyChars = r.pages.join('').replace(/\s/g, '').length;
      if (bodyChars < 20 * Math.max(1, r.pages.length) && bodyChars < 400) {
        throw new DocError('scanned', 'PDF này có vẻ là bản quét (chỉ có ảnh, không có lớp chữ) nên chưa đọc được chữ. Hãy chụp/xuất từng trang thành ảnh rồi gửi dưới dạng ảnh, hoặc dùng bản PDF có chữ.');
      }
      full = r.pages.map((p, i) => `[Trang ${i + 1}]\n${p}`).join('\n\n');
      if (r.pages.length < r.totalPages) notes.push(`Chỉ đọc ${r.pages.length}/${r.totalPages} trang đầu (đã đủ ngân sách chữ).`);
    } catch (err) {
      if (err instanceof DocError) throw err;
      if (err instanceof PdfError) throw new DocError(err.code, err.message);
      throw new DocError('corrupt', `Không đọc được PDF (${err instanceof Error ? err.message : String(err)}).`);
    }
  } else if (kind === 'docx') {
    full = docxToText(bytes, notes);
  } else if (kind === 'xlsx') {
    const r = xlsxToText(bytes, notes, opts.maxChars);
    full = r.text;
    sheets = r.sheets;
    rows = r.rows;
  } else if (kind === 'html') {
    const html = decodeBody(bytes, null);
    const r = htmlToMarkdown(html, undefined, { fullDocument: true });
    full = r.title && !r.text.startsWith(`# ${r.title}`) ? `# ${r.title}\n\n${r.text}` : r.text;
  } else {
    const d = decodeText(bytes);
    if (d.guessed) notes.push(`Đã đoán bảng mã ${d.encoding.toUpperCase()} (tệp không phải UTF-8).`);
    full = d.text;
    if (full.includes('\u0000')) throw new DocError('binary', `"${name}" có vẻ là tệp nhị phân, không phải văn bản.`);
    if (kind === 'csv') rows = csvStats(full, extOf(name) === '.tsv' ? '\t' : ',').rows;
  }

  full = sanitizeUploadedText(full).replace(/\n{4,}/g, '\n\n\n').trim();
  if (!full) throw new DocError('empty', `Không thấy chữ nào trong "${name}".`);
  const c = clipText(full, opts.maxChars);
  return { kind, text: c.text, totalChars: c.total, truncated: c.truncated, ...(pages !== undefined ? { pages } : {}), ...(sheets !== undefined ? { sheets } : {}), ...(rows !== undefined ? { rows } : {}), notes };
}
