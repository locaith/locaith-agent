/**
 * Kho nhà cung cấp của CLI (0.4.1): khoá API đã LƯU cho hãng khác (BYOK), API tuỳ chỉnh (`customProviders`) và việc ghi cài đặt người dùng.
 * Thuần Node (không vscode, không phụ thuộc lõi chạy) để dùng chung cho lệnh `locaith provider`, `/provider` trong phiên và lõi chạy.
 *
 * Khoá lưu ở `~/.locaith/provider-keys.json` (quyền 600, ghi nguyên tử), TÁCH khỏi `cli.json` (khoá tài khoản Locaith) để CLI 0.3.x và 0.4.0 vẫn đọc
 * `cli.json` như cũ. Mỗi khoá GẮN VỚI ĐỊA CHỈ lúc lưu: nếu sau đó địa chỉ của nhà cung cấp đổi (cài đặt bị sửa, kho mã lạ ghi đè) thì khoá đã lưu KHÔNG được
 * gửi đi — chặn việc đổi địa chỉ để hứng khoá. Biến môi trường (`ANTHROPIC_API_KEY`, `<ID>_API_KEY`…) luôn thắng khoá đã lưu và không bị gắn địa chỉ.
 *
 * `customProviders` và `baseUrls` chỉ được đọc từ cài đặt NGƯỜI DÙNG (giống `scope: machine` của extension; xem SECURE_KEYS ở runtime/config.ts).
 */

import * as path from 'node:path';
import { BUILTIN_PRESETS, CUSTOM_PRESETS, type CustomPreset } from '../core/providers/presets';
import { LOCAITH_PROVIDER_ID } from '../core/providers/locaithGateway';
import type { CustomProviderConfig } from '../core/providers/registry';
import type { ProviderKind } from '../core/types';
import { t, type Lang } from './i18n';
import { isPlainObject, readJsonDetailed, writeFileAtomic } from './runtime/util';
import './strings';

// ─────────────────────────────────────────────────────────────────────────────
// Danh mục: hãng dựng sẵn + mẫu thêm nhanh
// ─────────────────────────────────────────────────────────────────────────────

export interface Vendor {
  id: string;
  label: string;
  baseUrl: string;
  envNames: string[];
  keyUrl?: string;
}

/** Năm hãng dựng sẵn (khoá qua biến môi trường hoặc `locaith provider key`). */
export const BUILTIN_VENDORS: Vendor[] = BUILTIN_PRESETS.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, envNames: p.envKeys, ...(p.keyUrl ? { keyUrl: p.keyUrl } : {}) }));

/** Mẫu thêm nhanh API tương thích OpenAI (OpenRouter, Ollama, LM Studio, Groq, Together, Mistral, Fireworks). */
export const QUICK_PRESETS: CustomPreset[] = CUSTOM_PRESETS;

/** id không được dùng cho API tuỳ chỉnh (trùng hãng dựng sẵn / nhà cung cấp hệ thống). */
export const RESERVED_IDS: ReadonlySet<string> = new Set([LOCAITH_PROVIDER_ID, 'demo', 'auto', ...BUILTIN_PRESETS.map((p) => p.id)]);

/** id có thể đặt địa chỉ qua `baseUrls`: các hãng dựng sẵn và cổng Locaith (registry không áp `baseUrls` cho API tuỳ chỉnh). */
const BASEURL_IDS: ReadonlySet<string> = new Set([LOCAITH_PROVIDER_ID, ...BUILTIN_PRESETS.map((p) => p.id)]);

/** Cùng mẫu với `locaithAgent.customProviders[].id` của extension. */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];

/** Tên biến môi trường chứa khoá của một API tuỳ chỉnh (giống registry). */
export function customEnvName(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

export function vendorById(id: string): Vendor | undefined {
  return BUILTIN_VENDORS.find((v) => v.id === id);
}

export function quickPresetById(id: string): CustomPreset | undefined {
  return QUICK_PRESETS.find((p) => p.id === id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Địa chỉ gốc: chỉ https, hoặc http tới máy này / mạng nội bộ (không kèm khoá)
// ─────────────────────────────────────────────────────────────────────────────

export type HostZone = 'loopback' | 'private' | 'public';

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const p = m.slice(1).map(Number);
  return p.every((n) => n >= 0 && n <= 255) ? p : undefined;
}

/** Phân loại máy chủ theo CHỮ (không phân giải DNS): máy này · mạng nội bộ · công cộng. */
export function classifyHost(rawHost: string): HostZone {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return 'loopback';
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 127) return 'loopback';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT / Tailscale
    return 'public';
  }
  if (host.includes(':')) {
    // IPv6 literal: fc00::/7 (ULA) và fe80::/10 (link-local) là mạng nội bộ
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return 'private';
    return 'public';
  }
  if (!host.includes('.')) return 'private'; // tên một nhãn (my-nas): chỉ phân giải được trong mạng nội bộ
  if (/\.(local|lan|internal|home\.arpa)$/.test(host)) return 'private';
  return 'public';
}

