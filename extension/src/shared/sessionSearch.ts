/**
 * (lane:sessions-ux) Tìm toàn văn trong lịch sử trò chuyện: tiêu đề + chữ của tin nhắn người dùng và câu trả lời của trợ lý.
 *
 * - Chỉ mục nhẹ dựng LƯỜI khi có truy vấn đầu tiên (mở màn Lịch sử rồi gõ), giữ trong bộ nhớ theo `updatedAt` — cuộc đổi thì đọc lại.
 * - Quét theo LÔ (vài cuộc mỗi lô, nhường luồng giữa các lô) và báo kết quả dần: kho lớn không làm treo giao diện/host.
 * - Không phân biệt hoa/thường và DẤU tiếng Việt ("tai lieu" khớp "Tài liệu", "dang" khớp "Đặng") nhờ phép gập GIỮ ĐỘ DÀI:
 *   mỗi ký tự (sau NFC) gập thành đúng một ký tự, nên vị trí khớp trong bản gập = vị trí trong bản gốc → làm nổi được đúng chỗ.
 *
 * Thuần tuý (không vscode/node) — dùng chung bản VS Code và bản trình duyệt.
 */

import type { TItem } from './protocol';
import type { SessionSearchHit } from './sessionsUxTypes';

const COMBINING = /[̀-ͯ]/g;

/** Gập một chuỗi (đã NFC) mà GIỮ NGUYÊN độ dài: bỏ dấu, đ→d, chữ thường. */
export function foldKeep(s: string): string {
  let out = '';
  for (const ch of s) {
    // for…of đi theo điểm mã: cặp thay thế (emoji) giữ nguyên 2 đơn vị UTF-16 để độ dài khớp.
    if (ch.length > 1) {
      out += ch;
      continue;
    }
    let f = ch.normalize('NFD').replace(COMBINING, '');
    if (f === 'đ' || f === 'Đ') f = 'd';
    f = f.toLowerCase();
    out += f.length === 1 ? f : f.length === 0 ? ' ' : f[0];
  }
  return out;
}

/** Gập truy vấn: NFC rồi gập, gộp khoảng trắng. */
export function foldQuery(q: string): string[] {
  return foldKeep(q.normalize('NFC')).trim().split(/\s+/).filter(Boolean).slice(0, 8);
}

/** Chữ tìm được của một transcript (user + văn bản trả lời), đã NFC, cắt ở `max` ký tự. */
export function transcriptText(items: readonly TItem[], max = 400_000): string {
  const parts: string[] = [];
  let n = 0;
  for (const it of items) {
    let s = '';
    if (it.kind === 'user') s = it.text;
    else if (it.kind === 'assistant') s = it.blocks.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
    if (!s) continue;
    parts.push(s);
    n += s.length + 1;
    if (n >= max) break;
  }
  return parts.join('\n').normalize('NFC').slice(0, max);
}

interface Doc {
  updatedAt: number;
  title: string;
  ftitle: string;
  text: string;
  ftext: string;
}

const SNIPPET = 160;

