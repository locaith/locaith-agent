/**
 * Lệnh `locaith provider` (0.4.1): quản lý nhà cung cấp mô hình ở dòng lệnh — danh sách, thêm API tuỳ chỉnh, lưu/xoá khoá, gỡ, thử kết nối.
 *
 *   locaith provider                         danh sách (mặc định)
 *   locaith provider add [mẫu|id] [--url …]  thêm API tuỳ chỉnh (không đối số + có terminal → trình hướng dẫn)
 *   locaith provider key <id>                lưu/đổi khoá (ô nhập ẩn; hoặc --key-stdin / --key-env TÊN)   · --remove: xoá khoá đã lưu
 *   locaith provider remove <id>             gỡ API tuỳ chỉnh và/hoặc khoá đã lưu
 *   locaith provider test [id]               thử kết nối (hỏi danh sách model)
 *
 * KHÔNG bao giờ nhận khoá ở dòng lệnh (lộ trong lịch sử shell/tiến trình): chỉ qua ô nhập ẩn, stdin hoặc biến môi trường.
 */

import type { CustomProviderConfig } from '../core/providers/registry';
import type { ProviderKind } from '../core/types';
import type { ParsedArgs } from './args';
import { t, type Lang } from './i18n';
import {
  PROVIDER_ID_RE,
  PROVIDER_KINDS,
  RESERVED_IDS,
  KeyStoreCorruptError,
  ProviderConfigError,
  SettingsCorruptError,
  checkBaseUrl,
  classifyHost,
  cleanKey,
  customEnvName,
  effectiveVendorUrl,
  quickPresetById,
  readUserCustomRaw,
  removeStoredKey,
  saveStoredKey,
  upsertCustomProvider,
  urlProblemText,
  validateCustomProviders,
  vendorById,
} from './providerStore';
import { addProviderFlow, askKey, envWinsNote, keyFlow, removeNow, renderList, testLine, type WizardDeps, type WizardIO } from './providerWizard';
import { SettingsStore } from './runtime/config';
import { CliProviders, type ProviderRow, type ProviderTestResult } from './runtime/providers';
import './strings';

export interface ProviderCmdDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  lang: Lang;
  version: string;
  out(line: string): void;
  err(line: string): void;
  /** stdin và stdout đều là terminal tương tác. */
  isTTY: boolean;
  /** Đọc hết stdin (cho --key-stdin). */
  readStdin(): Promise<string>;
  /** Chạy một đoạn hội thoại trên giao diện terminal (hộp chọn/ô nhập). Vắng = không có giao diện (script/CI). */
  withUi?<T>(fn: (io: WizardIO) => Promise<T>): Promise<T>;
  fetchImpl?: typeof fetch;
}

export function makeProviders(d: Pick<ProviderCmdDeps, 'home' | 'env' | 'cwd' | 'lang' | 'version' | 'fetchImpl'>): CliProviders {
  const settings = new SettingsStore({ home: d.home, cwd: d.cwd, env: d.env, trusted: () => false });
  return new CliProviders({ home: d.home, env: d.env, version: d.version, settings, fetchImpl: d.fetchImpl, log: () => undefined, lang: () => d.lang });
}

