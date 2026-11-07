/**
 * Cổng hoàn thành (completion gate) — tầng CƯỠNG CHẾ, không phải lời khuyên.
 *
 * Vì sao có: một mô hình tự quyết định "đã xong" sẽ dừng ở chỗ *trông* xong — còn việc dở, chưa chạy phép kiểm tra nào,
 * hoặc hỏi lại người dùng điều mà chính nó tìm được trong workspace. Prompt không sửa được điều đó một cách đáng tin;
 * điều kiện dừng thì sửa được. Đây là bản tương đương của `/goal` + `Stop` hook ở Claude Code, thu gọn cho engine này:
 *
 *   • còn việc chưa xong trong danh sách → chèn một tin nhắc CỤ THỂ (nêu tên việc) và chạy tiếp;
 *   • đã sửa tệp mà chưa chạy gì để kiểm chứng → bắt chạy phép kiểm tra thật trước khi báo xong;
 *   • mỗi lý do được nhắc ít nhất MỘT lần trước khi lặp lại; việc dở được nhắc lại (model hay lờ lần đầu), kiểm chứng thì chỉ một lần;
 *   • tổng cộng cổng can thiệp tối đa `maxNudges` (= 3) lần → không bao giờ thành vòng lặp vô hạn. Lần 1–2 chèn tin nhắc có nhãn đếm
 *     ("[nhắc lần N]"); lần THỨ BA engine không nhắc nữa mà dừng và báo người dùng (xem `gateFinal`);
 *   • người dùng bấm Dừng, hoặc đã chạm trần vòng lặp → không nhắc gì (tôn trọng ý người dùng).
 *
 * Hàm thuần (không gọi mô hình, không đụng đĩa) nên test được từng luật.
 */

import type { ChatMessage, StopReason } from '../types';
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
  /** Số lần cổng đã can thiệp trong lượt này (kể cả lần "chốt" cuối cùng). */
  nudges: number;
  /** Các lý do đã can thiệp (theo thứ tự). 'verify' chỉ một lần; 'todos' lặp lại được cho tới trần. */
  reasons: readonly GateReason[];
  /** Đang ở lượt tổng kết vì chạm trần vòng lặp. */
  wrapUp: boolean;
  aborted: boolean;
  /** Tối đa số lần can thiệp trong một lượt chạy (mặc định `GATE_MAX_NUDGES` = 3; lần cuối là lần chốt, không chèn nhắc). */
  maxNudges?: number;
}

/** Số lần cổng được can thiệp trong một lượt chạy. Lần 1..MAX-1 chèn tin nhắc; lần MAX dừng và báo người dùng. */
export const GATE_MAX_NUDGES = 3;

export interface GateDecision {
  reason: GateReason;
  message: string;
}

