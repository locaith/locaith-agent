/** Tab Chrome của Chợ: ghép đôi VS Code với extension Locaith trên Chrome để trợ lý đọc/điều khiển các trang người dùng cho phép. */
import { useEffect, useState } from 'preact/hooks';
import type { ChromeStatus } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { cx } from '../util';
import { post } from '../vscode';
import { LoSpinner } from './Brand';
import { Icon } from './Icons';
import { Badge, Button } from './ui';

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  return <span class="chr-count">{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}</span>;
}

export function ChromePanel({ chrome }: { chrome?: ChromeStatus }) {
  const { t } = useApp();
  // Làm mới trạng thái mỗi 3 giây khi tab này mở (mã ghép đôi hết hạn, extension vừa kết nối…).
  useEffect(() => {
    post({ type: 'chrome_status' });
    const id = window.setInterval(() => post({ type: 'chrome_status' }), 3000);
    return () => window.clearInterval(id);
  }, []);

  if (!chrome) {
    return (
      <div class="mk-loading" role="status">
        <LoSpinner size={20} /> {t('mk.loading')}
      </div>
    );
  }
  const code = chrome.pairing;
  const state = chrome.paired ? (chrome.connected ? 'on' : 'wait') : code ? 'pairing' : 'off';
  return (
    <div class="mk-pane">
      <p class="set-hint">{t('chr.intro')}</p>
      <section class={cx('bio-card', chrome.paired && chrome.connected && 'is-on')} aria-label={t('chr.title')}>
        <div class="bio-head">
          <Icon name="globe" size={18} class="bio-ico" />
          <h3 class="bio-title">{t('chr.title')}</h3>
          <span class={cx('bio-state', state === 'on' && 'st-ready', chrome.error && 'st-error')}>{t(`chr.state.${state}` as 'chr.state.on')}</span>
        </div>

        {chrome.error && <div class="mk-err">{chrome.error}</div>}

        {!chrome.paired && !code && (
          <>
            <ol class="chr-steps">
              <li>{t('chr.step1')}</li>
              <li>{t('chr.step2')}</li>
              <li>{t('chr.step3')}</li>
            </ol>
            <div class="mk-toolbar">
              <Button small variant="primary" icon="link" onClick={() => post({ type: 'chrome_pair_start' })}>
                {t('chr.pair')}
              </Button>
            </div>
          </>
        )}

        {!chrome.paired && code && (
          <>
            <p class="mk-desc">{t('chr.codeHint')}</p>
            <div class="chr-code" aria-live="polite" aria-label={t('chr.codeLabel')}>
              {code.code}
            </div>
            <div class="mk-meta">
              {t('chr.expires')} <Countdown until={code.expiresAt} />
            </div>
            <div class="mk-toolbar">
              <Button small variant="ghost" icon="refresh" onClick={() => post({ type: 'chrome_pair_start' })}>
                {t('chr.newCode')}
              </Button>
            </div>
          </>
        )}

        {chrome.paired && (
          <>
            <p class="mk-desc">{chrome.connected ? t('chr.connected') : t('chr.waiting')}</p>
            {chrome.extensionId && <div class="mk-meta">{t('chr.extId', { id: chrome.extensionId })}</div>}
            <div class="mk-toolbar">
              <Badge tone={chrome.connected ? 'ok' : 'warn'}>{chrome.connected ? t('chr.badge.on') : t('chr.badge.wait')}</Badge>
              <Button small variant="ghost" icon="trash" onClick={() => post({ type: 'chrome_unpair' })}>
                {t('chr.unpair')}
              </Button>
            </div>
          </>
        )}
      </section>

      <h3 class="mk-sub">{t('chr.can.title')}</h3>
      <ul class="chr-list">
        <li>{t('chr.can.1')}</li>
        <li>{t('chr.can.2')}</li>
        <li>{t('chr.can.3')}</li>
      </ul>
      <h3 class="mk-sub">{t('chr.safe.title')}</h3>
      <ul class="chr-list">
        <li>{t('chr.safe.1')}</li>
        <li>{t('chr.safe.2')}</li>
        <li>{t('chr.safe.3')}</li>
      </ul>
      <p class="set-hint">{t('chr.need')}</p>
    </div>
  );
}
