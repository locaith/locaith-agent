/**
 * Markdown → dòng ANSI cho terminal. Một máy trạng thái THEO DÒNG dùng chung cho stream (từng đoạn chữ đến dần) và render một lần.
 *
 * Hỗ trợ: tiêu đề, **đậm**, *nghiêng*, ~~gạch~~, `mã nội dòng`, khối mã có tô màu, danh sách lồng (•, số, [ ]/[x]), trích dẫn, đường kẻ,
 * bảng căn cột (co theo chiều rộng, rơi về dạng bản ghi khi quá hẹp), liên kết (OSC 8 nếu terminal hỗ trợ, nếu không `chữ (url)`).
 *
 * Dòng đã hoàn chỉnh được trả ra ngay (để IN VÀO scrollback); phần dòng dở được cam kết dần theo từng dòng hiển thị khi đã chắc chắn
 * (không còn dấu định dạng chưa đóng), phần còn lại lấy qua `partial()` để vẽ ở vùng sống.
 */

import { highlightLine, langKind, newHlState, type HlState, type LangKind } from './highlight';
import type { Theme } from './theme';
import { padEnd, stringWidth, stripAnsi, truncateAnsi, wrapAnsi } from './width';

export interface MdOptions {
  /** Tổng chiều rộng terminal dành cho khối (đã gồm tiền tố). */
  width: number;
  theme: Theme;
  /** Tiền tố cho dòng nội dung đầu tiên (ví dụ `● `). */
  firstPrefix?: string;
  /** Tiền tố cho các dòng còn lại (ví dụ `  `). */
  prefix?: string;
}

// ───────────────────────── inline ─────────────────────────

const INLINE_RE = new RegExp(
  [
    '(?<code>(?<cq>`+)(?!`)(?<codeText>.+?)(?<!`)\\k<cq>(?!`))',
    '(?<img>!\\[(?<imgAlt>[^\\]]*)\\]\\((?<imgUrl>[^)\\s]+)[^)]*\\))',
    '(?<link>\\[(?<linkText>[^\\]]+)\\]\\((?<linkUrl>[^)\\s]+)(?:\\s+"[^"]*")?\\))',
    '(?<bold>(?<bq>\\*\\*|__)(?=\\S)(?<boldText>.+?)(?<=\\S)\\k<bq>)',
    '(?<strike>~~(?=\\S)(?<strikeText>.+?)(?<=\\S)~~)',
    '(?<it>(?<![\\w*\\\\])\\*(?![\\s*])(?<itText>[^*]+?)(?<![\\s*\\\\])\\*(?!\\*))',
    '(?<it2>(?<![\\w_\\\\])_(?![\\s_])(?<it2Text>[^_]+?)(?<![\\s_\\\\])_(?![\\w_]))',
    '(?<url>https?://[^\\s<>"\']+[^\\s<>"\'.,;:!?)\\]])',
  ].join('|'),
  'u',
);

/** Chuẩn hoá một chuỗi chữ thường: bỏ `\` trước ký tự markdown. */
function unescapeMd(s: string): string {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1');
}

