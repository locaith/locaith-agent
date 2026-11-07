/**
 * (lane:cc-timeline-ui) Dấu thời gian của dòng thời gian: giờ nhỏ xám căn phải (24h theo vi, 12h AM/PM theo en) và
 * ĐƯỜNG NGĂN NGÀY dạng sóng với nhãn ngày ở giữa («T7, 07/11» / «Sat, Nov 7»). Giờ lấy từ ts có sẵn — thiếu thì không vẽ.
 */
import { useApp } from '../../ctx';
import { formatClock, formatDayLabel } from '../../timelineCc';

export function Stamp({ ts }: { ts: number | undefined }) {
  const { lang } = useApp();
  const text = formatClock(ts, lang);
  if (!text) return null;
  return (
    <div class="cc-stamp">
      <time dateTime={Number.isNaN(new Date(ts!).getTime()) ? undefined : new Date(ts!).toISOString()}>{text}</time>
    </div>
  );
}

export function DayDivider({ ts }: { ts: number | undefined }) {
  const { lang } = useApp();
  const label = formatDayLabel(ts, lang);
  if (!label) return null;
  return (
    <div class="cc-day" role="separator" aria-label={label}>
      <span class="cc-day-line" aria-hidden="true" />
      <span class="cc-day-label">{label}</span>
      <span class="cc-day-line" aria-hidden="true" />
    </div>
  );
}