export type UrlCode = 'empty' | 'syntax' | 'scheme' | 'credentials' | 'http-public' | 'http-key';

export type UrlCheck = { ok: true; url: string; scheme: 'https' | 'http'; zone: HostZone } | { ok: false; code: UrlCode; host?: string };

/**
 * Kiểm địa chỉ gốc của một nhà cung cấp.
 *  - `https://…` luôn được (trừ khi kèm user:mật-khẩu).
 *  - `http://` chỉ cho máy này (localhost, 127.x, ::1) — và cho mạng nội bộ (10.x, 192.168.x, 172.16–31.x, *.local, Tailscale…) khi API KHÔNG đòi khoá,
 *    vì khoá sẽ đi qua mạng dạng văn bản thô. Địa chỉ công cộng qua http luôn bị từ chối.
 */
export function checkBaseUrl(raw: unknown, o: { requiresKey: boolean }): UrlCheck {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, code: 'empty' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, code: 'syntax' };
  }
  const scheme = u.protocol === 'https:' ? 'https' : u.protocol === 'http:' ? 'http' : undefined;
  if (!scheme) return { ok: false, code: 'scheme', host: u.protocol };
  if (!u.hostname) return { ok: false, code: 'syntax' };
  if (u.username || u.password) return { ok: false, code: 'credentials', host: u.hostname };
  const zone = classifyHost(u.hostname);
  if (scheme === 'http') {
    if (zone === 'public') return { ok: false, code: 'http-public', host: u.hostname };
    if (zone === 'private' && o.requiresKey) return { ok: false, code: 'http-key', host: u.hostname };
  }
  return { ok: true, url: s, scheme, zone };
}

/** Câu giải thích vì sao một địa chỉ bị từ chối (kèm cách sửa). */
export function urlProblemText(c: Extract<UrlCheck, { ok: false }>, lang: Lang): string {
  return t(`cli.prov.url.${c.code}`, { host: c.host ?? '' }, lang);
}

/** So sánh địa chỉ không phân biệt `/` cuối, hoa/thường của scheme/host, cổng mặc định. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Khoá đã lưu
// ─────────────────────────────────────────────────────────────────────────────

export function providerKeysFile(home: string): string {
  return path.join(home, '.locaith', 'provider-keys.json');
}

export interface StoredKey {
  key: string;
  /** Địa chỉ gốc lúc lưu — khoá chỉ dùng khi địa chỉ hiện tại còn khớp. */
  baseUrl: string;
  savedAt: string;
}

export interface KeyStoreRead {
  keys: Record<string, StoredKey>;
  /** Tệp có nhưng hỏng / sai dạng (không ghi đè khi chưa sửa). */
  problem?: string;
}

const KEY_MAX = 4096;

/** Làm sạch khoá do người dùng dán: bỏ khoảng trắng đầu/cuối và tiền tố `Bearer `; từ chối rỗng, có khoảng trắng/ký tự điều khiển, quá dài. */
export function cleanKey(raw: string): { ok: true; key: string } | { ok: false; code: 'empty' | 'space' | 'long' } {
  let k = String(raw ?? '').trim().replace(/^bearer\s+/i, '');
  if (!k) return { ok: false, code: 'empty' };
  if (/[\s\u0000-\u001f\u007f]/.test(k)) return { ok: false, code: 'space' };
  if (k.length > KEY_MAX) return { ok: false, code: 'long' };
  k = k.trim();
  return { ok: true, key: k };
}

export function readStoredKeys(home: string): KeyStoreRead {
  const file = providerKeysFile(home);
  const r = readJsonDetailed(file);
  if (!r.exists) return { keys: {} };
  if (r.error) return { keys: {}, problem: `${file}: ${r.error}` };
  if (!isPlainObject(r.value) || !isPlainObject(r.value.keys)) return { keys: {}, problem: `${file}: sai định dạng (cần { "version": 1, "keys": { … } })` };
  const keys: Record<string, StoredKey> = {};
  for (const [id, v] of Object.entries(r.value.keys)) {
    // Chỉ nhận id đúng dạng nhà cung cấp: tệp bị sửa với khoá «__proto__»… không được làm lệch đối tượng kết quả.
    if (!PROVIDER_ID_RE.test(id)) continue;
    if (!isPlainObject(v) || typeof v.key !== 'string' || typeof v.baseUrl !== 'string') continue;
    const c = cleanKey(v.key);
    if (c.ok) keys[id] = { key: c.key, baseUrl: v.baseUrl, savedAt: typeof v.savedAt === 'string' ? v.savedAt : '' };
  }
  return { keys };
}

