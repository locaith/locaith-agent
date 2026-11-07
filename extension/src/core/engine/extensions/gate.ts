/**
 * Cổng hoàn thành như một RunExtension (trước đây là khối `completionGate` nằm thẳng trong `run()`).
 *
 * Hành vi GIỮ NGUYÊN (xem completion.ts): còn việc dở / đã sửa tệp mà chưa chạy gì → nhắc có nhãn `[nhắc lần N]`; đủ `GATE_MAX_NUDGES`
 * lần can thiệp thì thôi nhắc (không bao giờ nhắc vô hạn) và báo người dùng việc còn lại — đó là cách DUY NHẤT người dùng biết còn
 * việc dở (bảng Tasks đã bỏ), nên số lần nói ra là số tin nhắc ĐÃ chèn thật (lần chốt không tính). Trạng thái đếm nằm trong closure
 * của MỘT lần chạy và được đặt lại khi tin xếp hàng của người dùng mở lượt kế tiếp (móc `queuedTurn`).
 */

import { GATE_MAX_NUDGES, completionGate, todoListOf, type GateReason } from '../completion';
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
            },
            scope.lang,
          );
          if (!decision) return { action: 'accept' };
          gate.nudges++;
          gate.reasons.push(decision.reason);
          if (gate.nudges >= maxNudges) {
            return {
              action: 'halt',
              notice: {
                level: 'warn',
                text: decision.reason === 'verify' ? t(scope.lang, 'gateFinalVerify') : t(scope.lang, 'gateFinal', { n: gate.nudges - 1, list: todoListOf(ctx.pendingTodos, scope.lang) }),
              },
            };
          }
          return { action: 'continue', message: `${t(scope.lang, 'gateLabel', { n: gate.nudges })} ${decision.message}`, reason: decision.reason };
        },
      };
    },
  };
}
