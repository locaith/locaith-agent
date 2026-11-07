/** Chip số agent con đang chạy. Bấm vào: SƠ ĐỒ LUỒNG rộng — agent điều phối ở trên, các agent con nối xuống dưới, thấy rõ ai đang làm gì. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ToolBlock, ViewState } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { formatCompact, formatDuration, formatInt } from '../../format';
import { AGENT_TOOLS, describeTool } from '../../toolLabels';
import { agentStats } from '../../timeline';
import { cx } from '../../util';
import { LoSpinner } from '../Brand';
import { Icon } from '../Icons';

/** Mọi khối agent của lượt gần nhất có agent (đang chạy hoặc vừa xong), mới nhất trước. */
export function agentsOf(view: ViewState): ToolBlock[] {
  for (let i = view.transcript.length - 1; i >= 0; i--) {
    const it = view.transcript[i];
    if (it.kind !== 'assistant') continue;
    const found = it.blocks.filter((b): b is ToolBlock => b.type === 'tool' && AGENT_TOOLS.has(b.name));
    if (found.length > 0) return found.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }
  return [];
}

/**
 * Đóng bảng SAU MỘT NHỊP chứ không đóng ngay khi rời chip: bảng nổi ở giữa màn hình, con trỏ phải đi qua
 * khoảng trống mới tới được nó — đóng ngay thì không kịp trỏ vào xem agent nào làm gì.
 */
const CLOSE_DELAY_MS = 260;

const STATE_LABEL: Record<string, string> = { running: 'running', error: 'error', done: 'done' };

export function AgentChip({ view }: { view: ViewState }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const agents = useMemo(() => agentsOf(view), [view.transcript]);
  const live = agents.filter((a) => a.state === 'running' || a.state === 'awaiting_permission');

  const stayOpen = () => {
    if (closeTimer.current !== undefined) {
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  };
  const closeLater = () => {
    stayOpen();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  useEffect(() => stayOpen, []); // rời giao diện: không để hẹn giờ treo lại

  if (agents.length === 0) return null;

  const n = live.length || agents.length;
  return (
    <div class="picker agent-chip" onMouseEnter={stayOpen} onMouseLeave={closeLater}>
      <button
        type="button"
        class={cx('picker-btn', open && 'is-open', live.length > 0 && 'is-live')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={live.length ? t('agent.chip.title') : t('agent.chip.done')}
        title={`${live.length ? t('agent.chip.title') : t('agent.chip.done')}\n${agents.map((a) => describeTool(lang, a.name, a.args, a.state).label).join('\n')}`}
        onClick={() => setOpen((v) => !v)}
      >
        {live.length > 0 ? <LoSpinner size={14} /> : <Icon name="bot" size={15} />}
        <span class="agent-count">{t('agent.chip', { n })}</span>
      </button>
      {open && (
        <div class="popover agent-pop" role="dialog" aria-label={t('agent.chip.done')} onMouseEnter={stayOpen} onMouseLeave={closeLater}>
          <div class="agent-flow-head">
            <span class="agent-flow-title">{live.length ? t('agent.chip.title') : t('agent.chip.done')}</span>
            <span class="agent-flow-count">
              <b>{live.length}</b>/{agents.length}
            </span>
          </div>
          <div class="agent-flow">
            <div class="agent-node is-main">
              <span class="agent-node-dot" data-state={live.length ? 'running' : 'done'} />
              <span class="agent-node-body">
                <span class="agent-node-name">Locaith</span>
                <span class="agent-node-meta">Locaith-v5-flash · điều phối {agents.length} agent</span>
              </span>
            </div>
            <ul class="agent-flow-kids" role="list">
              {agents.map((a) => {
                const d = describeTool(lang, a.name, a.args, a.state);
                const st = agentStats(a);
                const secs = a.startedAt ? Math.round(((a.durationMs ?? Date.now() - a.startedAt) || 0) / 1000) : undefined;
                const bits = [secs !== undefined && secs >= 1 ? formatDuration(secs * 1000, lang) : '', st.tokens || st.tools ? t('agent.row.tokens', { n: formatCompact(st.tokens, lang), m: formatInt(st.tools, lang) }) : ''].filter(Boolean).join(' · ');
                const doing = st.activity && a.state === 'running' ? st.activity : '';
                const tip = [d.label, d.detail, doing, bits].filter(Boolean).join('\n');
                return (
                  <li key={a.id} class={cx('agent-node', `is-${STATE_LABEL[a.state] ?? 'done'}`)} role="listitem" title={tip}>
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
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
