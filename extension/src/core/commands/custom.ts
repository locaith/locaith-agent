/**
 * Lệnh gạch chéo tuỳ chỉnh từ tệp Markdown — cùng định dạng với `.claude/commands/*.md` của Claude Code.
 *
 *   <thư mục lệnh>/frontend/component.md   →   /frontend:component
 *   ---
 *   description: Tạo component mới
 *   argument-hint: <tên> [thư mục]
 *   allowed-tools: Bash(git status:*), Bash(git diff:*)
 *   model: top
 *   disable-model-invocation: false
 *   ---
 *   Tạo component $1 trong $2. Toàn bộ đối số: $ARGUMENTS
 *   Quy ước: @docs/components.md
 *   Trạng thái git: !`git status --short`
 *
 * Dùng chung VS Code / CLI / trình duyệt: KHÔNG import 'vscode' hay 'node:*'; mọi thao tác tệp và lệnh đi qua ToolHost.
 *
 * An toàn:
 *   • `@đường/dẫn` chỉ nhúng tệp NẰM TRONG workspace (chặn `..`, đường dẫn tuyệt đối, `~`), bỏ qua tệp bí mật, có trần kích thước;
 *   • `!\`lệnh\`` chỉ chạy khi workspace đã tin cậy VÀ (lệnh khớp `allowed-tools` của tệp HOẶC người dùng cho phép qua thẻ xin phép).
 *     Luật `Bash(tiền tố:*)` không bao giờ cho qua lệnh có toán tử nối/chuyển hướng (`;`, `&&`, `|`, `>`, `$(`…).
 */

import type { ToolHost } from '../engine/types';
import { parseSkillMarkdown } from '../skills/registry';

export type CommandSource = 'project' | 'user' | 'plugin';

const PRIORITY: Record<CommandSource, number> = { project: 0, user: 1, plugin: 2 };

export interface CustomCommand {
  /** Tên không có `/`, chữ thường; thư mục con thành không gian tên `a:b`. */
  name: string;
  description: string;
  argumentHint?: string;
  /** Luật công cụ được phép (dạng Claude Code: `Bash(git diff:*)`, `Read`, `run_command`…). */
  allowedTools: string[];
  model?: string;
  /** true = model không được tự gọi qua công cụ `slash_command`. */
  disableModelInvocation: boolean;
  body: string;
  source: CommandSource;
  /** Đường dẫn tuyệt đối của tệp nguồn. */
  file: string;
}

export interface CommandDirSpec {
  path: string;
  source: CommandSource;
}

export const COMMAND_LIMITS = {
  maxDepth: 4,
  maxFiles: 300,
  maxBodyChars: 20_000,
  /** Nhúng tệp `@…`: mỗi tệp / tổng / số tệp. */
  maxRefBytes: 100_000,
  maxRefTotal: 200_000,
  maxRefs: 10,
  /** Lệnh `!\`…\``: số lệnh / thời gian / độ dài kết quả mỗi lệnh. */
  maxShell: 5,
  shellTimeoutMs: 30_000,
  maxShellOutput: 20_000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Phân tích tệp
// ─────────────────────────────────────────────────────────────────────────────

/** `frontend/component.md` → `frontend:component`. Trả '' nếu không hợp lệ. */
export function commandNameFromPath(rel: string): string {
  const parts = rel
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .split('/')
    .map((p) =>
      p
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, ''),
    )
    .filter(Boolean);
  return parts.join(':');
}

function str(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v.join(', ') : v ?? '').trim();
}

/** Tách danh sách luật công cụ, tôn trọng dấu phẩy nằm trong ngoặc: `Bash(git add:*), Read`. */
export function splitToolRules(v: string | string[] | undefined): string[] {
  const raw = Array.isArray(v) ? v.join(',') : v ?? '';
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === '\n') && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.slice(0, 50);
}

/** Lỗi frontmatter có thể nhìn thấy (một dòng) — tệp vẫn được nạp nếu có thể. */
function frontmatterProblem(text: string): string | undefined {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---')) return undefined;
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(src);
  if (!m) return 'frontmatter mở bằng `---` nhưng không có `---` đóng';
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#') || /^\s/.test(line) || /^\s*-\s/.test(line)) continue;
    if (!/^[A-Za-z0-9_-]+:/.test(line)) return `dòng frontmatter không hợp lệ: "${line.trim().slice(0, 60)}"`;
  }
  return undefined;
}

