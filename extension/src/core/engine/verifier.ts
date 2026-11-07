/**
 * (lane:blind-verifier) KIỂM TRA ĐỘC LẬP bằng "reviewer mù".
 *
 * Vì sao có: khi chính model tự phán "xong" nó hay sai — báo xong khi chưa chạy test, bỏ sót một yêu cầu phụ, tin vào lời mình.
 * Claude Code dùng một lượt kiểm tra riêng với ngữ cảnh SẠCH: chỉ thấy yêu cầu gốc + kết quả, KHÔNG thấy lập luận của agent chính.
 * Ở đây: một RunExtension gắn vào móc `finalize` — khi model chính định kết thúc lượt mà đủ điều kiện, khởi một agent con
 * (tái dùng `agents/runner.ts`) với bộ công cụ CHỈ ĐỌC + `run_command` CHỈ cho lệnh kiểm chứng + công cụ `submit_verdict` để nộp kết luận
 * (đọc từ đối số công cụ, không parse chữ). Kết luận không đạt → buộc model chính xử lý hết rồi mới báo xong (tối đa `maxRounds` vòng);
 * hết vòng mà còn tồn → chấp nhận NHƯNG báo trung thực danh sách tồn đọng cho người dùng. Agent kiểm tra lỗi/hết giờ → không bao giờ chặn người dùng.
 *
 * Tệp này không import `vscode` hay `node:*` (dùng được ở mọi bề mặt). Mọi thứ phụ thuộc môi trường đi qua `ToolHost` / `VerifierDeps`.
 */

import verifierPrompt from '../prompts/verifier.md';
import type { TodoItem, UiEvent, VerifyInfo } from '../../shared/protocol';
import { runSubAgent, type AgentServices } from '../agents/runner';
import type { AgentDef } from '../agents/definitions';
import { isReadOnlyCommand } from '../tools/terminal';
import type { ContentBlock, ThinkingLevel } from '../types';
import type { FinalizeContext, FinalizeDecision, RunExtension, RunScope, RunTrace, TraceCall } from './seams';
import { t, type Lang } from './strings';
import { ToolRegistry } from './toolRegistry';
import type { SessionState, ToolContext, ToolDef, ToolHost } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Cài đặt & hằng
// ─────────────────────────────────────────────────────────────────────────────

export type VerifyMode = 'off' | 'auto' | 'always';

export interface VerifierSettings {
  mode: VerifyMode;
  /** "provider:model" cố định cho agent kiểm tra; rỗng = cùng model chính. */
  model?: string;
  /** Số vòng kiểm tra tối đa trong một lần chạy (mặc định 2). */
  maxRounds?: number;
}

export const VERIFY_MAX_ROUNDS = 2;
export const VERIFY_MAX_TURNS = 25;
export const VERIFY_TIMEOUT_MS = 4 * 60_000;

/** Giới hạn độ lớn gói dữ liệu gửi agent kiểm tra (ký tự). */
const BUNDLE_CAP = 48_000;
const FILE_HEAD_LINES = 80;
const FILE_HEAD_CHARS = 4000;
const EDIT_SIDE_CHARS = 1500;
const CMD_TAIL_LINES = 40;
const CMD_TAIL_CHARS = 3000;
const LIST_CAP = 12;
const ITEM_CAP = 400;

const THINKING_RANK: Record<ThinkingLevel, number> = { off: 0, low: 1, medium: 2, high: 3, max: 4, swarm: 5 };
/** Công cụ tạo artifact (tài liệu) — không phải thay đổi mã nguồn cần kiểm chứng. */
const ARTIFACT_TOOLS = new Set(['create_artifact', 'update_artifact', 'list_artifact_types']);
/** Công cụ chỉ đọc mà agent kiểm tra được dùng (nếu kho chính có). */
const VERIFIER_READ_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'get_diagnostics', 'scratchpad'];

export function normalizeMode(v: unknown): VerifyMode {
  return v === 'off' || v === 'always' ? v : 'auto';
}

// ─────────────────────────────────────────────────────────────────────────────
// isVerificationCommand — danh sách cho phép DƯƠNG, tất định
// ─────────────────────────────────────────────────────────────────────────────

