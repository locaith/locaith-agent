/**
 * Chính sách quyền: một công cụ được chạy luôn, phải hỏi người dùng, hay bị từ chối — tuỳ chế độ quyền.
 *
 *   default      hỏi trước khi sửa tệp / chạy lệnh / đọc ngoài workspace / vào tên miền mới
 *   acceptEdits  tự nhận sửa/tạo tệp trong workspace; vẫn hỏi khi chạy lệnh và khi vào tên miền web mới
 *   plan         chỉ đọc và nghiên cứu; trình kế hoạch để duyệt
 *   bypass       không hỏi gì
 *
 * (lane:perm-rules) Luật bền theo mẫu (`locaithAgent.permissions.allow/ask/deny`, xem shared/permissionRules.ts) được xét TRƯỚC logic chế độ:
 *   deny   chặn tuyệt đối — kể cả bypass;
 *   ask    buộc hỏi — kể cả acceptEdits / bypass (người dùng đã nói rõ "việc này luôn hỏi tôi");
 *   allow  bỏ câu hỏi — trừ yêu cầu `elevated` (ngoài workspace, tệp bí mật, lệnh nguy hiểm) vẫn hỏi, và chế độ plan vẫn chỉ cho đọc.
 */

import type { PermissionMode } from '../../shared/protocol';
import type { PermissionAdvice } from './seams';
import { isPlanSafe } from './toolRegistry';
import type { PermissionNeed, SessionState, ToolContext, ToolDef } from './types';

export type RuleHitInfo = NonNullable<PermissionAdvice['hit']>;

export type Verdict =
  | { action: 'allow'; rule?: RuleHitInfo }
  | { action: 'ask'; need: PermissionNeed; rule?: RuleHitInfo }
  | { action: 'deny'; reason: 'plan_mode' }
  | { action: 'deny'; reason: 'rule'; rule: RuleHitInfo };

export async function decidePermission(
  def: ToolDef,
  input: unknown,
  ctx: ToolContext,
  mode: PermissionMode,
  rule?: RuleHitInfo | null,
): Promise<Verdict> {
  // Luật deny đứng trên mọi chế độ (kể cả bypass): người dùng đã cấm rõ ràng.
  if (rule?.action === 'deny') return { action: 'deny', reason: 'rule', rule };

  if (mode === 'plan' && !isPlanSafe(def) && def.onlyInMode !== 'plan') {
    return { action: 'deny', reason: 'plan_mode' };
  }

  const need = (await def.permission?.(input, ctx)) ?? null;
  // Không cần xin phép thì luật allow không "quyết định" gì → không ghi «cho phép bởi luật» lên dòng công cụ.
  if (!need) return { action: 'allow' };

  // Luật ask buộc hỏi dù chế độ nào — trừ duyệt kế hoạch (vốn luôn hỏi).
  if (rule?.action === 'ask' && need.kind !== 'plan') return { action: 'ask', need, rule };

  // Duyệt kế hoạch luôn cần người dùng, kể cả khi bypass? Bypass nghĩa là không hỏi gì → cho qua.
  if (mode === 'bypass') return { action: 'allow' };
  if (need.kind === 'plan') return { action: 'ask', need };

  if (!need.elevated) {
    // Luật allow bỏ câu hỏi — chỉ với yêu cầu thường (yêu cầu nâng cao vẫn hỏi dù luật nói gì).
    if (rule?.action === 'allow') return { action: 'allow', rule };
    if (need.sessionKey && ctx.session.approvals.includes(need.sessionKey)) return { action: 'allow' };
    // Chỉ chỉnh sửa/tạo tệp được tự nhận. Ra mạng (fetch_url) vẫn hỏi theo từng tên miền: URL có thể mang dữ liệu
    // đi (`https://evil/?d=<bí mật>`), nên "tự nhận chỉnh sửa" không được hiểu là "tự cho phép gửi dữ liệu ra ngoài".
    if (mode === 'acceptEdits' && (need.kind === 'edit' || need.kind === 'create' || (need.kind === 'browser' && need.autoInAcceptEdits))) {
      return { action: 'allow' };
    }
  }
  return { action: 'ask', need };
}

export function rememberApproval(session: SessionState, key: string | undefined): void {
  if (key && !session.approvals.includes(key)) session.approvals.push(key);
}
