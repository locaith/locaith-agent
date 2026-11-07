/**
 * Đọc cấu hình hook (JSON người dùng viết tay → danh sách `HookEntry` sạch) và so khớp `matcher`.
 *
 * Định dạng (giống Claude Code):
 *   { "PreToolUse": [ { "matcher": "run_command|edit_file", "hooks": [ { "type": "command", "command": "...", "timeout": 60 } ] } ] }
 *
 * Cấu hình do người viết tay nên đọc KHOAN DUNG nhưng không bao giờ ném lỗi: mục sai bị bỏ kèm cảnh báo, phần còn lại vẫn dùng được.
 */

import type { Lang } from '../engine/strings';
import { bi } from './lang';
import {
  HOOK_DEFAULT_TIMEOUT_SEC,
  HOOK_EVENTS,
  HOOK_MAX_TIMEOUT_SEC,
  type HookCommandDef,
  type HookEntry,
  type HookEvent,
  type HookGroup,
  type HookSourceKind,
  type HooksConfig,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Ánh xạ tên công cụ Claude Code ↔ Locaith
// ─────────────────────────────────────────────────────────────────────────────

/** Tên công cụ của Claude Code → tên công cụ của Locaith. Dùng cho `matcher` và cho stdin của hook đọc từ `.claude/settings.json`. */
export const CLAUDE_TO_LOCAITH_TOOL: Readonly<Record<string, string>> = {
  Bash: 'run_command',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Write: 'write_file',
  Read: 'read_file',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list_dir',
  WebFetch: 'fetch_url',
  WebSearch: 'web_search',
  TodoWrite: 'todo_write',
  Task: 'agent',
  ExitPlanMode: 'exit_plan_mode',
  Skill: 'load_skill',
};

/** Tên Claude Code đại diện cho mỗi công cụ Locaith (tên đầu tiên trong bảng trên). */
const LOCAITH_TO_CLAUDE: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [c, l] of Object.entries(CLAUDE_TO_LOCAITH_TOOL)) (out[l] ??= []).push(c);
  return out;
})();

/** Mọi tên mà người dùng có thể gọi một công cụ: tên Locaith + các tên Claude Code tương đương. */
export function toolNameCandidates(locaithName: string): string[] {
  return [locaithName, ...(LOCAITH_TO_CLAUDE[locaithName] ?? [])];
}

/** Tên Claude Code chính của một công cụ Locaith (không có thì giữ nguyên tên). */
export function claudeToolName(locaithName: string): string {
  return LOCAITH_TO_CLAUDE[locaithName]?.[0] ?? locaithName;
}

/** Đối số công cụ theo cách Claude Code đặt tên (thêm `file_path` cạnh `path`) — chỉ cho hook từ `.claude`. */
export function claudeToolInput(locaithName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.path === 'string' && input.file_path === undefined && (locaithName === 'edit_file' || locaithName === 'write_file' || locaithName === 'read_file')) {
    return { ...input, file_path: input.path };
  }
  return input;
}

// ─────────────────────────────────────────────────────────────────────────────
// matcher
// ─────────────────────────────────────────────────────────────────────────────

const SIMPLE_LIST = /^[A-Za-z0-9_\- ]+(?:\|[A-Za-z0-9_\- ]+)*$/;
const MATCHER_MAX = 300;

export interface MatcherCompiled {
  /** Kiểm tra một tập tên ứng viên. */
  test(candidates: readonly string[]): boolean;
  /** 'all' | 'list' | 'regex' | 'invalid' — để /hooks nói rõ cách hiểu. */
  kind: 'all' | 'list' | 'regex' | 'invalid';
}

/**
 * Quy tắc (khai báo rõ):
 *  • trống hoặc `*`           → mọi thứ;
 *  • chỉ gồm chữ/số/`_`/`-` và `|` (vd `run_command|edit_file`, `Bash`) → so khớp TÊN CHÍNH XÁC, phân biệt hoa thường;
 *  • còn lại (có `.`, `*`, `(`, `[`, `^`, `$`, `\`…) hoặc dạng `/mẫu/` → biểu thức chính quy KHỚP TOÀN BỘ TÊN, vd `mcp__.*`, `(read|write)_file`.
 * Regex sai cú pháp → không khớp gì (và bị báo). Khớp nếu BẤT KỲ tên ứng viên nào khớp (tên Locaith hoặc tên Claude Code).
 */
export function compileMatcher(matcher: string | undefined): MatcherCompiled {
  const m = (matcher ?? '').trim();
  if (!m || m === '*') return { kind: 'all', test: () => true };
  if (m.length > MATCHER_MAX) return { kind: 'invalid', test: () => false };
  if (SIMPLE_LIST.test(m)) {
    const names = new Set(m.split('|').map((s) => s.trim()).filter(Boolean));
    return { kind: 'list', test: (c) => c.some((x) => names.has(x)) };
  }
  const body = m.length > 2 && m.startsWith('/') && m.endsWith('/') ? m.slice(1, -1) : m;
  try {
    const re = new RegExp(`^(?:${body})$`);
    return { kind: 'regex', test: (c) => c.some((x) => re.test(x)) };
  } catch {
    return { kind: 'invalid', test: () => false };
  }
}

export function matchesMatcher(matcher: string | undefined, candidates: readonly string[]): boolean {
  return compileMatcher(matcher).test(candidates);
}

