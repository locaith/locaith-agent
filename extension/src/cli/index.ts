#!/usr/bin/env node
/**
 * Locaith CLI (POC) — chạy agent Locaith trên máy chủ/terminal, dùng CÙNG lõi với extension:
 * cùng provider (cổng Locaith, model locaith-v5-flash), cùng engine, cùng công cụ và kỹ năng.
 *
 *   locaith doctor                      kiểm máy có đủ điều kiện chạy (node, ffmpeg, font, đĩa, mạng, khoá)
 *   locaith ask "tóm tắt repo này"      chạy một việc rồi in câu trả lời
 *   locaith ask --json ...              in JSON để script/CI đọc
 *
 * Khoá: biến môi trường LOCAITH_API_KEY (khuyến nghị) hoặc tệp ~/.locaith/cli.json (0600).
 * Không ghi khoá ra log; không gửi gì lên ngoài cổng đã cấu hình.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { AgentEngine } from '../core/engine/engine';
import { DEFAULT_ENGINE_SETTINGS, newSession, type PermissionDecision, type SessionState, type ToolHost } from '../core/engine/types';
import { NodeToolHost } from '../core/host/nodeHost';
import { createProvider } from '../core/providers';
import { ACCOUNT_PRESETS, BUILTIN_PRESETS } from '../core/providers/presets';
import { LOCAITH_GATEWAY_URL, LOCAITH_MODEL_FLASH, LOCAITH_PROVIDER_ID, LocaithGatewayClient } from '../core/providers/locaithGateway';
import type { ImageBlock } from '../core/types';
import { SkillRegistry } from '../core/skills/registry';
import { builtinSkills } from '../core/skills/builtin';
import { createToolRegistry } from '../core/tools';
import type { PermissionRequest } from '../shared/protocol';
import { createInterface } from 'node:readline/promises';
import { loginCmd, whoamiCmd, type AccountDeps } from './account';
import { deviceLabel, loginWithBrowser } from './browserLogin';
import { DEFAULT_ACCOUNT_CONFIG } from '../core/account/config';
import { newId } from '../shared/transcript';

const VERSION = '0.3.4';
const CONFIG_FILE = path.join(os.homedir(), '.locaith', 'cli.json');

interface Options {
  command: 'doctor' | 'ask' | 'consent' | 'login' | 'whoami' | 'repl' | 'help' | 'version';
  prompt?: string;
  /** `--continue`: mở phiên gần nhất. */
  continueLast: boolean;
  /** `--resume <id>`: mở phiên đã lưu. */
  resumeId?: string;
  model: string;
  baseUrl: string;
  cwd: string;
  /** `consent --yes`: chủ tài khoản tự xác nhận (không hỏi lại). */
  yes: boolean;
  /** `login --no-browser`: không mở trình duyệt, hỏi dán token (máy không có trình duyệt / SSH). */
  noBrowser: boolean;
  allow: 'none' | 'reads' | 'all';
  maxTurns: number;
  json: boolean;
  quiet: boolean;
  timeoutSec: number;
}

function usage(): string {
  return `Locaith CLI ${VERSION}

  locaith                        Mở PHIÊN TƯƠNG TÁC (gõ việc, /help để xem lệnh)
  locaith --continue             Mở lại phiên gần nhất
  locaith --resume <id>          Mở phiên đã lưu (xem "locaith sessions")
  locaith doctor                 Kiểm máy có đủ điều kiện chạy
  locaith login                  Đăng nhập: mở trình duyệt, bấm «Cho phép» (lưu ~/.locaith/cli.json)
  locaith login --no-browser     Máy không có trình duyệt: dán token thủ công
  locaith whoami                 Xem tài khoản đang dùng, gói và model dùng được
  locaith consent [--yes]        Ghi nhận đồng ý thông báo dữ liệu cho tài khoản (bắt buộc trước lần chạy đầu)
  locaith ask "<việc>" [tuỳ chọn]  Chạy một việc rồi in kết quả

Tuỳ chọn:
  --model <id>        Model (mặc định ${LOCAITH_MODEL_FLASH})
  --base-url <url>    Cổng khác (mặc định ${LOCAITH_GATEWAY_URL})
  --cwd <dir>         Thư mục làm việc (mặc định thư mục hiện tại)
  --allow <mức>       none | reads | all   (mặc định reads: chỉ đọc; all: cho sửa tệp và chạy lệnh)
  --max-turns <n>     Số vòng tối đa (mặc định 30)
  --timeout <giây>    Hạn giờ mỗi lần chạy (mặc định 900)
  --json              In JSON (dùng cho script/CI)
  --quiet             Chỉ in câu trả lời cuối

Khoá: đặt LOCAITH_API_KEY. Không truyền khoá qua dòng lệnh (sẽ lộ trong lịch sử shell).`;
}

