import { useState } from 'preact/hooks';
import type { VerifyInfo } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { cx, memo } from '../../util';
import { verifyViewModel } from '../../verifyView';
import { Icon } from '../Icons';
import { CollapseFoot } from './CollapseFoot';

/**
 * (lane:blind-verifier) Dòng «Kiểm tra độc lập» trong dòng thời gian — gọn kiểu Claude Code: MỘT dòng = chấm trạng thái
 * (xanh đạt / đỏ cần sửa / vàng chưa chắc / xám bỏ qua / nhấp nháy đang chạy) + nhãn xám nhỏ + mũi tên mở ra.
 * Mở ra: thanh dọc mảnh bên trái (lớp `tool-group-body` sẵn có), từng mục đánh số, nút «Thu gọn» ở cuối. Không khung kín, không tô nền.
 */
function VerifyRowView({ verify, standalone = false }: { verify: VerifyInfo; standalone?: boolean }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const vm = verifyViewModel(verify, lang, (r, m) => t('verify.round', { r, m }));
  const label = t(vm.labelKey, vm.labelVars);
  const expanded = vm.expandable && open;
  let n = 0;
  return (
    <div class={cx('act', 'verify', standalone && 'verify-standalone')} role="list" aria-label={t('verify.title')}>
      <div class={cx('act-row', 'tool-row', 'verify-row', `is-${vm.tone}`)} role="listitem" data-testid="verify-row" data-state={verify.state}>
        <button
          type="button"
          class="tool-head"
          aria-expanded={vm.expandable ? expanded : undefined}
          disabled={!vm.expandable}
          title={vm.expandable ? (expanded ? t('verify.collapse') : t('verify.expand')) : undefined}
          onClick={() => vm.expandable && setOpen((v) => !v)}
        >
          <span class="act-icon" aria-hidden="true">
            <span class={cx('dot', 'verify-dot', vm.tone === 'running' && 'dot-active')} />
          </span>
          <span class="tool-text">
            <span class="tool-label">{label}</span>
            {vm.detail && <span class="tool-detail">{vm.detail}</span>}
          </span>
          {vm.expandable && (
            <span class="tool-meta">
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
            </span>
          )}
        </button>
        {expanded && (
          <div class="tool-group-body verify-body">
            {vm.sections.map((s) => (
              <div key={s.titleKey} class="verify-section">
                <div class="tool-section-title">{t(s.titleKey)}</div>
                <ol class="verify-list" start={n + 1}>
                  {s.items.map((it) => (
                    <li key={`${++n}`} class="verify-item">
                      {it}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            {vm.outstanding && <div class="verify-note">{t('verify.outstandingNote')}</div>}
            <CollapseFoot onCollapse={() => setOpen(false)} label={t('verify.collapse')} />
          </div>
        )}
      </div>
    </div>
  );
}

export const VerifyRow = memo(VerifyRowView);
