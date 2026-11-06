/**
 * Mô hình Locaith (AI Local) — thông báo về dữ liệu, ngay trong khung chat (không phải hộp thoại của VS Code):
 *  • LocaithConsentCard: thẻ cuối cuộc trò chuyện, hiện lần đầu người dùng định dùng Locaith-v5 (hoặc khi máy chủ đòi đồng ý lại). Chưa bấm «Đồng ý và dùng» thì không có gì
 *    rời máy; bấm thì extension ghi nhận lên máy chủ (theo TÀI KHOẢN), lỗi thì hiện ngay trong thẻ và thẻ không đóng.
 *  • LocaithCard: mục «Mô hình Locaith» trong Cài đặt — trạng thái, xem lại thông báo, rút lại đồng ý (chỉ tắt Locaith trên máy này).
 * Nội dung thông báo nằm ở i18n `locaith.notice.*`; đổi nội dung phải tăng LOCAITH_NOTICE_VERSION (có test canh).
 */
import { useState } from 'preact/hooks';
import type { AccountView, LocaithView } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
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

export function LocaithCard({ info }: { info: LocaithView }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <section class="set-section lcs" aria-label={t('locaith.set.title')} data-testid="locaith-card">
      <h2 class="set-title">{t('locaith.set.title')}</h2>
      <p class="set-hint">{t('locaith.set.intro')}</p>
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
