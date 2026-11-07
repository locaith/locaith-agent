/**
 * (lane:perm-rules) Nguồn luật quyền của bản VS Code: đọc `locaithAgent.permissions.allow/ask/deny` theo TỪNG CẤP cài đặt và áp quy tắc tin cậy.
 *
 *   • `ask` và `deny` nhận từ cả người dùng lẫn workspace (workspace chỉ được SIẾT CHẶT).
 *   • `allow` chỉ nhận từ cài đặt người dùng; luật allow nằm trong `.vscode/settings.json` chỉ có hiệu lực sau khi người dùng xác nhận MỘT lần
 *     (băm nội dung danh sách → `permissions.trustedWorkspaceAllow`, lưu ở cấp người dùng). Đổi danh sách = băm khác = phải xác nhận lại.
 *   • Workspace chưa tin cậy (Workspace Trust) ⇒ bỏ qua MỌI luật allow.
 *
 * Một thể hiện cho mỗi ConfigService (`for(config)`) để controller, extension engine và lệnh /permissions dùng chung.
 */

import * as vscode from 'vscode';
import type { PermissionsView } from '../shared/protocol';
import { buildRules, formatRule, hashRules, parseRule, type Rule, type RuleAction } from '../shared/permissionRules';
import type { RuleSnapshot } from '../core/engine/extensions/permissionRules';
import type { ConfigService } from './config';

export const PERM_KEYS: Record<RuleAction, string> = { allow: 'permissions.allow', ask: 'permissions.ask', deny: 'permissions.deny' };
export const TRUSTED_KEY = 'permissions.trustedWorkspaceAllow';
const MAX_RULES_PER_LIST = 500;

type Scope = 'user' | 'workspace';

const instances = new WeakMap<object, PermissionRulesService>();

export class PermissionRulesService {
  private readonly listeners = new Set<() => void>();
  private focus = false;
  private sub: vscode.Disposable | undefined;

  static for(config: ConfigService): PermissionRulesService {
    let s = instances.get(config);
    if (!s) {
      s = new PermissionRulesService(config);
      instances.set(config, s);
    }
    return s;
  }

  constructor(private readonly config: ConfigService) {
    try {
      this.sub = config.onDidChange((e) => {
        if (e.affectsConfiguration('locaithAgent.permissions')) this.changed();
      });
    } catch {
      /* stub test không có onDidChange đầy đủ */
    }
  }

  dispose(): void {
    this.sub?.dispose();
    this.listeners.clear();
  }

