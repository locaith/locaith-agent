/**
 * Dòng tóm tắt MỘT chuỗi lệnh gọi công cụ: «89 lệnh gọi công cụ · 1 lỗi», thu gọn mặc định. Đang chạy thì có vòng quay và việc mới nhất
 * («Đang đọc src/a.ts…») cùng một dòng, cắt bằng dấu …; bấm để mở từng lệnh (các chuỗi cùng tên đã xong vẫn gộp «Đã đọc 5 tệp» bên trong).
 * Thẻ xin phép không bao giờ nằm trong dòng này (timeline.ts tách chúng ra thành đoạn riêng).
 */
import { useMemo, useState } from 'preact/hooks';
import { useApp } from '../../ctx';
import { formatInt } from '../../format';
import { nestedRows, type ToolSummaryInfo } from '../../timeline';
import { memo } from '../../util';
import { LoSpinner } from '../Brand';
import { Icon } from '../Icons';
import { latestLabel } from './latestLabel';
import { ToolGroup, ToolRow } from './ToolRow';

function ToolSummaryView({ info }: { info: ToolSummaryInfo }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => (open ? nestedRows(info.blocks) : []), [open, info.blocks]);
  const now = info.running ? latestLabel(lang, info.latest) : '';

  return (
    <div class="act-row tool-group par-sum" role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} title={open ? t('par.collapse') : t('par.expand')} onClick={() => setOpen((v) => !v)}>
        <span class="act-icon">{info.running ? <LoSpinner size={15} /> : <Icon name="wand" size={15} />}</span>
        <span class="tool-text">
          <span class="par-sum-line">
            <span class="tool-label par-sum-count">
              {t('par.calls', { n: formatInt(info.total, lang) })}
              {info.failed > 0 && <span class="tool-state tone-danger">{`· ${t('par.failed', { n: formatInt(info.failed, lang) })}`}</span>}
            </span>
            {now && (
              <span class="par-sum-now" title={now}>
                {now}
              </span>
            )}
          </span>
        </span>
        <span class="tool-meta">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
        </span>
      </button>
      {open && (
        <div class="tool-group-body" role="list">
          {rows.map((r) => (r.kind === 'toolgroup' ? <ToolGroup key={r.key} name={r.name} blocks={r.blocks} /> : r.kind === 'tool' ? <ToolRow key={r.key} block={r.block} nested /> : null))}
        </div>
      )}
    </div>
  );
}

export const ToolSummary = memo(ToolSummaryView);
