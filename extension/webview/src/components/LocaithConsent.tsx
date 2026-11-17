/**
 * Mô hình Locaith (AI Local) — thông báo về dữ liệu, ngay trong khung chat (không phải hộp thoại của VS Code):
 *  • LocaithConsentCard: thẻ cuối cuộc trò chuyện, hiện lần đầu người dùng định dùng Locaith-v5 (hoặc khi máy chủ đòi đồng ý lại). Chưa bấm «Đồng ý và dùng» thì không có gì
 *    rời máy; bấm thì extension ghi nhận lên máy chủ (theo TÀI KHOẢN), lỗi thì hiện ngay trong thẻ và thẻ không đóng.
 *  • LocaithCard: mục «Mô hình Locaith» trong Cài đặt — trạng thái, xem lại thông báo, rút lại đồng ý (chỉ tắt Locaith trên máy này).
 * Nội dung thông báo nằm ở i18n `locaith.notice.*`; đổi nội dung phải tăng LOCAITH_NOTICE_VERSION (có test canh).
 */
import { useState } from 'preact/hooks';
import type { AccountView, LocaithUsageView, LocaithView } from '../../../src/shared/protocol';
import { percentText, planName, spanText } from '../../../src/shared/usageFormat';
import { useApp } from '../ctx';
import { openExternalLink } from '../externalLink';
import { cx } from '../util';
import { post } from '../vscode';
import { Icon } from './Icons';
import { Button } from './ui';

function NoticeBody() {
  const { t } = useApp();
  return (
    <ul class="lcn-list">
      <li>{t('locaith.notice.p1')}</li>
      <li>{t('locaith.notice.p2')}</li>
      <li>{t('locaith.notice.p3')}</li>
      <li>{t('locaith.notice.p4')}</li>
    </ul>
  );
}

export function LocaithConsentCard({ info, account }: { info: LocaithView; account?: AccountView }) {
  const { t } = useApp();
  const email = account?.user?.email;
  return (
    <section class="lcn" role="region" aria-labelledby="lcn-title" data-testid="locaith-consent">
      <div class="lcn-head">
        <span class="lcn-ico" aria-hidden="true">
          <Icon name="shield" size={16} />
        </span>
        <h2 id="lcn-title" class="lcn-title">
          {t('locaith.notice.title')}
        </h2>
      </div>
      <NoticeBody />
      {email && <p class="lcn-who">{t('locaith.notice.who', { email })}</p>}
      {info.outdated && (
        <div class="lcn-banner is-warn" role="status">
          <Icon name="alert" size={15} />
          <span>{t('locaith.notice.outdated')}</span>
        </div>
      )}
      {info.error && (
        <div class="lcn-banner is-error" role="alert">
          <Icon name="alert" size={15} />
          <span>{info.error}</span>
        </div>
      )}
      <div class="lcn-actions">
        <Button variant="primary" icon="check" busy={info.saving} disabled={info.outdated} onClick={() => post({ type: 'locaith_consent', action: 'accept' })}>
          {info.saving ? t('locaith.notice.saving') : t('locaith.notice.accept')}
        </Button>
        <Button variant="secondary" icon="key" disabled={info.saving} onClick={() => post({ type: 'locaith_consent', action: 'decline' })}>
          {t('locaith.notice.decline')}
        </Button>
      </div>
    </section>
  );
}

/** Một thanh hạn mức: nhãn, phần trăm đã dùng, và (tuỳ chọn) dòng phụ — «làm mới sau 2 giờ 10 phút». Chỉ phần trăm, không bao giờ số tiền. */
function UsageBar({ label, percent, note }: { label: string; percent: number; note?: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div class="lcu-row">
      <div class="lcu-line">
        <span class="lcu-label">{label}</span>
        <span class="lcu-pct">{percentText(percent)}</span>
      </div>
      <div class="lcu-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
        <span class={cx('lcu-fill', p >= 100 ? 'is-full' : p >= 80 ? 'is-high' : '')} style={{ width: `${p}%` }} />
      </div>
      {note && <div class="lcu-note">{note}</div>}
    </div>
  );
}

/**
 * (0.7.9) Hạn mức dùng mô hình Locaith kiểu Anthropic, đọc từ máy chủ: gói trả phí có phiên 5 giờ + tuần (làm mới theo cửa sổ, bắt đầu từ tin nhắn đầu tiên),
 * tài khoản miễn phí có token miễn phí MỘT LẦN (không làm mới). Kèm nút «Nâng cấp» / «Mua gói» khi còn gói để nâng.
 */
export function LocaithUsageBlock({ usage }: { usage: LocaithUsageView }) {
  const { t, lang } = useApp();
  const left = (secs: number | undefined): string | undefined => {
    if (secs === undefined) return undefined;
    const rest = Math.max(0, secs - (Date.now() - usage.at) / 1000); // `resetsInS` tính từ lúc máy chủ trả lời
    return t('usage.resets', { span: spanText(rest, lang) });
  };
  const name = planName(usage.plan);
  const free = !!usage.credit;
  const buy = usage.canUpgrade && (free || usage.state === 'limit_session' || usage.state === 'limit_week' || usage.plan !== 'ultra');
  return (
    <div class="lcu" data-testid="locaith-usage" data-state={usage.state}>
      <div class="lcu-head">
        <span class="lcu-title">{t('usage.title')}</span>
        <span class="lcu-plan">{name ? t('usage.plan', { plan: name }) : t('usage.free')}</span>
        {buy && (
          <button type="button" class="link-btn lcu-up" onClick={() => openExternalLink(usage.upgradeUrl)}>
            {free ? t('usage.buy') : t('usage.upgrade')}
          </button>
        )}
      </div>
      {usage.session && (
        <UsageBar label={t('usage.session', { hours: usage.sessionHours ?? 5 })} percent={usage.session.percent} note={left(usage.session.resetsInS) ?? t('usage.notStarted')} />
      )}
      {usage.week && <UsageBar label={t('usage.week')} percent={usage.week.percent} note={left(usage.week.resetsInS) ?? t('usage.notStarted')} />}
      {usage.credit && <UsageBar label={t('usage.credit')} percent={usage.credit.percent} note={t('usage.creditNote')} />}
      <p class="set-hint">{t('usage.hint')}</p>
    </div>
  );
}

export function LocaithCard({ info }: { info: LocaithView }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <section class="set-section lcs" aria-label={t('locaith.set.title')} data-testid="locaith-card">
      <h2 class="set-title">{t('locaith.set.title')}</h2>
      <p class="set-hint">{t('locaith.set.intro')}</p>
      {info.usage && <LocaithUsageBlock usage={info.usage} />}
      <div class={`lcs-state is-${info.accepted ? 'ok' : 'warn'}`}>
        <span class="lcs-dot" aria-hidden="true" />
        {info.accepted ? t('locaith.set.accepted') : t('locaith.set.notAccepted')}
      </div>
      <div class="lcs-actions">
        {info.accepted ? (
          <Button small variant="secondary" onClick={() => post({ type: 'locaith_consent', action: 'withdraw' })}>
            {t('locaith.set.withdraw')}
          </Button>
        ) : (
          <Button small variant="primary" onClick={() => post({ type: 'locaith_consent', action: 'review' })}>
            {t('locaith.set.review')}
          </Button>
        )}
        <button type="button" class="link-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
          {t('locaith.set.noticeToggle')}
        </button>
      </div>
      {open && (
        <div class="lcs-notice">
          <NoticeBody />
        </div>
      )}
      <p class="set-hint">{t('locaith.set.hint')}</p>
    </section>
  );
}
