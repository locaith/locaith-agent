/**
 * (lane:perm-rules) Phần "quản lý luật quyền" phía host: lệnh `/permissions`, tin nhắn từ webview (Luôn cho phép, thêm/xoá luật, xác nhận luật
 * allow của workspace) và trường `permissions` của ViewState. Tách khỏi ChatController để controller chỉ cần vài dòng gắn vào.
 *
 * Lệnh `/permissions` cũng hoạt động bằng CHỮ (không cần khu quản lý) để dùng được từ Remote/CLI:
 *   /permissions                         mở khu quản lý trong Cài đặt + tóm tắt bộ luật trong khung chat
 *   /permissions allow run_command(npm test:*)   thêm luật vào cài đặt NGƯỜI DÙNG (ask / deny tương tự)
 *   /permissions remove run_command(npm test:*)  xoá luật đó (mọi nhóm, cấp người dùng)
 *   /permissions test npm test && rm -rf /       thử khớp một lệnh với bộ luật hiện tại
 *   /permissions trust                   chấp nhận danh sách luật allow mà workspace đề xuất
 */

import * as vscode from 'vscode';
import type { Lang } from '../core/engine/strings';
import type { PermissionDecision } from '../core/engine/types';
import type { PermissionsView, ViewState, WebviewMessage } from '../shared/protocol';
import { evaluateRules, parseRule, type RuleAction } from '../shared/permissionRules';
import type { ConfigService } from './config';
import { PermissionRulesService } from './permissionRulesService';
import type { SlashRegistry } from './slashRegistry';

export interface PermissionsHostApi {
  config: ConfigService;
  lang(): Lang;
  patch(p: Partial<ViewState>): void;
  notice(level: 'info' | 'warn', text: string): void;
  /** Trả lời một thẻ xin quyền đang chờ. false = không còn thẻ đó. */
  resolvePermission(id: string, d: PermissionDecision): boolean;
  showScreen(screen: 'settings'): Promise<void>;
}

export interface PermissionsFeature {
  view(): PermissionsView;
  /** Xử lý tin của lane này; false = không phải tin của lane. */
  handle(m: WebviewMessage): boolean;
  dispose(): void;
}

const ACTIONS = new Set<string>(['allow', 'ask', 'deny']);
const isAction = (v: unknown): v is RuleAction => typeof v === 'string' && ACTIONS.has(v);
const isScope = (v: unknown): v is 'user' | 'workspace' => v === 'user' || v === 'workspace';

/** Luật quá rộng để lưu từ THẺ xin quyền (bấm một nút); vẫn thêm được qua /permissions hoặc cài đặt nếu người dùng chủ ý. */
function tooBroadForCard(rule: string): boolean {
  const p = parseRule(rule);
  if (!p) return true;
  if (p.spec === undefined) return !p.tool.startsWith('mcp__');
  const s = p.spec.trim();
  return s === '*' || s === '**' || s === ':*';
}

