/**
 * BẢNG AGENT của một workflow (hộp «Agents in this turn», 0.7.7) — kiểu bảng agent của Claude Code, phẳng, không vạch dọc:
 *   tiêu đề + tổng «3 chạy · 12 chờ · 20 xong · 2 lỗi» + thanh tiến độ nhiều đoạn + dải giới hạn/lỗi, bộ lọc, rồi các dòng agent gom theo pha:
 *   [chấm] tên/mô tả · loại · model ........ đồng hồ · token · lệnh, và dòng thứ hai = việc đang làm / lý do lỗi / trích báo cáo; bấm dòng để mở chi tiết.
 * Thứ tự: đang chạy > lỗi > xếp hàng > xong (mới nhất trước); nhiều agent thì gập bớt «đã xong» (hiện 3 cái mới nhất + «+N đã xong»).
 * Dữ liệu từ `AgentProgress.wf` (host dựng ở core/agents/progress.ts). Logic sắp/gom nằm ở `../../agentBoard.ts` (thuần, có test).
 */
import { useMemo, useState } from 'preact/hooks';
import type { AgentRunRow, ToolBlock, WfProgress } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { buildBoard, meterSegments, rowElapsedMs, summarize, type BoardFilter } from '../../agentBoard';
import { formatCompact, formatDuration, formatInt } from '../../format';
import { cx } from '../../util';
import { useNow } from './useTick';

const FILTERS: BoardFilter[] = ['all', 'active', 'error', 'done'];

function Row({ r, now, concurrent }: { r: AgentRunRow; now: number; concurrent?: number }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const ms = rowElapsedMs(r, now);
  const second = r.state === 'error' || r.state === 'stopped' ? r.error : r.state === 'running' ? r.activity : r.state === 'queued' ? t('ab.queuedhint', { conc: concurrent ?? '' }) : r.preview;
  const sub = [r.type, r.model].filter(Boolean).join(' · ');
  const stats = [ms !== undefined ? formatDuration(ms, lang) : '', r.tokens ? t('ab.tokens', { n: formatCompact(r.tokens, lang) }) : '', r.tools ? t('ab.tools', { n: formatInt(r.tools, lang) }) : ''].filter(Boolean).join(' · ');
  const title = r.label || r.type || `#${r.n}`;
  const detail = open && (r.error || r.preview || r.activity || sub);
  return (
    <li class={cx('ab-row', `is-${r.state}`, open && 'is-open')} role="listitem">
      <button type="button" class="ab-row-main" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={[title, sub, second].filter(Boolean).join('\n')}>
        <span class="ab-dot" data-state={r.state} aria-label={t(`ab.state.${r.state}`)} role="img" />
        <span class="ab-name">
          <b class="ab-n">{r.n}</b>
          <span class="ab-title">{title}</span>
          {sub && <span class="ab-sub">{sub}</span>}
        </span>
        {stats && <span class="ab-num">{stats}</span>}
      </button>
      {second && !open && (
        <div class={cx('ab-second', r.state === 'error' && 'is-err', r.state === 'running' && 'is-act')} title={second}>
          {second}
        </div>
      )}
      {detail && (
        <dl class="ab-detail">
          {r.model && (
            <>
              <dt>{t('ab.model')}</dt>
              <dd>{r.model}</dd>
            </>
          )}
          {r.type && (
            <>
              <dt>{t('ab.type')}</dt>
              <dd>{r.type}</dd>
            </>
          )}
          {r.state === 'running' && r.activity && (
            <>
              <dt>{t('ab.state.running')}</dt>
              <dd>{r.activity}</dd>
            </>
          )}
          {r.error && (
            <>
              <dt>{t('ab.reason')}</dt>
              <dd class="is-err">{r.error}</dd>
            </>
          )}
          {r.preview && (
            <>
              <dt>{t('ab.report')}</dt>
              <dd>{r.preview}</dd>
            </>
          )}
        </dl>
      )}
    </li>
  );
}

