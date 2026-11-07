/**
 * (lane:cc-timeline-ui) MỘT dòng cho một nhóm lệnh gọi công cụ, kiểu Claude Code:
 *   [chấm xanh/đỏ/xám nhấp nháy] «N lệnh gọi công cụ · M lỗi · sửa K tệp» [thời lượng] [⌄]
 * Đang chạy: «Đang chạy Lệnh · N lệnh gọi công cụ» + dòng phụ «Chạy nền» khi lệnh chạy nền.
 * Không biểu tượng, không khung, không nền; chữ xám nhạt cỡ nhỏ. Dùng chung cho dòng gộp lượt đang chạy (ActivityRun),
 * dòng «quá trình» của lượt đã xong (WorkSummary) và dòng tóm tắt bên trong (ToolSummary).
 */
import { useApp } from '../../ctx';
import { formatInt } from '../../format';
import { formatDurationShort, runTone, type RunTone } from '../../timelineCc';
import { cx } from '../../util';
import { Icon } from '../Icons';

export type DotTone = RunTone | 'muted' | 'warn';

/** Chấm trạng thái 7 px: ok = xanh lá, fail = đỏ, live = xám nhấp nháy nhẹ (tắt khi giảm chuyển động), muted = xám, warn = cam. */
export function StatusDot({ tone }: { tone: DotTone }) {
  return <span class={cx('cc-dot', `is-${tone}`)} aria-hidden="true" />;
}

export interface RunHeadProps {
  calls: number;
  failed: number;
  edits?: number;
  /** Dòng không phải công cụ (suy nghĩ, trạng thái…) — chỉ dùng khi không có lệnh nào. */
  steps?: number;
  live: boolean;
  /** Tên hành động đang chạy («Lệnh», «Đọc»…) — chỉ hiện khi live. */
  runningTool?: string;
  background?: boolean;
  durationMs?: number;
  open: boolean;
  onToggle(): void;
  expandTitle: string;
  collapseTitle: string;
  /** Lớp thêm cho ô đếm (để kiểm thử DOM cũ vẫn tìm được, ví dụ `par-sum-count`). */
  countClass?: string;
}

export function RunHead(p: RunHeadProps) {
  const { t, lang } = useApp();
  const tone = runTone({ failed: p.failed }, p.live);
  const count = p.calls > 0 ? t('par.calls', { n: formatInt(p.calls, lang) }) : t('act.steps', { n: formatInt(p.steps ?? 0, lang) });
  return (
    <button type="button" class={cx('tool-head', 'cc-head', p.live && 'is-live')} aria-expanded={p.open} title={p.open ? p.collapseTitle : p.expandTitle} onClick={p.onToggle}>
      <span class="act-icon">
        <StatusDot tone={tone} />
      </span>
      <span class="tool-text">
        <span class="cc-line">
          {p.live && p.runningTool && <span class="cc-now">{t('cc.running', { tool: p.runningTool })}</span>}
          <span class={cx('cc-count', p.countClass)}>
            {count}
            {p.failed > 0 && <span class="cc-fail">{` · ${t('par.failed', { n: formatInt(p.failed, lang) })}`}</span>}
          </span>
          {(p.edits ?? 0) > 0 && <span class="cc-edits">{t('work.edits', { n: formatInt(p.edits ?? 0, lang) })}</span>}
        </span>
        {p.live && p.background && <span class="cc-sub">{t('cc.background')}</span>}
      </span>
      <span class="tool-meta">
        {p.durationMs !== undefined && p.durationMs >= 1000 && <span class="tool-meta-text cc-dur">{formatDurationShort(p.durationMs, lang)}</span>}
        <Icon name={p.open ? 'chevron-up' : 'chevron-down'} size={14} class="tool-chevron" />
      </span>
    </button>
  );
}
