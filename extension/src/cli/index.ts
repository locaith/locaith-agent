#!/usr/bin/env node
/**
 * Locaith CLI — cửa vào. Chọn chế độ rồi giao cho: giao diện tương tác (`tui/`), chế độ in một lần (`print.ts`),
 * hoặc lệnh con (doctor, login, logout, whoami, consent, update, sessions, config, help, version).
 * Lõi chạy (engine, công cụ, phiên, quyền, hooks, MCP…) nằm ở `runtime/` và dùng CHUNG với extension VS Code.
 *
 * Khoá: LOCAITH_API_KEY (khuyến nghị cho máy chủ) hoặc `locaith login` (lưu ~/.locaith/cli.json, quyền 600). Không in/ghi khoá ra log.
 */

import './strings';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_ACCOUNT_CONFIG } from '../core/account/config';
import { createProvider } from '../core/providers';
import { ACCOUNT_PRESETS, BUILTIN_PRESETS } from '../core/providers/presets';
import { gatewayDiagnosticHeaders } from '../core/providers/gatewayDiagnostics';
import { LOCAITH_GATEWAY_URL, LOCAITH_MODEL_FLASH, LOCAITH_PROVIDER_ID, LocaithGatewayClient } from '../core/providers/locaithGateway';
import { loginCmd, whoamiCmd, type AccountDeps } from './account';
import { UsageError, parseArgs, type ParsedArgs } from './args';
import { deviceLabel, loginWithBrowser } from './browserLogin';
import { configFile, hasByokKey, homeDir, readApiKey, removeApiKey, writeApiKey } from './credentials';
import { doctor } from './doctor';
import { HELP_TOPICS, helpTopicText, topicList, usageText } from './help';
import { detectLang, getLang, setLang, t, type Lang } from './i18n';
import { runPrint, type PrintDeps } from './print';
import { runProviderCommand, wizardDeps, type ProviderCmdDeps } from './providerCmd';
import { knownProviders } from './providerStore';
import { addProviderFlow, wizardIoFromUi, type WizardIO } from './providerWizard';
import { createRuntime, isDirTrusted, NotLoggedInError, trustDir } from './runtime';
import { SessionRepo } from './runtime/sessions';
import { runOnboarding, runTui, withTerminalUi } from './tui';
import { compareVersions, latestKnown, runUpdate, updateAvailable } from './update';

export const VERSION = '0.4.1';

// ── nhỏ gọn: ngôn ngữ, tin cậy, tiện ích ─────────────────────────────────────────────────────────

function savedLang(env: NodeJS.ProcessEnv): Lang | undefined {
  try {
    const j = JSON.parse(readFileSync(path.join(homeDir(env), '.locaith', 'settings.json'), 'utf8')) as { language?: unknown };
    return j.language === 'en' || j.language === 'vi' ? j.language : undefined;
  } catch {
    return undefined;
  }
}

function resolveLang(a: ParsedArgs, env: NodeJS.ProcessEnv): Lang {
  return a.lang ?? savedLang(env) ?? detectLang(env);
}

/** Thư mục (hoặc thư mục cha của nó) đã được tin cậy? Cùng danh sách `~/.locaith/trusted.json` mà lõi chạy dùng. */
async function isTrusted(cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    return isDirTrusted(homeDir(env), cwd);
  } catch {
    return false;
  }
}

/**
 * Đọc stdin tới hết (EOF). `firstByteMs`: sau chừng đó mà chưa có byte nào (ống mở nhưng im lặng — hay gặp khi một chương trình khác
 * gọi `locaith -p "việc"` và để ngỏ stdin) thì thôi, trả null để chạy tiếp mà không có dữ liệu ống. Đã có byte đầu thì đọc tới EOF.
 */
function readStdin(firstByteMs?: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const stdin = process.stdin;
    const finish = (v: string | null): void => {
      if (timer) clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onEnd);
      if (v === null) stdin.pause(); // không giữ tiến trình sống vì một ống im lặng
      resolve(v);
    };
    const onData = (c: Buffer | string): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    };
    const onEnd = (): void => finish(Buffer.concat(chunks).toString('utf8'));
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onEnd);
    if (firstByteMs && firstByteMs > 0) timer = setTimeout(() => finish(null), firstByteMs);
  });
}