function parse(argv: string[]): Options {
  const o: Options = { command: 'repl', model: LOCAITH_MODEL_FLASH, baseUrl: LOCAITH_GATEWAY_URL, cwd: process.cwd(), allow: 'reads', maxTurns: 30, json: false, quiet: false, timeoutSec: 900, yes: false, noBrowser: false, continueLast: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Thiếu giá trị cho ${a}`);
      return v;
    };
    if (a === 'doctor') o.command = 'doctor';
    else if (a === 'consent') o.command = 'consent';
    else if (a === 'login') o.command = 'login';
    else if (a === 'whoami') o.command = 'whoami';
    else if (a === 'ask') o.command = 'ask';
    else if (a === '--help' || a === '-h') o.command = 'help';
    else if (a === '--version' || a === '-v') o.command = 'version';
    else if (a === '--model') o.model = val();
    else if (a === '--base-url') o.baseUrl = val();
    else if (a === '--cwd') o.cwd = path.resolve(val());
    else if (a === '--allow') {
      const v = val();
      if (v !== 'none' && v !== 'reads' && v !== 'all') throw new Error('--allow phải là none | reads | all');
      o.allow = v;
    } else if (a === '--max-turns') o.maxTurns = Math.max(1, Math.min(200, Number(val()) || 30));
    else if (a === '--timeout') o.timeoutSec = Math.max(10, Math.min(7200, Number(val()) || 900));
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--no-browser') o.noBrowser = true;
    else if (a === '--continue' || a === '-c') {
      o.continueLast = true;
      o.command = 'repl';
    } else if (a === '--resume' || a === '-r') {
      o.resumeId = val();
      o.command = 'repl';
    }
    else if (a.startsWith('-')) throw new Error(`Không biết tuỳ chọn ${a}`);
    else rest.push(a);
  }
  if (o.command === 'ask') o.prompt = rest.join(' ').trim() || undefined;
  return o;
}

function apiKey(): string | undefined {
  const env = (process.env.LOCAITH_API_KEY ?? process.env.LOCAITH_TOKEN ?? '').trim();
  if (env) return env;
  try {
    const j = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { apiKey?: string };
    return typeof j.apiKey === 'string' && j.apiKey.trim() ? j.apiKey.trim() : undefined;
  } catch {
    return undefined;
  }
}

function makeProvider(o: Options) {
  const preset = [...BUILTIN_PRESETS, ...ACCOUNT_PRESETS].find((p) => p.id === LOCAITH_PROVIDER_ID);
  if (!preset) throw new Error('Bản dựng này không có sẵn provider Locaith.');
  const key = apiKey();
  if (!key) throw new Error(`Chưa có khoá Locaith. Đặt biến môi trường LOCAITH_API_KEY, hoặc ghi { "apiKey": "lat_…" } vào ${CONFIG_FILE} (quyền 600).`);
  return createProvider({
    id: preset.id,
    label: preset.label,
    kind: preset.kind,
    flavor: preset.flavor,
    baseUrl: o.baseUrl,
    getApiKey: async () => key,
  });
}

function diskFreeGb(dir: string): number | undefined {
  try {
    const s = statfsSync(dir);
    return Math.round(((s.bavail * s.bsize) / 1e9) * 10) / 10;
  } catch {
    return undefined;
  }
}

function toolVersion(cmd: string): string | undefined {
  const r = spawnSync(cmd, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return undefined;
  return r.stdout.split('\n')[0]?.trim().slice(0, 90);
}

async function doctor(o: Options): Promise<number> {
  const rows: [string, boolean, string][] = [];
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  rows.push(['Node.js', nodeOk, `${process.versions.node}${nodeOk ? '' : ' — cần 20 trở lên'}`]);
  const ff = toolVersion('ffmpeg');
  const fp = toolVersion('ffprobe');
  rows.push(['ffmpeg', !!ff, ff ?? 'chưa có — cần cho kỹ năng video (apt install ffmpeg / winget install Gyan.FFmpeg)']);
  rows.push(['ffprobe', !!fp, fp ?? 'chưa có — đi kèm ffmpeg']);
  const fonts = ['/usr/share/fonts', 'C:\\Windows\\Fonts'].some((p) => existsSync(p));
  rows.push(['Font cho chữ trong video', fonts, fonts ? 'có' : 'không thấy thư mục font — drawtext sẽ lỗi']);
  const free = diskFreeGb(o.cwd);
  rows.push(['Đĩa trống', (free ?? 0) >= 10, free === undefined ? 'không đọc được' : `${free} GB (khuyến nghị ≥ 10 GB nếu render video)`]);
  const key = apiKey();
  rows.push(['Khoá Locaith', !!key, key ? `đã có (${key.slice(0, 6)}…, ${key.length} ký tự)` : `chưa có — đặt LOCAITH_API_KEY hoặc ghi ${CONFIG_FILE}`]);
  if (key) {
    const t0 = Date.now();
    try {
      const provider = makeProvider(o);
      const models = await provider.fetchModels();
      const ids = models.map((m) => m.id);
      rows.push(['Cổng Locaith', true, `${o.baseUrl} — ${Date.now() - t0} ms, ${ids.length} model${ids.includes(o.model) ? `, có ${o.model}` : ` — KHÔNG thấy ${o.model}`}`]);
      const c = await new LocaithGatewayClient({ baseUrl: () => o.baseUrl }).getConsent(key);
      rows.push(['Đồng ý thông báo dữ liệu', c.ok && c.state.accepted, c.ok ? (c.state.accepted ? `đã đồng ý (bản ${c.state.version})` : 'CHƯA — chạy `locaith consent --yes`') : 'không kiểm được']);
    } catch (err) {
      rows.push(['Cổng Locaith', false, err instanceof Error ? err.message : String(err)]);
    }
  }
  if (o.json) {
    console.log(JSON.stringify({ ok: rows.every(([, ok]) => ok), checks: rows.map(([name, ok, detail]) => ({ name, ok, detail })) }, null, 2));
  } else {
    for (const [name, ok, detail] of rows) console.log(`${ok ? '✔' : '✘'} ${name.padEnd(24)} ${detail}`);
    console.log(rows.every(([, ok]) => ok) ? '\nMáy này chạy được Locaith CLI.' : '\nCòn mục ✘ ở trên — sửa rồi chạy lại `locaith doctor`.');
  }
  return rows.every(([, ok]) => ok) ? 0 : 1;
}

/** Host cho CLI: quyền theo --allow; khi cần hỏi mà không có terminal thì từ chối (an toàn). */
class CliHost extends NodeToolHost {
  /** Người dùng chọn «cho phép tất cả trong phiên» → không hỏi lại cho tới khi thoát. */
  private sessionAll = false;

  constructor(
    roots: string[],
    private readonly allow: Options['allow'],
    private readonly json: boolean,
  ) {
    super({ roots });
  }
  override async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    const READ = new Set(['read_file', 'list_dir', 'glob', 'grep', 'web_search', 'fetch_url', 'search_skills', 'load_skill', 'scratchpad']);
    const allow: PermissionDecision = { decision: 'allow' };
    const deny: PermissionDecision = { decision: 'deny' };
    if (READ.has(req.tool)) return allow;
    if (this.allow === 'all' || this.sessionAll) return allow;
    if (this.allow === 'none' || !process.stdin.isTTY) return deny;

    // Trình bày rõ: làm gì, trên cái gì — rồi mới hỏi. Enter = từ chối (mặc định an toàn).
    const detail = (req as { detail?: unknown }).detail;
    const line = typeof detail === 'string' && detail.trim() ? detail.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    process.stderr.write(`\n┌ ${req.title}\n${line ? `│ ${line}\n` : ''}└ [y] cho phép · [a] cho phép tất cả trong phiên · [Enter/N] từ chối\n`);

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const a = (await rl.question('› ')).trim().toLowerCase();
      if (a === 'a' || a === 'all') {
        this.sessionAll = true;
        return allow;
      }
      return a === 'y' || a === 'yes' ? allow : deny;
    } finally {
      rl.close();
    }
  }
  override setting<T>(_key: string, fallback: T): T {
    return fallback;
  }
}

function accountDeps(o: Options): AccountDeps {
  return {
    baseUrl: o.baseUrl,
    // Đọc CẢ tệp cấu hình (trước đây chỉ đọc env → `login` ghi tệp xong `whoami` vẫn báo "chưa đăng nhập").
    readKey: () => apiKey(),
    writeKey: (k) => writeConfigFile(k),
    ask: async (m) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(m);
      } finally {
        rl.close();
      }
    },
    json: o.json,
    listModels: async () => makeProvider(o).fetchModels(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    noBrowser: o.noBrowser,
    browserLogin: () =>
      loginWithBrowser({
        webUrl: DEFAULT_ACCOUNT_CONFIG.webUrl,
        supabaseUrl: DEFAULT_ACCOUNT_CONFIG.supabaseUrl,
        anonKey: DEFAULT_ACCOUNT_CONFIG.anonKey,
        label: deviceLabel(),
        notify: (m, url) => {
          console.error(m);
          if (url) console.error('  ' + url);
        },
      }),
  };
}

/** Ghi nhận đồng ý thông báo dữ liệu theo TÀI KHOẢN (lưu ở cổng) — cổng trả 403 cho tới khi có bản ghi này. */
async function consent(o: Options): Promise<number> {
  const key = apiKey();
  if (!key) throw new Error(`Chưa có khoá Locaith. Đặt LOCAITH_API_KEY hoặc ghi { "apiKey": "lat_…" } vào ${CONFIG_FILE}.`);
  const client = new LocaithGatewayClient({ baseUrl: () => o.baseUrl });
  const cur = await client.getConsent(key);
  if (!cur.ok) {
    const why = cur.error === 'unauthorized' ? 'Token không còn hiệu lực (401).' : cur.error === 'network' ? 'Không kết nối được tới cổng.' : 'Cổng trả lỗi.';
    if (o.json) console.log(JSON.stringify({ ok: false, error: why }));
    else console.error(`✘ ${why}`);
    return 1;
  }
  if (cur.state.accepted) {
    if (o.json) console.log(JSON.stringify({ ok: true, already: true, version: cur.state.version }));
    else console.log(`✔ Tài khoản đã đồng ý thông báo dữ liệu (phiên bản ${cur.state.version}). Không cần làm gì.`);
    return 0;
  }
  if (!o.yes) {
    const msg = `Cần ghi nhận đồng ý thông báo dữ liệu phiên bản ${cur.state.current} cho tài khoản này (bản ghi lưu ở cổng, dùng chung với bản VS Code).
Chạy lại với --yes nếu bạn — với tư cách chủ tài khoản — đồng ý.`;
    if (o.json) console.log(JSON.stringify({ ok: false, needsConsent: true, current: cur.state.current }));
    else console.error(msg);
    return 1;
  }
  const r = await client.postConsent(key, cur.state.current, 'cli');
  if (!r.ok) {
    const why = r.error === 'unauthorized' ? 'Token không còn hiệu lực (401).' : r.error === 'network' ? 'Không kết nối được tới cổng.' : `Cổng từ chối: ${r.message ?? 'không rõ lý do'}`;
    if (o.json) console.log(JSON.stringify({ ok: false, error: why }));
    else console.error(`✘ ${why}`);
    return 1;
  }
  if (o.json) console.log(JSON.stringify({ ok: true, version: cur.state.current }));
  else console.log(`✔ Đã ghi nhận đồng ý phiên bản ${cur.state.current}.`);
  return 0;
}

async function ask(o: Options): Promise<number> {
  if (!o.prompt) {
    console.error('Thiếu nội dung: locaith ask "<việc cần làm>"');
    return 2;
  }
  const provider = makeProvider(o);
  const host: ToolHost = new CliHost([o.cwd], o.allow, o.json);
  const skills = new SkillRegistry(builtinSkills());
  const registry = createToolRegistry({ skills, host });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), o.timeoutSec * 1000);
  const session = newSession({ id: newId('cli'), provider: LOCAITH_PROVIDER_ID, model: o.model, mode: o.allow === 'all' ? 'acceptEdits' : 'default' });
  const say = (line: string) => {
    if (!o.json) process.stderr.write(line + '\n');
  };
  const engine = new AgentEngine({
    provider,
    summarizer: null,
    registry,
    skills,
    host,
    settings: { ...DEFAULT_ENGINE_SETTINGS, maxTurns: o.maxTurns, contextWindow: 1_000_000 },
    onQueue: (q) => say(`… đang xếp hàng${q ? ` (${q.position}/${q.limit ?? '?'})` : ' — đã được nhận'}`),
    emit: (ev) => {
      if (o.json || o.quiet) return;
      if (ev.t === 'tool_start') say(`· ${ev.name}`);
      else if (ev.t === 'notice' && ev.level !== 'info') say(`${ev.level === 'error' ? '✘' : '!'} ${ev.text}`);

    },
  });
  const t0 = Date.now();
  try {
    const res = await engine.run({ session, content: [{ type: 'text', text: o.prompt }], signal: abort.signal });
    const last = [...session.messages].reverse().find((m) => m.role === 'assistant');
    const text = (last?.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
    if (o.json) {
      console.log(JSON.stringify({ ok: res.stopReason === 'end_turn', stopReason: res.stopReason, turns: res.turns, usage: session.usageTotals, model: o.model, ms: Date.now() - t0, text }, null, 2));
    } else {
      console.log(text || '(không có câu trả lời)');
      if (!o.quiet) say(`\n— ${res.turns} vòng · ${session.usageTotals.input + session.usageTotals.output} token · ${Math.round((Date.now() - t0) / 100) / 10}s`);
    }
    return res.stopReason === 'end_turn' ? 0 : 1;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phiên tương tác (như `claude` / `codex`): gõ việc → chạy, có /lệnh, lưu phiên.
// ─────────────────────────────────────────────────────────────────────────────
const MCP_FILE = path.join(os.homedir(), '.locaith', 'mcp.json');
interface McpServer { command?: string; args?: string[] }
function readMcp(): Record<string, McpServer> {
  try { return JSON.parse(readFileSync(MCP_FILE, 'utf8')) as Record<string, McpServer>; } catch { return {}; }
}
const SETTINGS_FILE = path.join(os.homedir(), '.locaith', 'settings.json');
interface CliSettings { model?: string; allow?: 'none' | 'reads' | 'all' }
function readSettings(): CliSettings {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as CliSettings; } catch { return {}; }
}
function saveSettings(s: CliSettings): void {
  try {
    mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch {
    /* không ghi được thì thôi, phiên vẫn chạy */
  }
}

const SESS_DIR = path.join(os.homedir(), '.locaith', 'sessions');

interface SavedSession {
  id: string;
  title: string;
  model: string;
  cwd: string;
  updatedAt: number;
  messages: unknown[];
  usage?: { input: number; output: number };
}

function saveSession(session: SessionState, cwd: string, title: string): void {
  try {
    mkdirSync(SESS_DIR, { recursive: true });
    const rec: SavedSession = {
      id: session.id,
      title: title.replace(/\s+/g, ' ').trim().slice(0, 90) || '(chưa có tiêu đề)',
      model: session.model,
      cwd,
      updatedAt: Date.now(),
      messages: session.messages as unknown[],
      usage: session.usageTotals ?? undefined,
    };
    writeFileSync(path.join(SESS_DIR, `${session.id}.json`), JSON.stringify(rec), { mode: 0o600 });
  } catch {
    /* không lưu được phiên thì vẫn chạy tiếp, chỉ mất khả năng khôi phục */
  }
}

function listSessions(): SavedSession[] {
  try {
    return readdirSync(SESS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(SESS_DIR, f), 'utf8')) as SavedSession;
        } catch {
          return null;
        }
      })
      .filter((s): s is SavedSession => !!s && typeof s.id === 'string')
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function loadSession(id: string): SavedSession | undefined {
  return listSessions().find((s) => s.id === id || s.id.startsWith(id));
}

const REPL_CMDS: [string, string][] = [
  ['help', 'danh sách lệnh'],
  ['model', 'xem/đổi model (locaith-v5-flash · locaith-v5-si)'],
  ['allow', 'none | reads | all'],
  ['cwd', 'xem/đổi thư mục làm việc'],
  ['sessions', 'liệt kê phiên đã lưu'],
  ['resume', 'khôi phục phiên: /resume <id>'],
  ['new', 'phiên mới'],
  ['cost', 'token đã dùng trong phiên'],
  ['paste', 'dán ảnh từ clipboard (Windows)'],
  ['settings', 'xem/đặt mặc định: /settings model <id> · /settings allow <mức>'],
  ['mcp', 'xem cấu hình MCP (~/.locaith/mcp.json)'],
  ['clear', 'xoá màn hình'],
  ['exit', 'thoát'],
];

/** Gõ «/» hoặc «/mo» rồi Enter → sổ ra danh sách lệnh khớp, không phải nhớ tên đầy đủ. */
function slashMenu(prefix: string): boolean {
  const p = prefix.toLowerCase();
  const hit = REPL_CMDS.filter(([n]) => n.startsWith(p));
  if (hit.length === 0) return false;
  console.log(p ? `Lệnh khớp «/${p}»:` : 'Lệnh trong phiên:');
  for (const [n, d] of hit) console.log(`  /${n.padEnd(10)} ${d}`);
  console.log('');
  return true;
}

const REPL_HELP = `Lệnh trong phiên:
  /help              danh sách lệnh này
  /model [id]        xem hoặc đổi model (locaith-v5-flash · locaith-v5-si)
  /allow [mức]       none | reads | all  (mặc định reads: chỉ đọc)
  /cwd [thư-mục]     xem hoặc đổi thư mục làm việc
  /sessions          liệt kê phiên đã lưu
  /resume <id>       khôi phục phiên đã lưu
  /new               phiên mới (xoá ngữ cảnh đang có)
  /clear             xoá màn hình
  /exit              thoát (Ctrl+D cũng được)`;

async function repl(o: Options): Promise<number> {
  const histFile = path.join(os.homedir(), '.locaith', 'history');
  const history = (() => {
    try {
      return readFileSync(histFile, 'utf8').split('\n').filter(Boolean).slice(-300);
    } catch {
      return [];
    }
  })();
  // Ghi lịch sử ngay khi tiến trình thoát — không phụ thuộc khối finally (trước đây CLI crash lúc thoát nên finally không chạy).
  process.once('exit', () => {
    try {
      mkdirSync(path.dirname(histFile), { recursive: true });
      writeFileSync(histFile, history.slice(-300).join(String.fromCharCode(10)) + String.fromCharCode(10), { mode: 0o600 });
    } catch {
      /* khong ghi duoc thi thoi */
    }
  });
  let historySaved = 0;
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
    history,
    historySize: 300,
    // Tab: gợi ý /lệnh ở đầu dòng, gợi ý đường dẫn khi gõ @
    completer: (line: string): [string[], string] => {
      if (line.startsWith('/') && !line.includes(' ')) return [REPL_CMDS.map(([n]) => '/' + n).filter((n) => n.startsWith(line)), line];
      const m = /@([^\s]*)$/.exec(line);
      if (m) {
        try {
          const dir = path.dirname(path.resolve(process.cwd(), m[1] || '.'));
          const base = path.basename(m[1] || '');
          const hits = readdirSync(dir).filter((f) => f.startsWith(base)).slice(0, 40);
          return [hits, m[1] || ''];
        } catch {
          return [[], m[1] || ''];
        }
      }
      return [[], line];
    },
  });
  let model = o.model;
  let allow: Options['allow'] = o.allow;
  let cwd = o.cwd;
  const saved = readSettings();
  if (saved.model) model = saved.model;
  if (saved.allow && o.allow === 'reads') allow = saved.allow;
  /** Ảnh chờ gửi kèm câu hỏi kế tiếp (/image). */
  const pending: ImageBlock[] = [];

  const restored = o.resumeId ? loadSession(o.resumeId) : o.continueLast ? listSessions()[0] : undefined;
  let session: SessionState = newSession({ id: newId('cli'), provider: LOCAITH_PROVIDER_ID, model: restored?.model ?? model, mode: allow === 'all' ? 'acceptEdits' : 'default' });
  if (restored) {
    session = { ...session, id: restored.id, model: restored.model, messages: restored.messages as SessionState['messages'] };
    if (restored.cwd) cwd = restored.cwd;
    model = restored.model;
    console.log(`↺ Khôi phục phiên ${restored.id.slice(0, 8)} — ${restored.title}`);
  }
  console.log(`Locaith CLI ${VERSION} · model ${model} · ${cwd}\nGõ việc cần làm, hoặc /help để xem lệnh.\n`);

  const runTurn = async (prompt: string): Promise<void> => {
    // @đường-dẫn trong câu lệnh: chèn nội dung tệp vào ngữ cảnh (tối đa 20k ký tự mỗi tệp).
    const expand = (text: string): string => text.replace(/@([^\s]+)/g, (m, p) => {
      const abs = path.resolve(cwd, p);
      if (!existsSync(abs)) return m;
      try {
        const body = readFileSync(abs, 'utf8');
        return m + '\n\n``\n' + body.slice(0, 20000) + '\n``\n';
      } catch {
        return m;
      }
    });
    const engProvider = makeProvider({ ...o, model, cwd });
    const host: ToolHost = new CliHost([cwd], allow, false);
    const skills = new SkillRegistry(builtinSkills());
    const registry = createToolRegistry({ skills, host });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), o.timeoutSec * 1000);
    let streamed = false;
    const engine = new AgentEngine({
      provider: engProvider,
      summarizer: null,
      registry,
      skills,
      host,
      settings: { ...DEFAULT_ENGINE_SETTINGS, maxTurns: o.maxTurns, contextWindow: 1_000_000 },
      onQueue: (q) => process.stderr.write(`… đang xếp hàng${q ? ` (${q.position}/${q.limit ?? '?'})` : ' — đã được nhận'}\n`),
      emit: (ev) => {
        if (ev.t === 'tool_start') process.stderr.write(`· ${ev.name}\n`);
        else if (ev.t === 'text') {
          // In dần từng mẩu chữ như CLI của các hãng: sự kiện đã có sẵn từ StreamInterceptor, không cần sửa lõi.
          if (!streamed) {
            streamed = true;
            process.stdout.write('\n');
          }
          process.stdout.write(ev.delta);
        } else if (ev.t === 'notice' && ev.level !== 'info') process.stderr.write(`${ev.level === 'error' ? '✘' : '!'} ${ev.text}\n`);
      },
    });
    const t0 = Date.now();
    try {
      const res = await engine.run({ session, content: [{ type: 'text', text: expand(prompt) }, ...pending], signal: abort.signal });
      pending.length = 0;
      const last = [...session.messages].reverse().find((m) => m.role === 'assistant');
      const text = (last?.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
      // Đã in dần từng mẩu thì không in lại cả câu (tránh lặp); chưa có mẩu nào thì in trọn.
      if (streamed) process.stdout.write('\n\n');
      else console.log('\n' + (text || '(không có câu trả lời)') + '\n');
      console.log(`— ${res.turns} vòng · ${session.usageTotals.input + session.usageTotals.output} token · ${Math.round((Date.now() - t0) / 100) / 10}s\n`);
      saveSession(session, cwd, prompt);
    } catch (err) {
      console.error(`✘ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question('› ')).trim();
      } catch {
        break; // Ctrl+D / hết đầu vào (ống, script): thoát êm thay vì ném "readline was closed"
      }
      // Nhiều dòng: kết thúc bằng \\ thì đọc tiếp (không cần raw mode).
      while (line.endsWith('\\')) {
        line = line.slice(0, -1);
        try {
          line += String.fromCharCode(10) + (await rl.question('… '));
        } catch {
          break;
        }
      }
      if (!line.trim()) continue;
      history.push(line);
      if (!line.startsWith('/')) {
        await runTurn(line);
        continue;
      }
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();
      if (cmd === 'exit' || cmd === 'quit') break;
      if (cmd === 'help' || cmd === '?') {
        console.log(REPL_HELP + '\n');
      } else if (cmd === 'model') {
        if (!arg) console.log(`Model hiện tại: ${model} (có: locaith-v5-flash, locaith-v5-si)\n`);
        else {
          model = arg;
          session = { ...session, model };
          console.log(`→ model: ${model}\n`);
        }
      } else if (cmd === 'allow') {
        if (!arg) console.log(`Mức quyền hiện tại: ${allow}\n`);
        else if (arg !== 'none' && arg !== 'reads' && arg !== 'all') console.log('Mức phải là none | reads | all\n');
        else {
          allow = arg;
          session = { ...session, mode: allow === 'all' ? 'acceptEdits' : 'default' };
          console.log(`→ quyền: ${allow}\n`);
        }
      } else if (cmd === 'cwd') {
        if (!arg) console.log(`Thư mục: ${cwd}\n`);
        else {
          const next = path.resolve(cwd, arg);
          if (!existsSync(next)) console.log(`✘ Không thấy thư mục ${next}\n`);
          else {
            cwd = next;
            console.log(`→ thư mục: ${cwd}\n`);
          }
        }
      } else if (cmd === 'sessions') {
        const rows = listSessions().slice(0, 15);
        if (rows.length === 0) console.log('Chưa có phiên nào được lưu.\n');
        else {
          console.log('Phiên đã lưu (mới nhất trước):');
          for (const s of rows) console.log(`  ${s.id.slice(0, 8)}  ${new Date(s.updatedAt).toLocaleString('vi-VN')}  ${s.model}  ${s.title}`);
          console.log('');
        }
      } else if (cmd === 'resume') {
        let target = arg;
        if (!target) {
          const all = listSessions();
          if (all.length === 0) {
            console.log('Chưa có phiên nào.\n');
            continue;
          }
          console.log('Chọn phiên:');
          all.slice(0, 10).forEach((s, i) => console.log('  ' + (i + 1) + ') ' + s.id.slice(0, 8) + '  ' + s.model + '  ' + s.title));
          const pickN = (await rl.question('Số thứ tự (Enter = mới nhất): ')).trim();
          const idx = pickN ? Number(pickN) - 1 : 0;
          target = (all[idx] || all[0]).id;
          console.log('');
        }
        const found = loadSession(target);
        if (!found) console.log('✘ Không thấy phiên đó.\n');
        else {
          session = { ...session, id: found.id, model: found.model, messages: found.messages as SessionState['messages'] };
          model = found.model;
          if (found.cwd) cwd = found.cwd;
          console.log(`↺ Đã khôi phục ${found.id.slice(0, 8)} — ${found.title}\n`);
        }
      } else if (cmd === 'new') {
        session = newSession({ id: newId('cli'), provider: LOCAITH_PROVIDER_ID, model, mode: allow === 'all' ? 'acceptEdits' : 'default' });
        console.log('↺ Phiên mới.\n');
      } else if (cmd === 'image') {
        const p = arg ? path.resolve(cwd, arg) : '';
        if (!p || !existsSync(p)) console.log('✘ Không thấy tệp. Dùng: /image <đường-dẫn>\n');
        else {
          const ext = path.extname(p).toLowerCase();
          const mediaType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
          const data = readFileSync(p).toString('base64');
          pending.push({ type: 'image', mediaType, data });
          console.log('+ ảnh ' + path.basename(p) + ' — sẽ gửi kèm câu hỏi tiếp theo (' + pending.length + ' ảnh chờ)\n');
        }
      } else if (cmd === 'cost') {
        const u = session.usageTotals;
        console.log('Token phiên này: vào ' + u.input + ' · ra ' + u.output + ' · tổng ' + (u.input + u.output) + '\n');
      } else if (cmd === 'settings') {
        const parts = arg.split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          console.log('Mặc định đã lưu (' + SETTINGS_FILE + '):');
          console.log('  model: ' + (saved.model || '(chưa đặt)'));
          console.log('  allow: ' + (saved.allow || '(chưa đặt)'));
          console.log('');
        } else if (parts[0] === 'model' && parts[1]) {
          saved.model = parts[1];
          saveSettings(saved);
          model = parts[1];
          console.log('→ mặc định model: ' + model + '\n');
        } else if (parts[0] === 'allow' && parts[1] && (parts[1] === 'none' || parts[1] === 'reads' || parts[1] === 'all')) {
          saved.allow = parts[1] as Options['allow'];
          saveSettings(saved);
          allow = parts[1] as Options['allow'];
          console.log('→ mặc định quyền: ' + allow + '\n');
        } else {
          console.log('Dùng: /settings · /settings model locaith-v5-si · /settings allow all\n');
        }
      } else if (cmd === 'paste') {
        if (process.platform !== 'win32') {
          console.log('✘ Dán ảnh hiện chỉ hỗ trợ Windows. Trên máy khác, lưu ảnh ra tệp rồi dùng /image.\n');
        } else {
          const tmp = path.join(os.tmpdir(), 'locaith-paste-' + Date.now() + '.png');
          const ps = 'Add-Type -AssemblyName System.Windows.Forms; $i=[System.Windows.Forms.Clipboard]::GetImage(); if ($i -eq $null) { exit 2 }; $i.Save("' + tmp + '",[System.Drawing.Imaging.ImageFormat]::Png)';
          const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
          if (r.status !== 0 || !existsSync(tmp)) {
            console.log('✘ Clipboard không có ảnh (hoặc Windows không đọc được).\n');
          } else {
            pending.push({ type: 'image', mediaType: 'image/png', data: readFileSync(tmp).toString('base64') });
            console.log('+ ảnh từ clipboard — sẽ gửi kèm câu hỏi tiếp theo (' + pending.length + ' ảnh chờ)\n');
            try { rmSync(tmp); } catch { /* không xoá được tệp tạm thì thôi */ }
          }
        }
      } else if (cmd === 'compact') {
        const keep = Math.max(2, Number(arg) || 8);
        const before = session.messages.length;
        if (before <= keep) {
          console.log('Ngữ cảnh còn ngắn (' + before + ' tin), không cần nén.\n');
        } else {
          session = { ...session, messages: session.messages.slice(-keep) };
          console.log('↳ Đã bỏ ' + (before - keep) + ' tin cũ, giữ ' + keep + ' tin gần nhất. (Cắt bớt, chưa phải tóm tắt bằng model.)\n');
        }      } else if (cmd === 'mcp') {
        const cfg = readMcp();
        const names = Object.keys(cfg);
        if (names.length === 0) {
          console.log('Chưa cấu hình MCP. Tạo ' + MCP_FILE + ' dạng: {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]}}\n');
        } else {
          console.log('MCP đã cấu hình (' + names.length + ') — CHƯA kết nối:');
          for (const n of names) {
            const s = cfg[n] || {};
            console.log('  ' + n + '  ' + (s.command || '?') + ' ' + (s.args || []).join(' '));
          }
          console.log('');
        }      } else if (cmd === 'clear') {
        console.clear();
      } else if (!slashMenu(cmd)) {
        console.log(`Không biết lệnh /${cmd}. Gõ /help.\n`);
      }
    }
  } finally {
    // Ghi lịch sử đã được chuyển sang process.once(\"exit\") ở đầu phiên,
    // nên khối này chỉ cần đóng readline an toàn.
    try { rl.close(); } catch { /* đã đóng */ }
  }
  return 0;
}

