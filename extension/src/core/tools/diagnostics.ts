/**
 * (lane:ide-context) Công cụ `get_diagnostics`: lỗi/cảnh báo mà language server của VS Code đang báo
 * (tương đương mcp__ide__getDiagnostics của Claude Code).
 *
 * Chỉ được đăng ký khi host có `diagnostics` (VS Code). CLI/Chrome không có IDE → công cụ không xuất hiện; nếu vẫn bị gọi
 * (lịch sử cũ, agent con), trả lời "không khả dụng" thay vì đoán.
 */

import { resolveUserPathReal } from '../fsutil/paths';
import { t, type Lang } from '../engine/strings';
import type { ToolDef, ToolHost } from '../engine/types';
import { DEFAULT_DIAG_LIMIT, MAX_DIAG_LIMIT, parseSeverity, type DiagSeverity } from '../ide/diagnostics';
import { countsText, diagnosticsReport } from '../ide/diagnosticsText';

interface DiagInput {
  paths?: string[];
  severity?: 'error' | 'warning' | 'info' | 'all';
  limit?: number;
}

const MAX_PATHS = 50;

export function hostLang(host: Pick<ToolHost, 'setting'>): Lang {
  return host.setting<string>('language', 'vi') === 'en' ? 'en' : 'vi';
}

export const getDiagnosticsTool: ToolDef<DiagInput> = {
  name: 'get_diagnostics',
  description:
    'Get the errors/warnings the editor\'s language servers (TypeScript, ESLint, Pylance…) currently report, as "path:line:col severity [source code] message", errors first. ' +
    'Use after editing code to check you did not break anything, or to find what is broken before fixing it. ' +
    'Only covers files the language server has analysed (usually open or recently edited files) — it does not replace running the real build/tests.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_PATHS,
        description: 'Files or folders (relative to the workspace) to limit to. Omit for the whole workspace.',
      },
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'all'],
        description: 'Minimum severity. "error" = errors only; "warning" (default) = errors + warnings; "all" = everything incl. hints.',
      },
      limit: { type: 'integer', minimum: 1, maximum: MAX_DIAG_LIMIT, description: `Max entries (default ${DEFAULT_DIAG_LIMIT}).` },
    },
  },
  risk: 'read',
  concurrencySafe: true,
  async execute(input, ctx) {
    const lang = hostLang(ctx.host);
    if (!ctx.host.diagnostics) return { content: t(lang, 'diagUnavailable'), isError: true };
    const abs: string[] = [];
    const shown: string[] = [];
    for (const p of (input.paths ?? []).slice(0, MAX_PATHS)) {
      if (typeof p !== 'string' || !p.trim()) continue;
      const r = await resolveUserPathReal(ctx.host, p);
      // Chống path traversal: chỉ trong workspace (không phải thư mục kỹ năng, không ra ngoài qua `..` hay symlink).
      if (r.zone !== 'workspace' || r.suspicious) return { content: t(lang, 'diagOutside', { path: p }), isError: true };
      abs.push(r.abs);
      shown.push(r.rel);
    }
    const min: DiagSeverity = parseSeverity(input.severity, 'warning');
    const res = await ctx.host.diagnostics({ paths: abs.length ? abs : undefined, minSeverity: min, limit: input.limit ?? DEFAULT_DIAG_LIMIT });
    const content = diagnosticsReport(res, lang, { min, scope: shown });
    return { content, summary: res.items.length ? countsText(res.items, lang) : lang === 'vi' ? 'không có lỗi' : 'no problems' };
  },
};
