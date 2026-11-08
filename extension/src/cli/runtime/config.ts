/**
 * Cài đặt hợp nhất của CLI: người dùng < dự án < cục bộ < biến môi trường < tuỳ chọn dòng lệnh.
 *
 *   ~/.locaith/settings.json                  (user)
 *   <cwd>/.locaith/settings.json              (project — đi theo kho mã)
 *   <cwd>/.locaith/settings.local.json        (local — của riêng máy này, thường không commit)
 *
 * Khoá giống cài đặt extension bỏ tiền tố `locaithAgent.` (ví dụ `agent.compactAtPercent`, `permissions.allow`). Tệp có thể viết khoá CHẤM
 * (`"agent.compactAtPercent": 90`) hoặc LỒNG (`"agent": { "compactAtPercent": 90 }`) — đọc được cả hai.
 *
 * Hợp nhất: giá trị đơn lấy ở tầng cao nhất có khoá; đối tượng gộp theo khoá; mảng của `permissions.*` và `hooks` được NỐI (không đè) để luật của
 * người dùng và của dự án cùng có hiệu lực. Thư mục CHƯA TIN CẬY: tầng dự án/cục bộ chỉ đóng góp `permissions.ask` và `permissions.deny` (chỉ siết chặt).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_ENGINE_SETTINGS, type EngineSettings } from '../../core/engine/types';
import { detectLang } from '../i18n';
import type { SettingsApi } from './contract';
import { clamp, isPlainObject, readJsonDetailed, writeFileAtomic } from './util';

export type Scope = 'user' | 'project' | 'local';
type LayerName = Scope | 'env' | 'cli';

interface Layer {
  name: LayerName;
  data: Record<string, unknown>;
  /** Tệp tồn tại nhưng hỏng (để /doctor báo). */
  error?: string;
  file?: string;
  /** Tầng dự án/cục bộ của thư mục chưa tin cậy: chỉ được siết chặt. */
  restricted?: boolean;
}

/** Khoá an toàn: không bao giờ đọc từ dự án/cục bộ (kho mã lạ không được tự bật quyền nguy hiểm). */
const SECURE_KEYS = new Set(['agent.allowBypassPermissions']);
/** Mảng của các khoá này được nối giữa các tầng thay vì bị đè. */
const CONCAT_PREFIXES = ['permissions.', 'hooks'];
/** Khoá mà tầng dự án CHƯA TIN CẬY vẫn được đóng góp (chỉ siết chặt). */
const RESTRICTED_OK = new Set(['permissions.ask', 'permissions.deny']);

export function lookupKey(obj: Record<string, unknown>, key: string): { found: boolean; value?: unknown } {
  if (Object.prototype.hasOwnProperty.call(obj, key)) return { found: true, value: obj[key] };
  for (let i = key.indexOf('.'); i > 0; i = key.indexOf('.', i + 1)) {
    const head = key.slice(0, i);
    if (!Object.prototype.hasOwnProperty.call(obj, head)) continue;
    const sub = obj[head];
    if (isPlainObject(sub)) {
      const r = lookupKey(sub, key.slice(i + 1));
      if (r.found) return r;
    }
  }
  // Ngược lại: `get('permissions')` khi tệp viết `"permissions.allow": [...]` → dựng đối tượng từ các khoá chấm.
  const prefix = key + '.';
  let built: Record<string, unknown> | undefined;
  for (const k of Object.keys(obj)) {
    if (!k.startsWith(prefix)) continue;
    built ??= {};
    setDeep(built, k.slice(prefix.length), obj[k]);
  }
  return built ? { found: true, value: built } : { found: false };
}

