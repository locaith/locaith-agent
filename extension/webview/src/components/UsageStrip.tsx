import type { LocaithUsageView } from '../../../src/shared/protocol';
import { percentText, planName, spanText } from '../../../src/shared/usageFormat';
import { useApp } from '../ctx';
import { openExternalLink } from '../externalLink';
import { cx } from '../util';

/**
 * Hạn mức tài khoản Locaith, luôn thấy khi đã đăng nhập — MỘT dòng gọn dưới cuộc trò chuyện.
 *
 * Vì sao cần: trước đây mức đã dùng chỉ nằm trong thẻ ở Cài đặt (và thẻ đồng ý), nên người dùng đang chat
 * không biết mình còn bao nhiêu. Ở đây chỉ hiện phần trăm và thời gian làm mới (không bao giờ số tiền), thanh mảnh
 * để không chiếm chỗ; chạm vào mở trang gói khi đã cạn hoặc gần cạn.
 */
export function UsageStrip({ usage }: { usage: LocaithUsageView }) {
  const { t, lang } = useApp();
  const name = planName(usage.plan);
  const free = !!usage.credit;
  const left = (secs: number | undefined): string | undefined =>
    secs === undefined ? undefined : t('usage.resets', { span: spanText(Math.max(0, secs - (Date.now() - usage.at) / 1000), lang) });

  const rows: { key: string; label: string; percent: number; note?: string }[] = [];
  if (usage.session) rows.push({ key: 'session', label: t('usage.session', { hours: usage.sessionHours ?? 5 }), percent: usage.session.percent, note: left(usage.session.resetsInS) });
  if (usage.week) rows.push({ key: 'week', label: t('usage.week'), percent: usage.week.percent, note: left(usage.week.resetsInS) });
  if (usage.credit) rows.push({ key: 'credit', label: t('usage.credit'), percent: usage.credit.percent, note: t('usage.creditNote') });
  if (rows.length === 0) return null;

  // Cạn hạn mức (hoặc sắp cạn) thì có nút mở trang gói; bình thường giữ dải gọn, không mời chào.
  const maxPct = Math.max(...rows.map((r) => r.percent));
  const atLimit = usage.state.startsWith('limit') || usage.state === 'free_exhausted';
  const offerBuy = usage.canUpgrade && (atLimit || free || maxPct >= 80);

  return (
    <section class={cx('usage-strip', atLimit && 'is-limit')} aria-label={t('usage.title')} data-testid="usage-strip" data-state={usage.state}>
      <span class="us-plan">{name ? t('usage.plan', { plan: name }) : t('usage.free')}</span>
      {rows.map((r) => {
        const p = Math.max(0, Math.min(100, r.percent));
        return (
          <span key={r.key} class="us-item" title={`${r.label}: ${percentText(r.percent)}${r.note ? ` · ${r.note}` : ''}`}>
            <span class="us-label">{r.label}</span>
            <span class="us-bar" role="progressbar" aria-label={r.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
              <span class={cx('us-fill', p >= 100 ? 'is-full' : p >= 80 ? 'is-high' : '')} style={{ width: `${p}%` }} />
            </span>
            <span class="us-pct">{percentText(r.percent)}</span>
          </span>
        );
      })}
      {offerBuy && (
        <button type="button" class="link-btn us-buy" onClick={() => openExternalLink(usage.upgradeUrl)}>
          {free ? t('usage.buy') : t('usage.upgrade')}
        </button>
      )}
    </section>
  );
}