function accountDeps(a: ParsedArgs, env: NodeJS.ProcessEnv): AccountDeps {
  const baseUrl = a.baseUrl ?? LOCAITH_GATEWAY_URL;
  return {
    baseUrl,
    readKey: () => readApiKey(env),
    writeKey: (k) => writeApiKey(k, env),
    ask: async (m) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(m);
      } finally {
        rl.close();
      }
    },
    json: a.json || a.outputFormat === 'json',
    listModels: async () => {
      const key = readApiKey(env);
      const preset = [...BUILTIN_PRESETS, ...ACCOUNT_PRESETS].find((p) => p.id === LOCAITH_PROVIDER_ID);
      if (!key || !preset) return [];
      return createProvider({
        id: preset.id,
        label: preset.label,
        kind: preset.kind,
        flavor: preset.flavor,
        baseUrl,
        getApiKey: async () => key,
        requestHeaders: (c) => gatewayDiagnosticHeaders({ family: 'cli', version: VERSION, sessionKey: c.sessionKey }),
      }).fetchModels();
    },
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    noBrowser: a.noBrowser,
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
async function consent(a: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const json = a.json || a.outputFormat === 'json';
  const key = readApiKey(env);
  if (!key) throw new Error(t('cli.login.needed'));
  const client = new LocaithGatewayClient({ baseUrl: () => a.baseUrl ?? LOCAITH_GATEWAY_URL });
  const cur = await client.getConsent(key);
  if (!cur.ok) {
    const why = t(cur.error === 'unauthorized' ? 'cli.acct.bad.unauthorized' : cur.error === 'network' ? 'cli.acct.bad.network' : 'cli.acct.bad.server');
    if (json) console.log(JSON.stringify({ ok: false, error: why }));
    else console.error(`✘ ${why}`);
    return 1;
  }
  if (cur.state.accepted) {
    if (json) console.log(JSON.stringify({ ok: true, already: true, version: cur.state.version }));
    else console.log(`✔ ${t('cli.consentCmd.already', { v: cur.state.version })}`);
    return 0;
  }
  if (!a.yes) {
    if (json) console.log(JSON.stringify({ ok: false, needsConsent: true, current: cur.state.current }));
    else console.error(t('cli.consentCmd.needs', { v: cur.state.current }));
    return 1;
  }
  const r = await client.postConsent(key, cur.state.current, 'cli');
  if (!r.ok) {
    const why = r.error === 'unauthorized' ? t('cli.acct.bad.unauthorized') : r.error === 'network' ? t('cli.acct.bad.network') : t('cli.consent.rejected', { why: r.message ?? '—' });
    if (json) console.log(JSON.stringify({ ok: false, error: why }));
    else console.error(`✘ ${why}`);
    return 1;
  }
  if (json) console.log(JSON.stringify({ ok: true, version: cur.state.current }));
  else console.log(`✔ ${t('cli.consentCmd.done', { v: cur.state.current })}`);
  return 0;
}

// ── chế độ in một lần / tương tác ─────────────────────────────────────────────────────────────────

function printDeps(a: ParsedArgs, env: NodeJS.ProcessEnv, lang: Lang): PrintDeps {
  return {
    createRuntime: (opts) => createRuntime({ ...opts, env, home: homeDir(env) }),
    readStdin,
    stdinPiped: !process.stdin.isTTY,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    version: VERSION,
    isTrusted: (cwd) => isTrusted(cwd, env),
    lang,
  };
}

/** Ghi `language` vào ~/.locaith/settings.json (giữ nguyên các khoá khác; tệp hỏng thì KHÔNG ghi đè). Quyền 600. */
function saveLanguage(l: Lang, env: NodeJS.ProcessEnv): void {
  const file = path.join(homeDir(env), '.locaith', 'settings.json');
  let cur: Record<string, unknown> = {};
  try {
    const raw = readFileSync(file, 'utf8');
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return;
    cur = j as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  cur.language = l;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* không ghi được thì thôi: lần sau hỏi lại */
  }
}

function gatewayClient(a: ParsedArgs, timeoutMs?: number): LocaithGatewayClient {
  return new LocaithGatewayClient({ baseUrl: () => a.baseUrl ?? LOCAITH_GATEWAY_URL, ...(timeoutMs ? { timeoutMs } : {}) });
}

/** Tài khoản (khoá Locaith) đã đồng ý thông báo dữ liệu chưa? Không rõ (khoá hãng khác, mất mạng) → true: không chặn người dùng vì lỗi mạng. */
async function consentAlreadyAccepted(a: ParsedArgs, env: NodeJS.ProcessEnv): Promise<boolean> {
  const key = readApiKey(env);
  if (!key) return true;
  const cur = await gatewayClient(a, 4000).getConsent(key);
  return !cur.ok || cur.state.accepted;
}

