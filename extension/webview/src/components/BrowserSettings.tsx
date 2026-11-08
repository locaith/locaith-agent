/** Phần Cài đặt chỉ có ở bản trình duyệt: biểu mẫu thêm API tuỳ chỉnh, quyền truy cập trang web, hành vi và hướng dẫn riêng. */
import { useRef, useState } from 'preact/hooks';
import type { BrowserSettings, CustomProviderInput, PermissionMode, ViewState } from '../../../src/shared/protocol';
import { CUSTOM_PRESETS } from '../../../src/core/providers/presets';
import { useApp } from '../ctx';
import { post } from '../vscode';
import { Icon } from './Icons';
import { Badge, Button, Segmented, Switch } from './ui';

const KINDS: { value: NonNullable<CustomProviderInput['kind']>; label: string }[] = [
  { value: 'openai-chat', label: 'OpenAI Chat (Ollama, LM Studio…)' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'gemini', label: 'Google Gemini' },
];

/** Địa chỉ chuyển hướng OAuth của tiện ích (chrome.identity.getRedirectURL() cho cùng kết quả) — hiện sẵn để người dùng đăng ký với nhà cung cấp. */
function redirectUri(): string {
  const id = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id;
  return id ? `https://${id}.chromiumapp.org/` : '';
}