export function AgentBoard({ block, wf }: { block: ToolBlock; wf: WfProgress }) {
  const { t, lang } = useApp();
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [showDone, setShowDone] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const live = wf.counts.running > 0 || wf.counts.queued > 0 || block.state === 'running';
  const now = useNow(live);
  const model = useMemo(() => buildBoard(wf, { filter, showDone, collapsed }), [wf, filter, showDone, collapsed]);
  const sum = summarize(wf.counts, { running: t('ab.running'), queued: t('ab.queued'), done: t('ab.finished'), error: t('ab.error') });
  const segs = meterSegments(wf.counts);
  const elapsed = block.startedAt ? (block.durationMs ?? Math.max(0, now - block.startedAt)) : undefined;
  const lim = wf.limits;
  const limText = lim ? t('ab.limits', { max: formatInt(lim.maxAgents, lang), conc: lim.concurrent, budget: lim.tokenBudget === null ? t('ab.nobudget') : t('ab.budget', { n: formatCompact(lim.tokenBudget, lang) }) }) : '';
  const toggle = (name: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const title = typeof block.args?.description === 'string' && block.args.description.trim() ? block.args.description.trim() : t('ab.done');
  return (
    <section class="ab" aria-label={title}>
      <header class="ab-head">
        <span class="ab-head-title" title={title}>
          {title}
        </span>
        {elapsed !== undefined && elapsed >= 1000 && <span class="ab-head-time">{formatDuration(elapsed, lang)}</span>}
      </header>
      <div class="ab-sum" aria-live="off">
        {sum || t('agent.chip.done')}
      </div>
      {segs.length > 0 && (
        <div class="ab-meter" role="img" aria-label={t('ab.meter', { done: wf.counts.done, running: wf.counts.running, error: wf.counts.error + wf.counts.stopped, queued: wf.counts.queued, total: wf.counts.total })}>
          {segs.map((s) => (
            <span key={s.state} class={cx('ab-seg', `is-${s.state}`)} style={{ flexGrow: s.frac }} />
          ))}
        </div>
      )}
      {limText && <div class="ab-limits">{limText}</div>}
      {wf.hit && (
        <div class="ab-limit is-warn" role="status">
          {t(wf.hit.kind === 'tokens' ? 'ab.limit.tokens' : 'ab.limit.agents', { limit: formatCompact(wf.hit.limit, lang), n: wf.hit.skipped })}
        </div>
      )}
      <div class="ab-filter" role="group" aria-label={t('ab.filter')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" class={cx('ab-chip', filter === f && 'is-on')} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`ab.f.${f}`)}
          </button>
        ))}
      </div>
      <div class="ab-body" role="list">
        {model.groups.map((g) => (
          <div key={g.name} class="ab-group">
            {model.phased && (
              <button type="button" class="ab-group-head" aria-expanded={!collapsed.has(g.name)} onClick={() => toggle(g.name)}>
                <span class="ab-group-name">{g.name ? t('ab.phase', { name: g.name }) : t('ab.nophase')}</span>
                <span class="ab-group-count">
                  {g.done + g.error}/{g.total}
                  {g.error > 0 && <b class="is-err"> · {g.error} {t('ab.error')}</b>}
                </span>
              </button>
            )}
            <ul class="ab-rows" role="list">
              {g.rows.map((r) => (
                <Row key={r.n} r={r} now={now} concurrent={lim?.concurrent} />
              ))}
            </ul>
            {g.folded > 0 && !collapsed.has(g.name) && (
              <button type="button" class="ab-more" onClick={() => setShowDone(true)}>
                {t('ab.more.done', { n: g.folded })}
              </button>
            )}
          </div>
        ))}
        {showDone && model.matched > 12 && (
          <button type="button" class="ab-more" onClick={() => setShowDone(false)}>
            {t('ab.hide.done')}
          </button>
        )}
        {model.matched === 0 && wf.rows.length > 0 && <div class="ab-unlisted">{t('ab.empty')}</div>}
        {model.unlisted > 0 && filter === 'all' && <div class="ab-unlisted">{t('ab.unlisted', { n: formatInt(model.unlisted, lang) })}</div>}
      </div>
    </section>
  );
}
