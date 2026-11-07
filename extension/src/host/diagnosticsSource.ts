/**
 * (lane:ide-context) Đọc chẩn đoán từ `vscode.languages` và chờ language server cập nhật sau khi ghi tệp.
 *
 * Nhận API VS Code qua tham số (kiểu tối thiểu) để test được bằng bản giả, không cần VS Code thật.
 */

import * as path from 'node:path';
import { isInside, normalizeForCompare, toPosix } from '../core/fsutil/paths';
import { filterDiagnostics, type DiagnosticItem, type DiagnosticsQuery, type DiagnosticsResult, type DiagSeverity } from '../core/ide/diagnostics';

/** Phần của vscode.Diagnostic mà ta dùng. severity: 0 Error, 1 Warning, 2 Information, 3 Hint. */
export interface VsDiagnosticLike {
  severity: number;
  message: string;
  source?: string;
  code?: string | number | { value: string | number };
  range: { start: { line: number; character: number } };
}

export interface VsUriLike {
  scheme: string;
  fsPath: string;
}

export interface VsLanguagesLike {
  getDiagnostics(): Array<[VsUriLike, readonly VsDiagnosticLike[]]>;
  onDidChangeDiagnostics(listener: (e: { uris: readonly VsUriLike[] }) => void): { dispose(): void };
}

const SEVERITY: DiagSeverity[] = ['error', 'warning', 'info', 'hint'];

function codeText(code: VsDiagnosticLike['code']): string | undefined {
  if (code === undefined || code === null || code === '') return undefined;
  if (typeof code === 'object') return code.value === undefined ? undefined : String(code.value);
  return String(code);
}

/** Đổi dữ liệu thô của VS Code thành DiagnosticItem; bỏ mọi thứ ngoài workspace (tệp thư viện, untitled, git:…). */
export function toDiagnosticItems(entries: ReadonlyArray<[VsUriLike, readonly VsDiagnosticLike[]]>, roots: readonly string[]): DiagnosticItem[] {
  const out: DiagnosticItem[] = [];
  for (const [uri, diags] of entries) {
    if (uri.scheme !== 'file' || diags.length === 0) continue;
    const root = roots.find((r) => isInside(r, uri.fsPath));
    if (!root) continue;
    const rel = toPosix(path.relative(root, uri.fsPath)) || path.basename(uri.fsPath);
    for (const d of diags) {
      out.push({
        abs: uri.fsPath,
        rel,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: SEVERITY[d.severity] ?? 'info',
        source: d.source || undefined,
        code: codeText(d.code),
        message: String(d.message ?? ''),
      });
    }
  }
  return out;
}

export function readDiagnostics(langs: VsLanguagesLike, roots: readonly string[], q: DiagnosticsQuery): DiagnosticsResult {
  return filterDiagnostics(toDiagnosticItems(langs.getDiagnostics(), roots), q);
}

/**
 * Chờ chẩn đoán của `abs` ổn định: luôn chờ ít nhất `minMs` (language server cần thời gian phân tích); nếu trong lúc đó có
 * sự kiện đổi chẩn đoán cho đúng tệp thì chờ thêm một quãng lặng ngắn rồi trả về; không bao giờ quá `maxMs`; Dừng → trả ngay.
 */
export function waitForDiagnostics(
  langs: Pick<VsLanguagesLike, 'onDidChangeDiagnostics'>,
  abs: string,
  opts: { minMs: number; maxMs: number; signal: AbortSignal; quietMs?: number },
): Promise<void> {
  const key = normalizeForCompare(abs);
  const quiet = opts.quietMs ?? 250;
  const started = Date.now();
  return new Promise((resolve) => {
    if (opts.signal.aborted) return resolve();
    let lastChange = 0;
    let tick: ReturnType<typeof setTimeout> | undefined;
    const sub = langs.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.scheme === 'file' && normalizeForCompare(u.fsPath) === key)) {
        lastChange = Date.now();
        schedule();
      }
    });
    const hardStop = setTimeout(finish, opts.maxMs);
    function schedule() {
      if (tick) clearTimeout(tick);
      const elapsed = Date.now() - started;
      const waitMin = Math.max(0, opts.minMs - elapsed);
      const waitQuiet = lastChange ? Math.max(0, lastChange + quiet - Date.now()) : waitMin;
      tick = setTimeout(finish, Math.max(waitMin, waitQuiet));
    }
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      if (tick) clearTimeout(tick);
      clearTimeout(hardStop);
      sub.dispose();
      opts.signal.removeEventListener('abort', finish);
      resolve();
    }
    opts.signal.addEventListener('abort', finish, { once: true });
    schedule();
  });
}
