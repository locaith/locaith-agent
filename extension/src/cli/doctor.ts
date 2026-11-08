/**
 * `locaith doctor` — kiểm máy có đủ điều kiện chạy Locaith CLI và nói cách sửa.
 * Ba mức: ✔ ok · ! cảnh báo (tuỳ chọn, không làm doctor thất bại) · ✘ lỗi (mã thoát 1).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { createProvider } from '../core/providers';
import { ACCOUNT_PRESETS, BUILTIN_PRESETS } from '../core/providers/presets';
import { gatewayDiagnosticHeaders } from '../core/providers/gatewayDiagnostics';
import { LOCAITH_GATEWAY_URL, LOCAITH_MODEL_FLASH, LOCAITH_PROVIDER_ID, LocaithGatewayClient } from '../core/providers/locaithGateway';
import { configFile, hasByokKey, maskKey, readApiKey } from './credentials';
import { updateAvailable } from './update';
import type { Lang } from './i18n';

export type Level = 'ok' | 'warn' | 'fail';
export interface Check {
  name: string;
  level: Level;
  detail: string;
}

export interface DoctorOptions {
  cwd: string;
  baseUrl?: string;
  model?: string;
  json: boolean;
  version: string;
  lang: Lang;
  env?: NodeJS.ProcessEnv;
  out(line: string): void;
  /** Kiểm tin cậy thư mục (do lõi cung cấp). */
  isTrusted?(cwd: string): boolean | Promise<boolean>;
}

