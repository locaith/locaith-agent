/**
 * (lane:ide-context) Chẩn đoán của IDE (lỗi/cảnh báo do language server báo) — kiểu dữ liệu và hàm thuần dùng chung.
 *
 * Vì sao có: model yếu không tự biết mình vừa làm hỏng tệp; VS Code thì biết ngay (gạch đỏ). Lớp này đưa dữ liệu đó cho model
 * qua công cụ `get_diagnostics` và qua ghi chú tự động sau mỗi lần sửa tệp (xem editDiagnostics.ts).
 *
 * Tệp này KHÔNG import 'vscode' hay 'node:*' (bản trình duyệt/CLI dùng chung core). Host nào đọc được chẩn đoán thì cài
 * `ToolHost.diagnostics`; host không có IDE (CLI, Chrome) để trống → công cụ không được đăng ký.
 */

export type DiagSeverity = 'error' | 'warning' | 'info' | 'hint';

export const SEVERITY_RANK: Record<DiagSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

export interface DiagnosticItem {
  /** Đường dẫn tuyệt đối. */
  abs: string;
  /** Đường dẫn tương đối theo workspace (dấu '/'). */
  rel: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  severity: DiagSeverity;
  /** "ts", "eslint", "Pylance"… */
  source?: string;
  code?: string;
  message: string;
}

export interface DiagnosticsQuery {
  /** Đường dẫn tuyệt đối (tệp hoặc thư mục) cần lọc. Trống = mọi tệp trong workspace. */
  paths?: string[];
  /** Mức tối thiểu cần lấy (mặc định 'warning' = lỗi + cảnh báo). */
  minSeverity?: DiagSeverity;
  /** Chỉ lấy của nguồn này (so không phân biệt hoa/thường). */
  source?: string;
  /** Trần số mục trả về (mặc định 100). */
  limit?: number;
}

export interface DiagnosticsResult {
  /** Đã lọc, sắp xếp (lỗi trước), cắt theo `limit`. */
  items: DiagnosticItem[];
  /** Tổng số mục khớp bộ lọc TRƯỚC khi cắt. */
  total: number;
}

export const DEFAULT_DIAG_LIMIT = 100;
export const MAX_DIAG_LIMIT = 500;
const MAX_MESSAGE_CHARS = 400;

/** So đường dẫn: bỏ khác biệt `\`/`/`, dấu `/` cuối; không phân biệt hoa/thường (Windows/macOS). */
export function diagPathKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').normalize('NFC').toLowerCase();
}

/** `target` là chính `scope` hoặc nằm trong thư mục `scope`. */
export function pathMatches(scope: string, target: string): boolean {
  const s = diagPathKey(scope);
  const t = diagPathKey(target);
  return t === s || t.startsWith(s + '/');
}

/** Sắp: mức nặng trước, rồi theo tệp, dòng, cột. */
export function sortDiagnostics(items: DiagnosticItem[]): DiagnosticItem[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.rel.localeCompare(b.rel) ||
      a.line - b.line ||
      a.column - b.column,
  );
}

/** Lọc + sắp + cắt — dùng cho mọi host (host chỉ cần đổi dữ liệu thô của IDE thành `DiagnosticItem`). */
export function filterDiagnostics(all: readonly DiagnosticItem[], q: DiagnosticsQuery = {}): DiagnosticsResult {
  const min = SEVERITY_RANK[q.minSeverity ?? 'warning'];
  const src = q.source?.trim().toLowerCase();
  const scopes = (q.paths ?? []).filter(Boolean);
  const hits = all.filter(
    (d) =>
      SEVERITY_RANK[d.severity] <= min &&
      (!src || (d.source ?? '').toLowerCase() === src) &&
      (scopes.length === 0 || scopes.some((s) => pathMatches(s, d.abs))),
  );
  const limit = Math.max(1, Math.min(MAX_DIAG_LIMIT, Math.floor(q.limit ?? DEFAULT_DIAG_LIMIT)));
  return { items: sortDiagnostics(hits).slice(0, limit), total: hits.length };
}

function oneLine(s: string): string {
  const t = s.replace(/\s*\r?\n\s*/g, ' ').trim();
  return t.length > MAX_MESSAGE_CHARS ? t.slice(0, MAX_MESSAGE_CHARS - 1) + '…' : t;
}

/** `src/a.ts:12:5 error [ts 2304] Cannot find name 'x'.` — dạng mà parseFileRef của giao diện bấm mở được đúng dòng. */
export function formatDiagnostic(d: DiagnosticItem): string {
  const tag = d.source || d.code ? ` [${[d.source, d.code].filter(Boolean).join(' ')}]` : '';
  return `${d.rel}:${d.line}:${d.column} ${d.severity}${tag} ${oneLine(d.message)}`;
}

export function countBySeverity(items: readonly DiagnosticItem[]): Record<DiagSeverity, number> {
  const c: Record<DiagSeverity, number> = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const d of items) c[d.severity]++;
  return c;
}

/** Khoá so sánh không gồm số dòng: sửa tệp làm dòng dịch chuyển, nhưng một lỗi cũ vẫn là lỗi cũ. */
function identity(d: DiagnosticItem): string {
  return [diagPathKey(d.abs), d.severity, d.source ?? '', d.code ?? '', oneLine(d.message)].join('\u0001');
}

/**
 * Chẩn đoán có ở `after` mà KHÔNG có ở `before` (so theo đa tập: hai lỗi giống hệt trước, ba lỗi sau → một lỗi mới).
 * Giữ thứ tự của `after`.
 */
export function newDiagnostics(before: readonly DiagnosticItem[], after: readonly DiagnosticItem[]): DiagnosticItem[] {
  const pool = new Map<string, number>();
  for (const d of before) pool.set(identity(d), (pool.get(identity(d)) ?? 0) + 1);
  const out: DiagnosticItem[] = [];
  for (const d of after) {
    const k = identity(d);
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else out.push(d);
  }
  return out;
}

/** `DiagSeverity` từ chuỗi model đưa vào ('errors', 'warn', 'all'…); không nhận ra → fallback. */
export function parseSeverity(v: unknown, fallback: DiagSeverity = 'warning'): DiagSeverity {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'error' || s === 'errors') return 'error';
  if (s === 'warning' || s === 'warnings' || s === 'warn') return 'warning';
  if (s === 'info' || s === 'information') return 'info';
  if (s === 'hint' || s === 'all') return 'hint';
  return fallback;
}
