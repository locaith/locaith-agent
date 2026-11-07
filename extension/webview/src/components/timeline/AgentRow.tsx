/**
 * Dòng của một agent con (công cụ `agent`) hoặc workflow — kiểu Claude Code (lane:cc-timeline-ui):
 *   [chấm xanh/đỏ/xám] <mô tả ngắn, cắt …>              **654,9k token · 249 lệnh** · 39 phút 54 giây
 * Đang chạy: chấm xám nhấp nháy, thời gian đếm sống, dòng hai là việc đang làm. Đã xong: chấm theo kết quả, không dòng hai.
 * Nhiều agent song song = nhiều dòng xếp chồng; luôn hiện ngay dưới dòng nhóm (kể cả khi nhóm gập).
 *
 * Bố cục theo bề ngang (parallel.css): rộng → bộ số căn phải ở dòng đầu; hẹp (≤ 520 px) → dòng đầu chỉ tiêu đề + thời gian,
 * bộ số chuyển xuống đầu dòng hai — luôn tối đa hai dòng, không tràn ngang.
 */
import type { ToolBlock } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { formatCompact, formatInt } from '../../format';
import { agentStats } from '../../timeline';
import { formatSeconds } from '../../timelineCc';
import { describeTool } from '../../toolLabels';
import { cx, memo } from '../../util';
import { StatusDot, type DotTone } from './RunHead';
import { useNow } from './useTick';

function titleOf(block: ToolBlock, fallback: string): string {
  const d = typeof block.args?.description === 'string' ? block.args.description.trim() : '';
  const ty = typeof block.args?.agent_type === 'string' ? block.args.agent_type.trim() : '';
  return d || ty || fallback;
}

function toneOf(block: ToolBlock, failed: number): DotTone {
  if (block.state === 'error' || failed > 0) return 'fail';
  if (block.state === 'running' || block.state === 'awaiting_permission') return 'live';
  if (block.state === 'denied' || block.state === 'cancelled') return 'muted';
  return 'ok';
}

function AgentRowView({ block }: { block: ToolBlock }) {
  const { t, lang } = useApp();
  const live = block.state === 'running';
  const now = useNow(live);
  const s = agentStats(block);
  const title = titleOf(block, describeTool(lang, block.name, block.args, block.state).label);
  const activity = live ? s.activity || t('par.agent.starting') : '';

  // Đồng hồ chạy theo mốc bắt đầu của khối (không phải lúc dòng này được dựng): dựng lại/mở lại khung chat vẫn đúng số giây.
  const started = Number.isFinite(block.startedAt) && block.startedAt > 0 ? block.startedAt : 0;
  const elapsedMs = started ? Math.max(0, (live ? now : started + (block.durationMs ?? 0)) - started) : (block.durationMs ?? 0);
  const time = elapsedMs >= 1000 || live ? formatSeconds(Math.max(1000, Math.floor(elapsedMs / 1000) * 1000), lang) : '';
  const tokens = t('par.agent.tokens', { n: formatCompact(s.tokens, lang) });
  const tools = t('par.agent.tools', { n: formatInt(s.tools, lang) });
  const failed = s.failed > 0 ? t('par.agent.failed', { n: formatInt(s.failed, lang) }) : '';

  // Hai nơi hiển thị cùng bộ số (bề ngang rộng: dòng đầu; hẹp: đầu dòng hai) — CSS bật một trong hai; dựng mới mỗi lần để không dùng chung một vnode.
  const counts = (tail: string) => (
    <>
      {tokens} · {tools}
      {failed && (
        <>
          {' · '}
          <span class="tone-danger">{failed}</span>
        </>
      )}
      {tail ? ' · ' : ''}
    </>
  );

  return (
    // aria-label KHÔNG có số giây: đọc to một đồng hồ chạy mỗi giây là nhiễu. Số liệu đổi chỉ cập nhật chữ, không phát thông báo (aria-live tắt).
    <div class={cx('act-row', 'par-agent', 'cc-agent', `state-${block.state}`)} role="listitem" aria-live="off" aria-label={t('par.agent.aria', { title, activity, stats: `${tokens}, ${tools}${failed ? `, ${failed}` : ''}` })}>
      <span class="act-icon">
        <StatusDot tone={toneOf(block, s.failed)} />
      </span>
      <div class="par-agent-body">
        <div class="par-agent-top">
          <span class="par-agent-title" title={title}>
            {title}
          </span>
          <span class="par-agent-stats">
            <span class="par-st-counts">{counts(time)}</span>
            {time && <span class="par-st-time">{time}</span>}
          </span>
        </div>
        {/* Dòng hai: việc đang làm (khi chạy); khung hẹp còn chứa bộ số (CSS bật). Đã xong + rộng → rỗng và CSS ẩn. */}
        <div class={cx('par-agent-activity', !activity && 'is-empty')} title={activity}>
          <span class="par-act-counts">{counts(activity)}</span>
          {activity}
        </div>
      </div>
    </div>
  );
}

export const AgentRow = memo(AgentRowView);