function toolVersion(cmd: string, arg = '-version'): string | undefined {
  try {
    const r = spawnSync(cmd, [arg], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (r.status !== 0 || !r.stdout) return undefined;
    return r.stdout.split('\n')[0]?.trim().slice(0, 90);
  } catch {
    return undefined;
  }
}

function diskFreeGb(dir: string): number | undefined {
  try {
    const s = statfsSync(dir);
    return Math.round(((s.bavail * s.bsize) / 1e9) * 10) / 10;
  } catch {
    return undefined;
  }
}

/** Mức màu của terminal: 'truecolor' | '256' | '16' | 'none'. */
export function colorLevel(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout.isTTY): 'truecolor' | '256' | '16' | 'none' {
  if (!isTTY || 'NO_COLOR' in env || env.TERM === 'dumb') return 'none';
  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit' || env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'iTerm.app') return 'truecolor';
  if ((env.TERM ?? '').includes('256')) return '256';
  return process.platform === 'win32' ? '256' : '16';
}

export async function runChecks(o: DoctorOptions): Promise<Check[]> {
  const env = o.env ?? process.env;
  const t = (vi: string, en: string): string => (o.lang === 'en' ? en : vi);
  const rows: Check[] = [];
  const add = (name: string, level: Level, detail: string): void => void rows.push({ name, level, detail });

  const major = Number(process.versions.node.split('.')[0]);
  const src = env.LOCAITH_NODE_SOURCE === 'bundled' ? t('Node đi kèm gói pip', 'Node bundled with the pip package') : t('Node của hệ thống', 'system Node');
  add('Node.js', major >= 20 ? 'ok' : 'fail', `${process.versions.node} (${src})${major >= 20 ? '' : t(' — cần 20 trở lên', ' — needs 20 or newer')}`);
  add('Locaith CLI', 'ok', `${o.version}${env.LOCAITH_LAUNCHER ? ` · ${env.LOCAITH_LAUNCHER}` : ''}`);

  const isTTY = !!process.stdout.isTTY && !!process.stdin.isTTY;
  const color = colorLevel(env);
  const utf8 = !/^(c|posix)$/i.test(env.LC_ALL ?? env.LANG ?? 'utf8') || process.platform === 'win32';
  add(
    t('Terminal', 'Terminal'),
    isTTY ? 'ok' : 'warn',
    isTTY
      ? `${process.stdout.columns ?? '?'}×${process.stdout.rows ?? '?'} · ${t('màu', 'color')}: ${color} · ${utf8 ? 'UTF-8' : t('không phải UTF-8 (đặt LOCAITH_ASCII=1)', 'not UTF-8 (set LOCAITH_ASCII=1)')}${env.WT_SESSION ? ' · Windows Terminal' : ''}`
      : t('không có terminal tương tác — chỉ dùng được chế độ -p (in một lần)', 'no interactive terminal — only -p (print mode) works'),
  );

  const git = toolVersion('git', '--version');
  add('git', git ? 'ok' : 'warn', git ?? t('chưa có — cần để hiện nhánh, diff và một số kỹ năng', 'not found — used for branch, diff and some skills'));
  const ff = toolVersion('ffmpeg');
  const fp = toolVersion('ffprobe');
  add('ffmpeg', ff ? 'ok' : 'warn', ff ?? t('chưa có — chỉ cần cho kỹ năng video (winget install Gyan.FFmpeg / apt install ffmpeg / brew install ffmpeg)', 'not found — only needed for video skills (winget install Gyan.FFmpeg / apt install ffmpeg / brew install ffmpeg)'));
  add('ffprobe', fp ? 'ok' : 'warn', fp ?? t('chưa có — đi kèm ffmpeg', 'not found — ships with ffmpeg'));
  const free = diskFreeGb(o.cwd);
  add(t('Đĩa trống', 'Free disk'), (free ?? 99) >= 2 ? 'ok' : 'warn', free === undefined ? t('không đọc được', 'unreadable') : `${free} GB`);

  let trusted: boolean | undefined;
  try {
    trusted = o.isTrusted ? await o.isTrusted(o.cwd) : undefined;
  } catch {
    trusted = undefined;
  }
  if (trusted !== undefined) add(t('Thư mục tin cậy', 'Trusted folder'), trusted ? 'ok' : 'warn', trusted ? o.cwd : t(`chưa tin cậy ${o.cwd} — hooks/MCP/lệnh của dự án sẽ không chạy`, `${o.cwd} not trusted — project hooks/MCP/commands will not run`));

  const key = readApiKey(env);
  const baseUrl = o.baseUrl ?? LOCAITH_GATEWAY_URL;
  const model = o.model ?? LOCAITH_MODEL_FLASH;
  if (!key) {
    const byok = hasByokKey(env);
    add(t('Khoá Locaith', 'Locaith key'), byok ? 'warn' : 'fail', byok ? t('chưa có, nhưng có khoá hãng khác trong môi trường (BYOK)', 'none, but another vendor key is in the environment (BYOK)') : t(`chưa có — chạy \`locaith login\` (hoặc đặt LOCAITH_API_KEY; tệp ${configFile(env)})`, `none — run \`locaith login\` (or set LOCAITH_API_KEY; file ${configFile(env)})`));
  } else {
    add(t('Khoá Locaith', 'Locaith key'), 'ok', t(`đã có (${maskKey(key)})`, `present (${maskKey(key)})`));
    const t0 = Date.now();
    try {
      const preset = [...BUILTIN_PRESETS, ...ACCOUNT_PRESETS].find((p) => p.id === LOCAITH_PROVIDER_ID);
      if (!preset) throw new Error(t('bản dựng này không có provider Locaith', 'this build has no Locaith provider'));
      const provider = createProvider({
        id: preset.id,
        label: preset.label,
        kind: preset.kind,
        flavor: preset.flavor,
        baseUrl,
        getApiKey: async () => key,
        requestHeaders: (c) => gatewayDiagnosticHeaders({ family: 'cli', version: o.version, sessionKey: c.sessionKey }),
      });
      const ids = (await provider.fetchModels()).map((m) => m.id);
      add(t('Cổng Locaith', 'Locaith gateway'), ids.includes(model) ? 'ok' : 'warn', `${baseUrl} — ${Date.now() - t0} ms, ${ids.length} model${ids.includes(model) ? t(`, có ${model}`, `, ${model} available`) : t(` — KHÔNG thấy ${model}`, ` — ${model} NOT listed`)}`);
      const c = await new LocaithGatewayClient({ baseUrl: () => baseUrl }).getConsent(key);
      add(
        t('Thông báo dữ liệu', 'Data notice'),
        c.ok && c.state.accepted ? 'ok' : 'warn',
        c.ok ? (c.state.accepted ? t(`đã đồng ý (bản ${c.state.version})`, `accepted (v${c.state.version})`) : t('CHƯA đồng ý — chạy `locaith consent --yes`', 'NOT accepted — run `locaith consent --yes`')) : t('không kiểm được', 'could not check'),
      );
    } catch (err) {
      add(t('Cổng Locaith', 'Locaith gateway'), 'fail', err instanceof Error ? err.message : String(err));
    }
  }

  try {
    const u = await updateAvailable(o.version, env);
    if (u.latest) add(t('Bản mới', 'Updates'), u.newer ? 'warn' : 'ok', u.newer ? t(`có ${u.latest} (đang ${o.version}) — chạy \`locaith update\``, `${u.latest} available (you have ${o.version}) — run \`locaith update\``) : t(`đang dùng bản mới nhất (${o.version})`, `up to date (${o.version})`));
  } catch {
    /* không có mạng: bỏ qua mục này */
  }

  void existsSync;
  return rows;
}

export async function doctor(o: DoctorOptions): Promise<number> {
  const rows = await runChecks(o);
  const ok = rows.every((r) => r.level !== 'fail');
  if (o.json) {
    o.out(JSON.stringify({ ok, checks: rows.map((r) => ({ name: r.name, ok: r.level !== 'fail', level: r.level, detail: r.detail })) }, null, 2));
  } else {
    const mark = (l: Level): string => (l === 'ok' ? '✔' : l === 'warn' ? '!' : '✘');
    for (const r of rows) o.out(`${mark(r.level)} ${r.name.padEnd(22)} ${r.detail}`);
    const warn = rows.some((r) => r.level === 'warn');
    o.out(
      '\n' +
        (ok
          ? warn
            ? o.lang === 'en'
              ? 'Locaith CLI will run. Items marked "!" are optional or worth a look.'
              : 'Locaith CLI chạy được. Mục có dấu «!» là tuỳ chọn hoặc nên xem lại.'
            : o.lang === 'en'
              ? 'This machine is ready for Locaith CLI.'
              : 'Máy này sẵn sàng chạy Locaith CLI.'
          : o.lang === 'en'
            ? 'Fix the ✘ items above, then run `locaith doctor` again.'
            : 'Sửa các mục ✘ ở trên rồi chạy lại `locaith doctor`.'),
    );
  }
  return ok ? 0 : 1;
}
