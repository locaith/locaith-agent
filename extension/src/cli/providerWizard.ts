/**
 * Trình hướng dẫn nhà cung cấp (0.4.1): thêm API tuỳ chỉnh / lưu khoá hãng khác / gỡ / thử kết nối. MỘT logic, ba nơi dùng:
 *   • `locaith provider add|key|remove` ở terminal (qua TerminalUi của onboarding),
 *   • `/provider` trong phiên (qua `ask` của lõi chạy),
 *   • bước «dùng khoá hãng khác» của màn hình hướng dẫn lần đầu.
 * Chỉ nói chuyện qua `WizardIO` nên kiểm thử được bằng giao diện giả. Mọi thay đổi đi qua providerStore (kiểm hợp lệ trước khi ghi).
 */

import type { CustomProviderConfig } from '../core/providers/registry';
import { t, type Lang } from './i18n';
import {
  BUILTIN_VENDORS,
  PROVIDER_ID_RE,
  QUICK_PRESETS,
  RESERVED_IDS,
  ProviderConfigError,
  checkBaseUrl,
  cleanKey,
  customEnvName,
  effectiveVendorUrl,
  providerKeysFile,
  quickPresetById,
  readStoredKeys,
  readUserCustomRaw,
  removeCustomProvider,
  removeStoredKey,
  saveStoredKey,
  upsertCustomProvider,
  urlProblemText,
  validateCustomProviders,
  vendorById,
} from './providerStore';
import type { PickItem } from './runtime/contract';
import type { ProviderRow, ProviderTestResult } from './runtime/providers';
import { isPlainObject } from './runtime/util';
import './strings';

export type SayKind = 'info' | 'ok' | 'warn' | 'error' | 'text';

/** Cổng vào/ra của trình hướng dẫn (hộp chọn, ô nhập, xác nhận, thông báo). Trả null khi người dùng huỷ (Esc). */
export interface WizardIO {
  pick(title: string, items: PickItem[], hint?: string): Promise<string | null>;
  input(title: string, detail: string, o?: { secret?: boolean; initial?: string; placeholder?: string }): Promise<string | null>;
  confirm(title: string, detail: string, o?: { yes?: string; no?: string; danger?: boolean; defaultYes?: boolean }): Promise<boolean | null>;
  say(kind: SayKind, text: string): void;
}

export type TestResult = ProviderTestResult;

export interface WizardDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  lang: Lang;
  /** Đọc lại cấu hình sau khi ghi (nạp lại registry của lõi chạy trong phiên). */
  reload?(): void;
  /** Thử kết nối tới nhà cung cấp `id` (đã ghi và nạp lại). Vắng = không thử. */
  test?(id: string): Promise<TestResult>;
  /** Có khoá mới được lưu: để che khỏi nhật ký. */
  onKey?(key: string): void;
  /** Văn bản danh sách nhà cung cấp (markdown/plain) cho mục «Danh sách» của menu. */
  list?(): string;
  /** Nhà cung cấp thử kết nối được (đã có khoá/không cần khoá). */
  testable?(): Array<{ id: string; label: string }>;
}

/** Bọc một giao diện kiểu `OnboardingUi` (TerminalUi) thành `WizardIO`. */
export interface UiLike {
  pick(title: string, items: PickItem[], hint?: string): Promise<string | null>;
  confirm(title: string, detail: string, o?: { yes?: string; no?: string; danger?: boolean }): Promise<boolean | null>;
  input(title: string, detail: string, secret?: boolean, o?: { initial?: string; placeholder?: string }): Promise<string | null>;
  say(kind: SayKind, text: string): void;
}