async function main(): Promise<number> {
  let o: Options;
  try {
    o = parse(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}`);
    return 2;
  }
  if (o.command === 'help') return console.log(usage()), 0;
  if (o.command === 'version') return console.log(VERSION), 0;
  try {
    if (o.command === 'doctor') return await doctor(o);
    if (o.command === 'consent') return await consent(o);
    if (o.command === 'login') return await loginCmd(accountDeps(o));
    if (o.command === 'whoami') return await whoamiCmd(accountDeps(o));
    if (o.command === 'repl') return await repl(o);
    return await ask(o);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (o.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`✘ ${msg}`);
    return 1;
  }
}

main()
  .then((code) => {
    // Không bao giờ gọi process.exit() ngay sau khi có I/O: trên Windows, thoát lúc socket/stdout đang đóng làm libuv abort
    // (mã 0xC0000409) và mã thoát đúng bị mất. Đặt exitCode, đóng bộ điều phối HTTP còn keep-alive, rồi để loop tự rỗng.
    process.exitCode = code;
    closeDispatcher();
    setTimeout(forceQuit, 1500).unref?.();
  })
  .catch((err) => {
    console.error(`✘ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    closeDispatcher();
  });

/** Đóng các socket keep-alive của fetch (undici) để tiến trình kết thúc sạch. */
function closeDispatcher(): void {
  try {
    const sym = Symbol.for('undici.globalDispatcher.1');
    const d = (globalThis as Record<symbol, unknown>)[sym] as { close?: () => Promise<void> } | undefined;
    void d?.close?.().catch(() => undefined);
  } catch {
    /* bản Node không có undici: bỏ qua */
  }
}

function forceQuit(): void {
  try {
    process.stdout.write('', () => process.exit(process.exitCode ?? 0));
  } catch {
    process.exit(process.exitCode ?? 0);
  }
}
// Giữ chỗ cho tệp cấu hình mẫu (tạo khi người dùng muốn dùng tệp thay vì biến môi trường).
export function writeConfigFile(apiKeyValue: string): string {
  mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify({ apiKey: apiKeyValue }, null, 2)}\n`, { mode: 0o600 });
  return CONFIG_FILE;
}
