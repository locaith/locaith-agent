/**
 * (lane:output-timeouts · B08) Bị buộc dừng thì NÓI THẬT — ba phần: «Đã làm», «Còn lại», «Chạy tiếp bằng cách nào».
 *
 * Vì sao có: trong log thật, khi bị buộc dừng (hết vòng, hết thời gian, hết hạn mức) chỉ 22% lượt tổng kết trả lời đủ ba phần; số còn lại
 * hay nói "đã hoàn thành toàn bộ" trong khi danh sách việc còn dở. Model không thể tự biết vết thật nếu harness không nói, nên:
 *   • lời nhắc tổng kết (`wrapUpPrompt`) đính kèm VẾT THẬT (tệp đã ghi, lệnh đã chạy, việc chưa xong) — model không bịa được;
 *   • sau lượt tổng kết, harness tự phát một thông báo ba phần tất định từ vết thật (`forcedStopSummary`) — người dùng luôn có bản đúng,
 *     kể cả khi model nói sai; nói "đã xong toàn bộ" khi còn việc thì bị chỉ ra (`claimsAllDone`).
 * Hàm thuần, có test.
 */

import type { TodoItem } from '../../shared/protocol';
import { todoListOf } from './completion';
import type { RunTrace } from './seams';
import { t, type Lang } from './strings';
import type { SessionState } from './types';

export type ForcedStopReason = 'max_turns' | 'stall' | 'error';

export interface StopFacts {
  reason: ForcedStopReason;
  turns: number;
  /** Đường dẫn các tệp đã ghi thành công (không trùng). */
  writtenPaths: string[];
  execs: number;
  /** Tổng lệnh gọi công cụ đã hoàn tất. */
  toolCalls: number;
  doneTodos: TodoItem[];
  pendingTodos: TodoItem[];
  /** Model đã nói "xong toàn bộ" trong khi còn việc (phát hiện ở lượt tổng kết). */
  contradiction?: boolean;
}

export function stopFacts(i: { reason: ForcedStopReason; turns: number; trace: RunTrace; session: Pick<SessionState, 'todos' | 'mode'> }): StopFacts {
  // Chế độ lập kế hoạch: các bước là KẾ HOẠCH chờ duyệt, chưa phải việc dở.
  const todos = i.session.mode === 'plan' ? [] : i.session.todos;
  return {
    reason: i.reason,
    turns: i.turns,
    writtenPaths: i.trace.writtenPaths(),
    execs: i.trace.execs,
    toolCalls: i.trace.calls.length,
    doneTodos: todos.filter((x) => x.status === 'completed'),
    pendingTodos: todos.filter((x) => x.status !== 'completed'),
  };
}

/** Tên tệp gọn (tối đa 4, chỉ phần cuối đường dẫn). */
function fileList(paths: readonly string[]): string {
  const names = paths.slice(0, 4).map((p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p);
  const more = paths.length - names.length;
  return names.join(', ') + (more > 0 ? `, +${more}` : '');
}

function factsLine(lang: Lang, f: StopFacts): string {
  return t(lang, 'wrapUpFacts', {
    files: f.writtenPaths.length ? t(lang, 'factsFiles', { n: f.writtenPaths.length, list: fileList(f.writtenPaths) }) : t(lang, 'factsNoFiles'),
    execs: f.execs ? t(lang, 'factsExecs', { n: f.execs }) : t(lang, 'factsNoExecs'),
    pending: f.pendingTodos.length ? todoListOf(f.pendingTodos, lang) : t(lang, 'factsNoPending'),
  });
}

/** Lời nhắc tổng kết gửi model khi hết vòng — đòi đúng ba phần và đính kèm vết thật. */
export function wrapUpPrompt(lang: Lang, facts: StopFacts): string {
  return t(lang, 'maxTurnsWrapUp', { facts: factsLine(lang, facts) });
}

/**
 * Model có khẳng định "đã hoàn thành toàn bộ / all done" không. Tất định, hai ngôn ngữ (có dấu lẫn không dấu); dùng để đối chiếu
 * với danh sách việc thật, KHÔNG dùng để sửa chữ của model.
 */
export function claimsAllDone(text: string): boolean {
  const s = (text ?? '').toLowerCase();
  if (!s) return false;
  return (
    /(?:hoàn thành|hoan thanh|đã xong|da xong|làm xong|lam xong|xong)\s+(?:toàn bộ|toan bo|tất cả|tat ca|hết|het|100%)/.test(s) ||
    /(?:toàn bộ|toan bo|tất cả|tat ca)\s+(?:công việc|cong viec|việc|viec|yêu cầu|yeu cau|các mục|cac muc)?\s*(?:đã|da)\s+(?:hoàn thành|hoan thanh|xong)/.test(s) ||
    /\b(?:all|everything)\s+(?:is|has been|are|were)?\s*(?:now\s+)?(?:done|complete|completed|finished)\b/.test(s) ||
    /\b(?:fully|completely)\s+(?:done|complete|completed|finished)\b/.test(s) ||
    /\bcompleted all\b|\btask(?:s)? (?:is|are) (?:all )?complete\b|\b100% (?:done|complete)\b/.test(s)
  );
}

/** Thông báo ba phần, tất định, dựng từ vết thật. Mỗi phần một dòng. */
export function forcedStopSummary(lang: Lang, f: StopFacts, maxTurns?: number): string {
  const head =
    f.reason === 'max_turns' ? t(lang, 'stopReasonMaxTurns', { n: maxTurns ?? f.turns }) : f.reason === 'stall' ? t(lang, 'stopReasonStall') : t(lang, 'stopReasonError');
  const doneParts: string[] = [];
  if (f.writtenPaths.length) doneParts.push(t(lang, 'factsFiles', { n: f.writtenPaths.length, list: fileList(f.writtenPaths) }));
  if (f.execs) doneParts.push(t(lang, 'factsExecs', { n: f.execs }));
  const total = f.doneTodos.length + f.pendingTodos.length;
  if (total) doneParts.push(t(lang, 'stopDoneTodos', { done: f.doneTodos.length, total }));
  const done = doneParts.length ? t(lang, 'stopDone', { text: doneParts.join(', ') }) : t(lang, 'stopDoneNone');
  const left = f.pendingTodos.length ? t(lang, 'stopLeft', { list: todoListOf(f.pendingTodos, lang) }) : t(lang, 'stopLeftNone');
  const how = hasRemainingWork(f) ? t(lang, 'stopHow') : t(lang, 'stopHowNone');
  const lines = [head, `• ${done}`, `• ${left}`, `• ${how}`];
  if (f.contradiction && f.pendingTodos.length) lines.push(t(lang, 'stopContradiction', { n: f.pendingTodos.length }));
  return lines.join('\n');
}

/** Còn việc để chạy tiếp không: còn todo dở, hoặc bị cắt ngang (hết vòng / treo) khi chưa có danh sách việc nào. */
export function hasRemainingWork(f: StopFacts): boolean {
  if (f.pendingTodos.length > 0) return true;
  if (f.reason === 'max_turns' || f.reason === 'stall') return f.doneTodos.length === 0; // không có danh sách → không biết đã xong → coi là còn
  return false;
}
