/**
 * (lane:cc-timeline-ui) Chip «đồng hồ + thời gian chạy của lượt» dưới ô nhập (như «59m» của Claude Code), chỉ khi đang chạy.
 * Mốc bắt đầu = `ts` của lượt trả lời đang chạy (dựng lại khung chat vẫn đúng); đếm bằng đồng hồ dùng chung (useNow), không aria-live.
 */
import type { ViewState } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { formatElapsedShort, runningSince } from '../../timelineCc';
import { Icon } from '../Icons';
import { useNow } from '../timeline/useTick';

export function RunClock({ view }: { view: ViewState }) {
  const { t } = useApp();
  const since = runningSince(view);
  const now = useNow(since !== undefined);
  if (since === undefined) return null;
  return (
    <span class="picker-btn cc-clock" title={t('cc.runClock')} aria-label={t('cc.runClock')} aria-live="off">
      <Icon name="clock" size={13} />
      <span class="cc-clock-text">{formatElapsedShort(Math.max(0, now - since))}</span>
    </span>
  );
}