/** Phần dùng chung của `WizardDeps` cho lệnh ở terminal: nạp lại + thử kết nối bằng một `CliProviders` mới đọc lại cấu hình. */
export function wizardDeps(d: ProviderCmdDeps): WizardDeps {
  const fresh = () => makeProviders(d);
  return {
    home: d.home,
    env: d.env,
    lang: d.lang,
    test: (id) => fresh().test(id),
    list: () => renderList(fresh().rows(), fresh().problems(), d.lang, 'plain'),
    testable: () => fresh().rows().filter((r) => r.usable && r.id !== 'locaith').map((r) => ({ id: r.id, label: r.label })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Danh sách
// ─────────────────────────────────────────────────────────────────────────────

function listCmd(a: ParsedArgs, d: ProviderCmdDeps): number {
  const prov = makeProviders(d);
  const rows = prov.rows();
  const problems = prov.problems();
  if (a.json || a.outputFormat === 'json') {
    d.out(JSON.stringify({ providers: rows.map((r) => ({ id: r.id, label: r.label, baseUrl: r.baseUrl, kind: r.kind, builtin: r.builtin, usable: r.usable, key: r.key })), problems }, null, 2));
    return 0;
  }
  d.out(renderList(rows, problems, d.lang, 'plain'));
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Khoá từ stdin / biến môi trường
// ─────────────────────────────────────────────────────────────────────────────

type KeyInput = { kind: 'none' } | { kind: 'key'; key: string } | { kind: 'error'; message: string };

async function keyFromFlags(p: NonNullable<ParsedArgs['provider']>, d: ProviderCmdDeps): Promise<KeyInput> {
  if (p.keyStdin && p.keyEnv) return { kind: 'error', message: t('cli.prov.cmd.keyBoth', {}, d.lang) };
  let raw: string | undefined;
  if (p.keyStdin) {
    raw = (await d.readStdin()).split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
    if (!raw.trim()) return { kind: 'error', message: t('cli.prov.cmd.stdinEmpty', {}, d.lang) };
  } else if (p.keyEnv) {
    raw = d.env[p.keyEnv] ?? '';
    if (!raw.trim()) return { kind: 'error', message: t('cli.prov.cmd.envEmpty', { env: p.keyEnv }, d.lang) };
  }
  if (raw === undefined) return { kind: 'none' };
  const c = cleanKey(raw);
  return c.ok ? { kind: 'key', key: c.key } : { kind: 'error', message: t(`cli.prov.key.${c.code}`, {}, d.lang) };
}

// ─────────────────────────────────────────────────────────────────────────────
// add
// ─────────────────────────────────────────────────────────────────────────────

async function addCmd(a: ParsedArgs, d: ProviderCmdDeps): Promise<number> {
  const p = a.provider!;
  const target = p.args[0];
  if (!target) {
    if (d.isTTY && d.withUi) {
      const r = await d.withUi((io) => addProviderFlow(io, wizardDeps(d)));
      return r ? 0 : 1;
    }
    d.err(t('cli.prov.cmd.addUsage', {}, d.lang));
    return 2;
  }
  if (vendorById(target)) return keyCmd({ ...a, provider: { ...p, action: 'key', args: [target] } }, d);

  const preset = quickPresetById(target);
  const id = (p.id ?? preset?.id ?? target).trim().toLowerCase();
  if (!PROVIDER_ID_RE.test(id)) {
    d.err(t('cli.prov.cfg.badId', { at: `«${id}»` }, d.lang));
    return 2;
  }
  if (RESERVED_IDS.has(id)) {
    d.err(t('cli.prov.cfg.reservedId', { at: `«${id}»` }, d.lang));
    return 2;
  }
  const url = (p.url ?? preset?.baseUrl ?? '').trim();
  if (!url) {
    d.err(t('cli.prov.cmd.needUrl', { id }, d.lang));
    return 2;
  }
  let kind: ProviderKind | undefined;
  if (p.kind !== undefined) {
    kind = PROVIDER_KINDS.find((k) => k === p.kind);
    if (!kind) {
      d.err(t('cli.prov.cfg.badKind', { at: `«${id}»`, kinds: PROVIDER_KINDS.join(' | ') }, d.lang));
      return 2;
    }
  }
  // Cần khoá? --no-key nói rõ; mẫu có sẵn theo mẫu; người dùng đưa nguồn khoá (--key-stdin / --key-env) thì hiển nhiên là có;
  // còn lại: https → cần, http tới máy này/mạng nội bộ → không.
  let zoneLocal = false;
  try {
    zoneLocal = classifyHost(new URL(url).hostname) !== 'public' && /^http:/i.test(url);
  } catch {
    /* địa chỉ sai: checkBaseUrl bên dưới báo */
  }
  const keyFlagGiven = p.keyStdin || !!p.keyEnv;
  const requiresKey = p.noKey ? false : preset ? preset.requiresKey : keyFlagGiven ? true : !zoneLocal;
  const chk = checkBaseUrl(url, { requiresKey });
  if (!chk.ok) {
    d.err(urlProblemText(chk, d.lang));
    return 2;
  }
  const entry: CustomProviderConfig = {
    id,
    label: (p.label ?? preset?.label ?? id).trim(),
    ...(kind ? { kind } : {}),
    baseUrl: chk.url,
    ...(p.models && p.models.length ? { models: p.models } : {}),
    requiresKey,
    ...(preset?.keyUrl ? { keyUrl: preset.keyUrl } : {}),
  };

  const ki = await keyFromFlags(p, d);
  if (ki.kind === 'error') {
    d.err(ki.message);
    return 2;
  }
  let key = ki.kind === 'key' ? ki.key : undefined;
  if (!requiresKey && key) {
    d.err(t('cli.prov.cmd.keyNotNeeded', { id }, d.lang));
    return 2;
  }

  let file: string;
  let replaced: boolean;
  try {
    ({ file, replaced } = upsertCustomProvider(d.home, entry, d.lang));
  } catch (err) {
    d.err(describe(err, d.lang));
    return err instanceof ProviderConfigError ? 2 : 1;
  }
  d.out(`✔ ${t(replaced ? 'cli.prov.w.updated' : 'cli.prov.w.added', { id, file }, d.lang)}`);

  // Khoá: từ cờ; hoặc hỏi (ô nhập ẩn) khi có terminal; còn lại dùng biến môi trường.
  if (requiresKey && !key && d.isTTY && d.withUi) {
    const asked = await d.withUi((io) => askKey(io, wizardDeps(d), { label: entry.label, keyUrl: entry.keyUrl, envName: customEnvName(id) }));
    if (asked) key = asked;
  }
  if (key) {
    try {
      const f = saveStoredKey(d.home, id, key, chk.url);
      d.out(`✔ ${t('cli.prov.w.keySaved', { label: entry.label, file: f }, d.lang)}`);
      const wins = envWinsNote(d, id);
      if (wins) d.out(`! ${wins}`);
    } catch (err) {
      d.err(describe(err, d.lang));
      return 1;
    }
  } else if (requiresKey) d.out(`! ${t('cli.prov.cmd.keyLater', { env: customEnvName(id), id }, d.lang)}`);

  if (!p.noTest && (key || !requiresKey)) {
    const prov = makeProviders(d);
    const l = testLine(d.lang, id, await prov.test(id), prov.hasPinnedModels(id));
    d.out(`${l.ok ? '✔' : '!'} ${l.text}`);
  }
  d.out(t('cli.prov.w.useHint', { id }, d.lang));
  return 0;
}

function describe(err: unknown, lang: Lang): string {
  if (err instanceof SettingsCorruptError) return t('cli.prov.cmd.settingsCorrupt', { detail: err.message }, lang);
  if (err instanceof KeyStoreCorruptError) return t('cli.prov.cmd.keysCorrupt', { detail: err.message }, lang);
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// key
// ─────────────────────────────────────────────────────────────────────────────

async function keyCmd(a: ParsedArgs, d: ProviderCmdDeps): Promise<number> {
  const p = a.provider!;
  const id = (p.args[0] ?? '').trim();
  if (!id) {
    if (d.isTTY && d.withUi && !p.remove && !p.keyStdin && !p.keyEnv) return (await d.withUi((io) => keyFlow(io, wizardDeps(d)))) ? 0 : 1;
    d.err(t('cli.prov.cmd.keyUsage', {}, d.lang));
    return 2;
  }
  if (id === 'locaith') {
    d.err(t('cli.prov.cmd.useLogin', {}, d.lang));
    return 2;
  }
  if (p.remove) {
    try {
      const removed = removeStoredKey(d.home, id);
      d.out(removed ? `✔ ${t('cli.prov.cmd.keyRemoved', { id }, d.lang)}` : t('cli.prov.cmd.noSavedKey', { id }, d.lang));
      return removed ? 0 : 1;
    } catch (err) {
      d.err(describe(err, d.lang));
      return 1;
    }
  }
  const vendor = vendorById(id);
  const custom = validateCustomProviders(readUserCustomRaw(d.home), d.lang).valid.find((c) => c.id === id);
  if (!vendor && !custom) {
    d.err(t('cli.prov.w.unknown', { id }, d.lang));
    return 1;
  }
  const label = vendor?.label ?? custom!.label;
  const url = vendor ? effectiveVendorUrl(d.home, id, d.lang) : custom!.baseUrl;
  const ki = await keyFromFlags(p, d);
  if (ki.kind === 'error') {
    d.err(ki.message);
    return 2;
  }
  let key = ki.kind === 'key' ? ki.key : undefined;
  if (!key) {
    if (!(d.isTTY && d.withUi)) {
      d.err(t('cli.prov.cmd.keyUsage', {}, d.lang));
      return 2;
    }
    const asked = await d.withUi((io) => askKey(io, wizardDeps(d), { label, keyUrl: vendor?.keyUrl ?? custom?.keyUrl, envName: vendor?.envNames[0] ?? customEnvName(id) }));
    if (!asked) return 1;
    key = asked;
  }
  try {
    const file = saveStoredKey(d.home, id, key, url);
    d.out(`✔ ${t('cli.prov.w.keySaved', { label, file }, d.lang)}`);
    const wins = envWinsNote(d, id);
    if (wins) d.out(`! ${wins}`);
  } catch (err) {
    d.err(describe(err, d.lang));
    return 1;
  }
  if (!p.noTest) {
    const prov = makeProviders(d);
    const l = testLine(d.lang, id, await prov.test(id), prov.hasPinnedModels(id));
    d.out(`${l.ok ? '✔' : '!'} ${l.text}`);
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// remove, test
// ─────────────────────────────────────────────────────────────────────────────

async function removeCmd(a: ParsedArgs, d: ProviderCmdDeps): Promise<number> {
  const id = (a.provider!.args[0] ?? '').trim();
  if (!id) {
    d.err(t('cli.prov.cmd.removeUsage', {}, d.lang));
    return 2;
  }
  if (id === 'locaith') {
    d.err(t('cli.prov.cmd.useLogin', {}, d.lang));
    return 2;
  }
  try {
    const r = removeNow({ home: d.home }, id);
    if (!r.def && !r.key) {
      d.err(t('cli.prov.cmd.nothingToRemove', { id }, d.lang));
      return 1;
    }
    if (r.def) d.out(`✔ ${t('cli.prov.cmd.defRemoved', { id, file: r.file ?? '' }, d.lang)}`);
    if (r.key) d.out(`✔ ${t('cli.prov.cmd.keyRemoved', { id }, d.lang)}`);
    const names = vendorById(id)?.envNames ?? [customEnvName(id)];
    const stillEnv = names.find((n) => (d.env[n] ?? '').trim());
    if (stillEnv) d.out(`! ${t('cli.prov.cmd.envStill', { env: stillEnv }, d.lang)}`);
    return 0;
  } catch (err) {
    d.err(describe(err, d.lang));
    return 1;
  }
}

async function testCmd(a: ParsedArgs, d: ProviderCmdDeps): Promise<number> {
  const prov = makeProviders(d);
  const want = a.provider!.args[0];
  const ids = want ? [want] : prov.rows().filter((r) => r.usable && r.id !== 'locaith').map((r) => r.id);
  if (want && !prov.service.has(want)) {
    d.err(t('cli.prov.w.unknown', { id: want }, d.lang));
    return 1;
  }
  if (ids.length === 0) {
    d.out(t('cli.prov.w.nothingToTest', {}, d.lang));
    return 0;
  }
  let bad = 0;
  const out: Array<{ id: string; text: string } & ProviderTestResult> = [];
  for (const id of ids) {
    if (!prov.hasKey(id)) {
      // Chưa có khoá: không gọi mạng (khỏi gửi yêu cầu chắc chắn bị từ chối).
      const error = id === 'locaith' ? t('cli.prov.cmd.useLogin', {}, d.lang) : t('cli.prov.test.noKey', { id }, d.lang);
      out.push({ id, ok: false, ms: 0, reason: 'auth', error, text: error });
      bad++;
      continue;
    }
    const r = await prov.test(id);
    if (!r.ok) bad++;
    out.push({ id, ...r, text: testLine(d.lang, id, r, prov.hasPinnedModels(id)).text });
  }
  if (a.json || a.outputFormat === 'json') d.out(JSON.stringify({ ok: bad === 0, results: out.map(({ text: _text, ...r }) => r) }, null, 2));
  else for (const r of out) d.out(`${r.ok ? '✔' : '✘'} ${r.text}`);
  return bad === 0 ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// cửa vào
// ─────────────────────────────────────────────────────────────────────────────

export async function runProviderCommand(a: ParsedArgs, d: ProviderCmdDeps): Promise<number> {
  const p = a.provider ?? { action: 'list', args: [], noKey: false, keyStdin: false, remove: false, noTest: false };
  const args: ParsedArgs = { ...a, provider: p };
  // Đối số thừa — thường là người dùng gõ khoá ngay sau lệnh. KHÔNG in lại đối số; nhắc khoá đã lộ trong lịch sử shell.
  const maxArgs: Record<string, number> = { list: 0, ls: 0, add: 1, new: 1, key: 1, 'set-key': 1, remove: 1, rm: 1, delete: 1, test: 1 };
  if (p.action in maxArgs && p.args.length > maxArgs[p.action]!) {
    d.err(t('cli.prov.cmd.extraArgs', {}, d.lang));
    return 2;
  }
  switch (p.action) {
    case 'list':
    case 'ls':
      return listCmd(args, d);
    case 'add':
    case 'new':
      return addCmd(args, d);
    case 'key':
    case 'set-key':
      return keyCmd(args, d);
    case 'remove':
    case 'rm':
    case 'delete':
      return removeCmd(args, d);
    case 'test':
      return testCmd(args, d);
    default:
      d.err(t('cli.prov.cmd.usage', { action: p.action }, d.lang));
      return 2;
  }
}

