/**
 * Dòng SỐNG của một agent con (công cụ `agent`) hoặc workflow đang chạy: tiêu đề + việc đang làm (một dòng, cắt …) + số liệu
 * «461,4k token · 12 lệnh · 5 phút 18 giây». Nhiều agent chạy song song = nhiều dòng xếp chồng: gọn, quét mắt là biết cái nào đang làm gì.
 * Khi agent xong, dòng này biến mất và agent nhập vào dòng tóm tắt «N lệnh gọi công cụ» (báo cáo cuối vẫn mở ra được như trước).
 *
 * Bố cục theo bề ngang (parallel.css): rộng → tiêu đề bên trái, TOÀN BỘ số liệu căn phải ở dòng đầu, việc đang làm ở dòng hai; hẹp (thanh bên VS Code) →
 * dòng đầu chỉ còn tiêu đề + thời gian chạy, dòng hai là một chuỗi «token · lệnh · việc đang làm» cắt ở cuối — luôn đúng hai dòng, không tràn ngang.
 */
import type { ToolBlock } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { formatCompact, formatDuration, formatInt } from '../../format';
import { agentStats } from '../../timeline';
import { describeTool } from '../../toolLabels';
import { memo } from '../../util';
import { LoSpinner } from '../Brand';
import { useNow } from './useTick';

function titleOf(block: ToolBlock, fallback: string): string {
  const d = typeof block.args?.description === 'string' ? block.args.description.trim() : '';
  const ty = typeof block.args?.agent_type === 'string' ? block.args.agent_type.trim() : '';
  return d || ty || fallback;
}

function AgentRowView({ block }: { block: ToolBlock }) {
  const { t, lang } = useApp();
  const live = block.state === 'running';
  const now = useNow(live);
  const s = agentStats(block);
  const title = titleOf(block, describeTool(lang, block.name, block.args, block.state).label);
  const activity = s.activity || t('par.agent.starting');

  // Đồng hồ chạy theo mốc bắt đầu của khối (không phải lúc dòng này được dựng): dựng lại/mở lại khung chat vẫn đúng số giây.
  const elapsedMs = Math.max(0, (live ? now : block.startedAt + (block.durationMs ?? 0)) - block.startedAt);
  const time = formatDuration(Math.max(1000, Math.floor(elapsedMs / 1000) * 1000), lang);
  const tokens = t('par.agent.tokens', { n: formatCompact(s.tokens, lang) });
  const tools = t('par.agent.tools', { n: formatInt(s.tools, lang) });
  const failed = s.failed > 0 ? t('par.agent.failed', { n: formatInt(s.failed, lang) }) : '';

  // Hai nơi hiển thị cùng bộ số (bề ngang rộng: dòng đầu; hẹp: đầu dòng hai) — CSS bật một trong hai; dựng mới mỗi lần để không dùng chung một vnode.
  const counts = () => (
    <>
      {tokens} · {tools}
      {failed && (
        <>
          {' · '}
          <span class="tone-danger">{failed}</span>
        </>
      )}
      {' · '}
    </>
  );

  return (
    // aria-label KHÔNG có số giây: đọc to một đồng hồ chạy mỗi giây là nhiễu. Số liệu đổi chỉ cập nhật chữ, không phát thông báo (aria-live tắt).
    <div class="act-row par-agent" role="listitem" aria-live="off" aria-label={t('par.agent.aria', { title, activity, stats: `${tokens}, ${tools}${failed ? `, ${failed}` : ''}` })}>
      <span class="act-icon">{live ? <LoSpinner size={15} /> : null}</span>
      <div class="par-agent-body">
        <div class="par-agent-top">
          <span class="par-agent-title" title={title}>
            {title}
          </span>
          <span class="par-agent-stats">
            <span class="par-st-counts">{counts()}</span>
            <span class="par-st-time">{time}</span>
          </span>
        </div>
        <div class="par-agent-activity" title={activity}>
          <span class="par-act-counts">{counts()}</span>
          {activity}
        </div>
      </div>
    </div>
  );
}

export const AgentRow = memo(AgentRowView);
