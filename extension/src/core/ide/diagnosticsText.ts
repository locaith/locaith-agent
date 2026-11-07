/**
 * (lane:ide-context) Chữ gửi cho model/người dùng về chẩn đoán IDE: công cụ get_diagnostics, ghi chú sau khi sửa, @problems.
 */

import { t, type Lang } from '../engine/strings';
import { countBySeverity, formatDiagnostic, type DiagnosticItem, type DiagnosticsResult, type DiagSeverity } from './diagnostics';

/** "2 lỗi, 1 cảnh báo" — bỏ các mức bằng 0. */
export function countsText(items: readonly DiagnosticItem[], lang: Lang): string {
  const c = countBySeverity(items);
  const keys: Array<[DiagSeverity, 'diagError' | 'diagWarning' | 'diagInfo' | 'diagHint']> = [
    ['error', 'diagError'],
    ['warning', 'diagWarning'],
    ['info', 'diagInfo'],
    ['hint', 'diagHint'],
  ];
  return keys
    .filter(([s]) => c[s] > 0)
    .map(([s, k]) => t(lang, k, { n: c[s] }))
    .join(', ');
}

/** Toàn bộ kết quả cho model: dòng tiêu đề + một dòng mỗi chẩn đoán + dòng "còn N mục" nếu bị cắt. */
export function diagnosticsReport(r: DiagnosticsResult, lang: Lang, opts: { min: DiagSeverity; scope?: string[] }): string {
  if (r.items.length === 0) {
    const what = t(lang, opts.min === 'error' ? 'diagNoneErrors' : opts.min === 'warning' ? 'diagNoneWarnings' : 'diagNoneAny');
    const scope = opts.scope?.length ? t(lang, 'diagScope', { paths: opts.scope.join(', ') }) : '';
    return t(lang, 'diagNone', { what, scope });
  }
  const shown = r.total > r.items.length ? t(lang, 'diagShown', { n: r.items.length }) : '';
  const lines = [t(lang, 'diagHeader', { counts: countsText(r.items, lang), shown }), ...r.items.map(formatDiagnostic)];
  if (r.total > r.items.length) lines.push(t(lang, 'diagMore', { n: r.total - r.items.length }));
  return lines.join('\n');
}

/** Ghi chú gắn vào kết quả edit_file/write_file khi có chẩn đoán MỚI. */
export function afterEditNote(items: readonly DiagnosticItem[], file: string, lang: Lang, limit = 20): string {
  const shown = items.slice(0, limit);
  const lines = [t(lang, 'diagAfterEdit', { counts: countsText(items, lang), file }), ...shown.map((d) => `- ${formatDiagnostic(d)}`)];
  if (items.length > shown.length) lines.push(t(lang, 'diagMore', { n: items.length - shown.length }));
  if (items.some((d) => d.severity === 'error')) lines.push(t(lang, 'diagAfterEditFix'));
  return lines.join('\n');
}