/** So một tài liệu với các token đã gập. null = không khớp. */
export function matchDoc(doc: { title: string; text: string; ftitle?: string; ftext?: string }, tokens: readonly string[], id = ''): SessionSearchHit | null {
  if (tokens.length === 0) return null;
  const ftitle = doc.ftitle ?? foldKeep(doc.title.normalize('NFC'));
  const ftext = doc.ftext ?? foldKeep(doc.text);
  let inTitle = true;
  for (const tk of tokens) {
    const t = ftitle.includes(tk);
    if (!t && !ftext.includes(tk)) return null;
    if (!t) inTitle = false;
  }
  const first = ftext.indexOf(tokens[0]);
  const hit: SessionSearchHit = { id, inTitle, count: 0 };
  if (first < 0) return hit;
  let count = 0;
  for (let i = first; i >= 0 && count < 99; i = ftext.indexOf(tokens[0], i + tokens[0].length)) count++;
  hit.count = count;
  // Cửa sổ trích đoạn quanh chỗ khớp đầu tiên, nở ra tới ranh giới khoảng trắng.
  let start = Math.max(0, first - 50);
  let end = Math.min(doc.text.length, start + SNIPPET);
  if (start > 0) {
    const sp = doc.text.lastIndexOf(' ', first);
    if (sp > start - 20 && sp < first) start = sp + 1;
  }
  const raw = doc.text.slice(start, end);
  const lead = start > 0 ? '…' : '';
  const tail = end < doc.text.length ? '…' : '';
  // Thay xuống dòng bằng khoảng trắng mà không đổi độ dài.
  const snippet = lead + raw.replace(/[\r\n\t]/g, ' ') + tail;
  const fwin = ftext.slice(start, end);
  const marks: Array<[number, number]> = [];
  for (const tk of tokens) {
    for (let i = fwin.indexOf(tk); i >= 0 && marks.length < 24; i = fwin.indexOf(tk, i + tk.length)) marks.push([i + lead.length, i + lead.length + tk.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  // Gộp khoảng chồng nhau.
  const merged: Array<[number, number]> = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  hit.snippet = snippet;
  hit.marks = merged;
  return hit;
}

export interface SearchTarget {
  id: string;
  title: string;
  updatedAt: number;
}

export type SearchLoader = (id: string) => Promise<{ title: string; transcript: TItem[] } | null>;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class SessionSearchIndex {
  private readonly docs = new Map<string, Doc>();
  private gen = 0;

  constructor(
    private readonly load: SearchLoader,
    private readonly opts: { batch?: number; maxChars?: number } = {},
  ) {}

  /** Số cuộc đã nằm trong chỉ mục (kiểm thử). */
  get size(): number {
    return this.docs.size;
  }

  private async doc(t: SearchTarget): Promise<Doc | null> {
    const have = this.docs.get(t.id);
    if (have && have.updatedAt === t.updatedAt) {
      if (have.title !== t.title) {
        have.title = t.title;
        have.ftitle = foldKeep(t.title.normalize('NFC'));
      }
      return have;
    }
    const p = await this.load(t.id).catch(() => null);
    if (!p) return null;
    const text = transcriptText(p.transcript, this.opts.maxChars);
    const title = t.title || p.title || '';
    const d: Doc = { updatedAt: t.updatedAt, title, ftitle: foldKeep(title.normalize('NFC')), text, ftext: foldKeep(text) };
    this.docs.set(t.id, d);
    return d;
  }

  /**
   * Tìm `query` trong các cuộc `targets` (đã xếp theo thứ tự muốn hiện). Gọi `onBatch(hits, done)` sau mỗi lô với TOÀN BỘ kết quả tới lúc đó.
   * Truy vấn mới hơn bắt đầu thì lần tìm cũ tự dừng (không gọi `onBatch` nữa).
   */
  async search(targets: readonly SearchTarget[], query: string, onBatch: (hits: SessionSearchHit[], done: boolean) => void): Promise<void> {
    const my = ++this.gen;
    const tokens = foldQuery(query);
    const hits: SessionSearchHit[] = [];
    if (tokens.length === 0) {
      onBatch(hits, true);
      return;
    }
    const batch = Math.max(1, this.opts.batch ?? 12);
    const live = new Set(targets.map((t) => t.id));
    for (const k of [...this.docs.keys()]) if (!live.has(k)) this.docs.delete(k); // cuộc đã xoá
    for (let i = 0; i < targets.length; i += batch) {
      for (const t of targets.slice(i, i + batch)) {
        const d = await this.doc(t);
        if (my !== this.gen) return;
        if (!d) continue;
        const h = matchDoc(d, tokens, t.id);
        if (h) hits.push(h);
      }
      if (my !== this.gen) return;
      const done = i + batch >= targets.length;
      onBatch([...hits], done);
      if (!done) await tick();
      if (my !== this.gen) return;
    }
    if (targets.length === 0) onBatch(hits, true);
  }
}
