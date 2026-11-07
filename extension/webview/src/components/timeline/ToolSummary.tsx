/**
 * Dòng tóm tắt MỘT chuỗi lệnh gọi công cụ: «89 lệnh gọi công cụ · 1 lỗi» (lane:cc-timeline-ui: chấm trạng thái + chữ xám, dùng RunHead).
 * Đang chạy thì «Đang chạy Lệnh · N lệnh gọi công cụ»; bấm để mở từng lệnh (các chuỗi cùng tên đã xong vẫn gộp «Đã đọc 5 tệp» bên trong).
 * Nằm trong một nhóm NGƯỜI DÙNG VỪA MỞ (`flat`) thì KHÔNG có dòng tóm tắt trung gian: từng lệnh bày thẳng ở cùng cấp — một lần bấm là thấy
 * hết từng bước như Claude Code (nhóm ngoài đã có nút Thu gọn).
 * Thẻ xin phép không bao giờ nằm trong dòng này (timeline.ts tách chúng ra thành đoạn riêng).
 */
import { useMemo, useState } from 'preact/hooks';
import { useApp } from '../../ctx';
import { nestedRows, type ToolSummaryInfo } from '../../timeline';
import { actionName, backgroundOf } from '../../timelineCc';
import { cx, memo } from '../../util';
import { CollapseFoot } from './CollapseFoot';
import { RunHead } from './RunHead';
import { ToolGroup, ToolRow } from './ToolRow';

function ToolSummaryView({ info, flat = false }: { info: ToolSummaryInfo; flat?: boolean }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => (open || flat ? nestedRows(info.blocks) : []), [open, flat, info.blocks]);
  const list = rows.map((r) => (r.kind === 'toolgroup' ? <ToolGroup key={r.key} name={r.name} blocks={r.blocks} defaultOpen={flat} /> : r.kind === 'tool' ? <ToolRow key={r.key} block={r.block} nested /> : null));

  if (flat) {
    return (
      <div class="cc-flat" role="list" data-testid="toolsum-flat">
        {list}
      </div>
    );
  }
  return (
    <div class={cx('act-row', 'tool-group', 'par-sum', 'cc-group', info.failed > 0 && 'has-fail')} role="listitem">
      <RunHead
        calls={info.total}
        failed={info.failed}
        live={info.running}
        runningTool={info.latest ? actionName(lang, info.latest.name) : undefined}
        background={backgroundOf(info.latest)}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        expandTitle={t('par.expand')}
        collapseTitle={t('par.collapse')}
        countClass="par-sum-count"
      />
      {open && (
        <div class="tool-group-body" role="list">
          {list}
          <CollapseFoot onCollapse={() => setOpen(false)} label={t('par.collapse')} />
        </div>
      )}
    </div>
  );
}

export const ToolSummary = memo(ToolSummaryView);