/** Biểu mẫu thêm API tuỳ chỉnh (bản VS Code dùng hộp thoại gốc của VS Code, ở đây phải tự vẽ). */
export function AddProviderForm({ onDone }: { onDone: () => void }) {
  const { t } = useApp();
  const name = useRef<HTMLInputElement>(null);
  const url = useRef<HTMLInputElement>(null);
  const models = useRef<HTMLTextAreaElement>(null);
  const key = useRef<HTMLInputElement>(null);
  const authorizeUrl = useRef<HTMLInputElement>(null);
  const tokenUrl = useRef<HTMLInputElement>(null);
  const clientId = useRef<HTMLInputElement>(null);
  const scopes = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<NonNullable<CustomProviderInput['kind']>>('openai-chat');
  const [preset, setPreset] = useState('');

  const applyPreset = (id: string) => {
    setPreset(id);
    const p = CUSTOM_PRESETS.find((x) => x.id === id);
    if (!p) return;
    if (name.current) name.current.value = p.label;
    if (url.current) url.current.value = p.baseUrl;
    setKind('openai-chat'); // mọi mẫu đều dùng Chat Completions
  };

  const base = (): Pick<CustomProviderInput, 'label' | 'baseUrl' | 'kind' | 'models'> | null => {
    const label = name.current?.value.trim() ?? '';
    const baseUrl = url.current?.value.trim() ?? '';
    if (!label || !baseUrl) return null;
    return { label, baseUrl, kind, models: models.current?.value ?? '' };
  };
  const submit = () => {
    const b = base();
    if (!b) return;
    const apiKey = key.current?.value.trim();
    post({ type: 'save_custom_provider', provider: { ...b, apiKey: apiKey || undefined, requiresKey: !!apiKey } });
    onDone();
  };
  const submitOpenRouter = () => {
    const b = base();
    if (!b) return;
    post({ type: 'save_custom_provider', provider: { ...b, requiresKey: true, oauth: { flow: 'openrouter' }, loginNow: true } });
    onDone();
  };
  const submitOAuth2 = () => {
    const b = base();
    const a = authorizeUrl.current?.value.trim() ?? '';
    const tk = tokenUrl.current?.value.trim() ?? '';
    const cid = clientId.current?.value.trim() ?? '';
    if (!b || !a || !tk || !cid) return;
    post({ type: 'save_custom_provider', provider: { ...b, requiresKey: true, oauth: { flow: 'oauth2', authorizeUrl: a, tokenUrl: tk, clientId: cid, scopes: scopes.current?.value.trim() || undefined }, loginNow: true } });
    onDone();
  };
  const onEnter = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      submit();
    }
  };
  const isOpenRouter = preset === 'openrouter';

  return (
    <div class="add-provider-form" role="group" aria-label={t('set.addCustom')}>
      <div class="field">
        <label class="field-label" for="ap-preset">
          {t('set.addCustom.preset')}
        </label>
        <select id="ap-preset" class="text-input" value={preset} onChange={(e) => applyPreset((e.target as HTMLSelectElement).value)}>
          <option value="">{t('set.addCustom.presetNone')}</option>
          {CUSTOM_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="ap-name">
          {t('set.addCustom.name')}
        </label>
        <input id="ap-name" ref={name} class="text-input" type="text" autocomplete="off" spellcheck={false} onKeyDown={onEnter} />
      </div>
      <div class="field">
        <label class="field-label" for="ap-url">
          {t('set.addCustom.url')}
        </label>
        <input id="ap-url" ref={url} class="text-input is-mono" type="text" autocomplete="off" spellcheck={false} placeholder="https://api.example.com/v1" onKeyDown={onEnter} />
      </div>
      <div class="field">
        <label class="field-label" for="ap-kind">
          {t('set.addCustom.kind')}
        </label>
        <select id="ap-kind" class="text-input" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as typeof kind)}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="ap-models">
          {t('set.addCustom.models')}
        </label>
        <textarea id="ap-models" ref={models} class="text-input is-mono" rows={2} spellcheck={false} />
      </div>
      <div class="field">
        <label class="field-label" for="ap-key">
          {t('set.addCustom.key')}
        </label>
        <input id="ap-key" ref={key} class="text-input" type="password" autocomplete="off" spellcheck={false} onKeyDown={onEnter} />
      </div>

      {isOpenRouter && (
        <div class="field">
          <p class="set-hint">{t('set.oauth.hint.openrouter')}</p>
          <Button variant="primary" small icon="check" onClick={submitOpenRouter}>
            {t('set.addCustom.oauthOpenrouter')}
          </Button>
        </div>
      )}

      <details class="field">
        <summary class="field-label">{t('set.addCustom.oauth2.title')}</summary>
        <p class="set-hint">{t('set.addCustom.oauth2.hint', { uri: redirectUri() })}</p>
        <label class="field-label" for="ap-o2-auth">
          {t('set.addCustom.oauth2.authorize')}
        </label>
        <input id="ap-o2-auth" ref={authorizeUrl} class="text-input is-mono" type="text" autocomplete="off" spellcheck={false} placeholder="https://auth.example.com/authorize" />
        <label class="field-label" for="ap-o2-token">
          {t('set.addCustom.oauth2.token')}
        </label>
        <input id="ap-o2-token" ref={tokenUrl} class="text-input is-mono" type="text" autocomplete="off" spellcheck={false} placeholder="https://auth.example.com/token" />
        <label class="field-label" for="ap-o2-client">
          {t('set.addCustom.oauth2.client')}
        </label>
        <input id="ap-o2-client" ref={clientId} class="text-input is-mono" type="text" autocomplete="off" spellcheck={false} />
        <label class="field-label" for="ap-o2-scopes">
          {t('set.addCustom.oauth2.scopes')}
        </label>
        <input id="ap-o2-scopes" ref={scopes} class="text-input is-mono" type="text" autocomplete="off" spellcheck={false} />
        <div class="field-actions">
          <Button variant="secondary" small onClick={submitOAuth2}>
            {t('set.addCustom.oauth2.go')}
          </Button>
        </div>
      </details>

      <div class="field-actions">
        <Button variant="primary" small icon="check" onClick={submit}>
          {t('set.addCustom.save')}
        </Button>
        <Button variant="ghost" small onClick={onDone}>
          {t('set.addCustom.cancel')}
        </Button>
      </div>
    </div>
  );
}

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan'];

