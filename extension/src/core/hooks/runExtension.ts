/**
 * Hook của người dùng như một RunExtension (xem engine/seams.ts):
 *   PreToolUse  = toolBefore  (TRƯỚC khi hỏi quyền: chặn / sửa đối số / thêm ngữ cảnh);
 *   PostToolUse = toolAfter   (thêm phản hồi vào kết quả mà model nhìn thấy);
 *   Stop        = finalize    (chặn dừng → ép làm tiếp, tối đa STOP_HOOK_MAX_CONTINUES lần/lượt);
 *   SessionStart / UserPromptSubmit sinh ngữ cảnh ở `HookService.beforeSend` (controller) → nối vào lịch sử ở `beforeModel`.
 *
 * Phê duyệt KHÔNG vượt quyền: hook `approve` không bỏ qua hộp xin phép hay luật từ chối — `toolBefore` chỉ có thể chặn/sửa/ghi chú,
 * còn quyết định quyền do `permissions.ts` ra sau đó trên đối số CUỐI CÙNG (kể cả đối số hook đã sửa).
 */

import type { RunExtension } from '../engine/seams';
import { t } from '../engine/strings';
import { toolNameCandidates } from './config';
import type { HookService } from './service';
import { STOP_HOOK_MAX_CONTINUES } from './types';

const RESPONSE_CAP = 20_000;

export function hooksRunExtension(getService: () => HookService | null | undefined, opts: { subAgent?: boolean } = {}): RunExtension {
  const sub = opts.subAgent === true;
  return {
    id: 'hooks',
    begin(scope) {
      const svc = getService();
      if (!svc) return;
      // Agent con chạy xen kẽ với luồng chính trên CÙNG dịch vụ: không được giành/huỷ liên kết hiển thị của luồng chính.
      if (!sub) svc.bindRun({ emit: (ev) => scope.emit(ev), assistantId: () => scope.assistantId(), notice: (l, x) => scope.notice(l, x) });
      const lang = scope.lang;
      let stopContinues = 0;
      /** Một hook đã yêu cầu dừng hẳn (`continue:false`): chặn mọi công cụ về sau và kết thúc ở finalize. */
      let stopRequested: string | undefined;

      return {
        beforeModel() {
          if (sub) return undefined;
          const ctx = svc.takePendingContext();
          return ctx.length ? ctx : undefined;
        },

        async toolBefore(call) {
          if (stopRequested !== undefined) return { block: t(lang, 'hookStopped', { event: 'PreToolUse', reason: stopRequested ? `: ${stopRequested}` : '' }), state: 'denied' };
          const out = await svc.fire(
            'PreToolUse',
            { tool_name: call.name, tool_input: call.input, tool_use_id: call.id },
            { signal: scope.signal, matchNames: toolNameCandidates(call.name) },
          );
          svc.report('PreToolUse', out);
          if (out.stop) {
            stopRequested = out.stopReason ?? '';
            return { block: t(lang, 'hookStopped', { event: 'PreToolUse', reason: stopRequested ? `: ${stopRequested}` : '' }), state: 'denied' };
          }
          if (out.blocked) return { block: t(lang, 'hookToolBlocked', { event: 'PreToolUse', tool: call.name, reason: out.reason ?? t(lang, 'hookNoReason') }), state: 'denied' };
          const notes: string[] = out.additionalContext.map((c) => t(lang, 'hookNote', { event: 'PreToolUse', text: c }));
          if (out.updatedInput) notes.unshift(t(lang, 'hookToolEdited', { event: 'PreToolUse', tool: call.name }));
          if (out.updatedInput || notes.length) return { input: out.updatedInput ?? call.input, note: notes.join('\n') || undefined };
        },

        async toolAfter(call, _def, _ctx, result) {
          const out = await svc.fire(
            'PostToolUse',
            { tool_name: call.name, tool_input: call.input, tool_use_id: call.id, tool_response: { content: result.content.slice(0, RESPONSE_CAP), is_error: !!result.isError } },
            { signal: scope.signal, matchNames: toolNameCandidates(call.name) },
          );
          svc.report('PostToolUse', out);
          if (out.stop) stopRequested = out.stopReason ?? '';
          const parts: string[] = [];
          if (out.blocked) parts.push(out.reason ?? t(lang, 'hookNoReason'));
          parts.push(...out.additionalContext);
          if (!parts.length) return;
          return { ...result, content: `${result.content}\n\n${parts.map((p) => t(lang, 'hookNote', { event: 'PostToolUse', text: p })).join('\n')}` };
        },

        queuedTurn() {
          stopContinues = 0;
        },

        async finalize(fin) {
          // Agent con: chỉ PreToolUse/PostToolUse (Stop của luồng chính không áp cho agent con, như SubagentStop ở Claude Code).
          if (sub) return stopRequested !== undefined ? { action: 'halt' } : { action: 'accept' };
          if (stopRequested !== undefined) return { action: 'halt' };
          // Người dùng bấm Dừng, hoặc đang ở lượt tổng kết cuối vì cạn vòng: không còn chỗ để ép làm tiếp.
          if (fin.aborted || fin.turn.wrapUp) return { action: 'accept' };
          if (stopContinues >= STOP_HOOK_MAX_CONTINUES) return { action: 'halt', notice: { level: 'warn', text: t(lang, 'hookStopCap', { n: stopContinues }) } };
          const out = await svc.fire(
            'Stop',
            { stop_hook_active: stopContinues > 0, last_assistant_message: fin.text.slice(0, 4000) },
            { signal: scope.signal },
          );
          svc.report('Stop', out);
          if (out.stop) return { action: 'halt' };
          if (out.blocked) {
            stopContinues++;
            return { action: 'continue', message: t(lang, 'hookNote', { event: 'Stop', text: out.reason ?? t(lang, 'hookNoReason') }), reason: 'hook-stop' };
          }
          return { action: 'accept' };
        },

        end() {
          if (!sub) svc.bindRun(null);
        },
      };
    },
  };
}
