/**
 * (lane:sessions-ux) Chip nhỏ ở thanh tiêu đề: «ngữ cảnh 38%» + thanh mảnh đổi màu (> 60% vàng, > 80% đỏ).
 * Bấm để xem chi tiết: token đã dùng/cửa sổ, số lần nén, kết quả công cụ đã lược, token vào/ra và ƯỚC TÍNH chi phí
 * (chỉ khi danh mục model có giá — không có thì không hiện, không bịa).
 */

import { useRef, useState } from 'preact/hooks';
import type { SessionMeterView, ViewState } from '../../../src/shared/protocol';
import { contextRatio, formatUsd, meterTone } from '../../../src/shared/sessionMeterCalc';
import { useApp } from '../ctx';
import { cx, useDismiss } from '../util';

export function MeterChip({ context, meter }: { context?: ViewState['context']; meter?: SessionMeterView }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));

  const ratio = contextRatio(context);
  if (ratio === null || !context || context.usedTokens <= 0) return null;
  const pct = Math.round(ratio * 100);
  const tone = meterTone(ratio);
  const nf = new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-US');
  const used = nf.format(context.usedTokens);
  const limit = nf.format(context.limitTokens);
  const label = `${t('sx.meter.label')} ${pct}%`;
  const tip = `${t('sx.meter.title')}: ${used} / ${limit}`;

  return (
    <div class="meter-chip-wrap" ref={rootRef}>
      <button type="button" class={cx('meter-chip', `meter-${tone}`, open && 'is-open')} aria-haspopup="dialog" aria-expanded={open} title={tip} aria-label={`${label}. ${tip}`} onClick={() => setOpen((o) => !o)}>
        <span class="meter-text">
          <span class="meter-word">{t('sx.meter.label')}</span> {pct}%
        </span>
        <span class="meter-bar" aria-hidden="true">
          <span style={{ width: `${Math.max(2, pct)}%` }} />
        </span>
      </button>
      {open && (
        <div class="meter-pop" role="dialog" aria-label={t('sx.meter.title')}>
          <dl class="meter-list">
            <dt>{t('sx.meter.used')}</dt>
            <dd>
              {used} / {limit}
            </dd>
            {meter && meter.compactions > 0 && (
              <>
                <dt>{t('sx.meter.compactions')}</dt>
                <dd>{meter.compactions}</dd>
              </>
            )}
            {meter && meter.clearedResults > 0 && (
              <>
                <dt>{t('sx.meter.cleared')}</dt>
                <dd>{meter.clearedResults}</dd>
              </>
            )}
            {meter && (meter.inputTokens > 0 || meter.outputTokens > 0) && (
              <>
                <dt>{t('sx.meter.in')}</dt>
                <dd>{nf.format(meter.inputTokens)}</dd>
                <dt>{t('sx.meter.out')}</dt>
                <dd>{nf.format(meter.outputTokens)}</dd>
              </>
            )}
            {meter?.costUsd !== undefined && (
              <>
                <dt>{t('sx.meter.cost')}</dt>
                <dd>~{formatUsd(meter.costUsd)}</dd>
              </>
            )}
          </dl>
          {meter?.costUsd !== undefined && <p class="meter-note">{t('sx.meter.costNote')}</p>}
          <button type="button" class="link-btn meter-close" onClick={() => setOpen(false)}>
            {t('act.collapse')}
          </button>
        </div>
      )}
    </div>
  );
}