export class KeyStoreCorruptError extends Error {
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = 'KeyStoreCorruptError';
  }
}

function writeKeys(home: string, keys: Record<string, StoredKey>): string {
  const file = providerKeysFile(home);
  writeFileAtomic(file, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, 0o600);
  return file;
}

/** Lưu (hoặc thay) khoá của một nhà cung cấp, gắn với địa chỉ gốc hiện tại. Trả đường dẫn tệp. */
export function saveStoredKey(home: string, id: string, key: string, baseUrl: string): string {
  const cur = readStoredKeys(home);
  if (cur.problem) throw new KeyStoreCorruptError(providerKeysFile(home), cur.problem);
  const c = cleanKey(key);
  if (!c.ok) throw new Error(`khoá không hợp lệ (${c.code})`);
  return writeKeys(home, { ...cur.keys, [id]: { key: c.key, baseUrl: baseUrl.trim(), savedAt: new Date().toISOString() } });
}

/** Xoá khoá đã lưu. Trả true nếu có khoá để xoá. */
export function removeStoredKey(home: string, id: string): boolean {
  const cur = readStoredKeys(home);
  if (cur.problem) throw new KeyStoreCorruptError(providerKeysFile(home), cur.problem);
  if (!Object.prototype.hasOwnProperty.call(cur.keys, id)) return false;
  const { [id]: _drop, ...rest } = cur.keys;
  writeKeys(home, rest);
  return true;
}

export type StoredKeyUse = { key: string } | { mismatch: { savedUrl: string } } | { none: true };

/** Khoá đã lưu dùng được cho nhà cung cấp `id` đang trỏ tới `effectiveBaseUrl`? Không khớp địa chỉ → KHÔNG dùng. */
export function storedKeyFor(home: string, id: string, effectiveBaseUrl: string): StoredKeyUse {
  const all = readStoredKeys(home).keys;
  const s = Object.prototype.hasOwnProperty.call(all, id) ? all[id] : undefined;
  if (!s) return { none: true };
  if (normalizeUrl(s.baseUrl) !== normalizeUrl(effectiveBaseUrl)) return { mismatch: { savedUrl: s.baseUrl } };
  return { key: s.key };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cài đặt người dùng: ghi customProviders (không đụng khoá khác; không ghi đè tệp hỏng)
// ─────────────────────────────────────────────────────────────────────────────

export function userSettingsFile(home: string): string {
  return path.join(home, '.locaith', 'settings.json');
}

export class SettingsCorruptError extends Error {
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = 'SettingsCorruptError';
  }
}

/** Đọc-sửa-ghi nguyên tử `~/.locaith/settings.json` (quyền 600). Tệp hỏng → ném `SettingsCorruptError`, KHÔNG ghi đè (khỏi mất cài đặt). */
export function updateUserSettings(home: string, mutate: (data: Record<string, unknown>) => void): string {
  const file = userSettingsFile(home);
  const cur = readJsonDetailed(file);
  if (cur.exists && cur.error) throw new SettingsCorruptError(file, cur.error);
  const data: Record<string, unknown> = cur.exists && isPlainObject(cur.value) ? { ...cur.value } : {};
  mutate(data);
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
  return file;
}