export function attachPermissionsFeature(slash: SlashRegistry, api: PermissionsHostApi): PermissionsFeature {
  const svc = PermissionRulesService.for(api.config);
  const vi = () => api.lang() === 'vi';
  const unsubscribe = svc.onChange(() => api.patch({ permissions: svc.view() }));

  const summary = (): string => {
    const v = svc.view();
    const line = (a: RuleAction) => {
      const list = v.rules.filter((r) => r.action === a);
      if (!list.length) return '';
      return `**${a}** (${list.length}): ${list.map((r) => `\`${r.text}\`${r.source === 'workspace' ? (vi() ? ' (workspace)' : ' (workspace)') : ''}`).join(', ')}`;
    };
    const parts = [line('deny'), line('ask'), line('allow')].filter(Boolean);
    const head = vi() ? 'Luật quyền đang có hiệu lực' : 'Permission rules in effect';
    const none = vi() ? 'Chưa có luật nào. Thêm ở khu quản lý trong Cài đặt, hoặc `/permissions allow run_command(npm test:*)`.' : 'No rules yet. Add them in the Settings panel, or `/permissions allow run_command(npm test:*)`.';
    const pending = v.workspaceAllowPending
      ? vi()
        ? `\nWorkspace đề xuất ${v.workspaceAllowPending.rules.length} luật cho phép chưa áp dụng: ${v.workspaceAllowPending.rules.map((r) => `\`${r}\``).join(', ')} — gõ \`/permissions trust\` để chấp nhận.`
        : `\nThe workspace proposes ${v.workspaceAllowPending.rules.length} allow rule(s) not yet applied: ${v.workspaceAllowPending.rules.map((r) => `\`${r}\``).join(', ')} — type \`/permissions trust\` to accept.`
      : '';
    const untrusted = v.untrusted ? (vi() ? '\nWorkspace chưa được tin cậy: mọi luật cho phép bị bỏ qua.' : '\nWorkspace not trusted: all allow rules are ignored.') : '';
    return `${head}:\n${parts.length ? parts.join('\n') : none}${pending}${untrusted}`;
  };

  const add = async (action: RuleAction, rule: string, scope: 'user' | 'workspace'): Promise<string | null> => {
    if (scope === 'workspace' && vscode.workspace.isTrusted === false) {
      api.notice('warn', vi() ? 'Workspace chưa được tin cậy — không ghi luật vào .vscode/settings.json.' : 'Workspace is not trusted — not writing rules to .vscode/settings.json.');
      return null;
    }
    const saved = await svc.add(action, rule, scope);
    if (!saved) api.notice('warn', vi() ? `Luật không hợp lệ: \`${rule}\`` : `Invalid rule: \`${rule}\``);
    return saved;
  };

  slash.register({
    name: 'permissions',
    description: { vi: 'Luật quyền allow/ask/deny — /permissions [allow|ask|deny|remove <luật> | test <lệnh> | trust]', en: 'Permission rules allow/ask/deny — /permissions [allow|ask|deny|remove <rule> | test <command> | trust]' },
    argHint: '[allow <luật>]',
    needsIdle: false,
    async run(ctx) {
      const [verb = '', ...rest] = ctx.args.split(/\s+/);
      const tail = ctx.args.slice(verb.length).trim();
      const v = verb.toLowerCase();
      if (!v) {
        svc.setFocus(true);
        await api.showScreen('settings');
        ctx.info(summary());
        return;
      }
      if (isAction(v)) {
        const saved = await add(v, tail, 'user');
        if (saved) ctx.info(vi() ? `Đã thêm luật **${v}** \`${saved}\` vào cài đặt người dùng.` : `Added **${v}** rule \`${saved}\` to user settings.`);
        return;
      }
      if (v === 'remove' || v === 'rm' || v === 'xoa' || v === 'xoá') {
        let n = 0;
        for (const a of ['allow', 'ask', 'deny'] as const) if (await svc.remove(a, tail, 'user')) n++;
        ctx.info(n ? (vi() ? `Đã xoá \`${tail}\` khỏi cài đặt người dùng.` : `Removed \`${tail}\` from user settings.`) : vi() ? `Không có luật \`${tail}\` ở cài đặt người dùng.` : `No rule \`${tail}\` in user settings.`);
        return;
      }
      if (v === 'test' || v === 'thu' || v === 'thử') {
        const hit = evaluateRules(svc.snapshot().rules, 'run_command', { kind: 'command', command: tail }, { caseInsensitivePaths: process.platform === 'win32' });
        ctx.info(
          hit
            ? vi()
              ? `\`${tail}\` → **${hit.action}** bởi luật \`${hit.rule}\` (${hit.source === 'user' ? 'người dùng' : 'workspace'}).`
              : `\`${tail}\` → **${hit.action}** by rule \`${hit.rule}\` (${hit.source}).`
            : vi()
              ? `\`${tail}\` → không khớp luật nào; chế độ quyền hiện tại quyết định.`
              : `\`${tail}\` → no rule matches; the current permission mode decides.`,
        );
        return;
      }
      if (v === 'trust' || v === 'tin') {
        const pending = svc.view().workspaceAllowPending;
        const ok = pending ? await svc.trustWorkspaceAllow(pending.hash) : false;
        ctx.info(ok ? (vi() ? 'Đã chấp nhận luật cho phép của workspace này.' : 'Accepted this workspace’s allow rules.') : vi() ? 'Workspace không có luật cho phép nào đang chờ.' : 'This workspace has no pending allow rules.');
        return;
      }
      ctx.warn(vi() ? 'Cú pháp: `/permissions`, `/permissions allow|ask|deny <luật>`, `/permissions remove <luật>`, `/permissions test <lệnh>`, `/permissions trust`.' : 'Usage: `/permissions`, `/permissions allow|ask|deny <rule>`, `/permissions remove <rule>`, `/permissions test <command>`, `/permissions trust`.');
      void rest;
    },
  });

  return {
    view: () => svc.view(),
    handle(m) {
      switch (m.type) {
        case 'permission_always': {
          const rule = typeof m.rule === 'string' ? m.rule.trim().slice(0, 500) : '';
          const scope = isScope(m.scope) ? m.scope : 'user';
          if (tooBroadForCard(rule)) {
            api.notice('warn', vi() ? `Luật \`${rule}\` quá rộng để lưu từ thẻ xin quyền — hãy nêu đặc tả cụ thể, hoặc dùng \`/permissions allow …\` nếu thực sự muốn.` : `Rule \`${rule}\` is too broad to save from the permission card — give a specific spec, or use \`/permissions allow …\` if you really mean it.`);
            return true;
          }
          void add('allow', rule, scope).then((saved) => {
            if (!saved) return;
            api.notice('info', vi() ? `Đã lưu luật cho phép \`${saved}\` (${scope === 'user' ? 'người dùng' : 'workspace'}).` : `Saved allow rule \`${saved}\` (${scope}).`);
            api.resolvePermission(String(m.id ?? ''), { decision: 'allow' });
          });
          return true;
        }
        case 'perm_rules_add':
          if (isAction(m.action)) void add(m.action, typeof m.rule === 'string' ? m.rule.slice(0, 500) : '', isScope(m.scope) ? m.scope : 'user');
          return true;
        case 'perm_rules_remove':
          if (isAction(m.action)) void svc.remove(m.action, typeof m.rule === 'string' ? m.rule.slice(0, 500) : '', isScope(m.scope) ? m.scope : 'user');
          return true;
        case 'perm_rules_trust_workspace':
          void svc.trustWorkspaceAllow(typeof m.hash === 'string' ? m.hash : '');
          return true;
        case 'perm_rules_open':
          svc.setFocus(false);
          return true;
        default:
          return false;
      }
    },
    dispose() {
      unsubscribe();
    },
  };
}
