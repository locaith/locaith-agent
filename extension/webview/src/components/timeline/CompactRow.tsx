/**
 * (lane:cc-timeline-ui) Dòng nén ngữ cảnh kiểu Claude Code: chữ nghiêng xám
 *   «Đã nén cuộc trò chuyện · tự động · giải phóng 968k token ⌄»
 * bấm mở ra số liệu + bản tóm tắt đã giữ lại (nút Thu gọn ở cuối). Dùng chung cho notice trong lượt lẫn notice độc lập.
 * Dữ liệu: trường tuỳ chọn `compact` (CompactInfo) của 'notice' — bản cũ/Remote cũ chỉ thấy chữ thường.
 */
import { useState } from 'preact/hooks';
import type { CompactInfo } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { formatCompact, formatInt } from '../../format';
import { cx } from '../../util';
import { Icon } from '../Icons';
import { CollapseFoot } from './CollapseFoot';

const MODE_KEY = { auto: 'cc.compact.auto', manual: 'cc.compact.manual', overflow: 'cc.compact.overflow' } as const;

export function CompactRow({ compact, text }: { compact: CompactInfo; text: string }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const mode = MODE_KEY[compact.mode] ?? MODE_KEY.auto;
  const parts = [t('cc.compact.head'), t(mode), compact.tokensFreed ? t('cc.compact.freed', { n: formatCompact(compact.tokensFreed, lang) }) : ''].filter(Boolean);
  const details = [
    compact.summarizedMessages ? t('cc.compact.summarized', { n: formatInt(compact.summarizedMessages, lang) }) : '',
    compact.clearedResults ? t('cc.compact.cleared', { n: formatInt(compact.clearedResults, lang) }) : '',
  ].filter(Boolean);
  return (
    <div class={cx('cc-compact', open && 'is-open')} role="status" title={text}>
      <button type="button" class="cc-compact-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span class="cc-compact-text">{parts.join(' · ')}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} class="tool-chevron" />
      </button>
      {open && (
        <div class="cc-compact-body">
          {details.length > 0 && <div class="cc-compact-meta">{details.join(' · ')}</div>}
          <div class="cc-compact-title">{t('cc.compact.summaryTitle')}</div>
          <div class="cc-compact-summary">{compact.summary || t('cc.compact.noSummary')}</div>
          <CollapseFoot onCollapse={() => setOpen(false)} label={t('tool.showLess')} />
        </div>
      )}
    </div>
  );
}
