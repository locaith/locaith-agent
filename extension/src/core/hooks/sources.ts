/**
 * Gom hook từ các nguồn và quyết định nguồn nào ĐƯỢC PHÉP chạy.
 *
 * Hook là mã chạy với quyền người dùng. Quy tắc tin cậy:
 *   • hook cấp NGƯỜI DÙNG (`locaithAgent.hooks` trong cài đặt toàn cục) chạy luôn — chỉ người dùng viết được nó;
 *   • hook cấp DỰ ÁN (`.locaith/settings*.json`, và `.claude/settings*.json` khi bật `hooksReadClaudeSettings`) chỉ chạy khi
 *     workspace đã được TIN CẬY **và** người dùng đã xác nhận đúng nội dung hiện tại (hộp xác nhận liệt kê đầy đủ lệnh, ghi nhớ theo
 *     băm của khối hooks đã chuẩn hoá — đổi nội dung thì hỏi lại; đổi phần khác của tệp thì không).
 */

import type { Lang } from '../engine/strings';
import { dedupeEntries, parseHooksConfig } from './config';
import { bi } from './lang';
import type { HookEntry, HookSourceKind } from './types';

export interface ProjectSourceFile {
  kind: Exclude<HookSourceKind, 'user'>;
  /** Đường dẫn tương đối từ gốc workspace. */
  rel: string;
  claude: boolean;
}

export const PROJECT_SOURCE_FILES: readonly ProjectSourceFile[] = [
  { kind: 'project', rel: '.locaith/settings.json', claude: false },
  { kind: 'projectLocal', rel: '.locaith/settings.local.json', claude: false },
  { kind: 'claude', rel: '.claude/settings.json', claude: true },
  { kind: 'claudeLocal', rel: '.claude/settings.local.json', claude: true },
];

export type HookSourceState = 'active' | 'needs-approval' | 'declined' | 'untrusted' | 'disabled' | 'absent' | 'error';

export interface HookSourceStatus {
  kind: HookSourceKind;
  label: string;
  state: HookSourceState;
  count: number;
  /** Với nguồn dự án: đường dẫn tương đối (để mở tệp). */
  rel?: string;
  warnings: string[];
}

export interface HookLoadResult {
  entries: HookEntry[];
  sources: HookSourceStatus[];
  warnings: string[];
}

export interface HookConfirmRequest {
  rel: string;
  /** Mỗi dòng: «PreToolUse [run_command] — lệnh đầy đủ (timeout 60s)». */
  lines: string[];
  hash: string;
}

export interface HookSourcesDeps {
  /** Giá trị thô của `locaithAgent.hooks` — CHỈ cấp người dùng/toàn cục. */
  userHooks(): unknown;
  /** Công tắc tổng `locaithAgent.hooksEnabled`. */
  enabled(): boolean;
  readClaude(): boolean;
  workspaceRoot(): string | undefined;
  trusted(): boolean;
  /** Đọc tệp theo đường dẫn tương đối từ gốc workspace; null = không có/không đọc được. */
  readFile(rel: string): Promise<string | null>;
  hash(text: string): string;
  approvals: { get(key: string): string | undefined; set(key: string, hash: string): void | Promise<void> };
  /** Hỏi người dùng (hộp xác nhận). true = cho phép. */
  confirm(req: HookConfirmRequest): Promise<boolean>;
  log(level: 'info' | 'warn', message: string): void;
  /** Ghi chú cho người dùng thấy ngay trong khung chat (vd: «hook dự án chưa được xác nhận»). */
  note?(level: 'info' | 'warn', text: string): void;
  confirmTimeoutMs?: number;
  lang?(): Lang;
}

const USER_LABEL = 'locaithAgent.hooks';