/** Ký tự điều khiển shell / dấu nháy / xuống dòng: có là KHÔNG hợp lệ (không ghép lệnh, không chuyển hướng, không nháy). */
const META = /[;&|<>`$\r\n(){}'"\\\u0085\u2018-\u201F\u2028\u2029\uFF1B\uFF06\uFF5C]/;
/** Một đối số/cờ an toàn: không khoảng trắng (đã tách), chỉ ký tự tên tệp/cờ thông thường. */
const ARG = /^-{0,2}[\w.@:/+,=\u00C0-\u1EF9-]*$/;
/** Cờ ghi/tương tác/không-dừng: cấm dù lệnh gốc là kiểm chứng (ghi snapshot, sửa tệp, watch, in kết quả ra tệp…). */
const DENY_FLAG = /^-{1,2}(fix|fix-dry-run|write|w|u|update|update-snapshot|updatesnapshot|watch|watchall|o|out|outdir|outfile|output|output-file|init|install|i|exec|e|eval|print|require|r|import|loader|inspect|inspect-brk|save|save-dev|D|g|global|force|f|reporter-options|update-snapshots|apply|apply-unsafe|ui|headed|debug|open|codegen|interactive|delete|move|copy|set-upstream|set-upstream-to|unset-upstream|basetemp|outputfile|output-dir|outputdir|cache-location|junitxml|resultlog|log-file)(=.*)?$/i;
/** Cờ ghi báo cáo/độ phủ ra thư mục tuỳ ý: so theo TIỀN TỐ (`--coverage.reportsDirectory=…`, `--report-dir`…). (lane:blind-verifier) */
const DENY_PREFIX = /^-{1,2}(coverage[.-](reports?[-_]?directory|directory|dir|output)|reports?[-_]?(dir|directory|file|path)|out(put)?[-_.]?(dir|file|path))/i;
/** Hậu tố của tên script npm (`lint:fix`, `test:update`…) cho thấy script GHI/sửa/chạy dài, không phải kiểm chứng. */
const SCRIPT_WRITE_SEGMENT = /^(fix|fixes|update|updates|u|write|watch|serve|dev|start|deploy|publish|release|clean|install|open|codegen|format|apply|snapshot|snapshots|ui|migrate|generate|gen)$/;
/** `npx playwright|cypress` chỉ hợp lệ khi chạy bộ kiểm thử (không install / open / codegen / show-report…). */
const RUNNER_SUBCOMMAND: Record<string, string> = { playwright: 'test', cypress: 'run' };

/** Lệnh gốc + "động từ" đầu tiên phải khớp MỘT trong các mẫu này (so trên 1–3 token đầu, chữ thường). */
const HEADS: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|typecheck|type-check|lint|build|check|compile|verify|validate|tsc|vitest|jest|coverage|ci|e2e|test:[\w:-]+|build:[\w:-]+|lint:[\w:-]+|check:[\w:-]+|typecheck:[\w:-]+)$/,
  /^(npm|pnpm|yarn|bun)\s+(test|t)$/,
  /^npx\s+(vitest|jest|mocha|tsc|eslint|prettier|biome|stylelint|playwright|cypress|ava|tap|uvu|karma|tsd|knip|madge|depcheck|typescript)$/,
  /^(bunx|pnpx)\s+(vitest|jest|mocha|tsc|eslint|prettier|biome|playwright)$/,
  /^(tsc|eslint|prettier|biome|vitest|jest|mocha|pytest|mypy|pyright|ruff|flake8|black|isort|pylint|rubocop|rspec|phpunit|golangci-lint|clippy|ktlint|detekt|swiftlint|shellcheck|hadolint|markdownlint|stylelint)$/,
  /^node\s+(--test|--check|-c)$/,
  /^(python3?|py)\s+-m\s+(pytest|unittest|mypy|ruff|flake8|black|isort|pylint|compileall|py_compile|tox|nox)$/,
  /^go\s+(test|build|vet|fmt)$/,
  /^cargo\s+(test|build|check|clippy|fmt)$/,
  /^dotnet\s+(test|build)$/,
  /^(mvn|mvnw|\.\/mvnw)\s+(test|verify|compile|validate)$/,
  /^(gradle|gradlew|\.\/gradlew)\s+(test|build|check|assemble|lint)$/,
  /^make\s+(test|tests|check|build|lint|typecheck|verify)$/,
  /^make$/,
  /^(swift|dart|flutter|mix|composer|bundle)\s+(test|build|analyze|compile)$/,
  /^(bundle\s+exec\s+rspec)$/,
  /^(deno)\s+(test|check|lint|fmt)$/,
  // `git branch` KHÔNG ở đây: chỉ dạng liệt kê (isReadOnlyCommand) mới chỉ-đọc; `git branch x` / --delete / --move đổi kho.
  /^git\s+(status|diff|log|show|rev-parse|ls-files)$/,
];

/** Cờ chỉ hợp lệ khi lệnh gốc là `prettier`/`black`/`isort`/`ruff`/`cargo fmt`/`go fmt`/`deno fmt`… (phải là kiểm tra, không ghi). */
const FORMATTERS = /^(npx\s+)?(prettier|black|isort|biome|ruff|rubocop|gofmt|cargo\s+fmt|go\s+fmt|deno\s+fmt|dart\s+format|swift\s+format)\b/;
const FORMAT_CHECK = /(^|\s)(--check|--dry-run|--diff|-l|--list-different|-n|check)(\s|$)/;

/**
 * Lệnh có phải là lệnh KIỂM CHỨNG không (test / typecheck / build / lint / git status|diff|log). Tất định, không gọi ra ngoài.
 * Không có ký tự điều khiển shell (nên `npm test && rm -rf x` KHÔNG hợp lệ), không cờ ghi/sửa/watch, mỗi đối số chỉ gồm ký tự tên tệp thông thường.
 */
export function isVerificationCommand(command: string): boolean {
  const c = String(command ?? '').trim();
  if (!c || c.length > 400 || META.test(c)) return false;
  if (/[^\x20-\x7E\u00C0-\u1EF9]/.test(c)) return false; // ký tự điều khiển / vô hình (Trojan Source)
  if (isReadOnlyCommand(c)) return /^git\s/.test(c); // git status/diff/log… theo danh sách chỉ-đọc sẵn có
  const tokens = c.split(/\s+/);
  const lower = tokens.map((x) => x.toLowerCase());
  let head = -1;
  for (const n of [3, 2, 1]) {
    if (tokens.length < n) continue;
    const h = lower.slice(0, n).join(' ');
    if (HEADS.some((re) => re.test(h))) {
      head = n;
      break;
    }
  }
  if (head < 0) return false;
  for (const a of tokens.slice(head)) {
    if (a === '--') continue; // `npm test -- <đối số>` hợp lệ
    if (!ARG.test(a) || DENY_FLAG.test(a) || DENY_PREFIX.test(a)) return false;
    if (/(^|[=/])\.\.([/\\]|$)/.test(a)) return false; // không trỏ ra ngoài thư mục làm việc
  }
  // npm script có hậu tố ghi/sửa (`lint:fix`, `test:update`, `build:watch`…) KHÔNG phải kiểm chứng.
  if (/^(npm|pnpm|yarn|bun)$/.test(lower[0]) && head > 1) {
    const script = lower.slice(1, head).filter((x) => x !== 'run').join(' ');
    if (script.split(/[:\-_]/).slice(1).some((seg) => SCRIPT_WRITE_SEGMENT.test(seg))) return false;
  }
  // playwright / cypress: chỉ bộ lệnh chạy kiểm thử.
  const runner = lower.find((x, i) => i <= 2 && Object.prototype.hasOwnProperty.call(RUNNER_SUBCOMMAND, x));
  if (runner && lower[lower.indexOf(runner) + 1] !== RUNNER_SUBCOMMAND[runner]) return false;
  // git: chỉ các dạng chỉ-đọc + đường dẫn; cấm mọi cờ ghi (-m, --amend, …) — đã lọc bởi DENY_FLAG và ARG; thêm chặn `git log -p` quá dài không cần.
  if (lower[0] === 'git' && tokens.slice(head).some((a) => /^-{1,2}(amend|m|message|all|no-verify|signoff|interactive|patch|p)$/.test(a))) return false;
  // Trình định dạng chỉ được chạy ở chế độ KIỂM TRA.
  if (FORMATTERS.test(c) && !FORMAT_CHECK.test(c)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gói dữ liệu cho agent kiểm tra (chỉ sự thật, không có lập luận)
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangeEntry {
  path: string;
  /** write = tạo/ghi đè (có đầu tệp) · edit = thay chuỗi (có cũ → mới) · other = công cụ ghi khác (đối số rút gọn). */
  kind: 'write' | 'edit' | 'other';
  tool: string;
  text?: string;
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
}

export interface CommandEntry {
  command: string;
  cwd?: string;
  exitCode: number | null;
  ok: boolean;
  tail: string;
}

export interface VerifyBundle {
  /** Yêu cầu của người dùng trong lần chạy này, NGUYÊN VĂN, theo thứ tự (kể cả tin chen giữa / xếp hàng). */
  requests: string[];
  changes: ChangeEntry[];
  commands: CommandEntry[];
  todos: Pick<TodoItem, 'title' | 'status'>[];
  finalAnswer: string;
  /** Khoá "lệnh + cwd" đã chạy thật ở luồng chính: agent kiểm tra chạy lại đúng lệnh đó không phải hỏi quyền lần nữa. */
  ranByMain: string[];
}

const STEER_HEADER = /^\[(Người dùng vừa gửi thêm|The user sent)\b/;
const STEER_ITEM = /^\[(Việc mới|New task) \d+\/\d+\]$/;

function headOf(text: string, lines: number, chars: number): string {
  const ls = text.split(/\r?\n/);
  let out = ls.slice(0, lines).join('\n');
  if (out.length > chars) out = out.slice(0, chars);
  const cut = ls.length > lines || out.length < text.length;
  return cut ? `${out}\n… [cắt: tệp dài ${ls.length} dòng, ${text.length} ký tự]` : out;
}

function tailOf(text: string, lines: number, chars: number): string {
  const ls = text.split(/\r?\n/);
  let out = ls.slice(-lines).join('\n');
  if (out.length > chars) out = out.slice(out.length - chars);
  const cut = ls.length > lines || out.length < text.length;
  return cut ? `… [đầu ra dài ${ls.length} dòng, chỉ giữ phần cuối]\n${out}` : out;
}

function sideOf(text: unknown): string {
  const s = typeof text === 'string' ? text : '';
  return s.length > EDIT_SIDE_CHARS ? `${s.slice(0, EDIT_SIDE_CHARS)}\n… [+${s.length - EDIT_SIDE_CHARS} ký tự]` : s;
}

export function commandKey(command: unknown, cwd: unknown): string {
  return `${String(cwd ?? '.').trim() || '.'}::${String(command ?? '').replace(/\s+/g, ' ').trim()}`;
}

function parseExit(content: string): number | null {
  const m = /^Mã thoát:\s*(-?\d+)/m.exec(content) ?? /^Exit code:\s*(-?\d+)/m.exec(content);
  return m ? Number(m[1]) : null;
}

/** Tin người dùng (không tổng hợp) trong phạm vi lần chạy → danh sách chữ nguyên văn. */
export function collectRequests(messages: readonly { role: string; content: ContentBlock[]; synthetic?: boolean }[], startIdx: number, input: readonly ContentBlock[]): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.trim();
    if (v && !out.includes(v)) out.push(v);
  };
  for (const b of input) if (b.type === 'text' && !b.volatile) push(b.text);
  for (let i = Math.max(0, startIdx + 1); i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user' || m.synthetic) continue;
    const hasResults = m.content.some((b) => b.type === 'tool_result');
    const texts = m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text' && !b.volatile);
    if (hasResults) {
      // Tin chen giữa (steer): chỉ nhận chữ nếu có đúng tiêu đề của harness, và bỏ tiêu đề/nhãn mục.
      if (!texts.some((b) => STEER_HEADER.test(b.text.trim()))) continue;
      for (const b of texts) if (!STEER_HEADER.test(b.text.trim()) && !STEER_ITEM.test(b.text.trim())) push(b.text);
    } else {
      for (const b of texts) push(b.text);
    }
  }
  return out;
}

/** Công cụ uỷ quyền: agent con / workflow có thể đã sửa tệp mà luồng chính không thấy từng tệp (lane:blind-verifier). */
const DELEGATING_TOOLS = new Set(['agent', 'workflow_run']);

export function collectChanges(calls: readonly TraceCall[]): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  for (const c of calls) {
    if (DELEGATING_TOOLS.has(c.name) && c.ok) {
      const task = typeof c.input.prompt === 'string' ? c.input.prompt : typeof c.input.name === 'string' ? c.input.name : '';
      out.push({
        path: `(${c.name})`,
        kind: 'other',
        tool: c.name,
        text: `Delegated work — the list of files it changed is NOT available here; run git status / git diff and read them yourself.\nTask: ${task.slice(0, 400)}\nResult head: ${c.resultHead.slice(0, 600)}`,
      });
      continue;
    }
    if (c.risk !== 'write' || !c.ok || ARTIFACT_TOOLS.has(c.name)) continue;
    const path = typeof c.input.path === 'string' ? c.input.path : '';
    if (c.name === 'write_file') out.push({ path, kind: 'write', tool: c.name, text: headOf(String(c.input.content ?? ''), FILE_HEAD_LINES, FILE_HEAD_CHARS) });
    else if (c.name === 'edit_file') out.push({ path, kind: 'edit', tool: c.name, oldText: sideOf(c.input.old_string), newText: sideOf(c.input.new_string), ...(c.input.replace_all === true ? { replaceAll: true } : {}) });
    else {
      let s: string;
      try {
        s = JSON.stringify(c.input) ?? '';
      } catch {
        s = String(c.input);
      }
      out.push({ path: path || `(${c.name})`, kind: 'other', tool: c.name, text: s.length > 800 ? `${s.slice(0, 800)}…` : s });
    }
  }
  return out;
}

export function collectCommands(calls: readonly TraceCall[], outputs: ReadonlyMap<string, string>): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const c of calls) {
    if (c.name !== 'run_command') continue;
    const full = outputs.get(c.callId) ?? c.resultHead;
    const exitCode = parseExit(full);
    out.push({
      command: String(c.input.command ?? ''),
      ...(typeof c.input.cwd === 'string' && c.input.cwd ? { cwd: c.input.cwd } : {}),
      exitCode,
      ok: c.ok,
      tail: tailOf(full.replace(/^(Mã thoát|Exit code):.*\n?/m, '').trim(), CMD_TAIL_LINES, CMD_TAIL_CHARS),
    });
  }
  return out;
}

export function buildBundle(o: { session: SessionState; input: readonly ContentBlock[]; startIdx: number; trace: RunTrace; outputs: ReadonlyMap<string, string>; finalAnswer: string }): VerifyBundle {
  const ranByMain: string[] = [];
  for (const c of o.trace.calls) {
    if (c.name !== 'run_command') continue;
    if (!(c.ok || /^(Mã thoát|Exit code):/.test(c.resultHead))) continue;
    const k = commandKey(c.input.command, c.input.cwd);
    if (!ranByMain.includes(k)) ranByMain.push(k);
  }
  return {
    requests: collectRequests(o.session.messages, o.startIdx, o.input),
    changes: collectChanges(o.trace.calls),
    commands: collectCommands(o.trace.calls, o.outputs),
    todos: o.session.todos.map((x) => ({ title: x.title, status: x.status })),
    finalAnswer: o.finalAnswer,
    ranByMain,
  };
}

/** Văn bản nhiệm vụ cho agent kiểm tra: CHỈ dữ liệu trong gói (không khối suy luận, không lịch sử). Tiếng Anh gọn; mục kết luận theo ngôn ngữ phiên. */
export function buildVerifierTask(b: VerifyBundle, lang: Lang, platform?: ToolHost['platform']): string {
  const parts: string[] = [];
  parts.push(`Write every item of your verdict in ${lang === 'vi' ? 'Vietnamese' : 'English'} (the user reads them). Keep tool calls efficient.`);
  if (platform) parts.push(`Shell for run_command: ${platform.shellLabel} on ${platform.os}. Only verification commands are allowed (tests / typecheck / build / lint / git status|diff|log); anything else is rejected.`);
  parts.push('<user_requests>\n' + (b.requests.length ? b.requests.map((r, i) => `[${i + 1}] ${r}`).join('\n\n') : '(none captured)') + '\n</user_requests>');
  let budget = BUNDLE_CAP;
  const changes: string[] = [];
  for (const c of b.changes) {
    let s: string;
    if (c.kind === 'write') s = `### ${c.path} (${c.tool} — created or overwritten; file head)\n${c.text ?? ''}`;
    else if (c.kind === 'edit') s = `### ${c.path} (edit_file${c.replaceAll ? ', replace_all' : ''})\n--- old\n${c.oldText ?? ''}\n--- new\n${c.newText ?? ''}`;
    else s = `### ${c.path} (${c.tool})\n${c.text ?? ''}`;
    if (s.length > budget) {
      changes.push(`### ${c.path} (${c.tool}) — omitted: bundle size limit; read the file yourself`);
      continue;
    }
    budget -= s.length;
    changes.push(s);
  }
  parts.push('<changed_files>\n' + (changes.length ? changes.join('\n\n') : '(no files changed in this run)') + '\n</changed_files>');
  const cmds = b.commands.map((c, i) => `[${i + 1}] $ ${c.command}${c.cwd ? `   (cwd: ${c.cwd})` : ''}\nexit: ${c.exitCode ?? 'unknown'}${c.ok ? '' : ' (reported as error)'}\n${c.tail || '(no output)'}`);
  parts.push('<commands_run>\n' + (cmds.length ? cmds.join('\n\n') : '(no commands were run — nothing was verified by the worker)') + '\n</commands_run>');
  parts.push('<task_list>\n' + (b.todos.length ? b.todos.map((x) => `- [${x.status}] ${x.title}`).join('\n') : '(empty)') + '\n</task_list>');
  parts.push('<worker_final_answer>\n' + (b.finalAnswer || '(empty)') + '\n</worker_final_answer>');
  parts.push('Now verify. Run the relevant verification commands yourself when possible, read what matters, then call submit_verdict once.');
  return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Kết luận (submit_verdict) & bộ công cụ của agent kiểm tra