export function wizardIoFromUi(ui: UiLike): WizardIO {
  return {
    pick: (title, items, hint) => ui.pick(title, items, hint),
    input: (title, detail, o) => ui.input(title, detail, o?.secret ?? false, { initial: o?.initial, placeholder: o?.placeholder }),
    confirm: (title, detail, o) => ui.confirm(title, detail, o),
    say: (kind, text) => ui.say(kind, text),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phần dùng chung
// ─────────────────────────────────────────────────────────────────────────────

const tr = (d: WizardDeps, key: string, vars?: Record<string, string | number>): string => t(key, vars, d.lang);

/**
 * Dòng kết quả thử kết nối, theo ĐÚNG nguyên nhân: không tới được máy chủ · khoá bị từ chối · máy chủ trả lời nhưng không có /models
 * (nhiều máy chủ OpenAI-compatible không có /models mà vẫn chat được — nên nhắc khi đã ghim model).
 */
export function testLine(lang: Lang, id: string, r: TestResult, pinned = false): { ok: boolean; text: string } {
  if (r.ok) return { ok: true, text: r.models === undefined ? t('cli.prov.test.okNoCount', { id, ms: r.ms }, lang) : t('cli.prov.test.ok', { id, n: r.models, ms: r.ms }, lang) };
  const error = (r.error ?? '').slice(0, 240);
  const key = r.reason === 'auth' ? 'cli.prov.test.auth' : r.reason === 'no-models' ? (pinned ? 'cli.prov.test.failPinned' : 'cli.prov.test.noModels') : 'cli.prov.test.fail';
  return { ok: false, text: t(key, { id, error }, lang) };
}

/** API tuỳ chỉnh `id` (trong cài đặt người dùng) có ghim sẵn danh sách model không. */
function isPinned(d: Pick<WizardDeps, 'home' | 'lang'>, id: string): boolean {
  return (validateCustomProviders(readUserCustomRaw(d.home), d.lang).valid.find((c) => c.id === id)?.models?.length ?? 0) > 0;
}

export function reportTest(io: WizardIO, d: WizardDeps, id: string, r: TestResult): void {
  const l = testLine(d.lang, id, r, isPinned(d, id));
  io.say(l.ok ? 'ok' : 'warn', l.text);
}

async function testAndReport(io: WizardIO, d: WizardDeps, id: string): Promise<void> {
  if (!d.test) return;
  io.say('info', tr(d, 'cli.prov.w.testing', { id }));
  reportTest(io, d, id, await d.test(id));
}

/**
 * Hỏi khoá (ô nhập ẩn). Trả: khoá đã làm sạch · '' nếu người dùng để trống (sẽ dùng biến môi trường) · null nếu huỷ.
 * Khoá sai dạng (có khoảng trắng, quá dài) được hỏi lại tối đa 3 lần.
 */
export async function askKey(io: WizardIO, d: WizardDeps, o: { label: string; keyUrl?: string; envName: string }): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    const raw = await io.input(tr(d, 'cli.prov.w.keyTitle', { label: o.label }), tr(d, 'cli.prov.w.keyDetail', { url: o.keyUrl ? tr(d, 'cli.prov.w.keyUrl', { url: o.keyUrl }) : '', env: o.envName }), {
      secret: true,
      placeholder: 'sk-…',
    });
    if (raw === null) return null;
    if (!raw.trim()) return '';
    const c = cleanKey(raw);
    if (c.ok) return c.key;
    io.say('warn', tr(d, `cli.prov.key.${c.code}`));
  }
  return null;
}

/** Biến môi trường THẮNG khoá đã lưu: nếu nó đang đặt thì khoá vừa lưu sẽ không được dùng — nói rõ để khỏi khó hiểu. */
export function envWinsNote(d: Pick<WizardDeps, 'env' | 'lang'>, id: string): string | undefined {
  const names = vendorById(id)?.envNames ?? [customEnvName(id)];
  const set = names.find((n) => (d.env[n] ?? '').trim().length > 0);
  return set ? t('cli.prov.w.envWins', { env: set }, d.lang) : undefined;
}

/** Ghi khoá cho một nhà cung cấp, gắn với địa chỉ hiện tại; nạp lại; báo; thử kết nối. */
function storeKey(io: WizardIO, d: WizardDeps, id: string, label: string, key: string, url: string): void {
  const file = saveStoredKey(d.home, id, key, url);
  d.onKey?.(key);
  d.reload?.();
  io.say('ok', tr(d, 'cli.prov.w.keySaved', { label, file }));
  const note = envWinsNote(d, id);
  if (note) io.say('warn', note);
}

function slugFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // Địa chỉ IP (10.0.0.5 → «10») không gợi ra tên có nghĩa.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return 'custom';
    const host = hostname.replace(/^api\./, '').replace(/^www\./, '');
    const first = host.split('.')[0] ?? '';
    const slug = first.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    return PROVIDER_ID_RE.test(slug) && !RESERVED_IDS.has(slug) ? slug : 'custom';
  } catch {
    return 'custom';
  }
}

function parseModels(raw: string): string[] {
  return raw
    .split(/[,\n;]/)
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, 64);
}

// ─────────────────────────────────────────────────────────────────────────────
// Thêm nhà cung cấp
// ─────────────────────────────────────────────────────────────────────────────

/** Hãng dựng sẵn: chỉ cần khoá. Trả true nếu đã lưu khoá. */
export async function vendorKeyFlow(io: WizardIO, d: WizardDeps, id: string): Promise<boolean> {
  const v = vendorById(id);
  if (!v) return false;
  const key = await askKey(io, d, { label: v.label, keyUrl: v.keyUrl, envName: v.envNames[0] ?? customEnvName(id) });
  if (key === null) return false;
  if (key === '') {
    io.say('info', tr(d, 'cli.prov.w.keyBlank', { env: v.envNames[0] ?? customEnvName(id) }));
    return false;
  }
  storeKey(io, d, id, v.label, key, effectiveVendorUrl(d.home, id, d.lang));
  await testAndReport(io, d, id);
  io.say('info', tr(d, 'cli.prov.w.useHintVendor', { id }));
  return true;
}

/** API tương thích OpenAI (mẫu sẵn hoặc địa chỉ bất kỳ). Trả id đã thêm, hoặc null nếu huỷ. */
export async function customFlow(io: WizardIO, d: WizardDeps, preset?: { id: string; label: string; baseUrl: string; requiresKey: boolean; keyUrl?: string }): Promise<{ id: string } | null> {
  let requiresKey = preset?.requiresKey ?? true;
  if (!preset) {
    const need = await io.confirm(tr(d, 'cli.prov.w.needKeyTitle'), tr(d, 'cli.prov.w.needKeyDetail'), { yes: tr(d, 'cli.prov.w.needKeyYes'), no: tr(d, 'cli.prov.w.needKeyNo'), defaultYes: true });
    if (need === null) return null;
    requiresKey = need;
  }

  // Địa chỉ (hỏi lại khi bị từ chối, kèm lý do)
  let url: string | undefined;
  let draft = preset?.baseUrl ?? 'https://';
  for (let i = 0; i < 4 && !url; i++) {
    const raw = await io.input(tr(d, 'cli.prov.w.urlTitle'), tr(d, 'cli.prov.w.urlDetail'), { initial: draft, placeholder: 'https://api.example.com/v1' });
    if (raw === null) return null;
    draft = raw;
    const chk = checkBaseUrl(raw, { requiresKey });
    if (chk.ok) url = chk.url;
    else io.say('warn', urlProblemText(chk, d.lang));
  }
  if (!url) return null;

  // id
  const existing = new Set(readUserCustomRaw(d.home).map((x) => (isPlainObject(x) ? String(x.id) : '')));
  let id: string | undefined;
  let idDraft = preset?.id ?? slugFromUrl(url);
  for (let i = 0; i < 4 && !id; i++) {
    const raw = await io.input(tr(d, 'cli.prov.w.idTitle'), tr(d, 'cli.prov.w.idDetail'), { initial: idDraft });
    if (raw === null) return null;
    const v = raw.trim().toLowerCase();
    idDraft = v;
    if (!PROVIDER_ID_RE.test(v)) io.say('warn', tr(d, 'cli.prov.cfg.badId', { at: `«${v}»` }));
    else if (RESERVED_IDS.has(v)) io.say('warn', tr(d, 'cli.prov.cfg.reservedId', { at: `«${v}»` }));
    else if (existing.has(v)) {
      const ow = await io.confirm(tr(d, 'cli.prov.w.overwriteTitle', { id: v }), tr(d, 'cli.prov.w.overwriteDetail'), { danger: true, defaultYes: false });
      if (ow === null) return null;
      if (ow) id = v;
    } else id = v;
  }
  if (!id) return null;

  const labelRaw = await io.input(tr(d, 'cli.prov.w.labelTitle'), '', { initial: preset?.label ?? id });
  if (labelRaw === null) return null;
  const label = labelRaw.trim() || id;

  const modelsRaw = await io.input(tr(d, 'cli.prov.w.modelsTitle'), tr(d, 'cli.prov.w.modelsDetail'), { placeholder: 'qwen3-coder, llama3.3' });
  if (modelsRaw === null) return null;
  const models = parseModels(modelsRaw);

  let key: string | undefined;
  if (requiresKey) {
    const k = await askKey(io, d, { label, keyUrl: preset?.keyUrl, envName: customEnvName(id) });
    if (k === null) return null;
    if (k) key = k;
    else io.say('info', tr(d, 'cli.prov.w.keyBlank', { env: customEnvName(id) }));
  }

  const entry: CustomProviderConfig = { id, label, baseUrl: url, requiresKey, ...(models.length ? { models } : {}), ...(preset?.keyUrl ? { keyUrl: preset.keyUrl } : {}) };
  try {
    const r = upsertCustomProvider(d.home, entry, d.lang);
    io.say('ok', tr(d, r.replaced ? 'cli.prov.w.updated' : 'cli.prov.w.added', { id, file: r.file }));
  } catch (err) {
    io.say('error', err instanceof ProviderConfigError || err instanceof Error ? err.message : String(err));
    return null;
  }
  if (key) storeKey(io, d, id, label, key, url);
  else d.reload?.();
  await testAndReport(io, d, id);
  io.say('info', tr(d, 'cli.prov.w.useHint', { id }));
  return { id };
}