/** Quyền truy cập trang web + hành vi + hướng dẫn riêng. */
export function BrowserSettingsSections({ view }: { view: ViewState }) {
  const { t } = useApp();
  const instr = useRef<HTMLTextAreaElement>(null);
  const b = view.browser;
  if (!b) return null;
  const s = b.settings;
  const set = <K extends keyof BrowserSettings>(key: K, value: BrowserSettings[K]) => post({ type: 'set_browser_setting', key, value: value as string | number | boolean });
  const modes: PermissionMode[] = s.allowBypass ? [...MODES, 'bypass'] : MODES;

  return (
    <>
      <section class="set-section">
        <h2 class="set-title">{t('set.access')}</h2>
        <p class="set-hint">{t('set.access.hint')}</p>
        <div class="field field-inline">
          <span class="field-label">{b.browser}</span>
          {b.siteAccess ? <Badge tone="ok">{t('set.access.granted')}</Badge> : <Badge tone="neutral">{t('set.access.none')}</Badge>}
        </div>
        {b.siteAccess ? (
          <Button variant="outline" icon="x" onClick={() => post({ type: 'revoke_site_access' })}>
            {t('set.access.revoke')}
          </Button>
        ) : (
          <Button variant="primary" icon="check" onClick={() => post({ type: 'request_site_access' })}>
            {t('set.access.grant')}
          </Button>
        )}
      </section>

      <section class="set-section">
        <h2 class="set-title">{t('set.browser')}</h2>

        <div class="field">
          <div class="field-label">{t('set.defaultMode')}</div>
          <Segmented<PermissionMode>
            label={t('set.defaultMode')}
            value={s.defaultMode}
            options={modes.map((m) => ({ value: m, label: t(`mode.${m}.browser` as 'mode.default.browser') }))}
            onChange={(v) => set('defaultMode', v)}
          />
        </div>

        <div class="field field-inline">
          <span class="field-label">{t('set.allowBypass')}</span>
          <Switch checked={s.allowBypass} label={t('set.allowBypass')} onChange={(v) => set('allowBypass', v)} />
        </div>
        {s.allowBypass && (
          <div class="banner banner-warn" role="note">
            <Icon name="alert" size={15} />
            <div>{t('set.allowBypass.hint')}</div>
          </div>
        )}

        <div class="field field-inline">
          <span class="field-label">{t('set.summarizer')}</span>
          <Switch checked={s.summarizer} label={t('set.summarizer')} onChange={(v) => set('summarizer', v)} />
        </div>
        <div class="field field-inline">
          <span class="field-label">{t('set.autoCompact')}</span>
          <Switch checked={s.autoCompact} label={t('set.autoCompact')} onChange={(v) => set('autoCompact', v)} />
        </div>
        <div class="field field-inline">
          <span class="field-label">{t('set.attachTab')}</span>
          <Switch checked={s.attachTabContext} label={t('set.attachTab')} onChange={(v) => set('attachTabContext', v)} />
        </div>
        <div class="field-hint">{t('set.attachTab.hint')}</div>
        <div class="field field-inline">
          <span class="field-label">{t('set.pinTab')}</span>
          <Switch checked={s.pinTab} label={t('set.pinTab')} onChange={(v) => set('pinTab', v)} />
        </div>
        <div class="field-hint">{t('set.pinTab.hint')}</div>
        <div class="field field-inline">
          <span class="field-label">{t('set.presence')}</span>
          <Switch checked={s.presence} label={t('set.presence')} onChange={(v) => set('presence', v)} />
        </div>
        <div class="field-hint">{t('set.presence.hint')}</div>
        <div class="field field-inline">
          <span class="field-label">{t('set.focusTabs')}</span>
          <Switch checked={s.focusTabs} label={t('set.focusTabs')} onChange={(v) => set('focusTabs', v)} />
        </div>
        <div class="field-hint">{t('set.focusTabs.hint')}</div>
      </section>

      <section class="set-section">
        <h2 class="set-title">{t('set.instructions')}</h2>
        <p class="set-hint">{t('set.instructions.hint')}</p>
        {/* Không kiểm soát (không gán value khi đang gõ) để không làm hỏng bộ gõ Telex/VNI. */}
        <textarea key={s.customInstructions} ref={instr} class="text-input" rows={5} spellcheck={false} defaultValue={s.customInstructions} aria-label={t('set.instructions')} />
        <Button variant="secondary" small onClick={() => set('customInstructions', instr.current?.value ?? '')}>
          {t('set.instructions.save')}
        </Button>
      </section>

      <div class="banner banner-warn" role="note">
        <Icon name="key" size={15} />
        <div>{t('set.keysNotice')}</div>
      </div>
    </>
  );
}