// ─────────────────────────────────────────────────────────────────────────────

export interface Verdict {
  verdict: 'pass' | 'fail' | 'uncertain';
  missing: string[];
  defects: string[];
  unverifiedClaims: string[];
  summary?: string;
}

function cleanList(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const v of x) {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (!s || out.includes(s)) continue;
    out.push(s.length > ITEM_CAP ? `${s.slice(0, ITEM_CAP - 1)}…` : s);
    if (out.length >= LIST_CAP) break;
  }
  return out;
}

/** Chuẩn hoá kết luận: `pass` mà còn mục thiếu/lỗi thì hạ thành `fail` (máy quyết, không tin chữ). */
export function normalizeVerdict(input: unknown): Verdict {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const missing = cleanList(i.missing);
  const defects = cleanList(i.defects);
  const unverifiedClaims = cleanList(i.unverifiedClaims ?? i.unverified_claims ?? i.unverified);
  let verdict: Verdict['verdict'] = i.verdict === 'pass' || i.verdict === 'fail' || i.verdict === 'uncertain' ? i.verdict : 'uncertain';
  if (verdict === 'pass' && (missing.length || defects.length)) verdict = 'fail';
  if (verdict === 'pass' && unverifiedClaims.length) verdict = 'uncertain';
  if (verdict === 'uncertain' && (missing.length || defects.length)) verdict = 'fail';
  const summary = typeof i.summary === 'string' ? i.summary.replace(/\s+/g, ' ').trim().slice(0, 600) : undefined;
  return { verdict, missing, defects, unverifiedClaims, ...(summary ? { summary } : {}) };
}

