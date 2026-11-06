/**
 * Màn đăng nhập tài khoản locaith.ai — chặn mọi thứ còn lại cho tới khi đăng nhập xong (giống Claude Code: đăng nhập qua trình duyệt, bấm «Cho phép»).
 * Host (AccountService) mới là nơi cưỡng chế: dù giao diện bị bỏ qua, ChatController vẫn từ chối mọi thao tác khác.
 */
import type { AccountView } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import type { I18nKey } from '../i18n';
import { post } from '../vscode';
import { LoShine, LoSpinner } from './Brand';
import { Icon, LogoMark } from './Icons';
import { Button } from './ui';

const KNOWN_ERRORS = new Set(['denied', 'failed', 'no_pending', 'state_mismatch', 'invalid_grant', 'network', 'server']);

export function AccountGate({ account }: { account: AccountView }) {
  const { t } = useApp();
  const signingIn = account.status === 'signingIn';
  const expired = account.status === 'expired';
  const err = account.error ? (KNOWN_ERRORS.has(account.error) ? account.error : 'failed') : undefined;
  const web = account.webUrl ?? 'https://locaith.ai';

  return (
    <div class="acct-gate" role="main" aria-labelledby="acct-title">
      <div class="acct-card">
        {/* Logo: ô kính đen có viền gradient, quầng sáng xanh ngọc → tím chàm phía sau, vệt sáng lướt qua chữ "Lo". */}
        <div class="acct-logo" aria-hidden="true">
          <span class="acct-logo-aura" />
          <span class="acct-logo-tile">
            <LoShine size={54} />
          </span>
        </div>
        <h1 id="acct-title" class="acct-title">
          {t('acct.title')}
        </h1>
        <p class="acct-sub">{t('acct.sub')}</p>

        {expired && (
          <div class="acct-banner is-warn" role="status">
            <Icon name="alert" size={15} />
            <span>{t(account.reason === 'grace' ? 'acct.expired.grace' : 'acct.expired.revoked')}</span>
          </div>
        )}
        {err && !signingIn && (
          <div class="acct-banner is-error" role="alert">
            <Icon name="alert" size={15} />
            <span>{t(`acct.err.${err}` as I18nKey)}</span>
          </div>
        )}

        {signingIn ? (
          <div class="acct-wait" role="status" aria-live="polite">
            <div class="acct-wait-row">
              <LoSpinner size={22} />
              <span>{t('acct.waiting')}</span>
            </div>
            <p class="acct-hint">{t(account.manual ? 'acct.manualHint' : 'acct.waitingHint')}</p>
            <div class="acct-actions">
              <Button variant="secondary" icon="external" onClick={() => post({ type: 'account_sign_in', manual: account.manual === true })}>
                {t('acct.reopen')}
              </Button>
              <Button variant="secondary" icon="key" onClick={() => post({ type: 'account_enter_code' })}>
                {t('acct.pasteCode')}
              </Button>
              <Button variant="ghost" onClick={() => post({ type: 'account_cancel' })}>
                {t('acct.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div class="acct-cta">
            <button type="button" class="acct-signin" onClick={() => post({ type: 'account_sign_in' })}>
              <span class="acct-signin-mark" aria-hidden="true">
                <LogoMark size={22} />
              </span>
              <span class="acct-signin-label">{t('acct.signIn')}</span>
              <span class="acct-signin-arrow" aria-hidden="true">
                <Icon name="chevron-right" size={16} />
              </span>
            </button>
            <div class="acct-alt">
              {t('acct.noAccount')}{' '}
              <button type="button" class="acct-link" onClick={() => post({ type: 'open_external', url: web })}>
                {t('acct.create')}
              </button>
              <span class="acct-sep" aria-hidden="true">
                ·
              </span>
              <button type="button" class="acct-link" onClick={() => post({ type: 'account_enter_code' })}>
                {t('acct.pasteCode')}
              </button>
            </div>
          </div>
        )}

        <div class="acct-why">
          <div class="acct-why-title">
            <Icon name="shield" size={14} />
            {t('acct.why.title')}
          </div>
          <p>{t('acct.why.body')}</p>
        </div>
      </div>
    </div>
  );
}

/** Thẻ «Tài khoản Locaith» trong Cài đặt: ai đang đăng nhập, quản lý thiết bị, đăng xuất. */
export function AccountCard({ account }: { account: AccountView }) {
  const { t } = useApp();
  const name = account.user?.name || account.user?.email || 'Locaith';
  const initial = [...name.trim()][0]?.toUpperCase() ?? 'L';
  return (
    <section class="set-section acct-set" aria-label={t('acct.set.title')}>
      <h2 class="set-title">{t('acct.set.title')}</h2>
      <div class="acct-user">
        <div class="acct-avatar" aria-hidden="true">
          {initial}
        </div>
        <div class="acct-who">
          <div class="acct-name">{account.user?.name}</div>
          <div class="acct-email">{account.user?.email}</div>
          <div class={`acct-state${account.offline ? ' is-offline' : ''}`}>
            <span class="acct-dot" aria-hidden="true" />
            {account.offline ? t('acct.set.offline') : t('acct.set.signedIn')}
          </div>
        </div>
      </div>
      <div class="acct-actions">
        <Button small variant="secondary" icon="external" onClick={() => post({ type: 'account_manage' })}>
          {t('acct.set.devices')}
        </Button>
        <Button small variant="ghost" onClick={() => post({ type: 'account_sign_out' })}>
          {t('acct.set.signOut')}
        </Button>
      </div>
      <p class="set-hint">{t('acct.set.hint')}</p>
    </section>
  );
}