/** Ghi giá trị vào đối tượng theo khoá chấm: dùng khoá chấm có sẵn nếu tệp đã viết kiểu đó, không thì tạo lồng. `undefined` = xoá. */
export function setDeep(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    if (value === undefined) delete obj[key];
    else obj[key] = value;
    return;
  }
  const parts = key.split('.');
  // Có tiền tố lồng sẵn → đi tiếp trong đó.
  for (let i = 1; i < parts.length; i++) {
    const head = parts.slice(0, i).join('.');
    if (Object.prototype.hasOwnProperty.call(obj, head) && isPlainObject(obj[head])) {
      setDeep(obj[head] as Record<string, unknown>, parts.slice(i).join('.'), value);
      return;
    }
  }
  if (value === undefined) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') throw new Error(`Khoá không hợp lệ: ${key}`);
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') throw new Error(`Khoá không hợp lệ: ${key}`);
  cur[last] = value;
}

function mergeValues(pathKeyStr: string, a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b) && CONCAT_PREFIXES.some((p) => pathKeyStr === p || pathKeyStr.startsWith(p))) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const x of [...a, ...b]) {
      const k = typeof x === 'string' ? x : JSON.stringify(x);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeValues(`${pathKeyStr}.${k}`, out[k], v) : v;
    return out;
  }
  return b;
}

export interface SettingsStoreOptions {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Thư mục đã tin cậy? Gọi lại mỗi lần đọc (có thể đổi giữa chừng). */
  trusted(): boolean;
  /** Ghi đè từ dòng lệnh (khoá chấm). */
  cli?: Record<string, unknown>;
}

const ENV_MAP: Array<[string, string]> = [
  ['LOCAITH_MODEL', 'model'],
  ['LOCAITH_LANG', 'language'],
  ['LOCAITH_PERMISSION_MODE', 'agent.permissionMode'],
  ['LOCAITH_THINKING', 'agent.thinkingLevel'],
];

