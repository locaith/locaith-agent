import { useEffect, useRef, useState } from 'preact/hooks';
import type { ProviderSummary, UiCodeFont, UiFontFamily, UiLanguage, UiSettings, ViewState } from '../../../src/shared/protocol';
import { bus } from '../bus';
import { useApp } from '../ctx';
import { FONT_STACKS } from '../fonts';
import { formatDecimal } from '../format';
import type { I18nKey } from '../i18n';
import { cx } from '../util';
import { post } from '../vscode';
import { AccountCard } from './AccountGate';
import { LocaithCard } from './LocaithConsent';
import { RemoteCard } from './RemoteView';
import { AddProviderForm, BrowserSettingsSections } from './BrowserSettings';
import { Icon } from './Icons';
import { OrchestrationSection } from './OrchestrationSection';
import { PermissionsPanel } from './PermissionsPanel'; // (lane:perm-rules)
import { Badge, Button, ProviderBadge, Segmented, Switch } from './ui';

const FONT_ORDER: UiFontFamily[] = ['be-vietnam-pro', 'manrope', 'inter', 'system'];

type SetFn = <K extends keyof UiSettings>(key: K, value: UiSettings[K]) => void;

function ProviderCard({ p }: { p: ProviderSummary }) {
  const { t } = useApp();
  const keyRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const [hasKeyText, setHasKeyText] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(
    () =>
      bus.testResult.on((r) => {
        if (r.provider === p.id) {
          setTesting(false);
          setResult({ ok: r.ok, message: r.message });
        }
      }),
    [p.id],
  );
  // Danh sách model đổi (host đã làm mới xong) → tắt vòng xoay.
  useEffect(() => setRefreshing(false), [p.models, p.modelSource, p.modelError]);

  const saveKey = () => {
    const v = keyRef.current?.value.trim();
    if (!v) return;
    post({ type: 'save_api_key', provider: p.id, key: v });
    if (keyRef.current) keyRef.current.value = '';
    setHasKeyText(false);
    setResult(null);
  };

  const statusBadge = p.hasKey ? (
    <Badge tone="ok">{p.keyFromEnv ? t('set.key.env') : t('set.key.saved')}</Badge>
  ) : (
    <Badge tone="neutral">{t('set.key.none')}</Badge>
  );

  const sourceBadge =
    p.modelSource === 'live' ? (
      <Badge tone="ok">{t('model.live')}</Badge>
    ) : p.modelSource === 'cache' ? (
      <Badge tone="neutral">{t('model.cache')}</Badge>
    ) : (
      <Badge tone="warn">{t('model.fallback')}</Badge>
    );

  return (
    <div class={cx('prov-card', p.hasKey && 'has-key')}>
      <div class="prov-head">
        <ProviderBadge id={p.id} label={p.label} size={22} />
        <div class="prov-name">
          <span class="prov-label">{p.label}</span>
          <span class="prov-kind">{p.builtin ? p.id : t('set.custom')}</span>
        </div>
        <span class="prov-spacer" />
        {statusBadge}
      </div>

      {p.oauth && (
        <div class="field">
          <div class="field-label">{t('set.oauth.title')}</div>
          <div class="field-row">
            <Badge tone={p.oauth.signedIn ? 'ok' : 'neutral'}>{p.oauth.signedIn ? t('set.oauth.signedIn') : t('set.oauth.signedOut')}</Badge>
            <Button variant="primary" small onClick={() => post({ type: 'oauth_login', provider: p.id })}>
              {p.oauth.signedIn ? t('set.oauth.relogin') : t('set.oauth.login')}
            </Button>
            {p.oauth.signedIn && (
              <Button variant="ghost" small onClick={() => post({ type: 'oauth_logout', provider: p.id })}>
                {t('set.oauth.logout')}
              </Button>
            )}
          </div>
          <div class="field-hint">{t(p.oauth.flow === 'openrouter' ? 'set.oauth.hint.openrouter' : 'set.oauth.hint.oauth2')}</div>
        </div>
      )}

      <div class="field">
        <label class="field-label" for={`key-${p.id}`}>
          {t('set.key.label', { provider: p.label })}
        </label>
        <div class="field-row">
          <input
            id={`key-${p.id}`}
            ref={keyRef}
            class="text-input"
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder={p.hasKey && !p.keyFromEnv ? '••••••••••••••••' : t('set.key.placeholder')}
            onInput={() => setHasKeyText((keyRef.current?.value.trim().length ?? 0) > 0)}
            onKeyDown={(e) => {
              if (e.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                saveKey();
              }
            }}
          />
          <Button variant="primary" small disabled={!hasKeyText} onClick={saveKey}>
            {t('set.key.save')}
          </Button>
        </div>
        <div class="field-actions">
          {p.hasKey && !p.keyFromEnv && (
            <Button variant="ghost" small icon="trash" onClick={() => post({ type: 'clear_api_key', provider: p.id })}>
              {t('set.key.clear')}
            </Button>
          )}
          <Button
            variant="secondary"
            small
            icon="check"
            busy={testing}
            disabled={!p.hasKey}
            onClick={() => {
              setTesting(true);
              setResult(null);
              post({ type: 'test_connection', provider: p.id });
              window.setTimeout(() => setTesting(false), 30000);
            }}
          >
            {testing ? t('set.testing') : t('set.test')}
          </Button>
          {p.keyUrl && (
            <button type="button" class="link-btn" onClick={() => post({ type: 'open_external', url: p.keyUrl! })}>
              {t('set.getKey')}
              <Icon name="external" size={12} />
            </button>
          )}
        </div>
        {result && (
          <div class={cx('test-result', result.ok ? 'is-ok' : 'is-fail')} role="status">
            <Icon name={result.ok ? 'check' : 'alert'} size={14} />
            <span>{result.message}</span>
          </div>
        )}
      </div>

      <div class="field">
        <label class="field-label" for={`url-${p.id}`}>
          {t('set.baseUrl')}
        </label>
        <div class="field-row">
          <input
            key={p.baseUrl}
            id={`url-${p.id}`}
            ref={urlRef}
            class="text-input is-mono"
            type="text"
            spellcheck={false}
            autocomplete="off"
            defaultValue={p.baseUrl}
            onKeyDown={(e) => {
              if (e.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                post({ type: 'set_base_url', provider: p.id, baseUrl: urlRef.current?.value.trim() ?? '' });
              }
            }}
          />
          <Button
            variant="secondary"
            small
            onClick={() => post({ type: 'set_base_url', provider: p.id, baseUrl: urlRef.current?.value.trim() ?? '' })}
          >
            {t('set.baseUrl.save')}
          </Button>
        </div>
      </div>

      {p.hasKey && (
        <div class="field">
          <div class="models-line">
            <button
              type="button"
              class="link-btn"
              aria-expanded={showModels}
              onClick={() => setShowModels((v) => !v)}
              title={t('set.models.show')}
            >
              <Icon name={showModels ? 'chevron-down' : 'chevron-right'} size={13} />
              {t('set.models', { n: p.models.length })}
            </button>
            {sourceBadge}
            <span class="prov-spacer" />
            <Button
              variant="ghost"
              small
              icon="refresh"
              busy={refreshing}
              onClick={() => {
                setRefreshing(true);
                post({ type: 'refresh_models', provider: p.id });
                window.setTimeout(() => setRefreshing(false), 8000);
              }}
            >
              {t('set.models.refresh')}
            </Button>
          </div>
          {p.modelSource === 'fallback' && (
            <div class="banner banner-warn" role="note">
              <Icon name="alert" size={15} />
              <div>
                <div>{t('set.models.fallbackWarn')}</div>
                {p.modelError && <div class="banner-detail">{p.modelError}</div>}
              </div>
            </div>
          )}
          {showModels && (
            <ul class="models-list">
              {p.models.map((m) => (
                <li key={m.id}>
                  <span class="models-label">{m.label}</span>
                  {m.label !== m.id && <span class="models-id">{m.id}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!p.builtin && (
        <div class="field-actions prov-foot">
          {confirmRemove ? (
            <>
              <Button variant="danger" small onClick={() => post({ type: 'remove_custom_provider', provider: p.id })}>
                {t('hist.confirmYes')}
              </Button>
              <Button variant="ghost" small onClick={() => setConfirmRemove(false)}>
                {t('hist.cancel')}
              </Button>
            </>
          ) : (
            <Button variant="ghost" small icon="trash" onClick={() => setConfirmRemove(true)}>
              {t('set.removeCustom')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FontCard({ id, selected, onPick }: { id: UiFontFamily; selected: boolean; onPick: () => void }) {
  const { t } = useApp();
  return (
    <button type="button" role="radio" aria-checked={selected} class={cx('font-card', selected && 'is-on')} onClick={onPick}>
      <span class="font-card-head">
        <span class="font-card-name">{t(`set.font.${id}` as I18nKey)}</span>
        {selected && <Icon name="check" size={14} />}
      </span>
      <span class="font-card-sample" style={{ fontFamily: FONT_STACKS[id] }}>
        Nguyễn Thị Thuỷ Tiên · Ướ ữ ặ ổ ệ ẫ ể
      </span>
      <span class="font-card-hint">{t(`set.font.${id}.hint` as I18nKey)}</span>
    </button>
  );
}

export function SettingsView({ view, onSetting }: { view: ViewState; onSetting: SetFn }) {
  const { t, lang, platform } = useApp();
  const [adding, setAdding] = useState(false);
  const isBrowser = platform === 'browser';
  const s = view.settings;

  return (
    <div class="screen screen-settings">
      {view.account?.status === 'signedIn' && <AccountCard account={view.account} />}
      {view.account?.status === 'signedIn' && view.locaith && <LocaithCard info={view.locaith} />}
      {view.account?.status === 'signedIn' && view.remote && <RemoteCard remote={view.remote} />}
      <section class="set-section">
        <h2 class="set-title">{t('set.providers')}</h2>
        <p class="set-hint">{t(isBrowser ? 'set.providers.hint.browser' : 'set.providers.hint')}</p>
        {/* Mô hình Locaith dùng tài khoản thay cho khoá API: có mục riêng ở trên, không có ô nhập khoá/URL. */}
        {view.providers
          .filter((p) => !p.account)
          .map((p) => (
            <ProviderCard key={p.id} p={p} />
          ))}
        {isBrowser && adding ? (
          <AddProviderForm onDone={() => setAdding(false)} />
        ) : (
          <Button icon="plus" onClick={() => (isBrowser ? setAdding(true) : post({ type: 'add_custom_provider' }))}>
            {t('set.addCustom')}
          </Button>
        )}
      </section>

      {!isBrowser && <OrchestrationSection view={view} />}
      {!isBrowser && <PermissionsPanel view={view.permissions} />} {/* (lane:perm-rules) */}

      <section class="set-section">
        <h2 class="set-title">{t('set.ui')}</h2>

        <div class="field">
          <div class="field-label">{t('set.language')}</div>
          <Segmented<UiLanguage>
            label={t('set.language')}
            value={s.language}
            options={[
              { value: 'vi', label: t('set.lang.vi') },
              { value: 'en', label: t('set.lang.en') },
            ]}
            onChange={(v) => onSetting('language', v)}
          />
        </div>

        <div class="field">
          <div class="field-label">{t('set.font')}</div>
          <div class="font-cards" role="radiogroup" aria-label={t('set.font')}>
            {FONT_ORDER.map((id) => (
              <FontCard key={id} id={id} selected={s.fontFamily === id} onPick={() => onSetting('fontFamily', id)} />
            ))}
          </div>
        </div>

        <div class="field">
          <label class="field-label" for="set-fs">
            {t('set.fontSize')} <span class="field-value">{formatDecimal(s.fontSize, lang)} px</span>
          </label>
          <input
            id="set-fs"
            class="range"
            type="range"
            min={12}
            max={20}
            step={0.5}
            value={s.fontSize}
            style={{ '--fill': `${((s.fontSize - 12) / 8) * 100}%` }}
            onInput={(e) => onSetting('fontSize', Number((e.target as HTMLInputElement).value))}
          />
        </div>

        <div class="field">
          <label class="field-label" for="set-lh">
            {t('set.lineHeight')} <span class="field-value">{formatDecimal(s.lineHeight, lang, 2)}</span>
          </label>
          <input
            id="set-lh"
            class="range"
            type="range"
            min={1.4}
            max={2}
            step={0.05}
            value={s.lineHeight}
            style={{ '--fill': `${((s.lineHeight - 1.4) / 0.6) * 100}%` }}
            onInput={(e) => onSetting('lineHeight', Number((e.target as HTMLInputElement).value))}
          />
          <div class="field-hint">{t('set.lineHeight.hint')}</div>
        </div>

        <div class="field">
          <div class="field-label">{t('set.codeFont')}</div>
          <Segmented<UiCodeFont>
            label={t('set.codeFont')}
            value={s.codeFont}
            options={[
              { value: 'jetbrains-mono', label: t('set.codeFont.jetbrains-mono') },
              { value: 'editor', label: t('set.codeFont.editor') },
            ]}
            onChange={(v) => onSetting('codeFont', v)}
          />
        </div>

        <div class="field field-inline">
          <span class="field-label">{t('set.showThinking')}</span>
          <Switch checked={s.showThinking} label={t('set.showThinking')} onChange={(v) => onSetting('showThinking', v)} />
        </div>

        <div class="preview">
          <div class="preview-title">{t('set.preview')}</div>
          <p class="preview-text">{t('set.previewText')}</p>
          <pre class="preview-code">{'const tênKháchHàng = "Đặng Thị Hồng Nhung"; // chú thích'}</pre>
        </div>
      </section>

      {isBrowser ? (
        <BrowserSettingsSections view={view} />
      ) : (
        <section class="set-section">
          <h2 class="set-title">{t('set.more')}</h2>
          <Button icon="sliders" onClick={() => post({ type: 'open_vscode_settings' })}>
            {t('set.vscodeSettings')}
          </Button>
        </section>
      )}
    </div>
  );
}