/**
 * Có việc model chính LÀM ĐƯỢC không: chỉ khi có mục thiếu hoặc lỗi đã xác nhận. `unverifiedClaims` đơn thuần ("không chạy được test", "chưa thấy tệp")
 * là giới hạn của người kiểm tra, không phải việc để sửa — ép model chính xử lý chỉ đốt vòng và token (lane:blind-verifier).
 */
export function isActionable(v: Verdict): boolean {
  return v.missing.length + v.defects.length > 0 || (v.verdict === 'fail' && v.unverifiedClaims.length > 0);
}

export function createVerdictTool(onVerdict: (v: Verdict) => void): ToolDef {
  return {
    name: 'submit_verdict',
    description:
      'Submit your final verdict (call EXACTLY once, after you verified what you could). verdict: pass | fail | uncertain. ' +
      'missing: requirements not done. defects: confirmed bugs/errors (with evidence). unverifiedClaims: claims you could not confirm. ' +
      'Each item is ONE concrete sentence with evidence (path:line, command + exit code, or quoted requirement).',
    inputSchema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
        missing: { type: 'array', items: { type: 'string' } },
        defects: { type: 'array', items: { type: 'string' } },
        unverifiedClaims: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string', description: 'One sentence.' },
      },
      required: ['verdict'],
    },
    risk: 'meta',
    concurrencySafe: false,
    repeatExempt: true,
    async execute(input) {
      const v = normalizeVerdict(input);
      onVerdict(v);
      return { content: `Verdict recorded: ${v.verdict} (${v.missing.length} missing, ${v.defects.length} defects, ${v.unverifiedClaims.length} unverified). Reply with one short line and stop.`, summary: v.verdict };
    },
  };
}