export class SettingsStore implements SettingsApi {
  private layers: Layer[] = [];
  private stamp = new Map<string, string>();
  private lastCheck = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly o: SettingsStoreOptions) {}

  file(scope: Scope): string {
    if (scope === 'user') return path.join(this.o.home, '.locaith', 'settings.json');
    return path.join(this.o.cwd, '.locaith', scope === 'project' ? 'settings.json' : 'settings.local.json');
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  invalidate(): void {
    this.lastCheck = 0;
    this.stamp.clear();
    this.layers = [];
  }

  private fingerprint(): string {
    const parts: string[] = [];
    for (const s of ['user', 'project', 'local'] as const) {
      try {
        const st = fs.statSync(this.file(s));
        parts.push(`${s}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${s}:-`);
      }
    }
    parts.push(`trust:${this.o.trusted()}`);
    return parts.join('|');
  }

  private envLayer(): Layer {
    const data: Record<string, unknown> = {};
    const raw = this.o.env.LOCAITH_SETTINGS;
    if (raw && raw.trim()) {
      try {
        const j = JSON.parse(raw);
        if (isPlainObject(j)) Object.assign(data, j);
      } catch {
        /* LOCAITH_SETTINGS hỏng: bỏ qua (/doctor sẽ báo) */
      }
    }
    for (const [env, key] of ENV_MAP) {
      const v = this.o.env[env];
      if (v && v.trim()) setDeep(data, key, v.trim());
    }
    return { name: 'env', data };
  }

  private load(): Layer[] {
    const now = Date.now();
    if (this.layers.length && now - this.lastCheck < 300) return this.layers;
    const fp = this.fingerprint();
    if (this.layers.length && this.stamp.get('fp') === fp) {
      this.lastCheck = now;
      return this.layers;
    }
    const trusted = this.o.trusted();
    const layers: Layer[] = [];
    for (const s of ['user', 'project', 'local'] as const) {
      const file = this.file(s);
      const r = readJsonDetailed(file);
      const data = isPlainObject(r.value) ? r.value : {};
      layers.push({ name: s, data, file, ...(r.error ? { error: r.error } : {}), ...(s !== 'user' && !trusted ? { restricted: true } : {}) });
    }
    layers.push(this.envLayer());
    if (this.o.cli) layers.push({ name: 'cli', data: { ...this.o.cli } });
    this.layers = layers;
    this.lastCheck = now;
    this.stamp.set('fp', fp);
    return layers;
  }

  private fromLayer(l: Layer, key: string): { found: boolean; value?: unknown } {
    if (SECURE_KEYS.has(key) && (l.name === 'project' || l.name === 'local')) return { found: false };
    if (l.restricted) {
      if (RESTRICTED_OK.has(key)) return lookupKey(l.data, key);
      if (key === 'permissions') {
        const out: Record<string, unknown> = {};
        for (const k of RESTRICTED_OK) {
          const r = lookupKey(l.data, k);
          if (r.found) out[k.slice('permissions.'.length)] = r.value;
        }
        return Object.keys(out).length ? { found: true, value: out } : { found: false };
      }
      return { found: false };
    }
    return lookupKey(l.data, key);
  }

  /** Giá trị hợp nhất, hoặc undefined nếu không tầng nào có khoá. */
  getMerged(key: string): unknown {
    let acc: unknown;
    let any = false;
    for (const l of this.load()) {
      const r = this.fromLayer(l, key);
      if (!r.found) continue;
      acc = any ? mergeValues(key, acc, r.value) : r.value;
      any = true;
    }
    return any ? acc : undefined;
  }

  get<T>(key: string, fallback: T): T {
    const v = this.getMerged(key);
    return v === undefined || v === null ? fallback : (v as T);
  }

  /** Giá trị ở MỘT tầng (đã áp quy tắc tin cậy) — cho /permissions, /config để hiện nguồn. */
  getScoped<T = unknown>(key: string, scope: LayerName): T | undefined {
    const l = this.load().find((x) => x.name === scope);
    if (!l) return undefined;
    const r = this.fromLayer(l, key);
    return r.found ? (r.value as T) : undefined;
  }

  /** Tầng cao nhất có khoá (để hiện «đặt ở đâu»). */
  sourceOf(key: string): LayerName | undefined {
    let src: LayerName | undefined;
    for (const l of this.load()) if (this.fromLayer(l, key).found) src = l.name;
    return src;
  }

  /** Khoá có do NGƯỜI DÙNG đặt ở bất kỳ tầng nào (kể cả tầng bị hạn chế)? */
  isUserSet(key: string): boolean {
    return this.sourceOf(key) !== undefined;
  }

  /** Mô tả lỗi các tệp cài đặt hỏng (cho /doctor). */
  problems(): string[] {
    const out: string[] = [];
    for (const l of this.load()) if (l.error && l.file) out.push(`${l.file}: ${l.error}`);
    const raw = this.o.env.LOCAITH_SETTINGS;
    if (raw && raw.trim()) {
      try {
        if (!isPlainObject(JSON.parse(raw))) out.push('LOCAITH_SETTINGS: không phải đối tượng JSON');
      } catch (err) {
        out.push(`LOCAITH_SETTINGS: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  /** Toàn bộ cài đặt hợp nhất ở dạng khoá chấm phẳng (cho /config). */
  snapshot(): Record<string, { value: unknown; source: LayerName }> {
    const out: Record<string, { value: unknown; source: LayerName }> = {};
    const walk = (obj: Record<string, unknown>, prefix: string, source: LayerName, restricted: boolean) => {
      for (const [k, v] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (isPlainObject(v) && full !== 'hooks' && full !== 'mcpServers' && full !== 'env') walk(v, full, source, restricted);
        else if (!restricted || RESTRICTED_OK.has(full)) out[full] = { value: v, source };
      }
    };
    for (const l of this.load()) walk(l.data, '', l.name, !!l.restricted);
    for (const k of Object.keys(out)) if (SECURE_KEYS.has(k) && (out[k].source === 'project' || out[k].source === 'local')) delete out[k];
    return out;
  }

  set(key: string, value: unknown, scope: Scope): void {
    if (scope !== 'user' && !this.o.trusted()) {
      throw new Error(`Thư mục chưa được tin cậy nên không ghi được cài đặt ${scope === 'project' ? 'dự án' : 'cục bộ'} (${this.file(scope)}).`);
    }
    if (SECURE_KEYS.has(key) && scope !== 'user') throw new Error(`Khoá ${key} chỉ đặt được ở cài đặt người dùng.`);
    const file = this.file(scope);
    const cur = readJsonDetailed(file);
    let data: Record<string, unknown> = isPlainObject(cur.value) ? { ...cur.value } : {};
    if (cur.error) {
      // Tệp hỏng: giữ bản sao trước khi ghi đè để người dùng không mất nội dung.
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* không sao lưu được thì thôi */
      }
      data = {};
    }
    setDeep(data, key, value);
    writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', scope === 'user' ? 0o600 : undefined);
    this.invalidate();
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* người nghe lỗi không làm hỏng ghi cài đặt */
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ánh xạ sang EngineSettings
// ─────────────────────────────────────────────────────────────────────────────

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function cleanNameList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 300).map((x) => x.trim());
  return out.length ? out : fallback;
}

function stallSetting(v: unknown): 'auto' | number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return 'auto';
}

export function resolveLang(optLang: 'vi' | 'en' | undefined, store: SettingsStore, env: NodeJS.ProcessEnv): 'vi' | 'en' {
  if (optLang === 'vi' || optLang === 'en') return optLang;
  const s = store.get<string>('language', '');
  if (s === 'vi' || s === 'en') return s;
  return detectLang(env);
}

/** Cùng công thức `ConfigService.engine()` của extension, đọc từ cài đặt CLI. */
export function buildEngineSettings(
  store: SettingsStore,
  o: { lang: 'vi' | 'en'; contextWindow: number; modelMaxOutputTokens?: number; maxTurns?: number },
): EngineSettings {
  const d = DEFAULT_ENGINE_SETTINGS;
  const g = <T>(k: string, fb: T): T => store.get<T>(k, fb);
  return {
    ...d,
    language: o.lang,
    maxTurns: o.maxTurns && o.maxTurns > 0 ? Math.floor(o.maxTurns) : clamp(Math.floor(num(g('agent.maxTurns', d.maxTurns), d.maxTurns)), 1, 1000),
    maxOutputTokens: Math.max(256, Math.floor(num(g('agent.maxOutputTokens', d.maxOutputTokens), d.maxOutputTokens))),
    parallelToolCalls: g<boolean>('agent.parallelToolCalls', d.parallelToolCalls) !== false,
    autoCompact: g<boolean>('agent.autoCompact', d.autoCompact) !== false,
    contextWindow: o.contextWindow,
    compactAt: clamp(num(g('agent.compactAtPercent', 80), 80), 50, 95) / 100,
    instructionFiles: cleanNameList(g<unknown>('agent.instructionFiles', d.instructionFiles), d.instructionFiles),
    clearToolResultsAtPercent: clamp(num(g('agent.clearToolResultsAtPercent', d.clearToolResultsAtPercent ?? 40), 40), 0, 90),
    keepRecentMessages: clamp(num(g('agent.keepRecentMessages', d.keepRecentMessages ?? 20), 20), 4, 200),
    compactAtTokens: Math.max(0, num(g('agent.compactAtTokens', d.compactAtTokens ?? 0), 0)),
    compactAtUserSet: store.isUserSet('agent.compactAtPercent'),
    adaptiveOutputTokens: g<boolean>('agent.adaptiveOutputTokens', true) !== false,
    modelStallSeconds: stallSetting(g<unknown>('agent.modelStallSeconds', 'auto')),
    modelCallMaxSeconds: clamp(num(g('agent.modelCallMaxSeconds', 600), 600), 30, 3600),
    ...(o.modelMaxOutputTokens ? { modelMaxOutputTokens: o.modelMaxOutputTokens } : {}),
  };
}
