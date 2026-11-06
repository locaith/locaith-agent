/** Cài đặt "Điều phối nhiều AI": chế độ + bảng hạng → model của các khoá API đã nhập. */
import type { OrchestrationMode, ViewState } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { post } from '../vscode';
import { Segmented } from './ui';

const TIERS = ['top', 'balanced', 'fast'] as const;

export function OrchestrationSection({ view }: { view: ViewState }) {
  const { t } = useApp();
  const o = view.orchestration ?? { mode: 'off' as OrchestrationMode, pool: [] };
  return (
    <section class="set-section">
      <h2 class="set-title">{t('orch.title')}</h2>
      <p class="set-hint">{t('orch.hint')}</p>
      <Segmented<OrchestrationMode>
        label={t('orch.title')}
        value={o.mode}
        options={[
          { value: 'off', label: t('orch.mode.off') },
          { value: 'failover', label: t('orch.mode.failover') },
          { value: 'auto', label: t('orch.mode.auto') },
        ]}
        onChange={(v) => post({ type: 'set_orchestration', mode: v })}
      />
      <div class="field-hint">{t(`orch.mode.${o.mode}.hint` as const)}</div>

      <div class="field">
        <div class="field-label">{t('orch.pool')}</div>
        {o.pool.length === 0 ? (
          <div class="field-hint">{t('orch.pool.empty')}</div>
        ) : (
          <ul class="orch-pool">
            {o.pool.map((p) => (
              <li key={p.providerId} class="orch-row">
                <div class="orch-name">
                  {p.providerLabel}
                  {p.cooling && <span class="orch-cool">{t('orch.cooling')}</span>}
                </div>
                <div class="orch-tiers">
                  {TIERS.map((tier) => (
                    <span key={tier} class={`orch-tier tier-${tier}${p.tiers[tier] ? '' : ' is-none'}`} title={p.tiers[tier]?.label ?? ''}>
                      <b>{t(`orch.tier.${tier}` as const)}</b>
                      <span>{p.tiers[tier]?.label ?? '—'}</span>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="field-hint">{t('orch.autoModel')}</div>
    </section>
  );
}
