/**
 * Cổng hoàn thành (completion gate) — tầng CƯỠNG CHẾ, không phải lời khuyên.
 *
 * Vì sao có: một mô hình tự quyết định "đã xong" sẽ dừng ở chỗ *trông* xong — còn việc dở, chưa chạy phép kiểm tra nào,
 * hoặc hỏi lại người dùng điều mà chính nó tìm được trong workspace. Prompt không sửa được điều đó một cách đáng tin;
 * điều kiện dừng thì sửa được. Đây là bản tương đương của `/goal` + `Stop` hook ở Claude Code, thu gọn cho engine này:
 *
 *   • còn việc chưa xong trong danh sách → chèn một tin nhắc CỤ THỂ (nêu tên việc) và chạy tiếp;
 *   • đã sửa tệp mà chưa chạy gì để kiểm chứng → bắt chạy phép kiểm tra thật trước khi báo xong;
 *   • mỗi lý do chỉ nhắc MỘT lần, tổng tối đa `maxNudges` lần → không bao giờ thành vòng lặp vô hạn;
 *   • người dùng bấm Dừng, hoặc đã chạm trần vòng lặp → không nhắc gì (tôn trọng ý người dùng).
 *
 * Hàm thuần (không gọi mô hình, không đụng đĩa) nên test được từng luật.
 */

import type { StopReason } from '../types';
import { t, type Lang } from './strings';

export type GateReason = 'todos' | 'verify';

export interface GateTodo {
  title: string;
  status: string;
}

export interface GateInput {
  stop: StopReason;
  /** Chữ của lượt trả lời cuối cùng. */
  text: string;
  /** Việc còn dang dở trong danh sách tác vụ của phiên. */
  pendingTodos: readonly GateTodo[];
  /** Lượt chạy này đã ghi/sửa tệp chưa. */
  wroteFiles: boolean;
  /** Số lần công cụ loại `exec` (chạy lệnh) đã chạy trong lượt này. */
  execCalls: number;
  /** Số lần đã nhắc trong lượt này. */
  nudges: number;
  /** Các lý do đã nhắc (mỗi lý do nhắc tối đa một lần). */
  reasons: readonly GateReason[];
  /** Đang ở lượt tổng kết vì chạm trần vòng lặp. */
  wrapUp: boolean;
  aborted: boolean;
  /** Tối đa số lần nhắc trong một lượt chạy (mặc định 2). */
  maxNudges?: number;
}

export interface GateDecision {
  reason: GateReason;
  message: string;
}

/** Tên việc còn lại, gọn để không đốt ngữ cảnh: tối đa 5 việc, mỗi việc ≤ 60 ký tự. */
function todoList(todos: readonly GateTodo[], lang: Lang): string {
  const items = todos
    .slice(0, 5)
    .map((x) => x.title.replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(Boolean);
  const more = todos.length - items.length;
  const sep = lang === 'en' ? '; ' : '; ';
  return items.join(sep) + (more > 0 ? (lang === 'en' ? ` (+${more} more)` : ` (+${more} việc nữa)`) : '');
}

/**
 * Quyết định có chặn việc kết thúc lượt hay không. `null` = cho kết thúc.
 * Thứ tự ưu tiên: việc còn dở trước (cụ thể, chỉ ra đúng việc), rồi tới kiểm chứng.
 */
export function completionGate(i: GateInput, lang: Lang): GateDecision | null {
  if (i.aborted || i.wrapUp) return null;
  if (i.stop !== 'end_turn' && i.stop !== 'max_tokens') return null;
  const max = i.maxNudges ?? 2;
  if (i.nudges >= max) return null;

  const pending = i.pendingTodos.filter((x) => x.status !== 'completed');
  if (pending.length > 0 && !i.reasons.includes('todos')) {
    return { reason: 'todos', message: t(lang, 'gateTodos', { n: pending.length, list: todoList(pending, lang) }) };
  }
  if (i.wroteFiles && i.execCalls === 0 && !i.reasons.includes('verify')) {
    return { reason: 'verify', message: t(lang, 'gateVerify') };
  }
  return null;
}
