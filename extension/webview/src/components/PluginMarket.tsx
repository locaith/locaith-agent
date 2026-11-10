/** Chợ plugin: plugin chính thức của Anthropic và các nguồn đã kiểm khác (Microsoft, AWS, cộng đồng — có nhãn), định dạng plugin của Claude Code — bấm Cài là tải về và chép vào ~/.locaith/plugins (đang TẮT cho tới khi bạn bật). */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { PluginMarketState } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { cx } from '../util';
import { post } from '../vscode';
import { LoSpinner } from './Brand';
import { BrandIcon } from './BrandIcon';
import { Icon } from './Icons';
import { Badge, Button } from './ui';

const PAGE = 30;
const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();

export function PluginMarket({ market }: { market?: PluginMarketState }) {
  const { t } = useApp();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [src, setSrc] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const items = market?.items ?? [];
  useEffect(() => post({ type: 'plugin_market_refresh' }), []); // dùng bộ đệm 1 giờ của host
  useEffect(() => setBusy(new Set()), [items]);
  useEffect(() => setLimit(PAGE), [q, cat, src]);
  const sources = market?.sources ?? [];
  const inSrc = useMemo(() => (src === 'all' ? items : items.filter((i) => i.market === src)), [items, src]);
  const trustOf = (id?: string) => sources.find((s) => s.id === id)?.trust;

  const cats = useMemo(() => {
    const n = new Map<string, number>();
    for (const i of inSrc) n.set(i.category, (n.get(i.category) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c]) => c);
  }, [inSrc]);
  const list = useMemo(() => {
    const tokens = fold(q).split(/[^a-z0-9]+/).filter(Boolean);
    return inSrc.filter((i) => (cat === 'all' || i.category === cat) && (tokens.length === 0 || tokens.every((tk) => fold(`${i.name} ${i.description} ${i.category} ${i.origin}`).includes(tk))));
  }, [inSrc, q, cat]);

  const act = (type: 'plugin_market_install' | 'plugin_uninstall', id: string) => {
    setBusy((b) => new Set(b).add(id));
    post({ type, id });
    window.setTimeout(() => setBusy((b) => (b.has(id) ? new Set([...b].filter((x) => x !== id)) : b)), 180_000);
  };

  return (
    <section class="pm" aria-label={t('pm.title')}>
      <h3 class="mk-sub">{t('pm.title')}</h3>
      <p class="set-hint">{t('pm.intro')}</p>
      {market?.loading && (
        <div class="mk-loading" role="status">
          <LoSpinner size={18} /> {t('pm.loading')}
        </div>
      )}
      {market?.error && (
        <div class="mk-err">
          {market.error}{' '}
          <Button small variant="ghost" icon="refresh" onClick={() => post({ type: 'plugin_market_refresh', force: true })}>
            {t('pm.retry')}
          </Button>
        </div>
      )}
      {items.length > 0 && (
        <>
          <input class="text-input mk-search" type="search" value={q} placeholder={t('pm.search')} aria-label={t('pm.search')} spellcheck={false} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          {sources.length > 1 && (
            <div class="mk-chips" role="radiogroup" aria-label={t('pm.sources')}>
              {[{ id: 'all', label: t('pm.source.all'), count: items.length }, ...sources].map((s) => (
                <button key={s.id} type="button" role="radio" aria-checked={src === s.id} class={cx('mk-chip', src === s.id && 'is-on')} onClick={() => (setSrc(s.id), setCat('all'))}>
                  {s.label} <span class="mk-ver">{s.count}</span>
                </button>
              ))}
            </div>
          )}
          {trustOf(src) === 'community' && <div class="mk-warn">{t('pm.community.warn')}</div>}
          <div class="mk-chips" role="radiogroup" aria-label={t('pm.title')}>
            {['all', ...cats].map((c) => (
              <button key={c} type="button" role="radio" aria-checked={cat === c} class={cx('mk-chip', cat === c && 'is-on')} onClick={() => setCat(c)}>
                {c === 'all' ? t('mk.group.all') : c}
              </button>
            ))}
          </div>
          <div class="mk-count">{t('pm.count', { n: list.length, m: inSrc.length })}</div>
          {list.length === 0 ? (
            <div class="field-hint">{t('mk.empty')}</div>
          ) : (
            <ul class="mk-list">
              {list.slice(0, limit).map((i) => (
                <li key={i.id} class={cx('mk-row', 'has-bi', i.installed && 'is-in', !i.installable && 'is-off')}>
                  <BrandIcon id={i.id} name={i.name} origin={i.origin} />
                  <div class="mk-main">
                    <div class="mk-title">
                      <span class="mk-name">{i.name}</span>
                      <Badge tone="neutral">{i.category}</Badge>
                      {i.trust === 'community' && <Badge tone="warn">{t('pm.trust.community')}</Badge>}
                      {i.trust === 'vendor' && <Badge tone="neutral">{t('pm.trust.vendor')}</Badge>}
                      <span class="mk-ver">{i.origin}</span>
                    </div>
                    {i.description && <div class="mk-desc">{i.description}</div>}
                    {i.reason && <div class="mk-warn">{i.reason}</div>}
                  </div>
                  <div class="mk-actions">
                    {!i.installable ? (
                      <Badge tone="warn">{t('mcp.unsupported')}</Badge>
                    ) : i.installed ? (
                      <>
                        <span class="mk-added">
                          <Icon name="check" size={14} /> {t('pm.installed')}
                        </span>
                        <Button small variant="ghost" busy={busy.has(i.id)} onClick={() => act('plugin_uninstall', i.id)}>
                          {t('pm.uninstall')}
                        </Button>
                      </>
                    ) : (
                      <Button small variant="primary" icon="download" busy={busy.has(i.id)} onClick={() => act('plugin_market_install', i.id)}>
                        {t('pm.install')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {list.length > limit && (
            <Button class="mk-more" onClick={() => setLimit((l) => l + PAGE)}>
              {t('mk.more')} ({list.length - limit})
            </Button>
          )}
        </>
      )}
    </section>
  );
}
