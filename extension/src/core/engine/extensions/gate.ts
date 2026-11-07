/**
 * Cổng hoàn thành như một RunExtension (trước đây là khối `completionGate` nằm thẳng trong `run()`).
 *
 * Hành vi (xem completion.ts): còn việc dở / đã sửa tệp mà chưa chạy gì / câu trả lời cuối không tự đứng → nhắc có nhãn `[nhắc lần N]`; đủ
 * `GATE_MAX_NUDGES` lần can thiệp thì thôi nhắc (không bao giờ nhắc vô hạn) và báo người dùng việc còn lại — đó là cách DUY NHẤT người dùng biết
 * còn việc dở (bảng Tasks đã bỏ), nên số lần nói ra là số tin nhắc ĐÃ chèn thật (lần chốt không tính). Trạng thái đếm nằm trong closure của
 * MỘT lần chạy và được đặt lại khi tin xếp hàng của người dùng mở lượt kế tiếp (móc `queuedTurn`).
 *
 * (lane:loop-guards) Lần chốt vì việc dở: engine TỰ ĐÓNG danh sách — việc có vết ghi tệp / chạy lệnh khớp tên → completed; việc còn lại →
 * blocked kèm lý do — rồi báo người dùng. Nhắc thêm lần thứ 4, 5… không đổi được gì (log thật: 59 lần nhắc liền trong một phiên).
 */

import { GATE_MAX_NUDGES, completionGate, todoListOf, type GateReason } from '../completion';
import { autoCloseTodos } from '../guards/todoClose';
import type { RunExtension } from '../seams';
import { t } from '../strings';

export function completionGateExtension(maxNudges: number = GATE_MAX_NUDGES): RunExtension {
  return {
    id: 'completion-gate',
    begin(scope) {
      const gate = { nudges: 0, reasons: [] as GateReason[] };
      return {
        queuedTurn() {
          gate.nudges = 0;
          gate.reasons.length = 0;
        },
        finalize(ctx) {
          const decision = completionGate(
            {
              stop: ctx.stop,
              text: ctx.text,
              pendingTodos: ctx.pendingTodos,
              wroteFiles: scope.trace.wrote,
              execCalls: scope.trace.execs,
              nudges: gate.nudges,
              reasons: gate.reasons,
              wrapUp: ctx.turn.wrapUp,
              aborted: ctx.aborted,
              maxNudges,
              toolCalls: scope.trace.calls.length,
            },
            scope.lang,
          );
          if (!decision) return { action: 'accept' };
          gate.nudges++;
          gate.reasons.push(decision.reason);
          if (gate.nudges >= maxNudges) {
            if (decision.reason === 'verify') return { action: 'halt', notice: { level: 'warn', text: t(scope.lang, 'gateFinalVerify') } };
            // (lane:loop-guards) Tự đóng danh sách theo vết chạy, cập nhật phiên + giao diện, rồi báo và dừng.
            const closed = autoCloseTodos(scope.session.todos, scope.trace, scope.lang);
            scope.session.todos = closed.todos;
            scope.emit({ t: 'tasks', id: scope.assistantId(), todos: closed.todos, added: [] });
            const done = closed.completed.length ? t(scope.lang, 'gateFinalClosedDone', { k: closed.completed.length, doneList: todoListOf(closed.completed.map((title) => ({ title, status: 'completed' })), scope.lang) }) : '';
            const blockedList = todoListOf(closed.blocked.map((title) => ({ title, status: 'blocked' })), scope.lang);
            return { action: 'halt', notice: { level: 'warn', text: t(scope.lang, 'gateFinalClosed', { n: gate.nudges - 1, list: blockedList || todoListOf(ctx.pendingTodos, scope.lang), done }) } };
          }
          return { action: 'continue', message: `${t(scope.lang, 'gateLabel', { n: gate.nudges })} ${decision.message}`, reason: decision.reason };
        },
      };
    },
  };
}