export function renderInline(text: string, th: Theme): string {
  let out = '';
  let rest = text;
  while (rest) {
    const m = INLINE_RE.exec(rest);
    if (!m || !m.groups) {
      out += unescapeMd(rest);
      break;
    }
    out += unescapeMd(rest.slice(0, m.index));
    const g = m.groups;
    if (g.code !== undefined) out += th.code(g.codeText.replace(/^ (.*) $/, '$1'));
    else if (g.img !== undefined) out += th.muted(`[${g.imgAlt || 'ảnh'}]`);
    else if (g.link !== undefined) {
      const label = renderInline(g.linkText, th);
      out += th.caps.hyperlinks ? th.link(g.linkUrl, th.underline(label)) : `${th.underline(label)} ${th.muted('(' + g.linkUrl + ')')}`;
    } else if (g.bold !== undefined) out += th.bold(renderInline(g.boldText, th));
    else if (g.strike !== undefined) out += th.strike(renderInline(g.strikeText, th));
    else if (g.it !== undefined) out += th.italic(renderInline(g.itText, th));
    else if (g.it2 !== undefined) out += th.italic(renderInline(g.it2Text, th));
    else if (g.url !== undefined) out += th.caps.hyperlinks ? th.link(g.url, th.underline(g.url)) : th.underline(g.url);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Còn dấu định dạng chưa đóng (ví dụ `**đậm` chưa thấy `**`)? Khi đó chưa cam kết các hàng đã ngắt. */
function hasOpenMarkup(s: string): boolean {
  if ((s.match(/`/g) ?? []).length % 2) return true;
  if ((s.match(/\*\*/g) ?? []).length % 2) return true;
  if ((s.match(/~~/g) ?? []).length % 2) return true;
  const stripped = s.replace(/\*\*/g, '');
  if ((stripped.match(/(?<![\w*])\*(?!\s)/g) ?? []).length % 2) return true;
  const opens = (s.match(/\[/g) ?? []).length;
  const closes = (s.match(/\]\([^)]*\)/g) ?? []).length;
  if (opens > closes) return true;
  if (/\]\([^)]*$/.test(s)) return true;
  return false;
}

// ───────────────────────── bảng ─────────────────────────

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isSepRow = (line: string): boolean => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const looksLikeRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);

type Align = 'l' | 'r' | 'c';

export function renderTable(rows: string[], width: number, th: Theme): string[] {
  const head = splitRow(rows[0]);
  const aligns: Align[] = splitRow(rows[1]).map((c) => (/^:-+:$/.test(c) ? 'c' : /-:$/.test(c) ? 'r' : 'l'));
  const body = rows.slice(2).map(splitRow);
  const ncol = Math.max(head.length, ...body.map((r) => r.length));
  const norm = (r: string[]): string[] => Array.from({ length: ncol }, (_, i) => renderInline(r[i] ?? '', th));
  const H = norm(head);
  const B = body.map(norm);
  const natural = Array.from({ length: ncol }, (_, c) => Math.max(stringWidth(H[c]), ...B.map((r) => stringWidth(r[c])), 1));
  const g = th.g;
  const chrome = ncol * 3 + 1; // │ a │ b │
  const avail = width - chrome;
  const minW = 5;
  if (avail < ncol * 3) return recordList([H, ...B], width, th);
  const cw = natural.slice();
  if (cw.reduce((a, b) => a + b, 0) > avail) {
    // co các cột rộng nhất dần về mức vừa
    const total = (): number => cw.reduce((a, b) => a + b, 0);
    while (total() > avail) {
      let idx = 0;
      for (let i = 1; i < ncol; i++) if (cw[i] > cw[idx]) idx = i;
      if (cw[idx] <= Math.min(minW, natural[idx])) break;
      cw[idx]--;
    }
    if (total() > avail) return recordList([H, ...B], width, th);
  }
  const rule = (l: string, m: string, r: string): string => th.faint(l + cw.map((x) => g.h.repeat(x + 2)).join(m) + r);
  const vbar = th.faint(g.v);
  const cell = (txt: string, c: number, bold: boolean): string[] => {
    const lines = wrapAnsi(bold ? th.bold(txt) : txt, cw[c]);
    return lines.length ? lines : [''];
  };
  const fmtRow = (r: string[], bold: boolean): string[] => {
    const cells = r.map((t, c) => cell(t, c, bold));
    const h = Math.max(...cells.map((x) => x.length));
    const out: string[] = [];
    for (let k = 0; k < h; k++) {
      const parts = cells.map((lines, c) => {
        const t = lines[k] ?? '';
        const pad = Math.max(0, cw[c] - stringWidth(t));
        if (aligns[c] === 'r') return ' '.repeat(pad) + t;
        if (aligns[c] === 'c') return ' '.repeat(Math.floor(pad / 2)) + t + ' '.repeat(pad - Math.floor(pad / 2));
        return t + ' '.repeat(pad);
      });
      out.push(vbar + ' ' + parts.join(' ' + vbar + ' ') + ' ' + vbar);
    }
    return out;
  };
  const out: string[] = [rule(g.tl, g.h === '-' ? '+' : '┬', g.tr)];
  out.push(...fmtRow(H, true));
  out.push(rule(g.h === '-' ? '+' : '├', g.h === '-' ? '+' : '┼', g.h === '-' ? '+' : '┤'));
  for (const r of B) out.push(...fmtRow(r, false));
  out.push(rule(g.bl, g.h === '-' ? '+' : '┴', g.br));
  return out;
}

/** Bảng quá hẹp: mỗi hàng thành một khối «tiêu đề: giá trị». */
function recordList(rows: string[][], width: number, th: Theme): string[] {
  const [head, ...body] = rows;
  const out: string[] = [];
  body.forEach((r, i) => {
    r.forEach((v, c) => {
      const label = th.muted((stripAnsi(head[c]) || String(c + 1)) + ': ');
      out.push(...wrapAnsi(v, Math.max(8, width), { first: label, rest: '  ' }));
    });
    if (i < body.length - 1) out.push('');
  });
  return out;
}

// ───────────────────────── máy trạng thái ─────────────────────────

interface Fence {
  marker: string;
  lang: string;
  kind: LangKind;
  hl: HlState;
}

export class MarkdownStream {
  private buf = '';
  private fence: Fence | null = null;
  private table: string[] = [];
  /** Số hàng của dòng dở đã cam kết, và chữ thuần của chúng. */
  private committedRows = 0;
  private committedPlain = '';
  private emitted = false;
  private lastBlank = true;
  private readonly o: Required<MdOptions>;
  private readonly cw: number;

  constructor(o: MdOptions) {
    this.o = { firstPrefix: o.firstPrefix ?? '', prefix: o.prefix ?? '', width: o.width, theme: o.theme };
    this.cw = Math.max(10, o.width - Math.max(stringWidth(this.o.firstPrefix), stringWidth(this.o.prefix)));
  }

  /** Đã in dòng nội dung nào chưa (để người gọi biết `firstPrefix` đã dùng). */
  get started(): boolean {
    return this.emitted;
  }

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      out.push(...this.completeLine(line));
    }
    out.push(...this.commitPartial());
    return out;
  }

  /** Hết văn bản: xả dòng dở, đóng khối mã/bảng. */
  finish(): string[] {
    const out: string[] = [];
    if (this.buf) {
      const line = this.buf.replace(/\r$/, '');
      this.buf = '';
      out.push(...this.completeLine(line));
    }
    out.push(...this.flushTable());
    if (this.fence) {
      out.push(...this.emit([this.codeFoot()]));
      this.fence = null;
    }
    return out;
  }

  /** Các hàng đang dở (chưa cam kết) để vẽ ở vùng sống — đã gồm tiền tố. */
  partial(): string[] {
    const rows: string[] = [];
    if (this.table.length) rows.push(...this.table.map((r) => this.o.theme.faint(truncateAnsi(r, this.cw))));
    if (this.buf) {
      if (this.fence) {
        const hl = highlightLine(this.fence.kind, this.buf, this.o.theme, { ...this.fence.hl });
        rows.push(...wrapAnsi(hl, this.cw - 2, { pre: true, first: this.o.theme.faint(this.o.theme.g.v + ' '), rest: this.o.theme.faint(this.o.theme.g.v + ' ') }));
      } else {
        const all = this.renderPlainLine(this.buf);
        rows.push(...all.slice(this.committedRows));
      }
    }
    return this.decorate(rows, true);
  }

  // ── nội bộ ──

  private decorate(rows: string[], peek: boolean): string[] {
    const { firstPrefix, prefix } = this.o;
    let first = !this.emitted;
    const out: string[] = [];
    for (const r of rows) {
      if (r === '') {
        out.push('');
        continue;
      }
      out.push((first ? firstPrefix : prefix) + r);
      first = false;
    }
    if (!peek) {
      /* trạng thái cập nhật ở emit() */
    }
    return out;
  }

  private emit(rows: string[]): string[] {
    const out: string[] = [];
    for (const r of rows) {
      if (r === '') {
        if (this.lastBlank) continue; // gộp dòng trống, bỏ dòng trống đầu
        this.lastBlank = true;
        out.push('');
        continue;
      }
      out.push((this.emitted ? this.o.prefix : this.o.firstPrefix) + r);
      this.emitted = true;
      this.lastBlank = false;
    }
    return out;
  }

  private codeHead(lang: string): string {
    const th = this.o.theme;
    const label = lang ? ` ${lang}` : '';
    return th.faint(th.g.tl + th.g.h) + th.muted(label);
  }

  private codeFoot(): string {
    const th = this.o.theme;
    return th.faint(th.g.bl + th.g.h);
  }

  private flushTable(): string[] {
    if (!this.table.length) return [];
    const rows = this.table;
    this.table = [];
    if (rows.length >= 2 && isSepRow(rows[1])) return this.emit(renderTable(rows, this.cw, this.o.theme));
    // không phải bảng thật: xử lý như dòng thường
    const out: string[] = [];
    for (const r of rows) out.push(...this.emit(this.renderPlainLine(r)));
    return out;
  }

  private completeLine(line: string): string[] {
    const th = this.o.theme;
    const out: string[] = [];
    const wasPartial = this.committedRows;
    const plainBefore = this.committedPlain;
    this.committedRows = 0;
    this.committedPlain = '';

    // khối mã
    if (this.fence) {
      const t = line.trim();
      if (t.startsWith(this.fence.marker) && /^[`~]+$/.test(t)) {
        out.push(...this.emit([this.codeFoot()]));
        this.fence = null;
        return out;
      }
      const hl = highlightLine(this.fence.kind, line.replace(/\t/g, '  '), th, this.fence.hl);
      const g = th.faint(th.g.v + ' ');
      out.push(...this.emit(wrapAnsi(hl, this.cw - 2, { pre: true, first: g, rest: g })));
      return out;
    }
    const fm = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fm) {
      out.push(...this.flushTable());
      this.fence = { marker: fm[1], lang: fm[2], kind: langKind(fm[2]), hl: newHlState() };
      if (!this.lastBlank) out.push(...this.emit(['']));
      out.push(...this.emit([this.codeHead(fm[2])]));
      return out;
    }

    // bảng
    if (looksLikeRow(line) || (this.table.length === 1 && isSepRow(line))) {
      this.table.push(line);
      return out;
    }
    if (this.table.length) out.push(...this.flushTable());

    if (line.trim() === '') {
      out.push(...this.emit(['']));
      return out;
    }
    let rows = this.renderPlainLine(line);
    // bỏ các hàng đã cam kết khi còn là dòng dở (nếu khớp chữ)
    if (wasPartial > 0) {
      const finalPlain = rows.map(stripAnsi);
      let acc = '';
      let skip = 0;
      for (let i = 0; i < finalPlain.length && acc.length < plainBefore.length; i++) {
        acc += finalPlain[i];
        skip = i + 1;
      }
      rows = rows.slice(acc === plainBefore ? skip : Math.min(wasPartial, rows.length));
    }
    out.push(...this.emit(rows));
    return out;
  }

  /** Dòng đơn (tiêu đề, danh sách, trích dẫn, đường kẻ, đoạn) → các hàng đã ngắt theo chiều rộng. */
  private renderPlainLine(line: string): string[] {
    const th = this.o.theme;
    const w = this.cw;
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      const level = m[1].length;
      const txt = renderInline(m[2], th);
      const styled = level <= 2 ? th.heading(txt) : th.bold(txt);
      return ['', ...wrapAnsi(styled, w), ''];
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return [th.faint(th.g.rule.repeat(Math.min(w, 48)))];
    if ((m = /^(\s*)>\s?(.*)$/.exec(line))) {
      const bar = th.faint(th.g.quote + ' ');
      return wrapAnsi(th.italic(th.muted(renderInline(m[2], th))), w - 2, { first: bar, rest: bar });
    }
    if ((m = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line))) {
      const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
      const ind = '  '.repeat(Math.min(depth, 6));
      const numeric = /\d/.test(m[2]);
      let marker = numeric ? th.muted(m[2]) : th.g.listBullet;
      let body = m[4];
      if (m[3]) {
        const done = /x/i.test(m[3]);
        marker = done ? th.ok(th.g.todo.completed) : th.muted(th.g.todo.pending);
        body = done ? th.muted(renderInline(body, th)) : renderInline(body, th);
      } else body = renderInline(body, th);
      const mw = stringWidth(numeric ? m[2] : m[3] ? th.g.todo.completed : th.g.listBullet);
      const first = ind + marker + ' ';
      return wrapAnsi(body, w, { first, rest: ind + ' '.repeat(mw + 1) });
    }
    const lead = /^(\s+)/.exec(line);
    const ind = lead ? ' '.repeat(Math.min(lead[1].replace(/\t/g, '  ').length, 8)) : '';
    return wrapAnsi(renderInline(line.trim(), th), w, { first: ind, rest: ind });
  }

  /** Cam kết các hàng ĐÃ NGẮT của dòng dở khi chắc chắn (không còn dấu mở). */
  private commitPartial(): string[] {
    if (this.fence || !this.buf || this.table.length) return [];
    if (/^\s*(`{3,}|~{3,})/.test(this.buf) || /^\s*#{1,6}(\s|$)/.test(this.buf) || looksLikeRow(this.buf) || /^\s*\|/.test(this.buf)) return [];
    const rows = this.renderPlainLine(this.buf);
    if (rows.length < 2) return [];
    const stable = rows.length - 1; // hàng cuối còn có thể đổi
    const could = hasOpenMarkup(this.buf) ? (rows.length > 14 ? rows.length - 8 : 0) : stable;
    if (could <= this.committedRows) return [];
    const fresh = rows.slice(this.committedRows, could);
    this.committedRows = could;
    this.committedPlain = rows.slice(0, could).map(stripAnsi).join('');
    return this.emit(fresh);
  }
}

/** Render một lần cả văn bản. */
export function renderMarkdown(text: string, o: MdOptions): string[] {
  const s = new MarkdownStream(o);
  const out = s.push(text);
  out.push(...s.finish());
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export { padEnd };