/** Bấm «Tôi đồng ý» ở onboarding → ghi nhận ở cổng (cùng bản ghi với `locaith consent --yes` và bản VS Code). */
async function acceptConsentNow(a: ParsedArgs, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message?: string }> {
  const key = readApiKey(env);
  if (!key) return { ok: true };
  const client = gatewayClient(a);
  const cur = await client.getConsent(key);
  if (!cur.ok) return { ok: false, message: t(cur.error === 'unauthorized' ? 'cli.consent.unauthorized' : 'cli.consent.network') };
  if (cur.state.accepted) return { ok: true };
  const r = await client.postConsent(key, cur.state.current, 'cli');
  if (r.ok) return { ok: true };
  return { ok: false, message: r.error === 'unauthorized' ? t('cli.consent.unauthorized') : r.error === 'network' ? t('cli.consent.network') : t('cli.consent.rejected', { why: r.message ?? '—' }) };
}

/** Phụ thuộc cho `locaith provider …` và bước «dùng khoá hãng khác» của màn hình hướng dẫn lần đầu. */
function providerDeps(a: ParsedArgs, env: NodeJS.ProcessEnv, lang: Lang): ProviderCmdDeps {
  const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
  return {
    home: homeDir(env),
    env,
    cwd: a.cwd,
    lang,
    version: VERSION,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    isTTY: tty,
    // stdin là terminal (quên đưa khoá qua ống): KHÔNG đợi người dùng gõ — chữ gõ vào sẽ hiện nguyên trên màn hình. Trả rỗng để lệnh báo «hãy đưa khoá vào».
    readStdin: async () => (process.stdin.isTTY ? '' : ((await readStdin()) ?? '')),
    ...(tty ? { withUi: <T>(fn: (io: WizardIO) => Promise<T>) => withTerminalUi({ version: VERSION, lang, cwd: a.cwd, env, noColor: a.noColor }, (ui) => fn(wizardIoFromUi(ui))) } : {}),
  };
}

