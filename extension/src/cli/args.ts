/**
 * Phân tích dòng lệnh của Locaith CLI — cờ gần với Claude CLI để ai quen `claude` dùng được ngay.
 *
 *   locaith                       phiên tương tác (cần terminal)
 *   locaith "việc cần làm"        phiên tương tác, gửi sẵn câu này
 *   locaith -p "việc"             in một lần rồi thoát (cũng nhận từ stdin: `cat log | locaith -p "tóm tắt"`)
 *   locaith ask "việc"            như `-p` (tên cũ, giữ để không vỡ script)
 *   locaith doctor | login | logout | whoami | consent | update | sessions | config | help [chủ đề] | version
 */

import path from 'node:path';

export type CliCommand = 'chat' | 'print' | 'doctor' | 'login' | 'logout' | 'whoami' | 'consent' | 'update' | 'sessions' | 'config' | 'provider' | 'help' | 'version';
export type OutputFormat = 'text' | 'json' | 'stream-json';
export type PermissionModeArg = 'default' | 'acceptEdits' | 'plan' | 'bypass';

export interface ParsedArgs {
  command: CliCommand;
  /** Nội dung việc (print) hoặc câu mở đầu (chat). */
  prompt?: string;
  /** `help <chủ đề>`. */
  topic?: string;
  outputFormat: OutputFormat;
  /** Cờ tương thích cũ: `--json`, `--quiet`. */
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  model?: string;
  baseUrl?: string;
  cwd: string;
  permissionMode?: PermissionModeArg;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
  appendSystemPrompt?: string;
  maxTurns?: number;
  timeoutSec?: number;
  continueLast: boolean;
  /** `-r <id>`, hoặc `true` khi chỉ có `-r` (chọn từ danh sách / phiên gần nhất). */
  resume?: string | true;
  noPersist: boolean;
  mcpConfig: string[];
  noColor: boolean;
  lang?: 'vi' | 'en';
  /** consent --yes */
  yes: boolean;
  /** login --no-browser */
  noBrowser: boolean;
  /** `sessions --all`, `update --check` … cờ phụ của lệnh con. */
  flags: Record<string, boolean>;
  /** `locaith provider <hành-động> …` (chỉ có khi command === 'provider'). */
  provider?: ProviderArgs;
}

export interface ProviderArgs {
  /** list (mặc định) | add | key | remove | test — người gọi kiểm tên. */
  action: string;
  /** Các đối số đứng sau hành động (ví dụ id hoặc tên mẫu). */
  args: string[];
  id?: string;
  url?: string;
  label?: string;
  models?: string[];
  kind?: string;
  /** API này không cần khoá. */
  noKey: boolean;
  /** Đọc khoá từ stdin (KHÔNG nhận khoá ở dòng lệnh). */
  keyStdin: boolean;
  /** Đọc khoá từ biến môi trường có tên này. */
  keyEnv?: string;
  /** `provider key <id> --remove`: xoá khoá đã lưu. */
  remove: boolean;
  /** Không thử kết nối sau khi thêm. */
  noTest: boolean;
}

export class UsageError extends Error {}

const SUBCOMMANDS = new Set(['doctor', 'login', 'logout', 'whoami', 'consent', 'update', 'sessions', 'config', 'provider', 'help', 'version', 'ask']);

const PERMISSION_ALIASES: Record<string, PermissionModeArg> = {
  default: 'default',
  acceptedits: 'acceptEdits',
  'accept-edits': 'acceptEdits',
  plan: 'plan',
  bypass: 'bypass',
  bypasspermissions: 'bypass',
  'bypass-permissions': 'bypass',
};