/** Tên việc còn lại, gọn để không đốt ngữ cảnh: tối đa 5 việc, mỗi việc ≤ 60 ký tự. */
export function todoListOf(todos: readonly GateTodo[], lang: Lang): string {
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
 * Thứ tự: việc còn dở (lần đầu) → kiểm chứng (lần đầu) → việc còn dở nhắc LẠI. Mỗi lý do được nói ra ít nhất một lần trước khi
 * lặp, và tổng cộng không quá `maxNudges` lần.
 *
 * (0.6.31) Trước đây `todos` bị khoá ở "một lần": model lờ lời nhắc đầu thì lượt kết thúc im lặng với việc dở còn nguyên (bảng Tasks
 * đã bỏ nên người dùng không còn thấy gì), và nhánh "báo người dùng" ở lần thứ ba không bao giờ chạy tới.
 */
export function completionGate(i: GateInput, lang: Lang): GateDecision | null {
  if (i.aborted || i.wrapUp) return null;
  if (i.stop !== 'end_turn' && i.stop !== 'max_tokens') return null;
  const max = i.maxNudges ?? GATE_MAX_NUDGES;
  if (i.nudges >= max) return null;

  const pending = i.pendingTodos.filter((x) => x.status !== 'completed');
  const todos = (): GateDecision => ({ reason: 'todos', message: t(lang, 'gateTodos', { n: pending.length, list: todoListOf(pending, lang) }) });
  if (pending.length > 0 && !i.reasons.includes('todos')) return todos();
  if (i.wroteFiles && i.execCalls === 0 && !i.reasons.includes('verify')) {
    return { reason: 'verify', message: t(lang, 'gateVerify') };
  }
  // Đã nói đủ mọi lý do mà việc dở vẫn còn: nhắc lại (engine gắn nhãn "lần N"; tới trần thì thôi nhắc và báo người dùng).
  if (pending.length > 0) return todos();
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// (0.6.31) Dòng NGÂN SÁCH VÒNG LẶP — chèn vào payload mỗi lượt gọi model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Câu nói cho model biết nó đang ở vòng nào. Không có dòng này, model KHÔNG THỂ biết còn bao nhiêu
 * lượt (đây là lỗi thiếu dữ liệu, không phải lỗi ý thức) — nên mọi lời dặn "đừng mở việc mới khi cạn"
 * đều vô hiệu. Chỉ một dòng chữ, đổi hẳn hành vi ở cuối phiên dài.
 */
export function turnBudgetNote(turns: number, maxTurns: number, lang: Lang): string | null {
  if (!Number.isFinite(maxTurns) || maxTurns <= 0) return null;
  const used = Math.max(0, Math.min(maxTurns, Math.round(turns)));
  const left = Math.max(0, maxTurns - used);
  return left <= 3 ? t(lang, 'budgetLow', { n: used, max: maxTurns, left }) : t(lang, 'budget', { n: used, max: maxTurns, left });
}

/**
 * Gắn dòng ngân sách ở CUỐI payload của một lần gọi (KHÔNG sửa lịch sử đã lưu): thêm một KHỐI CHỮ RIÊNG (`volatile`) vào cuối tin
 * người dùng cuối cùng — sau mọi `tool_result`, không đụng vào khối chữ của người dùng.
 *
 * Vì sao là một khối trong tin cuối chứ không phải một tin `user` thứ hai: engine giữ bất biến "mỗi tin assistant chỉ được theo sau bởi
 * MỘT tin user" ở mọi hãng (xem chỗ chèn tin xếp hàng). Hai tin user liền nhau (nhất là ngay sau tin kết quả công cụ) là khuôn chưa từng có
 * trong luồng bình thường: Anthropic tự gộp được, nhưng mẫu hội thoại chặt của Ollama / LM Studio / Gemma (đòi vai trò xen kẽ) thì trả
 * lỗi, và DeepSeek coi tin user cuối là ranh giới lượt nên bỏ suy luận của các vòng công cụ phía trước. Một khối trong tin cuối thì
 * adapter chuyển đúng như tin "kết quả công cụ + chữ chen giữa" (steer) đã chạy ổn từ lâu.
 */
export function withBudgetNote(messages: readonly ChatMessage[], note: string | null): ChatMessage[] {
  if (!note) return messages as ChatMessage[];
  const last = messages[messages.length - 1];
  // CHỈ gắn vào tin của người dùng (tin mới, hoặc tin kết quả công cụ). Tin cuối là assistant thì giữ nguyên:
  //  • vừa gọi tool, chờ kết quả → chen tin vào sẽ phá cặp tool_use/tool_result;
  //  • đang tạm dừng (`pause_turn`) → hãng đòi lượt kế nối tiếp ĐÚNG tin đó (adapter tự thêm lời "tiếp tục" nếu cần);
  //    một lời "người dùng" chen vào sẽ biến nó thành một câu hỏi mới.
  if (!last || last.role !== 'user') return messages as ChatMessage[];
  return [...messages.slice(0, -1), { ...last, content: [...last.content, { type: 'text', text: note, volatile: true }] }];
}