/** `customProviders` thô trong cài đặt người dùng (mảng, hoặc rỗng nếu chưa có/hỏng). */
export function readUserCustomRaw(home: string): unknown[] {
  const r = readJsonDetailed(userSettingsFile(home));
  if (!r.exists || r.error || !isPlainObject(r.value)) return [];
  const v = r.value.customProviders;
  return Array.isArray(v) ? v : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Kiểm cấu hình customProviders / baseUrls (dùng cho lõi chạy, doctor, provider list)
// ─────────────────────────────────────────────────────────────────────────────

export interface Validated<T> {
  valid: T;
  /** Câu mô tả từng mục bị bỏ qua và cách sửa. */
  problems: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Lọc `customProviders`: mục đúng dạng được giữ, mục sai bị bỏ KÈM lý do (thay vì lặng lẽ biến mất). */
export function validateCustomProviders(raw: unknown, lang: Lang): Validated<CustomProviderConfig[]> {
  const problems: string[] = [];
  const valid: CustomProviderConfig[] = [];
  if (raw === undefined || raw === null) return { valid, problems };
  if (!Array.isArray(raw)) return { valid, problems: [t('cli.prov.cfg.notArray', {}, lang)] };
  const seen = new Set<string>();
  raw.forEach((c, i) => {
    const at = `customProviders[${i}]`;
    if (!isPlainObject(c)) {
      problems.push(t('cli.prov.cfg.notObject', { at }, lang));
      return;
    }
    const id = str(c.id);
    if (!id) {
      problems.push(t('cli.prov.cfg.noId', { at }, lang));
      return;
    }
    const name = `${at} «${id}»`;
    if (!PROVIDER_ID_RE.test(id)) {
      problems.push(t('cli.prov.cfg.badId', { at: name }, lang));
      return;
    }
    if (RESERVED_IDS.has(id)) {
      problems.push(t('cli.prov.cfg.reservedId', { at: name }, lang));
      return;
    }
    if (seen.has(id)) {
      problems.push(t('cli.prov.cfg.dupId', { at: name }, lang));
      return;
    }
    const kind = c.kind === undefined ? undefined : PROVIDER_KINDS.find((k) => k === c.kind);
    if (c.kind !== undefined && !kind) {
      problems.push(t('cli.prov.cfg.badKind', { at: name, kinds: PROVIDER_KINDS.join(' | ') }, lang));
      return;
    }
    const requiresKey = c.requiresKey === true;
    const chk = checkBaseUrl(c.baseUrl, { requiresKey });
    if (!chk.ok) {
      problems.push(`${name}: ${urlProblemText(chk, lang)}`);
      return;
    }
    const models = Array.isArray(c.models) ? c.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim()) : undefined;
    seen.add(id);
    valid.push({
      id,
      label: str(c.label) ?? id,
      ...(kind ? { kind } : {}),
      baseUrl: chk.url,
      ...(models && models.length ? { models } : {}),
      ...(c.requiresKey !== undefined ? { requiresKey } : {}),
      ...(str(c.keyUrl) ? { keyUrl: str(c.keyUrl)! } : {}),
    });
  });
  return { valid, problems };
}

/** Lọc `baseUrls` (ghi đè địa chỉ hãng dựng sẵn): chỉ https hoặc http tới máy này (hãng dựng sẵn luôn đòi khoá). */
export function validateBaseUrls(raw: unknown, lang: Lang): Validated<Record<string, string>> {
  const valid: Record<string, string> = {};
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { valid, problems };
  if (!isPlainObject(raw)) return { valid, problems: [t('cli.prov.cfg.baseUrlsNotObject', {}, lang)] };
  for (const [id, url] of Object.entries(raw)) {
    // Registry chỉ áp `baseUrls` cho hãng dựng sẵn (và cổng Locaith); API tuỳ chỉnh dùng "baseUrl" riêng. Nhận khoá khác sẽ làm địa chỉ «hiệu lực» lệch địa chỉ thật được gọi.
    if (!BASEURL_IDS.has(id)) {
      problems.push(t('cli.prov.cfg.baseUrlNotBuiltin', { id, ids: BUILTIN_PRESETS.map((p) => p.id).join(' · ') }, lang));
      continue;
    }
    const chk = checkBaseUrl(url, { requiresKey: true });
    if (chk.ok) valid[id] = chk.url;
    else problems.push(`baseUrls.${id}: ${urlProblemText(chk, lang)}`);
  }
  return { valid, problems };
}

// ─────────────────────────────────────────────────────────────────────────────
// Thêm / gỡ API tuỳ chỉnh trong cài đặt người dùng
// ─────────────────────────────────────────────────────────────────────────────

export class ProviderConfigError extends Error {
  constructor(
    readonly code: 'id' | 'reserved' | 'kind' | 'url',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/** Ghi (thêm hoặc thay theo id) một API tuỳ chỉnh vào `~/.locaith/settings.json`. Kiểm hợp lệ TRƯỚC khi ghi. */
export function upsertCustomProvider(home: string, entry: CustomProviderConfig, lang: Lang): { file: string; replaced: boolean } {
  if (!PROVIDER_ID_RE.test(entry.id)) throw new ProviderConfigError('id', t('cli.prov.cfg.badId', { at: `«${entry.id}»` }, lang));
  if (RESERVED_IDS.has(entry.id)) throw new ProviderConfigError('reserved', t('cli.prov.cfg.reservedId', { at: `«${entry.id}»` }, lang));
  if (entry.kind !== undefined && !PROVIDER_KINDS.includes(entry.kind)) throw new ProviderConfigError('kind', t('cli.prov.cfg.badKind', { at: `«${entry.id}»`, kinds: PROVIDER_KINDS.join(' | ') }, lang));
  const chk = checkBaseUrl(entry.baseUrl, { requiresKey: entry.requiresKey === true });
  if (!chk.ok) throw new ProviderConfigError('url', urlProblemText(chk, lang));
  const clean: CustomProviderConfig = {
    id: entry.id,
    label: entry.label?.trim() || entry.id,
    ...(entry.kind && entry.kind !== 'openai-chat' ? { kind: entry.kind } : {}),
    baseUrl: chk.url,
    ...(entry.models && entry.models.length ? { models: entry.models } : {}),
    requiresKey: entry.requiresKey === true,
    ...(entry.keyUrl ? { keyUrl: entry.keyUrl } : {}),
  };
  let replaced = false;
  const file = updateUserSettings(home, (data) => {
    const list = Array.isArray(data.customProviders) ? [...data.customProviders] : [];
    const at = list.findIndex((x) => isPlainObject(x) && x.id === clean.id);
    if (at >= 0) {
      list[at] = clean;
      replaced = true;
    } else list.push(clean);
    data.customProviders = list;
  });
  return { file, replaced };
}

/** Gỡ một API tuỳ chỉnh khỏi cài đặt người dùng. Trả `removed:false` (và KHÔNG ghi lại tệp) nếu không có mục nào mang id đó. */
export function removeCustomProvider(home: string, id: string): { file: string; removed: boolean } {
  const file = userSettingsFile(home);
  if (!readUserCustomRaw(home).some((x) => isPlainObject(x) && x.id === id)) return { file, removed: false };
  updateUserSettings(home, (data) => {
    if (!Array.isArray(data.customProviders)) return;
    const next = data.customProviders.filter((x) => !(isPlainObject(x) && x.id === id));
    if (next.length) data.customProviders = next;
    else delete data.customProviders;
  });
  return { file, removed: true };
}

/** Gỡ (hoặc đặt) ghi đè địa chỉ của một hãng dựng sẵn trong `baseUrls` của cài đặt người dùng. */
export function setBaseUrlOverride(home: string, id: string, url: string | undefined): string {
  return updateUserSettings(home, (data) => {
    const cur = isPlainObject(data.baseUrls) ? { ...data.baseUrls } : {};
    if (url === undefined) delete cur[id];
    else cur[id] = url;
    if (Object.keys(cur).length) data.baseUrls = cur;
    else delete data.baseUrls;
  });
}

/** `baseUrls` thô trong cài đặt người dùng. */
export function readUserBaseUrlsRaw(home: string): unknown {
  const r = readJsonDetailed(userSettingsFile(home));
  return r.exists && !r.error && isPlainObject(r.value) ? r.value.baseUrls : undefined;
}

/** Địa chỉ đang có hiệu lực của hãng dựng sẵn `id` (ghi đè hợp lệ trong `baseUrls` của người dùng, nếu không thì địa chỉ mặc định). */
export function effectiveVendorUrl(home: string, id: string, lang: Lang): string {
  const v = vendorById(id);
  const o = validateBaseUrls(readUserBaseUrlsRaw(home), lang).valid[id];
  return o ?? v?.baseUrl ?? '';
}

/**
 * Nhà cung cấp hãng khác ĐÃ dùng được sẵn mà không cần biến môi trường của hãng dựng sẵn: khoá đã lưu (còn khớp địa chỉ), API tuỳ chỉnh có biến `<ID>_API_KEY`,
 * API tuỳ chỉnh không cần khoá. Mỗi phần tử là chữ để hiện («openai (đã lưu khoá)»). Dùng cho màn hình hướng dẫn lần đầu và quyết định có cần đăng nhập không.
 */
export function knownProviders(home: string, env: NodeJS.ProcessEnv, lang: Lang): string[] {
  const out: string[] = [];
  const customs = validateCustomProviders(readUserCustomRaw(home), lang).valid;
  const stored = readStoredKeys(home).keys;
  for (const id of Object.keys(stored)) {
    const url = vendorById(id) ? effectiveVendorUrl(home, id, lang) : customs.find((c) => c.id === id)?.baseUrl;
    if (url && 'key' in storedKeyFor(home, id, url)) out.push(`${id} (${t('cli.prov.state.saved', {}, lang)})`);
  }
  for (const c of customs) {
    if (out.some((x) => x.startsWith(`${c.id} (`))) continue;
    if ((env[customEnvName(c.id)] ?? '').trim()) out.push(`${c.id} (${customEnvName(c.id)})`);
    else if (c.requiresKey !== true) out.push(`${c.id} (${t('cli.prov.list.notRequired', {}, lang)})`);
  }
  return out;
}
