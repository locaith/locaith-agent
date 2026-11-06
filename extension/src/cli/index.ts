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
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { AgentEngine } from '../core/engine/engine';
import { DEFAULT_ENGINE_SETTINGS, newSession, type PermissionDecision, type ToolHost } from '../core/engine/types';
import { NodeToolHost } from '../core/host/nodeHost';
import { createProvider } from '../core/providers';
import { ACCOUNT_PRESETS, BUILTIN_PRESETS } from '../core/providers/presets';
import { LOCAITH_GATEWAY_URL, LOCAITH_MODEL_FLASH, LOCAITH_PROVIDER_ID, LocaithGatewayClient } from '../core/providers/locaithGateway';
import { SkillRegistry } from '../core/skills/registry';
import { builtinSkills } from '../core/skills/builtin';
import { createToolRegistry } from '../core/tools';
import type { PermissionRequest } from '../shared/protocol';
import { createInterface } from 'node:readline/promises';
import { loginCmd, whoamiCmd, type AccountDeps } from './account';
import { deviceLabel, loginWithBrowser } from './browserLogin';
import { DEFAULT_ACCOUNT_CONFIG } from '../core/account/config';
import { newId } from '../shared/transcript';

const VERSION = '0.1.0-poc';
const CONFIG_FILE = path.join(os.homedir(), '.locaith', 'cli.json');

interface Options {
  command: 'doctor' | 'ask' | 'consent' | 'login' | 'whoami' | 'help' | 'version';
  prompt?: string;
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
  const o: Options = { command: 'help', model: LOCAITH_MODEL_FLASH, baseUrl: LOCAITH_GATEWAY_URL, cwd: process.cwd(), allow: 'reads', maxTurns: 30, json: false, quiet: false, timeoutSec: 900, yes: false, noBrowser: false };
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
    if (this.allow === 'all') return allow;
    if (this.allow === 'none' || !process.stdin.isTTY) return deny;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const a = await rl.question(`\nCho phép ${req.title}? [y/N] `);
      return /^y(es)?$/i.test(a.trim()) ? allow : deny;
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
    const text = (last?.content ?? []).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
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
