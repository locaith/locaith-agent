/** Chợ: kỹ năng đóng gói sẵn (bấm Thêm), plugin, server MCP và agent. Mọi thao tác chỉ gửi ý định cho host. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { MarketAgentItem, MarketMcpItem, MarketPluginItem, MarketSkillItem, MarketState } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import type { I18nKey } from '../i18n';
import { cx } from '../util';
import { post } from '../vscode';
import { LoSpinner } from './Brand';
import { BrandIcon } from './BrandIcon';
import { Icon } from './Icons';
import { ChromePanel } from './ChromePanel';
import { McpPanel } from './McpPanel';
import { PluginMarket } from './PluginMarket';
import { Badge, Button, Switch } from './ui';

type Tab = 'skills' | 'plugins' | 'mcp' | 'chrome' | 'agents';
type Group = 'all' | 'installed' | MarketSkillItem['group'];

const PAGE = 40;

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();

/** Nhãn ngắn của nguồn kỹ năng cho monogram: "wshobson-agents" → "wshobson". */
const sourceLabel = (repo: string): string => repo.replace(/-(agent-)?(skills|agents|superpowers|claude-plugins-official)$/i, '') || repo;

const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function SkillsTab({ state }: { state: MarketState }) {
  const { t } = useApp();
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<Group>('all');
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const installed = useMemo(() => new Set(state.installedSkills), [state.installedSkills]);
  useEffect(() => setBusy(new Set()), [state.installedSkills]);
  useEffect(() => setLimit(PAGE), [q, group]);

  const list = useMemo(() => {
    const tokens = fold(q).split(/[^a-z0-9]+/).filter(Boolean);
    return state.skills.filter((s) => {
      if (group === 'installed' ? !installed.has(s.id) : group !== 'all' && s.group !== group) return false;
      if (tokens.length === 0) return true;
      const hay = fold(`${s.name} ${s.description} ${s.repo}`);
      return tokens.every((tk) => hay.includes(tk));
    });
  }, [state.skills, installed, q, group]);

  const act = (type: 'market_install' | 'market_uninstall', id: string) => {
    setBusy((b) => new Set(b).add(id));
    post({ type, id });
    window.setTimeout(() => setBusy((b) => (b.has(id) ? new Set([...b].filter((x) => x !== id)) : b)), 20000);
  };

  const groups: Group[] = ['all', 'installed', 'anthropic', 'vendor', 'community'];
  return (
    <div class="mk-pane">
      <p class="set-hint">{t('mk.skills.intro')}</p>
      <input class="text-input mk-search" type="search" value={q} placeholder={t('mk.skills.search')} aria-label={t('mk.skills.search')} spellcheck={false} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="mk-chips" role="radiogroup" aria-label={t('mk.tab.skills')}>
        {groups.map((g) => (
          <button key={g} type="button" role="radio" aria-checked={group === g} class={cx('mk-chip', group === g && 'is-on')} onClick={() => setGroup(g)}>
            {t(`mk.group.${g}` as I18nKey)}
          </button>
        ))}
      </div>
      <div class="mk-count">{t('mk.skills.count', { n: state.skills.length, m: installed.size })}</div>
      {list.length === 0 ? (
        <div class="field-hint">{t('mk.empty')}</div>
      ) : (
        <ul class="mk-list">
          {list.slice(0, limit).map((s) => {
            const isIn = installed.has(s.id);
            return (
              <li key={s.id} class={cx('mk-row', 'has-bi', isIn && 'is-in')}>
                <BrandIcon origin={s.repo} label={sourceLabel(s.repo)} />
                <div class="mk-main">
                  <div class="mk-title">
                    <span class="mk-name">{s.name}</span>
                    <Badge tone={s.group === 'anthropic' ? 'ok' : 'neutral'}>{t(`mk.group.${s.group}` as I18nKey)}</Badge>
                  </div>
                  <div class="mk-desc">{s.description}</div>
                  <div class="mk-meta">
                    {s.repo} · {s.license} · {t('mk.files', { n: s.files })} · {kb(s.bytes)}
                  </div>
                </div>
                <div class="mk-actions">
                  {isIn ? (
                    <>
                      <span class="mk-added">
                        <Icon name="check" size={14} /> {t('mk.added')}
                      </span>
                      <Button small variant="ghost" busy={busy.has(s.id)} onClick={() => act('market_uninstall', s.id)}>
                        {t('mk.remove')}
                      </Button>
                    </>
                  ) : (
                    <Button small variant="primary" icon="plus" busy={busy.has(s.id)} onClick={() => act('market_install', s.id)}>
                      {t('mk.add')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {list.length > limit && (
        <Button class="mk-more" onClick={() => setLimit((l) => l + PAGE)}>
          {t('mk.more')} ({list.length - limit})
        </Button>
      )}
    </div>
  );
}

function PluginsTab({ plugins, market }: { plugins: MarketPluginItem[]; market?: MarketState['pluginMarket'] }) {
  const { t } = useApp();
  return (
    <div class="mk-pane">
      <p class="set-hint">{t('mk.plugins.intro')}</p>
      <div class="mk-toolbar">
        <Button small icon="folder" onClick={() => post({ type: 'plugin_install', source: 'folder' })}>
          {t('mk.plugins.install.folder')}
        </Button>
        <Button small icon="link" onClick={() => post({ type: 'plugin_install', source: 'git' })}>
          {t('mk.plugins.install.git')}
        </Button>
        <Button small variant="ghost" icon="external" onClick={() => post({ type: 'plugin_open_folder' })}>
          {t('mk.plugins.open')}
        </Button>
      </div>
      {plugins.length === 0 ? (
        <div class="field-hint">{t('mk.plugins.empty', { dir: '~/.locaith/plugins' })}</div>
      ) : (
        <ul class="mk-list">
          {plugins.map((p) => (
            <li key={p.id} class={cx('mk-row', 'has-bi', p.enabled && 'is-in')}>
              <BrandIcon id={p.id} name={p.name} />
              <div class="mk-main">
                <div class="mk-title">
                  <span class="mk-name">{p.name}</span>
                  {p.version && <span class="mk-ver">v{p.version}</span>}
                </div>
                {p.description && <div class="mk-desc">{p.description}</div>}
                <div class="mk-meta">{p.error ? p.error : t('mk.plugins.contrib', { s: p.skills, a: p.agents, m: p.mcp })}</div>
              </div>
              <div class="mk-actions">
                <Switch checked={p.enabled} label={p.name} onChange={(v) => post({ type: 'plugin_toggle', id: p.id, enabled: v })} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <PluginMarket market={market} />
    </div>
  );
}

function AgentsTab({ agents }: { agents: MarketAgentItem[] }) {
  const { t } = useApp();
  return (
    <div class="mk-pane">
      <p class="set-hint">{t('mk.agents.intro')}</p>
      <div class="mk-toolbar">
        <Button small variant="ghost" icon="folder" onClick={() => post({ type: 'agents_open_folder' })}>
          {t('mk.agents.open')}
        </Button>
      </div>
      <ul class="mk-list">
        {agents.map((a) => (
          <li key={a.name} class="mk-row">
            <div class="mk-main">
              <div class="mk-title">
                <span class="mk-name">{a.name}</span>
                <Badge tone="neutral">{a.tier}</Badge>
                <span class="mk-ver">{t(`mk.agents.source.${a.source}` as I18nKey)}</span>
              </div>
              <div class="mk-desc">{a.description}</div>
              <div class="mk-meta">{t('mk.agents.tools', { t: a.tools })}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MarketView({ state }: { state: MarketState | null }) {
  const { t } = useApp();
  const [tab, setTab] = useState<Tab>('skills');
  useEffect(() => post({ type: 'market_open' }), []);
  const tabs: { id: Tab; icon: 'package' | 'plug' | 'network' | 'bot' | 'globe'; label: I18nKey }[] = [
    { id: 'skills', icon: 'package', label: 'mk.tab.skills' },
    { id: 'plugins', icon: 'plug', label: 'mk.tab.plugins' },
    { id: 'mcp', icon: 'network', label: 'mk.tab.mcp' },
    { id: 'chrome', icon: 'globe', label: 'mk.tab.chrome' },
    { id: 'agents', icon: 'bot', label: 'mk.tab.agents' },
  ];
  return (
    <div class="screen screen-market">
      <div class="mk-tabs" role="tablist" aria-label={t('mk.title')}>
        {tabs.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} aria-label={t(x.label)} title={t(x.label)} class={cx('mk-tab', tab === x.id && 'is-on')} onClick={() => setTab(x.id)}>
            <Icon name={x.icon} size={15} />
            <span class="mk-tab-label">{t(x.label)}</span>
          </button>
        ))}
      </div>
      {/* The only scroller of this screen. The tab bar above it is a fixed band, NOT a sticky overlay: nothing ever scrolls underneath it,
          so no text shows through it whatever the theme or the background of the host container. key={tab}: a new tab starts at the top. */}
      <div class="mk-body" key={tab}>
        {!state ? (
          <div class="mk-loading" role="status">
            <LoSpinner size={22} /> {t('mk.loading')}
          </div>
        ) : tab === 'skills' ? (
          <SkillsTab state={state} />
        ) : tab === 'plugins' ? (
          <PluginsTab plugins={state.plugins} market={state.pluginMarket} />
        ) : tab === 'mcp' ? (
          <McpPanel state={state} />
        ) : tab === 'chrome' ? (
          <ChromePanel chrome={state.chrome} />
        ) : (
          <AgentsTab agents={state.agents} />
        )}
      </div>
    </div>
  );
}
