/**
 * (lane:ide-context) Phản hồi tự động sau khi sửa tệp: chụp chẩn đoán của tệp TRƯỚC khi sửa, chờ language server một
 * nhịp ngắn SAU khi sửa, rồi gắn vào kết quả công cụ những lỗi MỚI phát sinh ("Sau khi sửa, VS Code báo 2 lỗi mới: …").
 *
 * Vì sao: model yếu sửa xong là báo "xong" dù tệp đang gạch đỏ. Claude Code thấy ngay lỗi mới qua IDE; ở đây máy đưa dữ liệu
 * đó vào thẳng kết quả edit_file/write_file — model không thể bỏ qua thứ nằm ngay trong kết quả công cụ.
 *
 * Quy tắc:
 *  - Chỉ tệp vừa sửa, chỉ khi công cụ chạy thành công, chỉ tệp trong workspace.
 *  - Mức: 'errors' (mặc định) = chỉ lỗi; 'all' = lỗi + cảnh báo; 'off' = tắt hẳn (KHÔNG gọi diagnostics).
 *  - Không báo lại lỗi đã có trước khi sửa (so đa tập theo nội dung, bỏ qua số dòng vì dòng dịch chuyển).
 *  - Chờ tối đa 2 s, ngắt được bằng Dừng.
 */

import { resolveUserPath } from '../fsutil/paths';
import type { RunExtension } from '../engine/seams';
import { t } from '../engine/strings';
import type { ToolHost } from '../engine/types';
import { newDiagnostics, type DiagnosticItem, type DiagSeverity } from './diagnostics';
import { afterEditNote, countsText } from './diagnosticsText';

export type EditDiagnosticsMode = 'errors' | 'all' | 'off';

export const EDIT_DIAG_SETTING = 'agent.editDiagnostics';
export const EDIT_DIAG_MIN_WAIT_MS = 900;
export const EDIT_DIAG_MAX_WAIT_MS = 2000;

export function editDiagnosticsMode(v: unknown): EditDiagnosticsMode {
  if (v === false || v === 'off') return 'off';
  if (v === 'all') return 'all';
  return 'errors';
}

export interface EditDiagnosticsOptions {
  /** Đọc chế độ mỗi lần chạy (mặc định: host.setting('agent.editDiagnostics')). */
  mode?(host: ToolHost): EditDiagnosticsMode;
  minWaitMs?: number;
  maxWaitMs?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function editDiagnosticsExtension(opts: EditDiagnosticsOptions = {}): RunExtension {
  return {
    id: 'ide-edit-diagnostics',
    begin(scope) {
      const host = scope.host;
      if (!host.diagnostics) return;
      const mode = opts.mode ? opts.mode(host) : editDiagnosticsMode(host.setting<unknown>(EDIT_DIAG_SETTING, 'errors'));
      if (mode === 'off') return;
      const min: DiagSeverity = mode === 'all' ? 'warning' : 'error';
      const minWait = opts.minWaitMs ?? EDIT_DIAG_MIN_WAIT_MS;
      const maxWait = Math.max(minWait, opts.maxWaitMs ?? EDIT_DIAG_MAX_WAIT_MS);
      /** callId → ảnh chụp trước khi sửa. */
      const before = new Map<string, { abs: string; rel: string; items: DiagnosticItem[] }>();

      return {
        async toolBefore(call, def) {
          if (def.risk !== 'write') return;
          const p = (call.input as { path?: unknown })?.path;
          if (typeof p !== 'string' || !p.trim()) return;
          const r = resolveUserPath(host, p);
          if (r.zone !== 'workspace') return;
          const snap = await host.diagnostics!({ paths: [r.abs], minSeverity: min, limit: 500 });
          before.set(call.id, { abs: r.abs, rel: r.rel, items: snap.items });
        },
        async toolAfter(call, _def, ctx, result) {
          const snap = before.get(call.id);
          if (!snap) return;
          before.delete(call.id);
          if (result.isError || ctx.signal.aborted) return;
          if (host.waitForDiagnostics) await host.waitForDiagnostics(snap.abs, { minMs: minWait, maxMs: maxWait, signal: ctx.signal });
          else await sleep(minWait, ctx.signal);
          if (ctx.signal.aborted) return;
          const now = await host.diagnostics!({ paths: [snap.abs], minSeverity: min, limit: 500 });
          const fresh = newDiagnostics(snap.items, now.items);
          if (fresh.length === 0) return;
          const note = afterEditNote(fresh, snap.rel, scope.lang);
          const tag = t(scope.lang, 'diagSummaryNew', { counts: countsText(fresh, scope.lang) });
          return {
            ...result,
            content: `${result.content}\n\n${note}`,
            // Hiện cạnh nhãn công cụ trong dòng thời gian (và ở Remote — ToolBlock.summary đi qua relay nguyên vẹn).
            summary: result.summary ? `${result.summary} · ${tag}` : tag,
          };
        },
        end() {
          before.clear();
        },
      };
    },
  };
}