/** Màn «Thêm nhà cung cấp»: chọn hãng dựng sẵn / mẫu / địa chỉ khác rồi đi tiếp. Trả id nếu đã thêm hoặc lưu khoá, null nếu huỷ. */
export async function addProviderFlow(io: WizardIO, d: WizardDeps): Promise<{ id: string } | null> {
  const items: PickItem[] = [
    ...BUILTIN_VENDORS.map((v) => ({ id: `v:${v.id}`, label: v.label, detail: tr(d, 'cli.prov.w.vendorDetail', { env: v.envNames[0] ?? '' }), group: tr(d, 'cli.prov.w.grpVendors') })),
    ...QUICK_PRESETS.map((p) => ({ id: `p:${p.id}`, label: p.label, detail: p.note ?? p.baseUrl, group: tr(d, 'cli.prov.w.grpOpenAI') })),
    { id: 'custom', label: tr(d, 'cli.prov.w.custom'), detail: tr(d, 'cli.prov.w.customDetail'), group: tr(d, 'cli.prov.w.grpOpenAI') },
  ];
  const pick = await io.pick(tr(d, 'cli.prov.w.addTitle'), items, tr(d, 'cli.prov.w.addHint'));
  if (!pick) return null;
  if (pick.startsWith('v:')) {
    const id = pick.slice(2);
    return (await vendorKeyFlow(io, d, id)) ? { id } : null;
  }
  if (pick.startsWith('p:')) return customFlow(io, d, quickPresetById(pick.slice(2)));
  return customFlow(io, d);
}

// ─────────────────────────────────────────────────────────────────────────────
// Đặt / đổi khoá, gỡ, thử, menu
// ─────────────────────────────────────────────────────────────────────────────

interface Target {
  id: string;
  label: string;
  url: string;
  env: string;
  keyUrl?: string;
}

function targets(d: WizardDeps): Target[] {
  const customs = validateCustomProviders(readUserCustomRaw(d.home), d.lang).valid;
  return [
    ...BUILTIN_VENDORS.map<Target>((v) => ({ id: v.id, label: v.label, url: effectiveVendorUrl(d.home, v.id, d.lang), env: v.envNames[0] ?? customEnvName(v.id), keyUrl: v.keyUrl })),
    ...customs.map<Target>((c) => ({ id: c.id, label: c.label, url: c.baseUrl, env: customEnvName(c.id), keyUrl: c.keyUrl })),
  ];
}

