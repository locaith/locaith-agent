import { useMemo, useState } from 'preact/hooks';
import type { DiffInfo } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { cx } from '../../util';
import { post } from '../../vscode';
import { Icon } from '../Icons';

type Row =
  | { k: 'hunk'; header: string }
  | { k: 'line'; sign: ' ' | '+' | '-'; text: string; num: number };

function flatten(diff: DiffInfo): Row[] {
  const rows: Row[] = [];
  for (const h of diff.hunks) {
    const oldLen = h.lines.filter((l) => l.t !== '+').length;
    const newLen = h.lines.filter((l) => l.t !== '-').length;
    rows.push({ k: 'hunk', header: `@@ -${h.oldStart},${oldLen} +${h.newStart},${newLen} @@` });
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      if (l.t === ' ') {
        rows.push({ k: 'line', sign: ' ', text: l.s, num: n });
        o++;
        n++;
      } else if (l.t === '+') {
        rows.push({ k: 'line', sign: '+', text: l.s, num: n });
        n++;
      } else {
        rows.push({ k: 'line', sign: '-', text: l.s, num: o });
        o++;
      }
    }
  }
  return rows;
}

export function DiffView({ diff, callId, collapsedRows = 18 }: { diff: DiffInfo; callId?: string; collapsedRows?: number }) {
  const { t } = useApp();
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => flatten(diff), [diff]);
  const visible = expanded ? rows : rows.slice(0, collapsedRows);
  const hidden = rows.length - visible.length;

  return (
    <div class="diff">
      <div class="diff-head">
        <button type="button" class="diff-path" title={diff.path} onClick={() => post({ type: 'open_file', path: diff.path })}>
          <Icon name="file-text" size={13} />
          <span>{diff.path}</span>
        </button>
        {diff.isNew && <span class="badge badge-ok">{t('diff.newFile')}</span>}
        <span class="diff-stat">
          <span class="diff-stat-add">+{diff.added}</span>
          <span class="diff-stat-del">−{diff.removed}</span>
        </span>
        {callId && (
          <button type="button" class="diff-open" onClick={() => post({ type: 'open_diff', callId })} title={t('tool.openDiff')}>
            <Icon name="external" size={13} />
            <span>{t('tool.openDiff')}</span>
          </button>
        )}
      </div>
      <div class="diff-body" tabIndex={0}>
        <div class="diff-inner">
          {visible.map((r, i) =>
            r.k === 'hunk' ? (
              <div class="diff-hunk" key={i}>
                {r.header}
              </div>
            ) : (
              <div class={cx('diff-line', r.sign === '+' && 'is-add', r.sign === '-' && 'is-del')} key={i}>
                <span class="diff-num">{r.num}</span>
                <span class="diff-sign" aria-hidden="true">
                  {r.sign === ' ' ? '' : r.sign === '+' ? '+' : '−'}
                </span>
                <span class="diff-text">{r.text || '​'}</span>
              </div>
            ),
          )}
        </div>
      </div>
      {(hidden > 0 || expanded) && rows.length > collapsedRows && (
        <button type="button" class="diff-more" onClick={() => setExpanded((v) => !v)}>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />
          {expanded ? t('tool.showLess') : t('tool.showMore', { n: hidden })}
        </button>
      )}
      {diff.truncated && <div class="diff-truncated">{t('diff.truncated')}</div>}
    </div>
  );
}
