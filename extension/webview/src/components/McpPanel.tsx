/** Tab MCP của Chợ: Bio-Memory-Locaith (của Locaith), các kết nối đang có, và kho dịch vụ để kết nối một chạm (kiểu Connectors của Claude/ChatGPT). */
import { useMemo, useState } from 'preact/hooks';
import type { BioStatus, CatalogItem, MarketMcpItem, MarketState } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import type { I18nKey } from '../i18n';
import { cx } from '../util';
import { post } from '../vscode';
import { LoSpinner } from './Brand';
import { BrandIcon } from './BrandIcon';
import { Icon } from './Icons';
import { Badge, Button, Switch } from './ui';

const BIO = 'bio-memory-locaith';
const CATS = ['all', 'memory', 'dev', 'pm', 'office', 'comm', 'crm', 'data', 'cloud', 'auto', 'pay', 'design', 'docs', 'search', 'browser', 'files'] as const;

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();

function BioCard({ bio }: { bio: BioStatus }) {
  const { t } = useApp();
  const installing = bio.state === 'installing';
  return (
    <section class={cx('bio-card', bio.enabled && 'is-on')} aria-label={t('mcp.bio.title')}>
      <div class="bio-head">
        <BrandIcon id={BIO} name="Bio-Memory-Locaith" vendor="Locaith" size={36} class="bio-ico" />
        <h3 class="bio-title">{t('mcp.bio.title')}</h3>
        <Badge tone="accent">{t('mcp.bio.badge')}</Badge>
        <span class={cx('bio-state', `st-${bio.state}`)}>{bio.state === 'ready' ? (bio.enabled ? t('mcp.bio.on') : t('mcp.bio.off')) : t(`mcp.bio.state.${bio.state}` as I18nKey)}</span>
      </div>
      <p class="mk-desc bio-desc">{t('mcp.bio.desc')}</p>
      {installing && (
        <div class="bio-progress" role="status">
          <LoSpinner size={16} />
          <span class="bio-log">{bio.log?.[bio.log.length - 1] ?? t('mcp.bio.state.installing')}</span>
        </div>
      )}
      {bio.state === 'error' && bio.message && <div class="mk-err">{bio.message}</div>}
      <div class="mk-meta">{bio.state === 'none' || bio.state === 'error' ? t('mcp.bio.needs') : t('mcp.bio.data', { dir: bio.dataDir })}</div>
      <div class="mk-toolbar">
        {(bio.state === 'none' || bio.state === 'error') && (
          <Button small variant="primary" icon="download" busy={installing} onClick={() => post({ type: 'bio_install' })}>
            {t('mcp.bio.install')}
          </Button>
        )}
        {bio.state === 'ready' && (
          <>
            <Switch checked={bio.enabled} label={t('mcp.bio.title')} onChange={(v) => post({ type: 'bio_enable', enabled: v })} />
            <Button small variant="ghost" icon="folder" onClick={() => post({ type: 'bio_open_folder' })}>
              {t('mcp.bio.openData')}
            </Button>
            <Button small variant="ghost" icon="refresh" onClick={() => post({ type: 'bio_install' })}>
              {t('mcp.bio.reinstall')}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function PolicyBtns({ value, onChange }: { value?: 'allow' | 'ask' | 'deny'; onChange: (v: 'allow' | 'ask' | 'deny') => void }) {
  const { lang } = useApp();
  const cur = value ?? 'ask';
  const title = (v: 'allow' | 'ask' | 'deny'): string =>
    lang === 'vi'
      ? (v === 'allow' ? 'Luôn cho phép' : v === 'ask' ? 'Hỏi trước mỗi lần' : 'Tắt công cụ này')
      : (v === 'allow' ? 'Always allow' : v === 'ask' ? 'Ask every time' : 'Turn this tool off');
  return (
    <span class="mk-pol" role="group">
      {(['allow', 'ask', 'deny'] as const).map((v) => (
        <button
          key={v}
          type="button"
          class={cx('mk-pol-btn', `is-${v}`, cur === v && 'is-on')}
          aria-pressed={cur === v}
          title={title(v)}
          onClick={() => onChange(v)}
        >
          {v === 'allow' ? '✓' : v === 'ask' ? '?' : '⊘'}
        </button>
      ))}
    </span>
  );
}

function ServerRow({ s }: { s: MarketMcpItem }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const on = s.status === 'running' || s.status === 'starting';
  const isConn = s.scope === 'connector';
  const isBio = s.name === BIO;
  return (
    <li class={cx('mk-row', 'mk-mcp', 'has-bi', `st-${s.status}`)}>
      <BrandIcon id={s.catalogId} name={s.name} label={s.label ?? s.name} url={s.summary} />
      <div class="mk-main">
        <div class="mk-title">
          <span class={cx('mk-dot', `st-${s.status}`)} aria-hidden="true">
            {s.status === 'starting' && <LoSpinner size={12} />}
          </span>
          <span class="mk-name">{s.label ?? s.name}</span>
          <Badge tone="neutral">{t(`mk.mcp.scope.${s.scope}` as I18nKey)}</Badge>
          <span class="mk-ver">{t(`mk.mcp.status.${s.status}` as I18nKey)}</span>
        </div>
        {s.note && <div class="mk-warn">{s.note}</div>}
        {/* Chỗ người dùng quyết định cho chạy: server CHƯA duyệt hiện lệnh ĐẦY ĐỦ, xuống dòng (không còn một dòng bị cắt «…» che đuôi lệnh);
            đã duyệt thì gọn một dòng, lệnh đủ nằm ở tooltip. cwd / biến môi trường / tên header cũng thuộc thứ sẽ chạy nên hiện ngay dưới lệnh. */}
        <div class={cx('mk-meta', 'mk-cmd', !s.approved && 'mk-cmd-full')} title={s.detail ? `${s.summary}\n${s.detail}` : s.summary}>
          {s.summary}
        </div>
        {s.detail && <div class={cx('mk-meta', 'mk-cmd', !s.approved && 'mk-cmd-full')}>{s.detail}</div>}
        {!s.approved && <div class="mk-warn">{t('mk.mcp.notApproved')}</div>}
        {s.error && <div class="mk-err">{s.error}</div>}
        {s.tools.length > 0 && (
          <button type="button" class="mk-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} /> {t('mk.mcp.tools', { n: s.tools.length })}
          </button>
        )}
        {open && (
          <>
            {s.groupPolicy && (
              <div class="mk-pol-groups">
                {(['read', 'write'] as const).map((g) => (
                  <div class="mk-pol-row" key={g}>
                    <span class="mk-pol-label">{t(`mk.mcp.group.${g}` as I18nKey)}</span>
                    <PolicyBtns value={s.groupPolicy![g]} onChange={(v) => post({ type: 'mcp_tool_policy', server: s.name, group: g, policy: v })} />
                  </div>
                ))}
              </div>
            )}
            <ul class="mk-tools">
              {s.tools.map((tool) => (
                <li key={tool.name} title={tool.description}>
                  <code>{tool.name}</code> <span>{tool.description}</span>
                  <PolicyBtns value={tool.policy} onChange={(v) => post({ type: 'mcp_tool_policy', server: s.name, tool: tool.name, group: tool.group, policy: v })} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div class="mk-actions">
        {on && (
          <Button small variant="ghost" icon="refresh" title={t('mk.mcp.restart')} onClick={() => post({ type: 'mcp_restart', name: s.name })}>
            <span class="mk-hide-narrow">{t('mk.mcp.restart')}</span>
          </Button>
        )}
        {isConn && !isBio ? (
          <Button small variant="ghost" icon="trash" title={t('mcp.disconnect')} onClick={() => post({ type: 'connector_disconnect', id: s.name })}>
            <span class="mk-hide-narrow">{t('mcp.disconnect')}</span>
          </Button>
        ) : (
          <Switch checked={on} label={s.label ?? s.name} onChange={(v) => (isBio ? post({ type: 'bio_enable', enabled: v }) : post({ type: 'mcp_toggle', name: s.name, enabled: v }))} />
        )}
      </div>
    </li>
  );
}

function CatalogCard({ e }: { e: CatalogItem }) {
  const { t } = useApp();
  const [busy, setBusy] = useState(false);
  const go = (type: 'connector_connect' | 'connector_token') => {
    setBusy(true);
    post({ type, id: e.id });
    window.setTimeout(() => setBusy(false), 60_000); // đăng nhập trình duyệt có thể lâu; trạng thái thật quay về qua market_state
  };
  const authLabel = t(`mcp.auth.${e.auth}` as I18nKey);
  return (
    <li class={cx('mk-row', 'cat-card', 'has-bi', e.connected && 'is-in', e.unsupported && 'is-off')}>
      <BrandIcon id={e.id} name={e.name} vendor={e.vendor} />
      <div class="mk-main">
        <div class="mk-title">
          <span class="mk-name">{e.name}</span>
          <Badge tone={e.own ? 'accent' : 'neutral'}>{e.vendor}</Badge>
          <span class="mk-ver">
            <Icon name={e.auth === 'local' ? 'cpu' : e.auth === 'none' ? 'globe' : 'key'} size={11} /> {authLabel}
            {e.needs === 'node' ? ` · ${t('mcp.needsNode')}` : e.needs === 'python' ? ` · ${t('mcp.needsUv')}` : ''}
          </span>
        </div>
        <div class="mk-desc">{e.description}</div>
        {e.note && <div class="mk-meta">{e.note}</div>}
        {e.inputs && !e.connected && !e.unsupported && (
          <div class="mk-meta">
            {t('mcp.needsInputs', { list: e.inputs.map((i) => i.label).join(' · ') })}
          </div>
        )}
        {e.unsupported && <div class="mk-warn">{e.unsupported}</div>}
        {e.connected && e.status === 'error' && e.error && <div class="mk-err">{e.error}</div>}
      </div>
      <div class="mk-actions">
        {e.unsupported ? (
          <Badge tone="warn">{t('mcp.unsupported')}</Badge>
        ) : e.connected ? (
          <>
            <span class="mk-added">
              <Icon name="check" size={14} /> {t('mk.mcp.presetAdded')}
            </span>
            <Button small variant="ghost" onClick={() => post({ type: 'connector_disconnect', id: e.id })}>
              {t('mcp.disconnect')}
            </Button>
          </>
        ) : (
          <>
            <Button small variant="primary" icon="plus" busy={busy} onClick={() => go('connector_connect')}>
              {t('mcp.connect')}
            </Button>
            {e.id === 'github' && (
              <Button small variant="ghost" icon="key" busy={busy} onClick={() => go('connector_token')}>
                {t('mcp.useToken')}
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function McpPanel({ state }: { state: MarketState }) {
  const { t } = useApp();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<(typeof CATS)[number]>('all');
  const catalog = state.catalog ?? [];
  const list = useMemo(() => {
    const tokens = fold(q).split(/[^a-z0-9]+/).filter(Boolean);
    return catalog.filter((e) => (cat === 'all' || e.category === cat) && (tokens.length === 0 || tokens.every((tk) => fold(`${e.name} ${e.vendor} ${e.description}`).includes(tk))));
  }, [catalog, q, cat]);
  const present = useMemo(() => new Set(catalog.map((e) => e.category)), [catalog]);

  return (
    <div class="mk-pane">
      <p class="set-hint">{t('mk.mcp.intro')}</p>
      {state.bio && <BioCard bio={state.bio} />}
      <div class="mk-toolbar">
        <Button small icon="link" onClick={() => post({ type: 'connector_add_url' })}>
          {t('mcp.addUrl')}
        </Button>
        <Button small variant="ghost" icon="sliders" onClick={() => post({ type: 'mcp_open_config' })}>
          {t('mk.mcp.config')}
        </Button>
      </div>
      <h3 class="mk-sub">{t('mcp.connected')}</h3>
      {state.mcp.length === 0 ? (
        <div class="field-hint">{t('mcp.none')}</div>
      ) : (
        <ul class="mk-list">
          {state.mcp.map((s) => (
            <ServerRow key={s.name} s={s} />
          ))}
        </ul>
      )}
      <h3 class="mk-sub">{t('mcp.add')}</h3>
      <input class="text-input mk-search" type="search" value={q} placeholder={t('mcp.search')} aria-label={t('mcp.search')} spellcheck={false} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="mk-chips" role="radiogroup" aria-label={t('mcp.add')}>
        {CATS.filter((c) => c === 'all' || present.has(c)).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={cat === c} class={cx('mk-chip', cat === c && 'is-on')} onClick={() => setCat(c)}>
            {t(`mcp.cat.${c}` as I18nKey)}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <div class="field-hint">{t('mk.empty')}</div>
      ) : (
        <ul class="mk-list">
          {list.map((e) => (
            <CatalogCard key={e.id} e={e} />
          ))}
        </ul>
      )}
    </div>
  );
}
