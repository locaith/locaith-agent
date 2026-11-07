/**
 * (lane:perm-rules) Khu quản lý luật quyền trong Cài đặt: ba nhóm chặn / luôn hỏi / cho phép (kèm nguồn cá nhân · dự án, nút xoá), ô thêm luật,
 * ô «thử khớp một lệnh» (chạy ngay trong webview bằng cùng bộ so khớp với engine) và thẻ xác nhận luật cho phép mà dự án đề xuất.
 * Lệnh /permissions bật cờ `focus` → khu này mở ra và cuộn tới.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { PermissionsView } from '../../../src/shared/protocol';
import type { RuleAction } from '../../../src/shared/permissionRules';
import { useApp } from '../ctx';
import { groupRules, isValidRuleText, RULE_ACTIONS, tryCommand } from '../permRulesView';
import { cx } from '../util';
import { post } from '../vscode';
import { Icon } from './Icons';
import { Button } from './ui';

const ACTION_TONE: Record<RuleAction, string> = { deny: 'tone-danger', ask: 'tone-warn', allow: 'tone-ok' };

export function PermissionsPanel({ view }: { view: PermissionsView | undefined }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<RuleAction>('allow');
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'user' | 'workspace'>('user');
  const [probe, setProbe] = useState('');
  const rootRef = useRef<HTMLElement>(null);

  // /permissions → mở và cuộn tới; báo host đã nhận cờ để lần sau không tự mở lại.
  useEffect(() => {
    if (!view?.focus) return;
    setOpen(true);
    window.setTimeout(() => rootRef.current?.scrollIntoView({ block: 'start' }), 0);
    post({ type: 'perm_rules_open' });
  }, [view?.focus]);

  const groups = groupRules(view?.rules ?? []);
  const total = view?.rules.length ?? 0;
  const windows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  const hit = probe.trim() ? tryCommand(view, probe, windows) : null;
  const textOk = isValidRuleText(text);
  const add = () => {
    if (!textOk) return;
    post({ type: 'perm_rules_add', action, rule: text.trim(), scope });
    setText('');
  };

  return (
    <section class="set-section perm-rules" ref={rootRef}>
      <button type="button" class="perm-rules-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <h2 class="set-title">{t('rules.title')}</h2>
        <span class="perm-rules-count">{total}</span>
        {view?.workspaceAllowPending && <span class="perm-rules-dot" aria-hidden="true" />}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
      </button>
      {open && (
        <div class="perm-rules-body">
          <p class="set-hint">{t('rules.hint')}</p>
          {view?.untrusted && <div class="perm-warn">{t('rules.untrusted')}</div>}

          {view?.workspaceAllowPending && (
            <div class="perm-pending" role="group">
              <div class="perm-pending-title">{t('rules.pending', { n: view.workspaceAllowPending.rules.length })}</div>
              <ul class="perm-rule-list">
                {view.workspaceAllowPending.rules.map((r) => (
                  <li key={r} class="perm-rule-row">
                    <code class="inline-code">{r}</code>
                  </li>
                ))}
              </ul>
              <div class="perm-pending-hint">{t('rules.pending.hint')}</div>
              <Button variant="primary" small icon="check" onClick={() => post({ type: 'perm_rules_trust_workspace', hash: view.workspaceAllowPending!.hash })}>
                {t('rules.pending.accept')}
              </Button>
            </div>
          )}

          {RULE_ACTIONS.map((a) => (
            <div key={a} class="perm-group">
              <div class={cx('perm-group-title', ACTION_TONE[a])}>{t(`rules.${a}` as 'rules.deny')}</div>
              {groups[a].length === 0 ? (
                <div class="perm-group-empty">{t('rules.empty')}</div>
              ) : (
                <ul class="perm-rule-list">
                  {groups[a].map((r) => (
                    <li key={`${r.source}:${r.text}`} class="perm-rule-row">
                      <code class="inline-code">{r.text}</code>
                      <span class="perm-rule-src">{t(`rules.source.${r.source}` as 'rules.source.user')}</span>
                      <button
                        type="button"
                        class="perm-rule-del"
                        title={t('rules.remove')}
                        aria-label={`${t('rules.remove')}: ${r.text}`}
                        onClick={() => post({ type: 'perm_rules_remove', action: a, rule: r.text, scope: r.source })}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <div class="field-hint">{t('rules.workspaceAllowNote')}</div>

          <div class="perm-add">
            <div class="perm-add-row">
              <select class="perm-select" value={action} aria-label={t('rules.add')} onChange={(e) => setAction((e.target as HTMLSelectElement).value as RuleAction)}>
                {RULE_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {t(`rules.${a}` as 'rules.deny')}
                  </option>
                ))}
              </select>
              <input
                class={cx('perm-rule-input', text && !textOk && 'is-invalid')}
                type="text"
                spellcheck={false}
                placeholder={t('rules.add.placeholder')}
                value={text}
                aria-label={t('rules.add')}
                onInput={(e) => setText((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
              />
            </div>
            <div class="perm-add-row">
              <div class="perm-scope" role="radiogroup" aria-label={t('rules.add')}>
                {(['user', 'workspace'] as const).map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={scope === s} class={cx('perm-scope-opt', scope === s && 'is-on')} onClick={() => setScope(s)}>
                    {t(`rules.add.scope.${s}` as 'rules.add.scope.user')}
                  </button>
                ))}
              </div>
              <Button small icon="plus" disabled={!textOk} onClick={add}>
                {t('rules.add')}
              </Button>
              {text && !textOk && <span class="perm-always-hint">{t('rules.add.invalid')}</span>}
            </div>
          </div>

          <div class="perm-try">
            <label class="perm-note-label" for="perm-try">
              {t('rules.try')}
            </label>
            <input id="perm-try" class="perm-rule-input" type="text" spellcheck={false} placeholder={t('rules.try.placeholder')} value={probe} onInput={(e) => setProbe((e.target as HTMLInputElement).value)} />
            {probe.trim() && (
              <div class={cx('perm-try-result', hit ? ACTION_TONE[hit.action] : '')} role="status">
                {hit ? t('rules.try.hit', { action: t(`rules.${hit.action}` as 'rules.deny'), rule: hit.rule, source: t(`rules.source.${hit.source}` as 'rules.source.user') }) : t('rules.try.none')}
              </div>
            )}
          </div>

          <button type="button" class="link-btn perm-rules-collapse" onClick={() => setOpen(false)}>
            {t('rules.collapse')}
          </button>
        </div>
      )}
    </section>
  );
}
