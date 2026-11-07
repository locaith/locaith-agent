/**
 * Cạn vòng → không khám phá nữa (B01/B02, lane:loop-guards).
 *
 * Dòng ngân sách `[vòng N/M · còn K vòng]` cho model biết nó còn bao xa, nhưng 21/27 lượt bị buộc dừng vẫn đang gọi công cụ khám phá.
 * Lời dặn không đủ; chốt chặn bằng máy: còn ≤ `BUDGET_GUARD_TURNS` vòng thì công cụ KHÁM PHÁ (risk 'read' / 'network': read_file, grep,
 * glob, list_dir, fetch_url, web_search, MCP chỉ-đọc) không được chạy — trả lỗi có hướng dẫn chốt việc. Ghi/sửa/chạy lệnh/todo_write/
 * remember vẫn được, vì đó là việc "chốt". Ngoại lệ: lượt chưa ghi/chạy gì mà sắp hết vòng → cho ĐÚNG MỘT lần đọc để chốt có nghĩa.
 */

import type { ToolRisk } from '../types';

/** Còn ≤ số vòng này thì chặn khám phá (khớp mốc "CHỐT VIỆC" của dòng ngân sách). */
export const BUDGET_GUARD_TURNS = 3;

export interface BudgetGuardInput {
  enabled: boolean;
  /** Số vòng còn lại SAU vòng hiện tại (TurnInfo.turnsLeft). */
  turnsLeft: number;
  wrapUp: boolean;
  risk: ToolRisk | 'unknown';
  /** Lượt này đã ghi/sửa tệp hoặc chạy lệnh. */
  hasActed: boolean;
  /** Lần đọc "ân hạn" đã dùng. */
  graceUsed: boolean;
}

export type BudgetGuardDecision = 'allow' | 'grace' | 'block';

export const isExploratory = (risk: ToolRisk | 'unknown'): boolean => risk === 'read' || risk === 'network';

export function budgetGuardDecision(i: BudgetGuardInput): BudgetGuardDecision {
  if (!i.enabled || i.wrapUp) return 'allow';
  if (!isExploratory(i.risk)) return 'allow';
  if (i.turnsLeft > BUDGET_GUARD_TURNS) return 'allow';
  if (!i.hasActed && !i.graceUsed) return 'grace';
  return 'block';
}