/** `run_command` bị bọc: CHỈ lệnh kiểm chứng; lệnh luồng chính đã chạy (cùng lệnh + cwd) thì không hỏi quyền lại. */
export function guardRunCommand(base: ToolDef, ranByMain: ReadonlySet<string>): ToolDef {
  return {
    ...base,
    description: `${base.description} VERIFIER RESTRICTION: only verification commands are accepted (tests, typecheck, build, lint, git status/diff/log) with plain arguments — no shell operators, no write/fix/watch flags.`,
    async validate(input, ctx) {
      const cmd = typeof (input as { command?: unknown })?.command === 'string' ? (input as { command: string }).command : '';
      if (!isVerificationCommand(cmd)) return 'Rejected: the verifier may only run verification commands (test / typecheck / build / lint / git status|diff|log) without shell operators or write flags.';
      return base.validate ? base.validate(input, ctx) : null;
    },
    async permission(input, ctx) {
      const i = input as { command?: unknown; cwd?: unknown };
      if (ranByMain.has(commandKey(i.command, i.cwd))) return null;
      return base.permission ? base.permission(input, ctx) : null;
    },
  };
}

/** Kho công cụ của agent kiểm tra: chỉ đọc + run_command bị bọc + submit_verdict. */
export function createVerifierRegistry(source: ToolRegistry, ranByMain: ReadonlySet<string>, onVerdict: (v: Verdict) => void): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of VERIFIER_READ_TOOLS) {
    const d = source.get(name);
    if (d && (d.risk === 'read' || d.risk === 'meta')) reg.register(d);
  }
  const run = source.get('run_command');
  if (run) reg.register(guardRunCommand(run, ranByMain));
  reg.register(createVerdictTool(onVerdict));
  return reg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chạy agent kiểm tra
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifierAgentRequest {
  task: string;
  registry: ToolRegistry;
  ctx: ToolContext;
  /** "provider:model" cố định (rỗng = kế thừa phiên cha). */
  model?: string;
  maxTurns: number;
  lang: Lang;
}