function stateOf(d: WizardDeps, tg: Target): string {
  const names = vendorById(tg.id)?.envNames ?? [customEnvName(tg.id)];
  if (names.some((n) => (d.env[n] ?? '').trim())) return tr(d, 'cli.prov.state.env');
  return tr(d, readStoredKeys(d.home).keys[tg.id] ? 'cli.prov.state.saved' : 'cli.prov.state.none');
}

/** Đặt hoặc đổi khoá của một nhà cung cấp (hỏi chọn nếu chưa biết id). */
export async function keyFlow(io: WizardIO, d: WizardDeps, id?: string): Promise<boolean> {
  if (id === 'locaith') {
    io.say('info', tr(d, 'cli.prov.cmd.useLogin'));
    return false;
  }
  const all = targets(d);
  let tg = id ? all.find((x) => x.id === id) : undefined;
  if (id && !tg) {
    io.say('error', tr(d, 'cli.prov.w.unknown', { id }));
    return false;
  }
  if (!tg) {
    const pick = await io.pick(
      tr(d, 'cli.prov.w.keyPickTitle'),
      all.map((x) => ({ id: x.id, label: x.label, detail: stateOf(d, x) })),
    );
    if (!pick) return false;
    tg = all.find((x) => x.id === pick);
  }
  if (!tg) return false;
  const key = await askKey(io, d, { label: tg.label, keyUrl: tg.keyUrl, envName: tg.env });
  if (key === null) return false;
  if (key === '') {
    io.say('info', tr(d, 'cli.prov.w.keyBlank', { env: tg.env }));
    return false;
  }
  storeKey(io, d, tg.id, tg.label, key, tg.url);
  await testAndReport(io, d, tg.id);
  return true;
}

/** Gỡ một API tuỳ chỉnh (và khoá đã lưu của nó) hoặc chỉ khoá đã lưu của một hãng. */
export async function removeFlow(io: WizardIO, d: WizardDeps): Promise<boolean> {
  const customs = validateCustomProviders(readUserCustomRaw(d.home), d.lang).valid;
  const stored = readStoredKeys(d.home).keys;
  const ids = [...new Set([...customs.map((c) => c.id), ...Object.keys(stored)])];
  if (ids.length === 0) {
    io.say('info', tr(d, 'cli.prov.w.nothingToRemove'));
    return false;
  }
  const label = (id: string): string => customs.find((c) => c.id === id)?.label ?? vendorById(id)?.label ?? id;
  const pick = await io.pick(
    tr(d, 'cli.prov.w.removeTitle'),
    ids.map((id) => ({
      id,
      label: label(id),
      detail: [customs.some((c) => c.id === id) ? tr(d, 'cli.prov.w.rmDef') : '', stored[id] ? tr(d, 'cli.prov.w.rmKey') : ''].filter(Boolean).join(' + '),
    })),
  );
  if (!pick) return false;
  const ok = await io.confirm(tr(d, 'cli.prov.w.removeConfirm', { label: label(pick) }), tr(d, 'cli.prov.w.removeConfirmDetail'), { danger: true, defaultYes: false });
  if (ok !== true) return false;
  const r = removeNow(d, pick);
  d.reload?.();
  io.say('ok', tr(d, 'cli.prov.w.removed', { id: pick }));
  return r.def || r.key;
}

/** Gỡ định nghĩa (nếu là API tuỳ chỉnh của người dùng) và khoá đã lưu. Không hỏi. */
export function removeNow(d: Pick<WizardDeps, 'home'>, id: string): { def: boolean; key: boolean; file?: string } {
  const def = removeCustomProvider(d.home, id);
  const key = removeStoredKey(d.home, id);
  return { def: def.removed, key, ...(def.removed ? { file: def.file } : {}) };
}

export async function testFlow(io: WizardIO, d: WizardDeps, id?: string): Promise<void> {
  if (!d.test) return;
  const list = d.testable?.() ?? [];
  let target = id;
  if (!target) {
    if (list.length === 0) return io.say('info', tr(d, 'cli.prov.w.nothingToTest'));
    const pick = await io.pick(tr(d, 'cli.prov.w.testTitle'), list.map((x) => ({ id: x.id, label: x.label })));
    if (!pick) return;
    target = pick;
  }
  io.say('info', tr(d, 'cli.prov.w.testing', { id: target }));
  reportTest(io, d, target, await d.test(target));
}

