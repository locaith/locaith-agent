/**
 * (lane:ide-context) Lệnh `/problems`: hiện ngay trong khung chat các lỗi/cảnh báo mà language server của VS Code đang báo.
 * Không gọi model (chạy cả khi trợ lý đang bận); muốn nhờ trợ lý sửa thì gõ «@problems sửa hết giúp tôi».
 */

import { t } from '../core/engine/strings';
import type { DiagnosticsQuery, DiagnosticsResult } from '../core/ide/diagnostics';
import { diagnosticsReport } from '../core/ide/diagnosticsText';
import type { SlashRegistry } from './slashRegistry';

export interface IdeSlashSource {
  diagnostics(query: DiagnosticsQuery): Promise<DiagnosticsResult>;
}

export function registerIdeSlash(registry: SlashRegistry, src: IdeSlashSource): () => void {
  return registry.register({
    name: 'problems',
    description: { vi: 'Xem lỗi và cảnh báo VS Code đang báo', en: 'Show the errors and warnings VS Code reports' },
    needsIdle: false,
    async run(ctx) {
      try {
        const r = await src.diagnostics({ minSeverity: 'warning', limit: 100 });
        ctx.info('```\n' + diagnosticsReport(r, ctx.lang, { min: 'warning' }) + '\n```');
      } catch {
        ctx.warn(t(ctx.lang, 'problemsUnavailable'));
      }
    },
  });
}
