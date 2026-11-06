/**
 * Chọn shell và dựng lệnh chạy cho từng hệ điều hành.
 *
 * Lưu ý riêng cho tiếng Việt trên Windows: cmd/PowerShell mặc định xuất theo code page OEM (CP 1258/850/437),
 * nên tên tệp và thông báo có dấu bị vỡ nếu giải mã UTF-8. Ta ép UTF-8 ở đầu mỗi lệnh.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type ShellKind = 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh' | 'sh';

export interface ShellInfo {
  kind: ShellKind;
  file: string;
  /** Mô tả cho model: "PowerShell 7 (pwsh)", "Windows PowerShell 5.1", "bash"… */
  label: string;
}

function findOnPath(names: string[]): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* thử tiếp */
      }
    }
  }
  return undefined;
}

export function detectShell(preference: string = 'auto', platform: NodeJS.Platform = process.platform): ShellInfo {
  const win = platform === 'win32';
  const pref = preference === 'auto' ? undefined : (preference as ShellKind);

  if (win) {
    if (pref === 'cmd') return { kind: 'cmd', file: process.env.ComSpec ?? 'cmd.exe', label: 'cmd.exe' };
    if (pref === 'pwsh' || pref === undefined) {
      const pwsh = findOnPath(['pwsh.exe']);
      if (pwsh) return { kind: 'pwsh', file: pwsh, label: 'PowerShell 7+ (pwsh)' };
    }
    if (pref === 'bash') {
      const bash = findOnPath(['bash.exe']);
      if (bash) return { kind: 'bash', file: bash, label: 'bash (Git Bash/WSL)' };
    }
    return { kind: 'powershell', file: 'powershell.exe', label: 'Windows PowerShell 5.1' };
  }

  const candidates: ShellKind[] = pref && pref !== 'powershell' && pref !== 'cmd' && pref !== 'pwsh' ? [pref] : [];
  const envShell = path.basename(process.env.SHELL ?? '');
  if (envShell === 'zsh' || envShell === 'bash') candidates.push(envShell);
  candidates.push('bash', 'sh');
  for (const k of candidates) {
    for (const dir of ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
      const f = path.join(dir, k);
      if (fs.existsSync(f)) return { kind: k, file: f, label: k };
    }
  }
  return { kind: 'sh', file: '/bin/sh', label: 'sh' };
}

export interface SpawnSpec {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** Tệp tạm cần xoá sau khi chạy xong. */
  cleanup?: string;
}

/** Dấu thứ tự byte UTF-8: PowerShell 5.1 chỉ đọc đúng tiếng Việt trong tệp .ps1 khi có nó. Viết bằng mã số để mã nguồn không chứa ký tự ẩn. */
const UTF8_BOM = String.fromCharCode(0xfeff);

const PS_PREAMBLE =
  "$ErrorActionPreference = 'Continue'; $ProgressPreference = 'SilentlyContinue'; " +
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding } catch {}';

export function buildSpawn(shell: ShellInfo, command: string): SpawnSpec {
  switch (shell.kind) {
    case 'powershell':
    case 'pwsh': {
      // Mã thoát: lệnh gốc (native) thất bại → mã của nó; ngược lại lệnh cuối lỗi (kể cả lỗi không-dừng của cmdlet như
      // `Get-Item đường-dẫn-không-có`) → 1, giống ngữ nghĩa `-Command` mà model quen; còn lại 0.
      const script = `${PS_PREAMBLE}\n${command}\n$__nd_ok = $?\nif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nif (-not $__nd_ok) { exit 1 }\nexit 0`;
      const common = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
      // Luôn chạy qua tệp tạm bằng -File (UTF-8 có BOM để PowerShell 5.1 đọc đúng dấu tiếng Việt). Không dùng
      // -EncodedCommand: khi stdout/stderr là ống, Windows PowerShell 5.1 trả MỌI lỗi dưới dạng CLIXML
      // (`#< CLIXML <Objs …><S S="Error">…_x000D__x000A_</S>`) kèm cả mã nguồn đoạn mở đầu — model không đọc nổi.
      const tmp = path.join(os.tmpdir(), `nd-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
      fs.writeFileSync(tmp, UTF8_BOM + script, 'utf8');
      return { file: shell.file, args: [...common, '-File', tmp], cleanup: tmp };
    }
    case 'cmd':
      return {
        file: shell.file,
        args: ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`],
        windowsVerbatimArguments: true,
      };
    case 'bash':
    case 'zsh':
      return { file: shell.file, args: ['-lc', command] };
    default:
      return { file: shell.file, args: ['-c', command] };
  }
}

/** Biến môi trường gửi cho tiến trình con: gỡ khoá API của các nhà cung cấp để lệnh `env`/`printenv` không làm lộ khoá. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
  for (const k of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'DEEPSEEK_API_KEY',
    'XAI_API_KEY',
    'GROK_API_KEY',
    'OPENROUTER_API_KEY',
    'MISTRAL_API_KEY',
    'GROQ_API_KEY',
    'TOGETHER_API_KEY',
    'BRAVE_API_KEY',
    'TAVILY_API_KEY',
    'SERPER_API_KEY',
  ]) {
    delete env[k];
  }
  return env;
}