function list(v: string): string[] {
  // `--allowedTools "Bash(git *)" "Read"` hoặc "Bash(git *),Read": tách theo dấu phẩy NGOÀI ngoặc.
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ' ') && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseArgs(argv: string[], cwd: string = process.cwd()): ParsedArgs {
  const o: ParsedArgs = {
    command: 'chat',
    outputFormat: 'text',
    json: false,
    quiet: false,
    verbose: false,
    cwd,
    allowedTools: [],
    disallowedTools: [],
    addDirs: [],
    continueLast: false,
    noPersist: false,
    mcpConfig: [],
    noColor: false,
    yes: false,
    noBrowser: false,
    flags: {},
  };
  const rest: string[] = [];
  const pv: ProviderArgs = { action: 'list', args: [], noKey: false, keyStdin: false, remove: false, noTest: false };
  const pvFlags: string[] = [];
  let printFlag = false;
  let sawSub = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`Thiếu giá trị cho ${a}`);
      return v;
    };
    // --cờ=giá trị
    let flag = a;
    let inline: string | undefined;
    if (a.startsWith('--') && a.includes('=')) {
      flag = a.slice(0, a.indexOf('='));
      inline = a.slice(a.indexOf('=') + 1);
    }
    const val = (): string => (inline !== undefined ? inline : next());

    if (!a.startsWith('-')) {
      if (!sawSub && rest.length === 0 && SUBCOMMANDS.has(a)) {
        sawSub = true;
        if (a === 'ask') {
          o.command = 'print';
          printFlag = true;
        } else o.command = a as CliCommand;
        continue;
      }
      rest.push(a);
      continue;
    }

    switch (flag) {
      case '-p':
      case '--print':
        printFlag = true;
        break;
      case '--output-format':
        {
          const v = val();
          if (v !== 'text' && v !== 'json' && v !== 'stream-json') throw new UsageError('--output-format phải là text | json | stream-json');
          o.outputFormat = v;
        }
        break;
      case '--json':
        o.json = true;
        o.outputFormat = 'json';
        break;
      case '--quiet':
        o.quiet = true;
        break;
      case '--verbose':
        o.verbose = true;
        break;
      case '--model':
        o.model = val();
        break;
      case '--base-url':
        o.baseUrl = val();
        break;
      case '--cwd':
        o.cwd = path.resolve(cwd, val());
        break;
      case '--permission-mode': {
        const v = PERMISSION_ALIASES[val().toLowerCase()];
        if (!v) throw new UsageError('--permission-mode phải là default | acceptEdits | plan | bypassPermissions');
        o.permissionMode = v;
        break;
      }
      case '--dangerously-skip-permissions':
        o.permissionMode = 'bypass';
        break;
      case '--allow': {
        // Cờ cũ của 0.3.x: none | reads | all
        const v = val();
        if (v === 'none') o.permissionMode = 'plan';
        else if (v === 'reads') o.permissionMode = 'default';
        else if (v === 'all') o.permissionMode = 'bypass';
        else throw new UsageError('--allow phải là none | reads | all');
        break;
      }
      case '--allowedTools':
      case '--allowed-tools':
        o.allowedTools.push(...list(val()));
        break;
      case '--disallowedTools':
      case '--disallowed-tools':
        o.disallowedTools.push(...list(val()));
        break;
      case '--add-dir':
        o.addDirs.push(path.resolve(cwd, val()));
        break;
      case '--append-system-prompt':
        o.appendSystemPrompt = val();
        break;
      case '--max-turns': {
        const n = Number(val());
        if (!Number.isFinite(n) || n < 1) throw new UsageError('--max-turns phải là số nguyên ≥ 1');
        o.maxTurns = Math.min(1000, Math.floor(n));
        break;
      }
      case '--timeout': {
        const n = Number(val());
        if (!Number.isFinite(n) || n < 1) throw new UsageError('--timeout là số giây ≥ 1');
        o.timeoutSec = Math.min(86_400, Math.floor(n));
        break;
      }
      case '-c':
      case '--continue':
        o.continueLast = true;
        break;
      case '-r':
      case '--resume': {
        // `-r` đứng một mình (hoặc trước một cờ khác) = chọn phiên; `-r <id>` = mở thẳng.
        const peek = argv[i + 1];
        if (inline !== undefined) o.resume = inline;
        else if (peek !== undefined && !peek.startsWith('-') && !SUBCOMMANDS.has(peek)) o.resume = argv[++i];
        else o.resume = true;
        break;
      }
      case '--no-session-persistence':
        o.noPersist = true;
        break;
      case '--mcp-config':
        o.mcpConfig.push(path.resolve(cwd, val()));
        break;
      case '--no-color':
        o.noColor = true;
        break;
      case '--lang': {
        const v = val();
        if (v !== 'vi' && v !== 'en') throw new UsageError('--lang phải là vi | en');
        o.lang = v;
        break;
      }
      case '--yes':
      case '-y':
        o.yes = true;
        break;
      case '--no-browser':
        o.noBrowser = true;
        break;
      case '--id':
        pv.id = val();
        pvFlags.push(flag);
        break;
      case '--url':
        pv.url = val();
        pvFlags.push(flag);
        break;
      case '--label':
        pv.label = val();
        pvFlags.push(flag);
        break;
      case '--models':
        pv.models = val()
          .split(/[,;\n]/)
          .map((m) => m.trim())
          .filter(Boolean);
        pvFlags.push(flag);
        break;
      case '--kind':
        pv.kind = val();
        pvFlags.push(flag);
        break;
      case '--no-key':
        pv.noKey = true;
        pvFlags.push(flag);
        break;
      case '--key-stdin':
        pv.keyStdin = true;
        pvFlags.push(flag);
        break;
      case '--key-env':
        pv.keyEnv = val();
        pvFlags.push(flag);
        break;
      case '--remove':
        pv.remove = true;
        pvFlags.push(flag);
        break;
      case '--no-test':
        pv.noTest = true;
        pvFlags.push(flag);
        break;
      case '--all':
      case '--check':
      case '--force':
        o.flags[flag.slice(2)] = true;
        break;
      case '-h':
      case '--help':
        o.command = 'help';
        break;
      case '-v':
      case '--version':
        o.command = 'version';
        break;
      case '--key':
      case '--api-key':
      case '--apikey':
      case '--token':
      case '--password':
        // Khoá ở dòng lệnh lộ trong lịch sử shell và danh sách tiến trình: từ chối ngay, KHÔNG in lại giá trị.
        throw new UsageError(`${flag}: không nhận khoá ở dòng lệnh (lộ trong lịch sử shell). Dùng \`locaith provider key <id>\` (ô nhập ẩn), hoặc --key-stdin / --key-env TÊN.`);
      default:
        // Chỉ in tên cờ, không in `=giá-trị`: giá trị có thể là khoá.
        throw new UsageError(`Không biết tuỳ chọn ${flag}`);
    }
  }

  if (o.command === 'help') {
    o.topic = rest[0];
    return o;
  }
  if (o.command === 'version') return o;
  if (o.command === 'provider') {
    o.provider = { ...pv, action: (rest[0] ?? 'list').toLowerCase(), args: rest.slice(1) };
    return o;
  }
  if (pvFlags.length) throw new UsageError(`Tuỳ chọn ${pvFlags[0]} chỉ dùng với \`locaith provider\``);
  const text = rest.join(' ').trim();
  if (o.command === 'chat') {
    if (printFlag) o.command = 'print';
    if (text) o.prompt = text;
  } else if (o.command === 'print') {
    if (text) o.prompt = text;
  }
  return o;
}
