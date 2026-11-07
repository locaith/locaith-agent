/**
 * (lane:output-timeouts · B08) RunExtension: khi lần chạy bị BUỘC DỪNG (hết vòng, lỗi nhà cung cấp sau khi đã làm việc) thì phát một
 * thông báo ba phần tất định dựng từ vết thật («Đã làm» / «Còn lại» / «Chạy tiếp bằng cách nào») và nút «Chạy tiếp» nếu còn việc.
 * Lượt tổng kết của model (nếu có) vẫn hiện trước; thông báo này là bản đối chiếu không bịa được. Treo model (stall) do engine xử lý
 * trực tiếp vì nằm trong lần stream — dùng cùng hàm thuần ở forcedStop.ts.
 */

import { claimsAllDone, forcedStopSummary, hasRemainingWork, stopFacts } from '../forcedStop';
import type { RunExtension } from '../seams';
import { continueWorkOption } from '../truncation';

export function forcedStopExtension(): RunExtension {
  return {
    id: 'forced-stop',
    begin(scope) {
      let contradiction = false;
      /** Đã đi qua lượt tổng kết vì hết vòng (engine trả 'end_turn' khi lượt tổng kết xong êm — nhưng với người dùng đó vẫn là bị buộc dừng). */
      let wrapUpSeen = false;
      return {
        finalize(ctx) {
          if (ctx.turn.wrapUp) wrapUpSeen = true;
          // Lượt tổng kết nói "xong toàn bộ" trong khi còn việc: không còn vòng để buộc sửa — ghi lại để thông báo cuối chỉ ra.
          if (ctx.turn.wrapUp && ctx.pendingTodos.length > 0 && claimsAllDone(ctx.text)) contradiction = true;
          return { action: 'accept' };
        },
        end({ stopReason, turns }) {
          const reason = stopReason === 'max_turns' || (wrapUpSeen && stopReason === 'end_turn') ? 'max_turns' : stopReason === 'error' ? 'error' : null;
          if (!reason) return;
          const facts = stopFacts({ reason, turns, trace: scope.trace, session: scope.session });
          facts.contradiction = contradiction;
          // Lỗi ngay ở lần gọi đầu, chưa làm gì và không có danh sách việc: nút «Thử lại» của thông báo lỗi là đủ, không thêm tổng kết rỗng.
          if (stopReason === 'error' && facts.toolCalls === 0 && facts.pendingTodos.length === 0) return;
          scope.notice('warn', forcedStopSummary(scope.lang, facts, scope.settings.maxTurns));
          if (!hasRemainingWork(facts)) return;
          const option = continueWorkOption(scope.lang);
          scope.session.options = [option];
          scope.emit({ t: 'options', id: scope.assistantId(), options: [option] });
        },
      };
    },
  };
}
