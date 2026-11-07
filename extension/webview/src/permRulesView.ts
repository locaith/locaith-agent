/**
 * (lane:perm-rules) Phần thuần của giao diện luật quyền: nhóm luật cho khu quản lý, thử khớp một lệnh ngay trong webview (dùng chung bộ so khớp với engine),
 * và mô hình nút của thẻ xin quyền (thẻ hiện gì tuỳ yêu cầu). Không phụ thuộc Preact để kiểm thử bằng Node thuần.
 */

import type { PermissionRequest, PermissionRuleInfo, PermissionsView } from '../../src/shared/protocol';
import { buildRules, evaluateRules, parseRule, type RuleAction, type RuleHit } from '../../src/shared/permissionRules';

export const RULE_ACTIONS: readonly RuleAction[] = ['deny', 'ask', 'allow'];

export function groupRules(rules: readonly PermissionRuleInfo[]): Record<RuleAction, PermissionRuleInfo[]> {
  const out: Record<RuleAction, PermissionRuleInfo[]> = { deny: [], ask: [], allow: [] };
  for (const r of rules) if (out[r.action]) out[r.action].push(r);
  return out;
}

/** Thử khớp một lệnh shell với bộ luật đang hiển thị (đúng bộ so khớp engine dùng; `null` = không luật nào khớp). */
export function tryCommand(view: PermissionsView | undefined, command: string, windows: boolean): RuleHit | null {
  const cmd = command.trim();
  if (!view || !cmd) return null;
  const rules = buildRules(RULE_ACTIONS.map((a) => ({ action: a, source: 'user' as const, items: view.rules.filter((r) => r.action === a).map((r) => r.text) })));
  // Nguồn thật của từng luật (user/workspace) được gắn lại sau khi khớp.
  const hit = evaluateRules(rules, 'run_command', { kind: 'command', command: cmd }, { caseInsensitivePaths: windows });
  if (!hit) return null;
  const src = view.rules.find((r) => r.action === hit.action && r.text === hit.rule)?.source ?? 'user';
  return { ...hit, source: src };
}

export function isValidRuleText(text: string): boolean {
  return parseRule(text) !== null;
}

export interface PermissionCardModel {
  isPlan: boolean;
  /** Nút «Luôn cho phép» + đặc tả mặc định (sửa được). */
  always?: { defaultRule: string };
  /** Nút «Cho phép trong phiên này». */
  session: boolean;
  /** Dòng «hỏi theo luật …». */
  askedByRule?: string;
}

/** Thẻ xin quyền hiện gì: «Luôn cho phép» chỉ khi host đề xuất được đặc tả (không đề xuất cho lệnh nguy hiểm / yêu cầu nâng cao / kế hoạch). */
export function permissionCardModel(req: Pick<PermissionRequest, 'kind' | 'canAllowSession' | 'suggest' | 'rule'>): PermissionCardModel {
  const isPlan = req.kind === 'plan';
  const first = req.suggest?.find((s) => typeof s === 'string' && isValidRuleText(s));
  return {
    isPlan,
    ...(first && !isPlan ? { always: { defaultRule: first } } : {}),
    session: !isPlan && req.canAllowSession,
    ...(req.rule ? { askedByRule: req.rule } : {}),
  };
}