/** Menu của `/provider` (không đối số, trong phiên tương tác). */
export async function providerMenu(io: WizardIO, d: WizardDeps): Promise<void> {
  const pick = await io.pick(tr(d, 'cli.prov.w.menuTitle'), [
    { id: 'list', label: tr(d, 'cli.prov.w.mList'), detail: tr(d, 'cli.prov.w.mListD') },
    { id: 'add', label: tr(d, 'cli.prov.w.mAdd'), detail: tr(d, 'cli.prov.w.mAddD') },
    { id: 'key', label: tr(d, 'cli.prov.w.mKey'), detail: tr(d, 'cli.prov.w.mKeyD') },
    { id: 'remove', label: tr(d, 'cli.prov.w.mRemove'), detail: tr(d, 'cli.prov.w.mRemoveD') },
    { id: 'test', label: tr(d, 'cli.prov.w.mTest'), detail: tr(d, 'cli.prov.w.mTestD') },
  ]);
  switch (pick) {
    case 'list':
      io.say('text', d.list?.() ?? '');
      return;
    case 'add':
      await addProviderFlow(io, d);
      return;
    case 'key':
      await keyFlow(io, d);
      return;
    case 'remove':
      await removeFlow(io, d);
      return;
    case 'test':
      await testFlow(io, d);
      return;
    default:
      return;
  }
}

/** Đường dẫn tệp khoá (để hiện cho người dùng). */
export { providerKeysFile };

// ─────────────────────────────────────────────────────────────────────────────
// Danh sách nhà cung cấp dạng chữ
// ─────────────────────────────────────────────────────────────────────────────

function keyText(r: ProviderRow, lang: Lang): string {
  switch (r.key.source) {
    case 'login':
      return t('cli.prov.list.login', {}, lang);
    case 'env':
      return t('cli.prov.list.env', { env: r.key.env ?? '' }, lang);
    case 'saved':
      return t('cli.prov.list.saved', {}, lang);
    case 'not-required':
      return t('cli.prov.list.notRequired', {}, lang);
    case 'mismatch':
      return t('cli.prov.list.mismatch', { url: r.key.savedUrl ?? '' }, lang);
    default:
      // Nhà cung cấp «locaith» dùng TÀI KHOẢN, không dùng khoá API: chỉ cho đúng lối vào (`locaith login`).
      if (r.id === 'locaith') return t('cli.prov.list.loginNeeded', {}, lang);
      return t('cli.prov.list.none', { env: vendorById(r.id)?.envNames[0] ?? customEnvName(r.id), id: r.id }, lang);
  }
}

/** Danh sách nhà cung cấp dạng chữ (markdown cho `/provider list`, thuần chữ cho terminal). */
export function renderList(rows: ProviderRow[], problems: string[], lang: Lang, style: 'markdown' | 'plain'): string {
  const lines: string[] = [];
  if (style === 'markdown') {
    lines.push(`**${t('cli.prov.list.title', {}, lang)}**`, '');
    for (const r of rows) lines.push(`- ${r.usable ? '✔' : '○'} **${r.id}** — ${r.label}${r.baseUrl ? ` · \`${r.baseUrl}\`` : ''} · ${keyText(r, lang)}`);
  } else {
    lines.push(t('cli.prov.list.title', {}, lang));
    const w = Math.max(8, ...rows.map((r) => r.id.length));
    for (const r of rows) lines.push(`  ${r.usable ? '✔' : '○'} ${r.id.padEnd(w)}  ${r.label} · ${r.baseUrl || '—'} · ${keyText(r, lang)}`);
  }
  if (problems.length) {
    lines.push('', t('cli.prov.list.problems', {}, lang));
    for (const p of problems) lines.push(style === 'markdown' ? `- ! ${p}` : `  ! ${p}`);
  }
  lines.push('', t('cli.prov.list.hint', {}, lang));
  return lines.join('\n');
}

