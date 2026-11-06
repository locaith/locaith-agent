/** Các bộ chọn dưới ô nhập: model, chế độ quyền, mức suy luận, và đồng hồ ngữ cảnh. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ModelInfo, PermissionMode, ProviderSummary, ThinkingLevel, ViewState } from '../../../../src/shared/protocol';
import { PICKER_THINKING_LEVELS } from '../../../../src/shared/protocol';
import { bus } from '../../bus';
import { useApp } from '../../ctx';
import { formatContextWindow, formatInt, formatPercent } from '../../format';
import type { I18nKey } from '../../i18n';
import type { IconName } from '../../iconNames';
import { filterByQuery, normalizeVi } from '../../text';
import { cx, useDismiss } from '../../util';
import { post } from '../../vscode';
import { Icon } from '../Icons';
import { Badge, Button, ProviderBadge } from '../ui';

// ── Hook điều hướng bàn phím trong danh sách ────────────────────────────────

function useListNav(count: number, initial: number, onPick: (index: number) => void) {
  const [active, setActive] = useState(Math.max(0, initial));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (count === 0 ? 0 : (i + 1) % count));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (count === 0 ? 0 : (i - 1 + count) % count));
    } else if ((e.key === 'Home' || e.key === 'End') && (e.target as HTMLElement | null)?.tagName !== 'INPUT') {
      // Trong ô tìm kiếm, Home/End phải di chuyển con trỏ chữ như bình thường.
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : Math.max(0, count - 1));
    } else if (e.key === 'Enter' && count > 0) {
      e.preventDefault();
      onPick(active);
    }
  };
  return { active, setActive, onKeyDown };
}

function scrollActiveIntoView(root: HTMLElement | null) {
  root?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
}

// ── Chọn model ──────────────────────────────────────────────────────────────

const TIER_KEY: Record<NonNullable<ModelInfo['tier']>, I18nKey> = {
  top: 'model.tier.top',
  balanced: 'model.tier.balanced',
  fast: 'model.tier.fast',
};

interface ModelEntry {
  provider: ProviderSummary;
  model: ModelInfo;
}

export function ModelPicker({ view, open, onToggle, onClose }: { view: ViewState; open: boolean; onToggle: () => void; onClose: () => void }) {
  const { t, lang, openSettings } = useApp();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  useDismiss(rootRef, open, onClose);

  const current = view.providers.find((p) => p.id === view.provider);
  const currentModel = current?.models.find((m) => m.id === view.model);
  const label = currentModel?.label ?? (view.model || t('composer.noProvider'));

  // Danh sách phẳng các model chọn được (theo bộ lọc) để điều hướng bằng phím.
  const groups = useMemo(() => {
    return view.providers.map((p) => ({
      provider: p,
      models: p.hasKey ? filterByQuery(p.models, filter, (m) => [m.label, m.id, p.label]) : [],
    }));
  }, [view.providers, filter]);

  const flat: ModelEntry[] = useMemo(
    () => groups.flatMap((g) => g.models.map((model) => ({ provider: g.provider, model }))),
    [groups],
  );

  const trimmed = filter.trim();
  const customTarget = current?.hasKey ? current : view.providers.find((p) => p.hasKey);
  const showCustom =
    trimmed.length > 1 && !!customTarget && !flat.some((e) => normalizeVi(e.model.id) === normalizeVi(trimmed));
  const count = flat.length + (showCustom ? 1 : 0);

  const pick = (i: number) => {
    if (i < flat.length) {
      const e = flat[i];
      post({ type: 'set_model', provider: e.provider.id, model: e.model.id });
      onClose();
    } else if (customTarget) {
      post({ type: 'set_model', provider: customTarget.id, model: trimmed });
      onClose();
    }
  };

  const initialIdx = Math.max(0, flat.findIndex((e) => e.provider.id === view.provider && e.model.id === view.model));
  const nav = useListNav(count, initialIdx, pick);

  useEffect(() => {
    if (open) {
      setFilter('');
      nav.setActive(initialIdx);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => scrollActiveIntoView(listRef.current), [nav.active, open, filter]);
  useEffect(() => nav.setActive(0), [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  let runningIdx = -1;

  return (
    <div class="picker" ref={rootRef}>
      <button
        type="button"
        class={cx('picker-btn', 'picker-model', open && 'is-open')}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('model.title')}
        onClick={onToggle}
      >
        {current ? <ProviderBadge id={current.id} label={current.label} size={16} /> : <Icon name="cpu" size={15} />}
        <span class="picker-text">{label}</span>
        <Icon name="chevron-down" size={13} class="picker-caret" />
      </button>

      {open && (
        <div class="popover popover-model" role="dialog" aria-label={t('model.title')} onKeyDown={nav.onKeyDown}>
          <div class="popover-search">
            <Icon name="search" size={14} />
            <input
              ref={inputRef}
              type="text"
              class="popover-search-input"
              placeholder={t('model.search')}
              aria-label={t('model.search')}
              spellcheck={false}
              autocomplete="off"
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="popover-list" role="listbox" ref={listRef}>
            {groups.map(({ provider: p, models }) => {
              if (p.hasKey && models.length === 0 && trimmed) return null;
              return (
                <div class="model-group" key={p.id}>
                  <div class="model-group-head">
                    <ProviderBadge id={p.id} label={p.label} size={16} />
                    <span class="model-group-name">{p.label}</span>
                    {p.hasKey && p.modelSource === 'fallback' && (
                      <Badge tone="warn" title={t('model.fallbackHint')}>
                        {t('model.fallback')}
                      </Badge>
                    )}
                    {p.hasKey && p.modelSource === 'cache' && <Badge tone="neutral">{t('model.cache')}</Badge>}
                    {p.account && p.needsConsent && <Badge tone="warn">{t('model.needsConsent')}</Badge>}
                    <span class="model-group-spacer" />
                    {p.hasKey ? (
                      <button
                        type="button"
                        class="icon-btn icon-btn-sm"
                        title={t('model.refresh')}
                        aria-label={`${t('model.refresh')}: ${p.label}`}
                        onClick={() => post({ type: 'refresh_models', provider: p.id })}
                      >
                        <Icon name="refresh" size={13} />
                      </button>
                    ) : (
                      <button type="button" class="link-btn" onClick={() => { onClose(); openSettings(); }}>
                        {t('model.addKey')}
                      </button>
                    )}
                  </div>
                  {!p.hasKey && <div class="model-nokey">{t('model.noKey')}</div>}
                  {models.map((m) => {
                    runningIdx++;
                    const idx = runningIdx;
                    const selected = p.id === view.provider && m.id === view.model;
                    const isActive = idx === nav.active;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        data-active={isActive}
                        class={cx('model-row', selected && 'is-selected', isActive && 'is-active')}
                        onMouseMove={() => nav.setActive(idx)}
                        onClick={() => pick(idx)}
                      >
                        <span class="model-check">{selected && <Icon name="check" size={14} />}</span>
                        <span class="model-main">
                          <span class="model-name">{m.label}</span>
                          {m.label !== m.id && <span class="model-id">{m.id}</span>}
                        </span>
                        <span class="model-tags">
                          {m.tier && <span class={cx('tag', `tag-${m.tier}`)}>{t(TIER_KEY[m.tier])}</span>}
                          {m.contextWindow ? <span class="tag tag-ctx" title={t('model.ctx', { n: formatContextWindow(m.contextWindow, lang) })}>{formatContextWindow(m.contextWindow, lang)}</span> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {showCustom && customTarget && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-active={nav.active === flat.length}
                class={cx('model-row', 'model-custom', nav.active === flat.length && 'is-active')}
                onMouseMove={() => nav.setActive(flat.length)}
                onClick={() => pick(flat.length)}
              >
                <span class="model-check" />
                <span class="model-main">
                  <span class="model-name">{t('model.custom', { q: trimmed, provider: customTarget.label })}</span>
                </span>
              </button>
            )}
            {count === 0 && trimmed && <div class="popover-empty">{t('model.empty')}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chế độ quyền ────────────────────────────────────────────────────────────

const MODE_ICON: Record<PermissionMode, IconName> = {
  default: 'shield',
  acceptEdits: 'pencil',
  plan: 'list-checks',
  bypass: 'alert',
};

export function ModePicker({ view, open, onToggle, onClose }: { view: ViewState; open: boolean; onToggle: () => void; onClose: () => void }) {
  const { t, platform } = useApp();
  // Nhãn riêng cho trình duyệt: "chỉnh sửa/chạy lệnh" đổi thành "thao tác trên trang".
  const mk = (m: PermissionMode, desc = false) => `mode.${m}${platform === 'browser' ? '.browser' : ''}${desc ? '.desc' : ''}` as I18nKey;
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, onClose);

  // "Bỏ qua mọi xác nhận" (bản trình duyệt: "Toàn quyền") luôn hiện trong danh sách ở CẢ HAI bản — người dùng không phải vào Cài đặt để mở nó ra.
  // Chọn lúc chưa bật thì hiện MỘT hộp xác nhận (FullAccessDialog) bật và chuyển sang chế độ đó trong một bước.
  const modes = useMemo(() => ['default', 'acceptEdits', 'plan', 'bypass'] as PermissionMode[], []);
  const choose = (i: number) => {
    if (modes[i] === 'bypass' && !view.allowBypass) bus.fullAccess.emit();
    else post({ type: 'set_mode', mode: modes[i] });
    onClose();
  };
  const nav = useListNav(modes.length, modes.indexOf(view.mode), choose);

  useEffect(() => {
    if (open) {
      nav.setActive(Math.max(0, modes.indexOf(view.mode)));
      window.setTimeout(() => popRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div class="picker" ref={rootRef}>
      <button
        type="button"
        class={cx('picker-btn', open && 'is-open', view.mode === 'bypass' && 'is-danger', view.mode === 'plan' && 'is-accent')}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${t('mode.title')}: ${t(mk(view.mode))}`}
        aria-label={`${t('mode.title')}: ${t(mk(view.mode))}`}
        onClick={onToggle}
      >
        <Icon name={MODE_ICON[view.mode]} size={15} />
        <span class="picker-text picker-label-opt picker-text-quiet">{t(mk(view.mode))}</span>
        <Icon name="chevron-down" size={13} class="picker-caret picker-caret-opt" />
      </button>
      {open && (
        <div class="popover popover-small" role="listbox" aria-label={t('mode.title')} tabIndex={-1} ref={popRef} onKeyDown={nav.onKeyDown}>
          <div class="popover-title">{t('mode.title')}</div>
          {modes.map((m, i) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={m === view.mode}
              class={cx('opt-row', m === view.mode && 'is-selected', i === nav.active && 'is-active', m === 'bypass' && 'is-danger')}
              onMouseMove={() => nav.setActive(i)}
              onClick={() => choose(i)}
            >
              <span class="opt-icon">
                <Icon name={MODE_ICON[m]} size={16} />
              </span>
              <span class="opt-main">
                <span class="opt-name">{t(mk(m))}</span>
                <span class="opt-desc">{t(mk(m, true))}</span>
              </span>
              <span class="opt-check">{m === view.mode && <Icon name="check" size={14} />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Mức suy luận ────────────────────────────────────────────────────────────

/** Công tắc Swarm: bật điều phối bầy agent, độc lập với mức suy luận đang chọn. */
export function SwarmToggle({ view }: { view: ViewState }) {
  const { t } = useApp();
  const on = view.swarm === true || view.thinkingLevel === 'swarm';
  return (
    <button
      type="button"
      class={cx('picker-btn', 'swarm-toggle', on && 'is-swarm')}
      aria-pressed={on}
      aria-label={t('swarm.toggle')}
      title={on ? t('swarm.on.hint') : t('swarm.off.hint')}
      onClick={() => post({ type: 'set_swarm', on: !on })}
    >
      <Icon name="network" size={15} />
      <span class="picker-text picker-label-opt">{on ? t('swarm.on') : t('swarm.off')}</span>
    </button>
  );
}

