/**
 * Chip số agent con đang chạy. Bấm vào: BẢNG AGENT (kiểu Claude Code) — workflow nhiều agent hiện từng agent (đang chạy / chờ / xong / lỗi, theo pha, có tổng + thanh tiến độ + bộ lọc),
 * agent lẻ hiện một dòng. Đóng bằng bấm ra ngoài / Esc / bấm lại chip (0.7.7: bỏ kiểu «rời chuột là đóng» — hộp cao phủ lên chip nên tự đóng khi đang đọc).
 */
import { useMemo, useRef, useState } from 'preact/hooks';
import type { ViewState } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { formatCompact, formatDuration, formatInt } from '../../format';
import { describeTool } from '../../toolLabels';
import { agentStats } from '../../timeline';
import { cx, useDismiss } from '../../util';
import { LoSpinner } from '../Brand';
import { Icon } from '../Icons';
import { AgentBoard } from '../timeline/AgentBoard';
import { agentsOf, liveCount } from '../../agentBoard';

const STATE_LABEL: Record<string, string> = { running: 'running', error: 'error', done: 'done' };

export function AgentChip({ view }: { view: ViewState }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));
  const agents = useMemo(() => agentsOf(view), [view.transcript]);
  const live = agents.filter((a) => a.state === 'running' || a.state === 'awaiting_permission');
  const liveN = liveCount(agents);

  if (agents.length === 0) return null;

  const total = agents.reduce((n, a) => n + (a.agent?.wf ? a.agent.wf.counts.total : 1), 0);
  const n = liveN || agents.length;
  const current = view.providers.find((p) => p.id === view.provider);
  const model = current?.models.find((m) => m.id === view.model)?.label ?? view.model;
  return (
    <div class="picker agent-chip" ref={rootRef}>
      <button
        type="button"
        class={cx('picker-btn', open && 'is-open', liveN > 0 && 'is-live')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={liveN ? t('agent.chip.title') : t('agent.chip.done')}
        title={`${liveN ? t('agent.chip.title') : t('agent.chip.done')}\n${agents.map((a) => describeTool(lang, a.name, a.args, a.state).label).join('\n')}`}
        onClick={() => setOpen((v) => !v)}
      >
        {liveN > 0 ? <LoSpinner size={14} /> : <Icon name="bot" size={15} />}
        <span class="agent-count">{t('agent.chip', { n })}</span>
      </button>
      {open && (
        <div class="popover agent-pop" role="dialog" aria-label={t('agent.chip.done')}>
          <div class="agent-flow-head">
            <span class="agent-flow-title">{liveN ? t('agent.chip.title') : t('agent.chip.done')}</span>
            <span class="agent-flow-count">
              <b>{liveN}</b>/{total}
            </span>
            <button type="button" class="agent-pop-x" aria-label={t('ab.close')} title={t('ab.close')} onClick={() => setOpen(false)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div class="agent-flow-main">{t('ab.main', { model: model || 'Locaith', n: total })}</div>
          <div class="agent-flow">
            {agents.map((a) => {
              const wf = a.agent?.wf;
              if (wf) return <AgentBoard key={a.id} block={a} wf={wf} />;
              const d = describeTool(lang, a.name, a.args, a.state);
              const st = agentStats(a);
              const secs = a.startedAt ? Math.round(((a.durationMs ?? Date.now() - a.startedAt) || 0) / 1000) : undefined;
              const bits = [secs !== undefined && secs >= 1 ? formatDuration(secs * 1000, lang) : '', st.tokens || st.tools ? t('agent.row.tokens', { n: formatCompact(st.tokens, lang), m: formatInt(st.tools, lang) }) : ''].filter(Boolean).join(' · ');
              const doing = st.activity && a.state === 'running' ? st.activity : '';
              const tip = [d.label, d.detail, doing, bits].filter(Boolean).join('\n');
              return (
                <div key={a.id} class={cx('agent-node', `is-${STATE_LABEL[a.state] ?? 'done'}`)} title={tip}>
                  <span class="agent-node-dot" data-state={a.state} />
                  <span class="agent-node-body">
                    <span class="agent-node-name">{d.label}</span>
                    <span class="agent-node-meta">
                      {d.detail ? `${d.detail}${bits ? ' · ' : ''}` : ''}
                      {bits}
                    </span>
                    {doing && (
                      <span class="agent-node-act" title={doing}>
                        {doing}
                      </span>
                    )}
                    {a.state === 'error' && a.output && <span class="agent-node-err">{a.output.slice(0, 160)}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