export interface ParsedCommandFile {
  command?: CustomCommand;
  warning?: string;
}

export function parseCommandFile(text: string, rel: string, source: CommandSource, file: string): ParsedCommandFile {
  const name = commandNameFromPath(rel);
  if (!name) return { warning: `${rel}: tên lệnh không hợp lệ` };
  const problem = frontmatterProblem(text);
  if (problem && problem.startsWith('frontmatter mở')) return { warning: `/${name}: ${problem}` };
  const { meta, body } = parseSkillMarkdown(text);
  let warning = problem ? `/${name}: ${problem}` : undefined;
  const dmiRaw = str(meta['disable-model-invocation']).toLowerCase();
  if (dmiRaw && dmiRaw !== 'true' && dmiRaw !== 'false') warning = `/${name}: disable-model-invocation phải là true hoặc false`;
  const description = str(meta.description).replace(/\s+/g, ' ') || body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 120) || name;
  return {
    command: {
      name,
      description: description.slice(0, 300),
      ...(str(meta['argument-hint']) ? { argumentHint: str(meta['argument-hint']).slice(0, 80) } : {}),
      allowedTools: splitToolRules(meta['allowed-tools']),
      ...(str(meta.model) ? { model: str(meta.model).slice(0, 120) } : {}),
      disableModelInvocation: dmiRaw === 'true',
      body: body.slice(0, COMMAND_LIMITS.maxBodyChars),
      source,
      file,
    },
    warning,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Nạp thư mục
// ─────────────────────────────────────────────────────────────────────────────

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

export interface LoadedCommands {
  commands: CustomCommand[];
  warnings: string[];
}

/**
 * Quét các thư mục lệnh (đệ quy, có trần). Trùng tên: nguồn ưu tiên hơn thắng (dự án > người dùng > plugin);
 * cùng nguồn thì thư mục đứng trước trong danh sách thắng (ví dụ `.locaith/commands` trước `.claude/commands`).
 */
export async function loadCommandDirs(host: ToolHost, dirs: readonly CommandDirSpec[]): Promise<LoadedCommands> {
  const found = new Map<string, CustomCommand>();
  const warnings: string[] = [];
  let files = 0;
  const walk = async (spec: CommandDirSpec, dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > COMMAND_LIMITS.maxDepth || files >= COMMAND_LIMITS.maxFiles) return;
    let entries;
    try {
      entries = await host.readDir(dir);
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (files >= COMMAND_LIMITS.maxFiles) return;
      if (e.name.startsWith('.')) continue;
      const abs = joinPath(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        await walk(spec, abs, r, depth + 1);
        continue;
      }
      if (!/\.md$/i.test(e.name)) continue;
      files++;
      let text: string | null = null;
      try {
        text = await host.readText(abs);
      } catch (err) {
        warnings.push(`${r}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (text == null) continue;
      const p = parseCommandFile(text, r, spec.source, abs);
      if (p.warning) warnings.push(p.warning);
      if (!p.command) continue;
      const prev = found.get(p.command.name);
      if (prev && PRIORITY[prev.source] <= PRIORITY[p.command.source]) continue;
      found.set(p.command.name, p.command);
    }
  };
  for (const d of dirs) {
    try {
      if (!(await host.stat(d.path))?.isDirectory) continue;
    } catch {
      continue;
    }
    await walk(d, d.path, '', 0);
  }
  return { commands: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Đối số
// ─────────────────────────────────────────────────────────────────────────────

/** Tách đối số kiểu shell đơn giản: khoảng trắng, giữ cụm trong "…" hoặc '…'. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** Thay `$ARGUMENTS` và `$1..$9`. Không có chỗ giữ nào mà người dùng có gõ đối số → nối đối số vào cuối. */
export function substituteArguments(body: string, args: string): string {
  const a = args.trim();
  const positional = splitArgs(a);
  const hasPlaceholder = /\$ARGUMENTS|\$[1-9](?![0-9])/.test(body);
  const out = body.split('$ARGUMENTS').join(a).replace(/\$([1-9])(?![0-9])/g, (_m, d: string) => positional[Number(d) - 1] ?? '');
  return !hasPlaceholder && a ? `${out}\n\n${a}` : out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nhúng tệp `@đường/dẫn`
// ─────────────────────────────────────────────────────────────────────────────

const SECRET_FILE = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore|jks)|token[^/]*\.md|credentials[^/]*)$/i;

/** Chuẩn hoá đường dẫn TƯƠNG ĐỐI trong workspace; null nếu thoát ra ngoài (`..`), tuyệt đối, `~`, hoặc chứa ký tự lạ. */
export function safeRelative(ref: string): string | null {
  const r = ref.replace(/\\/g, '/').trim();
  if (!r || r.startsWith('/') || r.startsWith('~') || /^[a-zA-Z]:/.test(r) || r.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(r)) return null;
  const parts: string[] = [];
  for (const seg of r.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** Các tham chiếu `@…` trong văn bản (đứng đầu dòng hoặc sau khoảng trắng/ngoặc — không bắt email). */
export function findFileRefs(text: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s(])@([^\s`'"()<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ref = m[2].replace(/[.,;:!?]+$/, '');
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

export interface ExpandNotes {
  embedded: string[];
  skipped: string[];
  ran: string[];
  refused: string[];
}

async function embedFiles(text: string, refs: readonly string[], host: ToolHost, notes: ExpandNotes): Promise<string> {
  const roots = host.workspaceRoots();
  if (refs.length === 0 || roots.length === 0) return text;
  const blocks: string[] = [];
  let total = 0;
  for (const ref of refs) {
    if (notes.embedded.length >= COMMAND_LIMITS.maxRefs) break;
    const rel = safeRelative(ref);
    if (!rel) {
      notes.skipped.push(ref);
      continue;
    }
    if (SECRET_FILE.test(rel)) {
      notes.skipped.push(ref);
      continue;
    }
    const abs = joinPath(roots[0], rel);
    let st;
    try {
      st = await host.stat(abs);
    } catch {
      st = null;
    }
    if (!st?.isFile) continue; // không phải tệp (có thể là @tên-người) → để nguyên chữ
    if (st.size > COMMAND_LIMITS.maxRefBytes || total + st.size > COMMAND_LIMITS.maxRefTotal) {
      notes.skipped.push(ref);
      continue;
    }
    let body: string | null = null;
    try {
      body = await host.readText(abs);
    } catch {
      body = null;
    }
    if (body == null) {
      notes.skipped.push(ref);
      continue;
    }
    total += body.length;
    notes.embedded.push(rel);
    blocks.push(`<file path="${rel}">\n${body}\n</file>`);
  }
  return blocks.length ? `${text}\n\n<referenced_files>\n${blocks.join('\n')}\n</referenced_files>` : text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lệnh nhúng `!\`…\``
// ─────────────────────────────────────────────────────────────────────────────

export function findShellRefs(text: string): string[] {
  const out: string[] = [];
  const re = /!`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

/** Toán tử shell có thể nối thêm lệnh khác sau một tiền tố được phép. */
const SHELL_META = /[;&|<>`\n\r]|\$\(|\$\{/;

/** Lệnh có khớp một luật `allowed-tools` không (`Bash`, `run_command`, `Bash(git diff:*)`, `Bash(git status)`). */
export function shellAllowedByRules(command: string, rules: readonly string[]): boolean {
  const cmd = command.trim().replace(/\s+/g, ' ');
  for (const rule of rules) {
    const m = /^(bash|run_command|shell)\s*(?:\((.*)\))?$/i.exec(rule.trim());
    if (!m) continue;
    const spec = (m[2] ?? '').trim();
    if (!spec || spec === '*') {
      if (!SHELL_META.test(cmd)) return true;
      continue;
    }
    if (SHELL_META.test(cmd)) continue;
    if (spec.endsWith(':*')) {
      const prefix = spec.slice(0, -2).trim().replace(/\s+/g, ' ');
      if (cmd === prefix || cmd.startsWith(prefix + ' ')) return true;
    } else if (spec.endsWith('*')) {
      const prefix = spec.slice(0, -1).replace(/\s+/g, ' ');
      if (cmd.startsWith(prefix)) return true;
    } else if (cmd === spec.replace(/\s+/g, ' ')) return true;
  }
  return false;
}

export interface ExpandOptions {
  host: ToolHost;
  /** Workspace đã được tin cậy (chưa tin cậy → không bao giờ chạy lệnh nhúng). */
  trusted: boolean;
  signal: AbortSignal;
  /** Không chạy lệnh nhúng (ví dụ chế độ lập kế hoạch) — vẫn nhúng tệp. */
  noShell?: boolean;
  /** Hỏi người dùng cho lệnh không khớp `allowed-tools`. Vắng = từ chối. */
  confirmShell?(command: string, cmd: CustomCommand): Promise<boolean>;
}

export interface ExpandedCommand {
  prompt: string;
  notes: ExpandNotes;
}

/** Chạy các lệnh `!\`…\`` của TEMPLATE (không bao giờ của đối số); trả về khối kết quả theo đúng thứ tự `refs`. */
async function runShellRefs(refs: readonly string[], cmd: CustomCommand, o: ExpandOptions, notes: ExpandNotes): Promise<string[]> {
  const results = new Map<string, string>();
  const cwd = o.host.workspaceRoots()[0];
  let count = 0;
  for (const command of refs) {
    if (results.has(command)) continue;
    let out: string;
    if (!o.trusted || o.noShell || !cwd || count >= COMMAND_LIMITS.maxShell) {
      notes.refused.push(command);
      out = !o.trusted ? '[not run: workspace is not trusted]' : '[not run]';
    } else {
      count++;
      const ok = shellAllowedByRules(command, cmd.allowedTools) || (o.confirmShell ? await o.confirmShell(command, cmd).catch(() => false) : false);
      if (!ok) {
        notes.refused.push(command);
        out = '[not run: permission denied]';
      } else {
        try {
          const r = await o.host.runCommand({ command, cwd, timeoutMs: COMMAND_LIMITS.shellTimeoutMs, signal: o.signal, onData: () => undefined });
          notes.ran.push(command);
          const body = r.output.length > COMMAND_LIMITS.maxShellOutput ? r.output.slice(0, COMMAND_LIMITS.maxShellOutput) + '\n[…truncated]' : r.output;
          out = `${body.trimEnd()}${r.exitCode && r.exitCode !== 0 ? `\n[exit code ${r.exitCode}]` : ''}${r.timedOut ? '\n[timed out]' : ''}`;
        } catch (err) {
          notes.refused.push(command);
          out = `[failed: ${err instanceof Error ? err.message : String(err)}]`;
        }
      }
    }
    results.set(command, out);
  }
  return refs.map((c) => `\n\`\`\`\n$ ${c}\n${results.get(c) ?? '[not run]'}\n\`\`\`\n`);
}

/**
 * Dựng prompt cuối của một lệnh tuỳ chỉnh. Thứ tự có chủ đích:
 *   1) lệnh `!\`…\`` CHỈ lấy từ template — đối số (có thể do model đưa vào) không bao giờ thành lệnh shell;
 *   2) thay `$ARGUMENTS` / `$1..$9`;
 *   3) nhúng tệp `@…` tìm trong template + đối số — KHÔNG tìm trong kết quả lệnh hay trong nội dung tệp đã nhúng.
 */
export async function expandCustomCommand(cmd: CustomCommand, args: string, o: ExpandOptions): Promise<ExpandedCommand> {
  const notes: ExpandNotes = { embedded: [], skipped: [], ran: [], refused: [] };
  const safeArgs = args.replace(/\u0000/g, '');
  const shellRefs: string[] = [];
  const templ = cmd.body.replace(/\u0000/g, '').replace(/!`([^`\n]+)`/g, (_m, c: string) => `\u0000SH${shellRefs.push(c) - 1}\u0000`);
  const substituted = substituteArguments(templ, safeArgs);
  const refs = findFileRefs(substituted.replace(/\u0000SH\d+\u0000/g, ' '));
  const outputs = await runShellRefs(shellRefs, cmd, o, notes);
  const text = substituted.replace(/\u0000SH(\d+)\u0000/g, (_m, i: string) => outputs[Number(i)] ?? '');
  return { prompt: (await embedFiles(text, refs, o.host, notes)).trim(), notes };
}

/** Lệnh có cho model tự gọi không: tác giả không tắt, và lệnh của dự án chỉ khi workspace đã tin cậy. */
export function modelInvocable(cmd: CustomCommand, trusted: boolean): boolean {
  if (cmd.disableModelInvocation) return false;
  if (cmd.source === 'project' && !trusted) return false;
  return true;
}