export function ThinkingPicker({ view, open, onToggle, onClose }: { view: ViewState; open: boolean; onToggle: () => void; onClose: () => void }) {
  const { t } = useApp();
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, onClose);

  const levels = PICKER_THINKING_LEVELS;
  const choose = (i: number) => {
    post({ type: 'set_thinking', level: levels[i] as ThinkingLevel });
    onClose();
  };
  const nav = useListNav(levels.length, levels.indexOf(view.thinkingLevel), choose);

  useEffect(() => {
    if (open) {
      nav.setActive(Math.max(0, levels.indexOf(view.thinkingLevel)));
      window.setTimeout(() => popRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div class="picker" ref={rootRef}>
      <button
        type="button"
        class={cx('picker-btn', open && 'is-open', view.thinkingLevel !== 'off' && 'is-accent')}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${t('think.title')}: ${t(`think.${view.thinkingLevel}` as I18nKey)}`}
        onClick={onToggle}
      >
        <Icon name="lightbulb" size={15} />
        <span class="picker-text picker-label-opt">
          {t(`think.${view.thinkingLevel}` as I18nKey)}
        </span>
        <Icon name="chevron-down" size={13} class="picker-caret picker-caret-opt" />
      </button>
      {open && (
        <div class="popover popover-small" role="listbox" aria-label={t('think.title')} tabIndex={-1} ref={popRef} onKeyDown={nav.onKeyDown}>
          <div class="popover-title">{t('think.title')}</div>
          {levels.map((l, i) => (
            <button
              key={l}
              type="button"
              role="option"
              aria-selected={l === view.thinkingLevel}
              class={cx('opt-row', l === view.thinkingLevel && 'is-selected', i === nav.active && 'is-active')}
              onMouseMove={() => nav.setActive(i)}
              onClick={() => choose(i)}
            >
              <span class="opt-icon">
                {l === 'swarm' ? (
                  <Icon name="network" size={15} class="think-swarm" />
                ) : (
                  <span class="think-bars" aria-hidden="true">
                    {[0, 1, 2, 3].map((n) => (
                      <i key={n} class={cx(n < i && 'on')} />
                    ))}
                  </span>
                )}
              </span>
              <span class="opt-main">
                <span class="opt-name">{t(`think.${l}` as I18nKey)}</span>
                <span class="opt-desc">{t(`think.${l}.desc` as I18nKey)}</span>
              </span>
              <span class="opt-check">{l === view.thinkingLevel && <Icon name="check" size={14} />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Đồng hồ ngữ cảnh ────────────────────────────────────────────────────────

export function ContextMeter({ view, open, onToggle, onClose }: { view: ViewState; open: boolean; onToggle: () => void; onClose: () => void }) {
  const { t, lang } = useApp();
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, onClose);

  const ctx = view.context;
  const ratio = ctx && ctx.limitTokens > 0 ? Math.min(1, ctx.usedTokens / ctx.limitTokens) : 0;
  const tone = ratio > 0.9 ? 'danger' : ratio > 0.7 ? 'warn' : 'ok';
  const R = 8.5;
  const C = 2 * Math.PI * R;
  const detail = ctx
    ? t('ctx.detail', { used: formatInt(ctx.usedTokens, lang), limit: formatInt(ctx.limitTokens, lang), pct: formatPercent(ratio, lang) })
    : t('ctx.unknown');

  return (
    <div class="picker picker-ctx" ref={rootRef}>
      <button
        type="button"
        class={cx('ctx-btn', `ctx-${tone}`, open && 'is-open')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t('ctx.title')}: ${detail}`}
        title={`${t('ctx.title')}: ${detail}`}
        onClick={onToggle}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="ctx-track" cx="12" cy="12" r={R} fill="none" stroke-width="3" />
          {ratio > 0.005 && (
            <circle
              class="ctx-value"
              cx="12"
              cy="12"
              r={R}
              fill="none"
              stroke-width="3"
              stroke-linecap="round"
              stroke-dasharray={`${(C * ratio).toFixed(2)} ${C.toFixed(2)}`}
              transform="rotate(-90 12 12)"
            />
          )}
        </svg>
      </button>
      {open && (
        <div class="popover popover-small popover-ctx" role="dialog" aria-label={t('ctx.title')}>
          <div class="popover-title">{t('ctx.title')}</div>
          <div class="ctx-detail">{detail}</div>
          <div class={cx('ctx-bar', `ctx-${tone}`)} aria-hidden="true">
            <span style={{ width: `${Math.round(ratio * 100)}%` }} />
          </div>
          <div class="ctx-hint">{t('ctx.compactHint')}</div>
          <Button
            variant="secondary"
            small
            icon="refresh"
            disabled={view.running || !ctx || ctx.usedTokens === 0}
            onClick={() => {
              post({ type: 'compact' });
              onClose();
            }}
          >
            {t('ctx.compact')}
          </Button>
        </div>
      )}
    </div>
  );
}
