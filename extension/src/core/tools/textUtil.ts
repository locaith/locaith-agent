import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';
import type { DiffHunk, DiffInfo, DiffLine } from '../../shared/protocol';
import { sliceSafe } from '../textSafe';

export function sha1(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

export function detectEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/** Đổi mọi kiểu xuống dòng về `eol`. */
export function withEol(s: string, eol: '\r\n' | '\n'): string {
  const lf = s.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/** Đánh số dòng kiểu `cat -n` để model tham chiếu; số dòng KHÔNG thuộc nội dung tệp. */
export function numberLines(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(Math.max(width, 4))}\t${l}`).join('\n');
}

const MAX_DIFF_LINES = 400;

export function makeDiff(displayPath: string, before: string, after: string, isNew = false): DiffInfo {
  const patch = structuredPatch(displayPath, displayPath, before, after, '', '', { context: 3 });
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let shown = 0;
  let truncated = false;
  for (const h of patch.hunks) {
    const lines: DiffLine[] = [];
    for (const raw of h.lines) {
      const mark = raw[0];
      if (mark !== ' ' && mark !== '+' && mark !== '-') continue; // bỏ "\ No newline at end of file"
      if (mark === '+') added++;
      else if (mark === '-') removed++;
      if (shown >= MAX_DIFF_LINES) {
        truncated = true;
        continue;
      }
      shown++;
      lines.push({ t: mark, s: raw.slice(1).replace(/\r$/, '') });
    }
    if (lines.length > 0) hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines });
  }
  return { path: displayPath, added, removed, hunks, isNew: isNew || undefined, truncated: truncated || undefined };
}

export function plural(n: number, one: string): string {
  return `${n.toLocaleString('en-US')} ${one}`;
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : sliceSafe(s, 0, max - 1) + '…';
}
