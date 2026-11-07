/**
 * Chốt chặn vòng lặp bằng MÁY (lane:loop-guards) — một RunExtension gắn qua seams.ts, không chèn vào thân `run()`.
 *
 *   • beforeModel  → nhớ vòng hiện tại (TurnInfo) cho các móc công cụ;
 *   • toolBefore   → (B01) cạn vòng: chặn công cụ khám phá, cho một lần đọc ân hạn;
 *                    (B06) kiểm tra lệnh `run_command` theo shell thật: viết lại `&&`/`||` đơn giản, gợi ý, hoặc chặn;
 *                    (B07) chặn lần gọi thứ 4 khi 3 lần trước cùng kết quả và đối số gần y hệt;
 *   • toolAfter    → (B07) ghi chữ ký kết quả; lần thứ 3 giống nhau → nối ghi chú đổi chiến lược; ghi/thao tác thành công → xoá chuỗi.
 *
 * Phần nhắc todo / câu trả lời tự đứng / tự đóng việc nằm trong cổng hoàn thành (completion.ts + gate.ts) vì chúng dùng chung ngân sách nhắc.
 * Sửa JSON đối số (B09) nằm ở guards/jsonRepair.ts và được engine gọi trước dispatcher (không có móc nào đứng trước chỗ dispatcher báo lỗi).
 *
 * Cài đặt (đọc qua ToolHost.setting, mặc định an toàn): agent.budgetGuard (true) · agent.shellCheck ('rewrite') · agent.loopBreaker (true).
 */

import type { RunExtension, TurnInfo } from '../seams';
import { t } from '../strings';
import type { ToolDef } from '../types';
import { budgetGuardDecision } from '../guards/budgetGuard';
import { LOOP_STREAK, LoopTracker } from '../guards/loopBreaker';
import { checkShellCommand, type ShellCheckMode } from '../guards/shellCheck';

/** Công cụ mà gọi lặp lại là bình thường (cùng danh sách với engine) — không tính vào vòng lặp. */
const REPEAT_EXEMPT = new Set(['todo_write', 'scratchpad', 'load_skill', 'search_skills', 'offer_options', 'remember']);

function shellMode(v: unknown): ShellCheckMode {
  return v === 'off' || v === 'hint' || v === 'rewrite' ? v : 'rewrite';
}

export function loopGuardsExtension(): RunExtension {
  return {
    id: 'loop-guards',
    begin(scope) {
      const { host, lang, trace } = scope;
      const budgetEnabled = host.setting<boolean>('agent.budgetGuard', true) !== false;
      const loopEnabled = host.setting<boolean>('agent.loopBreaker', true) !== false;
      const shell = shellMode(host.setting<string>('agent.shellCheck', 'rewrite'));
      const shellKind = host.platform.shell;

      let turn: TurnInfo | null = null;
      let graceUsed = false;
      const loops = new LoopTracker();
      const exempt = (def: ToolDef): boolean => REPEAT_EXEMPT.has(def.name) || def.repeatExempt === true;

      return {
        beforeModel(info) {
          turn = info;
        },
        queuedTurn() {
          // Tin xếp hàng mở lượt kế tiếp của cùng lần chạy: việc mới, cho lại một lần đọc ân hạn.
          graceUsed = false;
        },
        toolBefore(call, def) {
          // (B01) Cạn vòng → không khám phá.
          if (turn) {
            const d = budgetGuardDecision({
              enabled: budgetEnabled,
              turnsLeft: turn.turnsLeft,
              wrapUp: turn.wrapUp,
              risk: def.risk,
              hasActed: trace.wrote || trace.execs > 0,
              graceUsed,
            });
            if (d === 'block') return { block: t(lang, 'budgetBlock', { left: turn.turnsLeft, name: def.name }) };
            if (d === 'grace') {
              graceUsed = true;
              return { input: call.input, note: t(lang, 'budgetGrace', { left: turn.turnsLeft }) };
            }
          }
          // (B07) Lần thứ 4 gần y hệt sau 3 lần cùng kết quả → không chạy.
          if (loopEnabled && !exempt(def) && loops.shouldBlock(def.name, call.input)) {
            return { block: t(lang, 'loopBlock', { name: def.name, n: loops.streakOf(def.name) }) };
          }
          // (B06) Lệnh shell đúng cú pháp của shell thật.
          if (def.name === 'run_command' && shell !== 'off' && typeof call.input.command === 'string') {
            const r = checkShellCommand(call.input.command, shellKind, shell, lang);
            if (r.action === 'block') return { block: r.message };
            if (r.action === 'rewrite') return { input: { ...call.input, command: r.command }, note: r.note };
            if (r.action === 'hint') return { input: call.input, note: r.note };
          }
          return undefined;
        },
        toolAfter(call, def, _ctx, result) {
          if (!loopEnabled) return undefined;
          // Thế giới đã đổi sau khi ghi/thao tác thành công: đọc lại, chạy lại là chính đáng.
          if ((def.risk === 'write' || def.risk === 'act') && !result.isError) {
            loops.reset();
            return undefined;
          }
          if (exempt(def)) return undefined;
          const streak = loops.record(def.name, call.input, result.content, !!result.isError);
          if (streak >= LOOP_STREAK) {
            return { ...result, content: `${result.content}\n\n${t(lang, 'loopNote', { name: def.name, n: streak })}` };
          }
          return undefined;
        },
      };
    },
  };
}