export interface VerifierAgentResult {
  stopReason: string;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export type VerifierRunner = (req: VerifierAgentRequest) => Promise<VerifierAgentResult>;

export function verifierAgentDef(model: string | undefined, maxTurns: number, toolNames?: readonly string[]): AgentDef {
  return {
    name: 'verifier',
    description: 'Independent blind reviewer of the last run.',
    tier: 'inherit',
    ...(model && model.includes(':') ? { model } : {}),
    // Danh sách tên CỤ THỂ (kho của agent kiểm tra đã được thu hẹp): `'all'` rơi về bộ chỉ-đọc ở chế độ lập kế hoạch và làm mất `submit_verdict`.
    tools: toolNames ? [...toolNames] : 'all',
    maxTurns,
    thinking: 'high',
    prompt: verifierPrompt,
    source: 'builtin',
  };
}

/** Bộ chạy mặc định: tái dùng `runSubAgent` với dịch vụ agent của host, kho công cụ = kho của agent kiểm tra. */
export function runnerFromServices(svc: Omit<AgentServices, 'registry'>): VerifierRunner {
  return async (req) => {
    const services: AgentServices = { ...svc, registry: () => req.registry };
    const r = await runSubAgent(services, req.ctx, { def: verifierAgentDef(req.model, req.maxTurns, req.registry.all().map((d) => d.name)), prompt: req.task, label: 'verifier', maxTurns: req.maxTurns, maxChars: 4000 });
    return { stopReason: r.stopReason, error: r.error, inputTokens: r.inputTokens, outputTokens: r.outputTokens, model: r.model };
  };
}

export type VerifyOutcome =
  | { kind: 'verdict'; verdict: Verdict; durationMs: number; model: string; tokens: number }
  | { kind: 'skipped'; reason: 'error' | 'timeout' | 'aborted' | 'no_verdict' | 'no_model'; detail?: string; durationMs: number; tokens: number };

export interface VerifyRunOptions {
  bundle: VerifyBundle;
  registry: ToolRegistry;
  host: ToolHost;
  session: SessionState;
  signal: AbortSignal;
  emit(ev: UiEvent): void;
  assistantId: string;
  callId: string;
  lang: Lang;
  model?: string;
  run: VerifierRunner;
  maxTurns?: number;
  timeoutMs?: number;
}

/** Chạy MỘT lần kiểm tra trên gói dữ liệu: dựng kho công cụ, chạy agent, trả kết luận (hoặc lý do không kiểm tra được). Không ném. */
export async function runVerification(o: VerifyRunOptions): Promise<VerifyOutcome> {
  const started = Date.now();
  let verdict: Verdict | null = null;
  const ranByMain = new Set(o.bundle.ranByMain);
  const registry = createVerifierRegistry(o.registry, ranByMain, (v) => (verdict = v));
  // Hết giờ (4 phút) HOẶC người dùng Dừng → huỷ agent kiểm tra.
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = () => ac.abort();
  if (o.signal.aborted) ac.abort();
  else o.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, o.timeoutMs ?? VERIFY_TIMEOUT_MS);
  const ctx: ToolContext = {
    signal: ac.signal,
    session: o.session,
    host: o.host,
    callId: o.callId,
    assistantId: o.assistantId,
    emit: o.emit,
    progress: () => {},
    log: (l, m) => o.host.log(l, m),
  };
  let tokens = 0;
  try {
    const r = await o.run({ task: buildVerifierTask(o.bundle, o.lang, o.host.platform), registry, ctx, model: o.model, maxTurns: o.maxTurns ?? VERIFY_MAX_TURNS, lang: o.lang });
    tokens = r.inputTokens + r.outputTokens;
    const durationMs = Date.now() - started;
    if (verdict) return { kind: 'verdict', verdict, durationMs, model: r.model, tokens };
    if (o.signal.aborted) return { kind: 'skipped', reason: 'aborted', durationMs, tokens };
    if (timedOut) return { kind: 'skipped', reason: 'timeout', durationMs, tokens };
    if (r.stopReason === 'error' && /không có model|no model/i.test(r.error ?? '')) return { kind: 'skipped', reason: 'no_model', detail: r.error, durationMs, tokens };
    if (r.stopReason === 'error') return { kind: 'skipped', reason: 'error', detail: r.error, durationMs, tokens };
    return { kind: 'skipped', reason: 'no_verdict', detail: r.error, durationMs, tokens };
  } catch (err) {
    const durationMs = Date.now() - started;
    if (o.signal.aborted) return { kind: 'skipped', reason: 'aborted', durationMs, tokens };
    if (timedOut) return { kind: 'skipped', reason: 'timeout', durationMs, tokens };
    return { kind: 'skipped', reason: 'error', detail: err instanceof Error ? err.message : String(err), durationMs, tokens };
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener('abort', onAbort);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Điều kiện kích hoạt & thông điệp
// ─────────────────────────────────────────────────────────────────────────────

export interface TriggerInput {
  mode: VerifyMode;
  trace: Pick<RunTrace, 'turns' | 'execs' | 'calls'>;
  thinkingLevel: ThinkingLevel;
  sessionMode: SessionState['mode'];
  stop: FinalizeContext['stop'];
  aborted: boolean;
  wrapUp: boolean;
  /** Lệnh /verify: bỏ qua điều kiện tự động (vẫn tôn trọng off/Dừng/hết vòng). */
  force?: boolean;
}

export function shouldVerify(i: TriggerInput): boolean {
  if (i.mode === 'off') return false;
  if (i.aborted || i.wrapUp) return false;
  if (i.stop !== 'end_turn') return false;
  if (i.sessionMode === 'plan') return false;
  if (i.mode === 'always' || i.force) return true;
  if (THINKING_RANK[i.thinkingLevel] < THINKING_RANK.medium) return false;
  const wrote = i.trace.calls.some((c) => c.ok && ((c.risk === 'write' && !ARTIFACT_TOOLS.has(c.name)) || DELEGATING_TOOLS.has(c.name)));
  if (wrote) return true;
  return i.trace.execs >= 3 && i.trace.turns >= 4;
}

function sections(v: Verdict, lang: Lang): string {
  const out: string[] = [];
  let n = 0;
  const add = (title: string, items: string[]) => {
    if (!items.length) return;
    out.push(`${title}:`);
    for (const it of items) out.push(`${++n}. ${it}`);
  };
  add(t(lang, 'verifySectionMissing'), v.missing);
  add(t(lang, 'verifySectionDefects'), v.defects);
  add(t(lang, 'verifySectionUnverified'), v.unverifiedClaims);
  return out.join('\n');
}

/** Tin tổng hợp gửi lại cho model chính (đánh số từng mục, nêu bằng chứng của agent kiểm tra). */
export function feedbackMessage(v: Verdict, round: number, max: number, lang: Lang): string {
  const head = t(lang, 'verifyFeedbackHead', { round, max, verdict: v.verdict === 'fail' ? t(lang, 'verifyFeedbackVerdictFail') : t(lang, 'verifyFeedbackVerdictUncertain') });
  return `${head}\n${sections(v, lang)}`;
}

export function skipReasonText(reason: Extract<VerifyOutcome, { kind: 'skipped' }>['reason'], lang: Lang): string {
  switch (reason) {
    case 'timeout':
      return t(lang, 'verifyReasonTimeout');
    case 'aborted':
      return t(lang, 'verifyReasonAborted');
    case 'no_verdict':
      return t(lang, 'verifyReasonNoVerdict');
    case 'no_model':
      return t(lang, 'verifyReasonNoModel');
    default:
      return t(lang, 'verifyReasonError');
  }
}

/** Sự kiện `notice` mang kết quả (chữ đủ ý cho Remote cũ + `verify` có cấu trúc cho giao diện mới). */
export function verifyNotice(o: { id?: string; key: string; round: number; maxRounds: number; outcome: VerifyOutcome | 'running'; outstanding?: boolean; lang: Lang }): UiEvent {
  const base = { key: o.key, round: o.round, maxRounds: o.maxRounds };
  const idPart = o.id ? { id: o.id } : {};
  if (o.outcome === 'running') return { t: 'notice', ...idPart, level: 'info', text: t(o.lang, 'verifyRunning', { round: o.round, max: o.maxRounds }), verify: { ...base, state: 'running' } };
  if (o.outcome.kind === 'skipped') {
    const reason = skipReasonText(o.outcome.reason, o.lang);
    return { t: 'notice', ...idPart, level: 'info', text: t(o.lang, 'verifySkipped', { reason }), verify: { ...base, state: 'skipped', reason, durationMs: o.outcome.durationMs, tokens: o.outcome.tokens } };
  }
  const v = o.outcome.verdict;
  const n = v.missing.length + v.defects.length + v.unverifiedClaims.length;
  const info: VerifyInfo = {
    ...base,
    state: v.verdict,
    ...(v.missing.length ? { missing: v.missing } : {}),
    ...(v.defects.length ? { defects: v.defects } : {}),
    ...(v.unverifiedClaims.length ? { unverifiedClaims: v.unverifiedClaims } : {}),
    ...(o.outstanding ? { outstanding: true } : {}),
    durationMs: o.outcome.durationMs,
    model: o.outcome.model,
    tokens: o.outcome.tokens,
  };
  if (v.verdict === 'pass') return { t: 'notice', ...idPart, level: 'info', text: t(o.lang, 'verifyPass'), verify: info };
  const list = n ? `\n${sections(v, o.lang)}` : '';
  if (o.outstanding) return { t: 'notice', ...idPart, level: 'warn', text: `${t(o.lang, 'verifyOutstanding', { n, rounds: o.round })}${list}`, verify: info };
  if (v.verdict === 'fail') return { t: 'notice', ...idPart, level: 'warn', text: `${t(o.lang, 'verifyFail', { n })}${list}`, verify: info };
  return { t: 'notice', ...idPart, level: 'warn', text: `${t(o.lang, 'verifyUncertain', { n })}${list}`, verify: info };
}

// ─────────────────────────────────────────────────────────────────────────────
// RunExtension
// ─────────────────────────────────────────────────────────────────────────────

/** Gói dữ liệu + ngữ cảnh của lần chạy gần nhất (để lệnh /verify chạy tay). */
export interface LastRun {
  sessionId: string;
  bundle: VerifyBundle;
  lang: Lang;
  at: number;
  /** Lý do kết thúc lần chạy (end_turn / aborted / error / max_turns…). Khác 'end_turn' = lần chạy dừng giữa chừng. */
  stopReason?: string;
}

/** Chữ của tin trợ lý CUỐI sau vị trí `startIdx` (lần chạy không tới finalize thì dùng cái này làm "câu trả lời cuối"). */
function lastAssistantText(messages: readonly { role: string; content: ContentBlock[] }[], startIdx: number): string {
  for (let i = messages.length - 1; i > startIdx; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const txt = m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (txt) return txt;
  }
  return '';
}

export interface VerifierDeps {
  settings(): VerifierSettings;
  /** Kho công cụ của luồng chính (nguồn cho bộ công cụ chỉ-đọc của agent kiểm tra). */
  registry(): ToolRegistry;
  run: VerifierRunner;
  /** Gọi mỗi khi một lần chạy có gói dữ liệu (kể cả khi không kích hoạt kiểm tra tự động). */
  onLastRun?(last: LastRun): void;
  /** Đang có một kiểm tra khác chạy (ví dụ /verify) → không chạy chồng. */
  busy?(): boolean;
  /** Ghi đè trần (kiểm thử). */
  maxTurns?: number;
  timeoutMs?: number;
}

let verifySeq = 0;

/**
 * Extension 'verifier'. Trạng thái của MỘT lần chạy nằm trong closure: số vòng đã kiểm tra, đầu ra lệnh đã chạy, vị trí tin mở đầu.
 * Tin xếp hàng mở lượt kế tiếp (`queuedTurn`) → đặt lại số vòng. Không đệ quy: agent kiểm tra chạy bằng engine con KHÔNG có extension này
 * (runSubAgent chỉ dùng extension dùng chung), và trong lúc một kiểm tra đang chạy `begin()` của mọi lần chạy khác trả về null.
 */
export function createVerifierExtension(deps: VerifierDeps): RunExtension {
  let running = false;
  return {
    id: 'verifier',
    begin(scope: RunScope) {
      if (running || deps.busy?.()) return null;
      const startIdx = scope.session.messages.length - 1;
      const outputs = new Map<string, string>();
      let rounds = 0;
      const decide = async (ctx: FinalizeContext): Promise<FinalizeDecision> => {
        const s = deps.settings();
        const maxRounds = Math.max(1, Math.min(4, s.maxRounds ?? VERIFY_MAX_ROUNDS));
        const bundle = buildBundle({ session: scope.session, input: scope.input, startIdx, trace: scope.trace, outputs, finalAnswer: ctx.text });
        if (s.mode !== 'off' && !ctx.aborted) deps.onLastRun?.({ sessionId: scope.session.id, bundle, lang: scope.lang, at: Date.now() });
        if (rounds >= maxRounds) return { action: 'accept' };
        const trigger: TriggerInput = { mode: s.mode, trace: scope.trace, thinkingLevel: scope.session.thinkingLevel, sessionMode: scope.session.mode, stop: ctx.stop, aborted: ctx.aborted, wrapUp: ctx.turn.wrapUp };
        if (!shouldVerify(trigger)) return { action: 'accept' };
        rounds++;
        const key = `v${++verifySeq}`;
        const id = scope.assistantId();
        scope.emit(verifyNotice({ id, key, round: rounds, maxRounds, outcome: 'running', lang: scope.lang }));
        running = true;
        let outcome: VerifyOutcome;
        try {
          outcome = await runVerification({
            bundle,
            registry: deps.registry(),
            host: scope.host,
            session: scope.session,
            signal: scope.signal,
            emit: scope.emit,
            assistantId: id,
            callId: `verify:${key}`,
            lang: scope.lang,
            model: s.model,
            run: deps.run,
            maxTurns: deps.maxTurns,
            timeoutMs: deps.timeoutMs,
          });
        } finally {
          running = false;
        }
        // Chi phí token của kiểm tra tính vào usage phiên (không gộp vào số của lượt trả lời để khỏi lẫn với model chính).
        if (outcome.tokens > 0) {
          scope.session.usageTotals.input += Math.max(0, outcome.tokens);
        }
        if (outcome.kind === 'skipped') {
          scope.emit(verifyNotice({ id, key, round: rounds, maxRounds, outcome, lang: scope.lang }));
          return { action: 'accept' };
        }
        const v = outcome.verdict;
        if (v.verdict === 'pass' || !isActionable(v)) {
          scope.emit(verifyNotice({ id, key, round: rounds, maxRounds, outcome, lang: scope.lang }));
          return { action: 'accept' };
        }
        if (rounds < maxRounds && !scope.signal.aborted) {
          scope.emit(verifyNotice({ id, key, round: rounds, maxRounds, outcome, lang: scope.lang }));
          return { action: 'continue', message: feedbackMessage(v, rounds, maxRounds, scope.lang), reason: 'verify' };
        }
        // Hết vòng mà còn tồn: chấp nhận nhưng nói thật với người dùng.
        scope.emit(verifyNotice({ id, key, round: rounds, maxRounds, outcome, outstanding: true, lang: scope.lang }));
        return { action: 'accept' };
      };
      return {
        toolAfter(call, _def, _ctx, result) {
          if (call.name === 'run_command') outputs.set(call.id, result.content.length > 12_000 ? result.content.slice(result.content.length - 12_000) : result.content);
        },
        queuedTurn() {
          rounds = 0;
        },
        finalize: decide,
        // Mọi đường thoát (Dừng / lỗi / hết vòng / từ chối) cũng ghi gói dữ liệu → `/verify` không kiểm tra nhầm lần chạy TRƯỚC (lane:blind-verifier).
        end(info) {
          if (deps.settings().mode === 'off') return;
          const bundle = buildBundle({ session: scope.session, input: scope.input, startIdx, trace: scope.trace, outputs, finalAnswer: lastAssistantText(scope.session.messages, startIdx) });
          deps.onLastRun?.({ sessionId: scope.session.id, bundle, lang: scope.lang, at: Date.now(), stopReason: info.stopReason });
        },
      };
    },
  };
}