  /** Nghe thay đổi bộ luật (để vá ViewState). Trả về hàm huỷ. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* người nghe lỗi không làm hỏng dịch vụ */
      }
    }
  }

  /** Đọc theo cấp; chịu được cấu hình giả trong kiểm thử (không có `cfg()`/`inspect`). */
  private inspect(key: string): { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined {
    try {
      return this.config.cfg()?.inspect?.<unknown>(key);
    } catch {
      return undefined;
    }
  }

  private async update(key: string, value: unknown, scope: Scope): Promise<void> {
    const cfg = this.config.cfg?.();
    if (!cfg?.update) return;
    await cfg.update(key, value, scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
  }

  private list(key: string, scope: Scope): string[] {
    const info = this.inspect(key);
    const raw = scope === 'user' ? info?.globalValue : [info?.workspaceValue, info?.workspaceFolderValue];
    const arr = scope === 'user' ? (Array.isArray(raw) ? raw : []) : (raw as unknown[]).flatMap((v) => (Array.isArray(v) ? v : []));
    return arr.filter((v): v is string => typeof v === 'string').slice(0, MAX_RULES_PER_LIST);
  }

  private trusted(): boolean {
    return vscode.workspace.isTrusted !== false;
  }

  private trustedHashes(): string[] {
    const v = this.inspect(TRUSTED_KEY)?.globalValue;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  /** Luật allow hợp lệ do workspace đề xuất (đã chuẩn hoá) và băm của chúng. */
  private workspaceAllow(): { rules: string[]; hash: string } {
    const rules = this.list(PERM_KEYS.allow, 'workspace')
      .map((s) => parseRule(s))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map(formatRule);
    const uniq = [...new Set(rules)];
    return { rules: uniq, hash: hashRules(uniq) };
  }

  /** Bộ luật có hiệu lực + số liệu phụ. */
  snapshot(): RuleSnapshot {
    const trusted = this.trusted();
    const ws = this.workspaceAllow();
    const wsAllowOk = trusted && ws.rules.length > 0 && this.trustedHashes().includes(ws.hash);
    const rules: Rule[] = buildRules([
      { action: 'deny', source: 'user', items: this.list(PERM_KEYS.deny, 'user') },
      { action: 'deny', source: 'workspace', items: this.list(PERM_KEYS.deny, 'workspace') },
      { action: 'ask', source: 'user', items: this.list(PERM_KEYS.ask, 'user') },
      { action: 'ask', source: 'workspace', items: this.list(PERM_KEYS.ask, 'workspace') },
      ...(trusted ? [{ action: 'allow' as const, source: 'user' as const, items: this.list(PERM_KEYS.allow, 'user') }] : []),
      ...(wsAllowOk ? [{ action: 'allow' as const, source: 'workspace' as const, items: ws.rules }] : []),
    ]);
    return {
      rules,
      ...(trusted && ws.rules.length && !wsAllowOk ? { workspaceAllowPending: ws.rules.length } : {}),
      ...(trusted ? {} : { untrusted: true }),
    };
  }

  view(): PermissionsView {
    const snap = this.snapshot();
    const ws = this.workspaceAllow();
    const pending = snap.workspaceAllowPending ? { hash: ws.hash, rules: ws.rules } : undefined;
    return {
      rules: snap.rules.map((r) => ({ action: r.action, text: r.text, source: r.source })),
      ...(pending ? { workspaceAllowPending: pending } : {}),
      ...(snap.untrusted ? { untrusted: true } : {}),
      ...(this.focus ? { focus: true } : {}),
    };
  }

  /** Bật/tắt cờ "mở khu quản lý" (lệnh /permissions). */
  setFocus(on: boolean): void {
    if (this.focus === on) return;
    this.focus = on;
    this.changed();
  }

  /** Thêm một luật vào cài đặt. Trả về dạng chuẩn, hoặc null nếu luật không hợp lệ / không được phép ở phạm vi này. */
  async add(action: RuleAction, text: string, scope: Scope): Promise<string | null> {
    const p = parseRule(text);
    if (!p) return null;
    const rule = formatRule(p);
    const key = PERM_KEYS[action];
    const cur = this.list(key, scope);
    if (!cur.includes(rule)) {
      if (cur.length >= MAX_RULES_PER_LIST) return null;
      await this.update(key, [...cur, rule], scope);
    }
    // Luật allow ghi vào workspace theo yêu cầu của chính người dùng → coi như đã xác nhận danh sách mới (băm cập nhật).
    if (action === 'allow' && scope === 'workspace') await this.trustWorkspaceAllow(this.workspaceAllow().hash);
    this.changed();
    return rule;
  }

  async remove(action: RuleAction, text: string, scope: Scope): Promise<boolean> {
    const p = parseRule(text);
    if (!p) return false;
    const rule = formatRule(p);
    const key = PERM_KEYS[action];
    const cur = this.list(key, scope);
    const next = cur.filter((s) => {
      const q = parseRule(s);
      return !q || formatRule(q) !== rule;
    });
    if (next.length === cur.length) return false;
    await this.update(key, next, scope);
    this.changed();
    return true;
  }

  /** Xác nhận danh sách luật allow của workspace: chỉ nhận khi `hash` ĐÚNG băm của danh sách hiện tại (người dùng đã thấy đúng nó). */
  async trustWorkspaceAllow(hash: string): Promise<boolean> {
    const ws = this.workspaceAllow();
    if (!ws.rules.length || hash !== ws.hash) return false;
    const cur = this.trustedHashes();
    if (!cur.includes(hash)) await this.update(TRUSTED_KEY, [...cur.slice(-49), hash], 'user');
    this.changed();
    return true;
  }
}