async function chat(a: ParsedArgs, env: NodeJS.ProcessEnv, lang: Lang): Promise<number> {
  const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (!tty) {
    // Không có terminal: nếu có việc (đối số hoặc ống stdin) thì chạy như `-p`, ngược lại báo cách dùng.
    if (a.prompt || !process.stdin.isTTY) return runPrint({ ...a, command: 'print' }, printDeps(a, env, lang));
    console.error(t('cli.tty.required'));
    return 2;
  }

  const home = homeDir(env);
  let trusted = await isTrusted(a.cwd, env);
  const loggedIn = !!readApiKey(env) || hasByokKey(env);
  const languageChosen = !!a.lang || !!env.LOCAITH_LANG?.trim() || !!savedLang(env);
  let curLang = lang;
  if (!loggedIn || !trusted || !languageChosen) {
    const r = await runOnboarding({
      version: VERSION,
      lang,
      cwd: a.cwd,
      env,
      noColor: a.noColor,
      languageChosen,
      loggedIn,
      consentAccepted: false,
      checkConsent: () => consentAlreadyAccepted(a, env),
      trusted,
      accountDeps: (io) => ({ ...accountDeps(a, env), ask: io.ask, out: io.out, err: io.err }),
      acceptConsent: () => acceptConsentNow(a, env),
      saveLang: (l) => saveLanguage(l, env),
      byokKnown: () => knownProviders(home, env, getLang()),
      byokSetup: async (io) => !!(await addProviderFlow(io, wizardDeps(providerDeps(a, env, getLang())))),
      saveTrust: (v) => {
        if (v) trustDir(home, a.cwd);
      },
    });
    if (r.cancelled) {
      if (r.reason === 'untrusted') console.error(t('cli.trust.declined'));
      else if (r.reason === 'byok-missing') console.error(t('cli.byok.missing'));
      return 1;
    }
    curLang = r.lang;
    setLang(curLang);
    trusted = r.trusted;
  }

  let rt;
  try {
    rt = await createRuntime({
      cwd: a.cwd,
      home,
      version: VERSION,
      interactive: true,
      model: a.model,
      baseUrl: a.baseUrl,
      permissionMode: a.permissionMode,
      allowedTools: a.allowedTools,
      disallowedTools: a.disallowedTools,
      addDirs: a.addDirs,
      appendSystemPrompt: a.appendSystemPrompt,
      maxTurns: a.maxTurns,
      timeoutSec: a.timeoutSec,
      mcpConfig: a.mcpConfig,
      resume: a.resume ?? (a.continueLast ? true : undefined),
      noPersist: a.noPersist,
      lang: curLang,
      verbose: a.verbose,
      trusted,
      env,
    });
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  try {
    return await runTui(rt, { version: VERSION, lang: curLang, cwd: a.cwd, env, noColor: a.noColor, home, initialPrompt: a.prompt });
  } finally {
    await rt.dispose();
  }
}

// ── lệnh con ───────────────────────────────────────────────────────────────────────────────────────

async function update(a: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  console.error(t('cli.update.checking'));
  const latest = await latestKnown(env, { force: true });
  if (!latest) {
    console.error(t('cli.update.offline'));
    return 1;
  }
  if (compareVersions(VERSION, latest) >= 0) {
    console.log(t('cli.update.latest', { v: VERSION }));
    return 0;
  }
  console.log(t('cli.update.available', { latest, current: VERSION }));
  if (a.flags.check) return 0;
  return runUpdate(env, (l) => console.log(l));
}

function configCmd(a: ParsedArgs, env: NodeJS.ProcessEnv): number {
  const home = homeDir(env);
  const lines = [
    t('cli.config.title'),
    `  version        ${VERSION}`,
    `  home           ${path.join(home, '.locaith')}`,
    `  settings       ${path.join(home, '.locaith', 'settings.json')}`,
    `  project        ${path.join(a.cwd, '.locaith', 'settings.json')}`,
    `  local          ${path.join(a.cwd, '.locaith', 'settings.local.json')}`,
    `  key file       ${configFile(env)}`,
    `  sessions       ${path.join(home, '.locaith', 'sessions')}`,
    `  mcp            ${path.join(home, '.locaith', 'mcp.json')} · ${path.join(a.cwd, '.mcp.json')}`,
    `  memory         ${path.join(a.cwd, 'LOCAITH.md')} · ${path.join(home, '.locaith', 'LOCAITH.md')}`,
  ];
  console.log(lines.join('\n'));
  return 0;
}

async function sessionsCmd(a: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const repo = new SessionRepo(homeDir(env), a.cwd, VERSION);
  const rows = await repo.list(a.flags.all ? 'all' : 'cwd');
  if (a.json || a.outputFormat === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log(t('cli.sessions.none'));
    return 0;
  }
  console.log(t('cli.sessions.header'));
  for (const s of rows.slice(0, 40)) console.log(`  ${s.id.slice(0, 8)}  ${new Date(s.updatedAt).toLocaleString()}  ${(s.model ?? '').padEnd(18)} ${s.title}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const env = process.env;
  let a: ParsedArgs;
  try {
    a = parseArgs(argv);
  } catch (err) {
    const lang = detectLang(env);
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${usageText(VERSION, lang)}`);
    return err instanceof UsageError ? 2 : 1;
  }
  if (a.noColor) env.NO_COLOR = '1';
  const lang = resolveLang(a, env);
  setLang(lang);

  try {
    switch (a.command) {
      case 'version':
        console.log(VERSION);
        return 0;
      case 'help': {
        if (a.topic) {
          const txt = helpTopicText(a.topic, lang);
          if (txt) return console.log(txt), 0;
          console.error(lang === 'en' ? `No help topic "${a.topic}".` : `Không có chủ đề "${a.topic}".`);
          console.error(topicList(lang));
          return 2;
        }
        console.log(usageText(VERSION, lang));
        return 0;
      }
      case 'doctor':
        return await doctor({ cwd: a.cwd, baseUrl: a.baseUrl, model: a.model, json: a.json || a.outputFormat === 'json', version: VERSION, lang, env, out: (l) => console.log(l), isTrusted: (c) => isTrusted(c, env) });
      case 'login':
        return await loginCmd(accountDeps(a, env));
      case 'whoami':
        return await whoamiCmd(accountDeps(a, env));
      case 'logout': {
        const file = configFile(env);
        const removed = removeApiKey(env);
        console.log(removed ? t('cli.logout.done', { file }) : t('cli.logout.none'));
        return 0;
      }
      case 'consent':
        return await consent(a, env);
      case 'update':
        return await update(a, env);
      case 'config':
        return configCmd(a, env);
      case 'sessions':
        return await sessionsCmd(a, env);
      case 'provider':
        return await runProviderCommand(a, providerDeps(a, env, lang));
      case 'print':
        return await runPrint(a, printDeps(a, env, lang));
      case 'chat':
        return await chat(a, env, lang);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (a.json || a.outputFormat === 'json') console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`✘ ${msg}`);
    return 1;
  }
}

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

// Chỉ chạy khi là chương trình chính (test import các hàm khác không kích hoạt).
if (process.env.LOCAITH_NO_MAIN !== '1') {
  main(process.argv.slice(2))
    .then((code) => {
      // Không gọi process.exit() ngay sau khi có I/O: trên Windows làm libuv abort (0xC0000409) và mất mã thoát đúng.
      process.exitCode = code;
      closeDispatcher();
      setTimeout(forceQuit, 1500).unref?.();
    })
    .catch((err) => {
      console.error(`✘ ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      closeDispatcher();
    });
}

export { main, HELP_TOPICS, updateAvailable, LOCAITH_MODEL_FLASH };
