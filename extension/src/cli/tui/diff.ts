/**
 * Vẽ diff kiểu Claude Code: số dòng, nền đỏ/xanh nhạt, làm nổi phần chữ đổi trong dòng, rút gọn «… +N dòng».
 */

import type { DiffInfo, DiffLine } from '../../shared/protocol';
import type { Theme } from './theme';
import { stringWidth, truncateAnsi, wrapAnsi } from './width';

export interface DiffRenderOptions {
  width: number;
  theme: Theme;
  /** Số dòng diff tối đa khi chưa mở rộng. */
  maxLines?: number;
  expanded?: boolean;
  /** Tiền tố mỗi dòng (ví dụ thụt lề của `⎿`). */
  indent?: string;
  /** Hàm tạo dòng «… +N dòng». */
  moreLabel?: (hidden: number) => string;
}

interface Row {
  t: ' ' | '+' | '-' | '~';
  n?: number;
  s: string;
  /** vùng đổi [from,to) trong s (để làm đậm) */
  hl?: [number, number];
}

function flatten(d: DiffInfo): Row[] {
  const rows: Row[] = [];
  d.hunks.forEach((h, i) => {
    if (i > 0) rows.push({ t: '~', s: '' });
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines as DiffLine[]) {
      if (l.t === ' ') rows.push({ t: ' ', n: n++, s: l.s }), o++;
      else if (l.t === '+') rows.push({ t: '+', n: n++, s: l.s });
      else rows.push({ t: '-', n: o++, s: l.s });
    }
  });
  // ghép cặp khối '-' rồi '+' cùng số dòng để làm nổi phần đổi
  for (let i = 0; i < rows.length; ) {
    if (rows[i].t !== '-') {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].t === '-') j++;
    let k = j;
    while (k < rows.length && rows[k].t === '+') k++;
    const nDel = j - i;
    const nAdd = k - j;
    if (nDel === nAdd && nDel <= 6) {
      for (let x = 0; x < nDel; x++) {
        const a = rows[i + x].s;
        const b = rows[j + x].s;
        let p = 0;
        while (p < a.length && p < b.length && a[p] === b[p]) p++;
        let sa = a.length;
        let sb = b.length;
        while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) {
          sa--;
          sb--;
        }
        const changed = Math.max(sa - p, sb - p);
        if (changed > 0 && changed <= Math.max(a.length, b.length) * 0.7) {
          rows[i + x].hl = [p, sa];
          rows[j + x].hl = [p, sb];
        }
      }
    }
    i = k;
  }
  return rows;
}

export function renderDiff(d: DiffInfo, o: DiffRenderOptions): string[] {
  const th = o.theme;
  const indent = o.indent ?? '';
  const all = flatten(d);
  const max = o.expanded ? Infinity : (o.maxLines ?? 12);
  const shown = all.length > max ? all.slice(0, max) : all;
  const hidden = all.length - shown.length;
  const maxNum = Math.max(1, ...all.map((r) => r.n ?? 0));
  const nw = String(maxNum).length;
  const inner = Math.max(10, o.width - stringWidth(indent));
  const out: string[] = [];
  for (const r of shown) {
    if (r.t === '~') {
      out.push(indent + th.faint(' '.repeat(nw) + ' ' + th.g.ellipsis));
      continue;
    }
    const num = String(r.n ?? '').padStart(nw);
    const sign = r.t === ' ' ? ' ' : r.t;
    const gutter = `${num} ${sign} `;
    const gw = gutter.length;
    const text = r.s.replace(/\t/g, '  ');
    let body = text;
    const style = r.t === '+' ? th.addLine : r.t === '-' ? th.delLine : (s: string) => s;
    const wordStyle = r.t === '+' ? th.addWord : th.delWord;
    if (r.hl && r.t !== ' ') {
      const [a, b] = r.hl;
      body = text.slice(0, a) + (b > a ? wordStyle(text.slice(a, b)) : '') + text.slice(b);
    }
    const lines = wrapAnsi(body, inner - gw, { pre: true });
    lines.forEach((ln, idx) => {
      const g = idx === 0 ? gutter : ' '.repeat(gw);
      const pad = Math.max(0, inner - gw - stringWidth(ln));
      const gutterStyled = r.t === ' ' ? th.faint(g) : r.t === '+' ? th.ok(g) : th.err(g);
      if (r.t === ' ') out.push(indent + gutterStyled + th.muted(ln));
      else out.push(indent + style(gutterStyled + ln + ' '.repeat(pad)));
    });
  }
  if (hidden > 0) {
    const label = o.moreLabel ? o.moreLabel(hidden) : `${th.g.ellipsis} +${hidden}`;
    out.push(indent + th.muted(truncateAnsi(label, inner)));
  }
  if (d.truncated && o.expanded) out.push(indent + th.muted(`${th.g.ellipsis}`));
  return out;
}

/** Nội dung tệp mới (isNew): coi mọi dòng là '+'. */
export function newFileDiff(path: string, content: string): DiffInfo {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { path, added: lines.length, removed: 0, isNew: true, hunks: [{ oldStart: 0, newStart: 1, lines: lines.map((s) => ({ t: '+' as const, s })) }] };
}