/** Chuỗi chuẩn tắc (khoá sắp xếp) để băm: không phụ thuộc thứ tự khoá, khoảng trắng hay các khoá khác trong tệp. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export class HookSources {
  /** key → băm đã bị từ chối/hết hạn trong phiên làm việc này: không hỏi lại cho tới khi nội dung đổi hoặc người dùng chủ động xem lại. */
  private readonly declined = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(private readonly d: HookSourcesDeps) {}

  /** Cho phép hỏi lại các nguồn đã bị từ chối (lệnh `/hooks trust`). */
  reviewAgain(): void {
    this.declined.clear();
  }

  async load(): Promise<HookLoadResult> {
    const d = this.d;
    const result: HookLoadResult = { entries: [], sources: [], warnings: [] };
    if (!d.enabled()) {
      result.sources.push({ kind: 'user', label: USER_LABEL, state: 'disabled', count: 0, warnings: [] });
      return result;
    }

    // 1) cấp người dùng
    const lang = d.lang?.();
    const user = parseHooksConfig(d.userHooks(), 'user', USER_LABEL, lang);
    result.entries.push(...user.entries);
    result.sources.push({ kind: 'user', label: USER_LABEL, state: user.entries.length ? 'active' : 'absent', count: user.entries.length, warnings: user.warnings });
    result.warnings.push(...user.warnings);

    // 2) cấp dự án
    const root = d.workspaceRoot();
    for (const f of PROJECT_SOURCE_FILES) {
      if (f.claude && !d.readClaude()) continue;
      const status: HookSourceStatus = { kind: f.kind, label: f.rel, rel: f.rel, state: 'absent', count: 0, warnings: [] };
      if (!root) {
        result.sources.push(status);
        continue;
      }
      let text: string | null = null;
      try {
        text = await d.readFile(f.rel);
      } catch {
        text = null;
      }
      if (text === null) {
        result.sources.push(status);
        continue;
      }
      let raw: unknown;
      try {
        const doc = JSON.parse(text.replace(/^﻿/, ''));
        raw = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).hooks : undefined;
      } catch (err) {
        status.state = 'error';
        const detail = err instanceof Error ? err.message : String(err);
        status.warnings.push(`${f.rel}: ${bi(lang, `JSON không hợp lệ (${detail}) — hook trong tệp này không chạy.`, `invalid JSON (${detail}) — hooks in this file do not run.`)}`);
        result.sources.push(status);
        result.warnings.push(...status.warnings);
        continue;
      }
      const parsed = parseHooksConfig(raw, f.kind, f.rel, lang);
      status.warnings.push(...parsed.warnings);
      result.warnings.push(...parsed.warnings);
      if (!parsed.entries.length) {
        result.sources.push(status);
        continue;
      }
      status.count = parsed.entries.length;
      if (!d.trusted()) {
        status.state = 'untrusted';
        result.sources.push(status);
        continue;
      }
      const hash = d.hash(canonicalJson(parsed.config));
      const key = `${root}::${f.rel}`;
      if (d.approvals.get(key) === hash) {
        status.state = 'active';
        result.entries.push(...parsed.entries);
      } else if (this.declined.get(key) === hash) {
        status.state = 'declined';
      } else {
        const ok = await this.ask(key, hash, f.rel, parsed.entries);
        if (ok) {
          await d.approvals.set(key, hash);
          status.state = 'active';
          result.entries.push(...parsed.entries);
        } else {
          this.declined.set(key, hash);
          status.state = 'needs-approval';
          d.note?.('warn', bi(lang, `Hook của dự án trong ${f.rel} chưa được xác nhận nên KHÔNG chạy. Gõ /hooks trust để xem và cho phép.`, `Project hooks in ${f.rel} are not approved, so they do NOT run. Type /hooks trust to review and allow.`));
        }
      }
      result.sources.push(status);
    }
    result.entries = dedupeEntries(result.entries);
    return result;
  }

  private ask(key: string, hash: string, rel: string, entries: HookEntry[]): Promise<boolean> {
    const k = `${key}#${hash}`;
    const existing = this.inflight.get(k);
    if (existing) return existing;
    const lines = entries.map((e) => `${e.event}${e.matcher ? ` [${e.matcher}]` : ''} — ${e.command} (timeout ${e.timeoutSec}s)`);
    const timeoutMs = this.d.confirmTimeoutMs ?? 120_000;
    const p = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.d.confirm({ rel, lines, hash }).then(
        (v) => {
          clearTimeout(timer);
          resolve(v === true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    }).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }
}