// ─────────────────────────────────────────────────────────────────────────────
// Đọc cấu hình
// ─────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface ParsedHooks {
  config: HooksConfig;
  entries: HookEntry[];
  warnings: string[];
}

function clampTimeout(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return HOOK_DEFAULT_TIMEOUT_SEC;
  return Math.min(HOOK_MAX_TIMEOUT_SEC, Math.max(1, Math.round(n)));
}

/** Tên ngắn để hiện: `name` nếu có, không thì từ đầu tiên của lệnh (bỏ đường dẫn thư mục), cắt 28 ký tự. */
export function hookDisplayName(def: { name?: string; command: string }): string {
  if (def.name && def.name.trim()) return def.name.trim().slice(0, 28);
  const first = def.command.trim().split(/\s+/)[0] ?? '';
  const base = first.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() || first;
  return (base || 'hook').slice(0, 28);
}

/** Chuẩn hoá một khối `hooks` (đối tượng thô) thành cấu hình sạch + danh sách phẳng. Không bao giờ ném lỗi. */
export function parseHooksConfig(raw: unknown, source: HookSourceKind, sourceLabel: string, lang: Lang = 'vi'): ParsedHooks {
  const warnings: string[] = [];
  const config: HooksConfig = {};
  const entries: HookEntry[] = [];
  if (raw === undefined || raw === null) return { config, entries, warnings };
  if (!isObj(raw)) return { config, entries, warnings: [`${sourceLabel}: ${bi(lang, '"hooks" phải là một đối tượng.', '"hooks" must be an object.')}`] };
  const dialect: HookEntry['dialect'] = source === 'claude' || source === 'claudeLocal' ? 'claude' : 'locaith';

  for (const [eventName, groupsRaw] of Object.entries(raw)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(eventName)) {
      warnings.push(`${sourceLabel}: ${bi(lang, `sự kiện "${eventName}" không được hỗ trợ — bỏ qua.`, `event "${eventName}" is not supported — skipped.`)}`);
      continue;
    }
    const event = eventName as HookEvent;
    if (!Array.isArray(groupsRaw)) {
      warnings.push(`${sourceLabel}: ${bi(lang, `"${eventName}" phải là một mảng.`, `"${eventName}" must be an array.`)}`);
      continue;
    }
    const groups: HookGroup[] = [];
    for (const g of groupsRaw) {
      if (!isObj(g) || !Array.isArray(g.hooks)) {
        warnings.push(`${sourceLabel}: ${bi(lang, `một nhóm trong "${eventName}" thiếu mảng "hooks" — bỏ qua.`, `a group in "${eventName}" has no "hooks" array — skipped.`)}`);
        continue;
      }
      const matcher = typeof g.matcher === 'string' && g.matcher.trim() ? g.matcher.trim() : undefined;
      if (matcher && compileMatcher(matcher).kind === 'invalid') {
        warnings.push(`${sourceLabel}: ${bi(lang, `matcher "${matcher.slice(0, 60)}" của "${eventName}" không hợp lệ (regex sai hoặc quá dài) — nhóm này bị bỏ.`, `matcher "${matcher.slice(0, 60)}" of "${eventName}" is invalid (bad or too long regex) — group skipped.`)}`);
        continue;
      }
      const hooks: HookCommandDef[] = [];
      for (const h of g.hooks) {
        if (!isObj(h) || (h.type !== undefined && h.type !== 'command')) {
          warnings.push(`${sourceLabel}: ${bi(lang, `hook trong "${eventName}" có "type" không hỗ trợ (chỉ "command") — bỏ qua.`, `a hook in "${eventName}" has an unsupported "type" (only "command") — skipped.`)}`);
          continue;
        }
        if (typeof h.command !== 'string' || !h.command.trim()) {
          warnings.push(`${sourceLabel}: ${bi(lang, `hook trong "${eventName}" thiếu "command" — bỏ qua.`, `a hook in "${eventName}" has no "command" — skipped.`)}`);
          continue;
        }
        const env: Record<string, string> = {};
        if (isObj(h.env)) {
          for (const [k, v] of Object.entries(h.env)) {
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && (typeof v === 'string' || typeof v === 'number')) env[k] = String(v);
          }
        }
        const def: HookCommandDef = { type: 'command', command: h.command, timeout: clampTimeout(h.timeout), env };
        if (typeof h.name === 'string' && h.name.trim()) def.name = h.name.trim();
        hooks.push(def);
        entries.push({
          event,
          source,
          sourceLabel,
          matcher,
          command: def.command,
          timeoutSec: def.timeout!,
          name: hookDisplayName(def),
          env,
          dialect,
        });
      }
      if (hooks.length) groups.push({ ...(matcher ? { matcher } : {}), hooks });
    }
    if (groups.length) config[event] = groups;
  }
  return { config, entries, warnings };
}

/** Bỏ các hook trùng hệt (cùng sự kiện + matcher + lệnh): giữ cái đầu theo thứ tự nguồn. */
export function dedupeEntries(entries: readonly HookEntry[]): HookEntry[] {
  const seen = new Set<string>();
  const out: HookEntry[] = [];
  for (const e of entries) {
    const key = `${e.event}\u0000${e.matcher ?? ''}\u0000${e.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
