import type { ViewState } from '../../../src/shared/protocol';
import { bus } from '../bus';
import { useApp } from '../ctx';
import { post } from '../vscode';
import { Icon, LogoMark } from './Icons';
import { Button } from './ui';

export function Welcome({ view, hasAnyKey }: { view: ViewState; hasAnyKey: boolean }) {
  const { t, openSettings, platform } = useApp();
  const isBrowser = platform === 'browser';
  const suggestions = isBrowser ? [t('welcome.b1'), t('welcome.b2'), t('welcome.b3'), t('welcome.b4')] : [t('welcome.s1'), t('welcome.s2'), t('welcome.s3'), t('welcome.s4')];
  const names = ['Claude', 'ChatGPT', 'Gemini', 'DeepSeek', 'Grok'];
  // Đang dùng mô hình Locaith (đăng nhập tài khoản, không cần khoá API): nói rõ để người mới biết không phải nhập gì.
  const onLocaith = view.providers.some((p) => p.id === view.provider && p.account);

  return (
    <div class="welcome">
      <div class="welcome-logo">
        <LogoMark size={48} />
      </div>
      <h1 class="welcome-title">{t('welcome.title')}</h1>
      <p class="welcome-sub">{t(isBrowser ? 'welcome.sub.browser' : 'welcome.sub')}</p>
      {onLocaith && <p class="welcome-locaith">{t('welcome.locaith')}</p>}

      {!hasAnyKey ? (
        <>
        <div class="callout">
          <div class="callout-title">
            <Icon name="key" size={16} />
            {t('welcome.nokey.title')}
          </div>
          <p class="callout-body">{t(isBrowser ? 'welcome.nokey.body.browser' : 'welcome.nokey.body')}</p>
          <div class="callout-names" aria-hidden="true">
            {names.map((n) => (
              <span class="chip chip-plain" key={n}>
                <span class="chip-main">
                  <span class="chip-text">{n}</span>
                </span>
              </span>
            ))}
          </div>
          <Button variant="primary" icon="key" onClick={openSettings}>
            {t('welcome.nokey.cta')}
          </Button>
        </div>
        {/* (0.7.10) Bản trình duyệt: mô hình Locaith dùng tài khoản thay cho API key — đăng nhập là tuỳ chọn. */}
        {isBrowser && view.account?.optional && view.account.status !== 'signedIn' && (
          <div class="callout callout-account" data-testid="welcome-account">
            <div class="callout-title">
              <LogoMark size={16} />
              {t('welcome.account.title')}
            </div>
            <p class="callout-body">{t('welcome.account.body')}</p>
            <Button
              variant="secondary"
              icon="external"
              onClick={() => {
                post({ type: 'account_sign_in' });
                openSettings();
              }}
            >
              {t('welcome.account.cta')}
            </Button>
          </div>
        )}
        </>
      ) : (
        <div class="suggest">
          <div class="suggest-title">{t('welcome.suggest')}</div>
          {suggestions.map((s) => (
            <button key={s} type="button" class="suggest-item" onClick={() => bus.prefill.emit(s)}>
              <span class="suggest-icon">
                <Icon name="sparkle" size={14} />
              </span>
              <span>{s}</span>
            </button>
          ))}
        </div>
      )}
      {isBrowser && view.browser && !view.browser.siteAccess && (
        <div class="callout callout-access">
          <div class="callout-title">
            <Icon name="shield" size={16} />
            {t('welcome.access.title')}
          </div>
          <p class="callout-body">{t('welcome.access.body')}</p>
          <Button variant="secondary" icon="check" onClick={() => post({ type: 'request_site_access' })}>
            {t('welcome.access.cta')}
          </Button>
        </div>
      )}
      {hasAnyKey && view.workspace && <div class="welcome-ws">{view.workspace.name}</div>}
    </div>
  );
}
