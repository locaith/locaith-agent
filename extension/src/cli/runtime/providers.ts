/**
 * Nhà cung cấp cho CLI: mô hình Locaith qua cổng (token tài khoản `lat_…`) + BYOK qua biến môi trường (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * GEMINI_API_KEY/GOOGLE_API_KEY, DEEPSEEK_API_KEY, XAI_API_KEY…, đúng `core/providers/presets.ts`).
 *
 * Bọc `ProviderService` của extension (không phụ thuộc `vscode`) để dùng chung danh mục model, cửa sổ ngữ cảnh, model nhanh cho bộ tóm tắt,
 * kho điều phối cho agent con. Không gọi mạng khi khởi tạo.
 */

import { ModelPool } from '../../core/orchestration/pool';
import { ACCOUNT_PRESETS, BUILTIN_PRESETS, knownContextWindow, type ProviderPreset } from '../../core/providers/presets';
import { gatewayDiagnosticHeaders } from '../../core/providers/gatewayDiagnostics';
import { LOCAITH_MODEL_FLASH, LOCAITH_PROVIDER_ID } from '../../core/providers/locaithGateway';
import type { AccountProviderHooks, CustomProviderConfig } from '../../core/providers/registry';
import { ProviderService } from '../../core/providers/service';
import { ProviderError, type LLMProvider, type LogLevel, type ModelInfo } from '../../core/types';
import type { SettingsStore } from './config';
import { t as cliT } from '../i18n';
import { customEnvName, readStoredKeys, storedKeyFor, validateBaseUrls, validateCustomProviders } from '../providerStore';
import { NotLoggedInError, readLocaithKey } from './auth';

const DEFAULT_CONTEXT = 128_000;
/** Thứ tự thử khi người dùng không chọn model và chưa đăng nhập Locaith. */
const BYOK_ORDER = ['anthropic', 'openai', 'gemini', 'deepseek', 'xai'];

/** Đoán nhà cung cấp từ tên model trần (`claude-…` → anthropic…). */
const MODEL_PREFIXES: Array<[RegExp, string]> = [
  [/^locaith-/i, LOCAITH_PROVIDER_ID],
  [/^claude/i, 'anthropic'],
  [/^(gpt|o\d|chatgpt|codex)/i, 'openai'],
  [/^gemini/i, 'gemini'],
  [/^deepseek/i, 'deepseek'],
  [/^grok/i, 'xai'],
];

export interface ProvidersInit {
  home: string;
  env: NodeJS.ProcessEnv;
  version: string;
  settings: SettingsStore;
  baseUrl?: string;
  override?: LLMProvider;
  overrideModel?: string;
  fetchImpl?: typeof fetch;
  log(level: LogLevel, message: string): void;
  lang(): 'vi' | 'en';
}

export interface ProviderRow {
  id: string;
  label: string;
  baseUrl: string;
  kind: string;
  builtin: boolean;
  usable: boolean;
  key: { source: 'login' | 'env' | 'saved' | 'not-required' | 'none' | 'mismatch'; env?: string; savedUrl?: string };
}

/** Kết quả thử kết nối. `reason` (khi hỏng): không tới được máy chủ · khoá bị từ chối · máy chủ trả lời nhưng không có /models · khác. */
export interface ProviderTestResult {
  ok: boolean;
  models?: number;
  ms: number;
  error?: string;
  reason?: 'unreachable' | 'auth' | 'no-models' | 'other';
}

export interface ProviderTarget {
  provider: string;
  model: string;
}

export interface ModelGroup {
  providerId: string;
  label: string;
  models: ModelInfo[];
  hasKey: boolean;
  source: 'live' | 'cache' | 'fallback';
}

const headerSafe = (v: string, max: number): string => v.replace(/[^A-Za-z0-9 ._/-]/g, '_').slice(0, max);

export class CliProviders {
  readonly service: ProviderService;
  readonly pool: ModelPool;
  private readonly override?: LLMProvider;
  private readonly overrideModel: string;

  constructor(private readonly i: ProvidersInit) {
    this.override = i.override;
    this.overrideModel = i.overrideModel || 'test-model';
    const account: AccountProviderHooks = {
      token: () => this.token(),
      headers: ({ sessionKey, ticket }) => ({
        ...gatewayDiagnosticHeaders({ family: 'cli', version: i.version, sessionKey }),
        // Báo cho cổng rằng ta xử lý được 429 + mã vé khi đầy (hiện vị trí hàng chờ thay vì giữ kết nối mở).
        'x-locaith-queue': 'ticket',
        ...(ticket ? { 'x-locaith-ticket': headerSafe(ticket, 120) } : {}),
      }),
    };
    this.service = new ProviderService({
      baseUrls: () => this.baseUrls(),
      customProviders: () => this.customProviders(),
      eagerInput: () => false,
      summarizerModel: () => (i.settings.get<string>('summarizer.model', 'auto') || 'auto').trim() || 'auto',
      // Khoá hãng khác: biến môi trường thắng (registry tự đọc `env` khi hàm này trả undefined); không có thì dùng khoá đã lưu bằng `locaith provider key`.
      resolveKey: async (id) => this.savedKeyForUse(id),
      log: (l, m) => i.log(l, m),
      env: i.env,
      fetchImpl: i.fetchImpl,
      account,
    });
    if (this.override) this.service.registry.addExtraProvider(this.override, [{ id: this.overrideModel, label: this.overrideModel }]);
    this.pool = new ModelPool(this.service, { maxPerProvider: 4 });
  }

  // ── cấu hình ────────────────────────────────────────────────────────────────

  private baseUrls(): Record<string, string> {
    // Chỉ cài đặt NGƯỜI DÙNG (xem SECURE_KEYS ở config.ts); mục sai bị bỏ và được báo ở `problems()`.
    const out = { ...validateBaseUrls(this.i.settings.get<unknown>('baseUrls', undefined), this.i.lang()).valid };
    if (this.i.baseUrl && this.i.baseUrl.trim()) out[LOCAITH_PROVIDER_ID] = this.i.baseUrl.trim();
    return out;
  }

  private customProviders(): CustomProviderConfig[] {
    return validateCustomProviders(this.i.settings.get<unknown>('customProviders', undefined), this.i.lang()).valid;
  }

  /** Nạp lại cấu hình (sau khi `/provider` hoặc `locaith provider` ghi cài đặt/khoá): dựng lại registry, bỏ danh sách model đã đệm của mục đổi. */
  reload(): void {
    this.probCache = undefined;
    // SettingsStore đệm 300 ms: vừa ghi tệp xong mà không bỏ đệm thì sẽ đọc lại bản cũ.
    this.i.settings.invalidate();
    this.service.reconfigure();
  }

  /**
   * Địa chỉ THẬT mà nhà cung cấp sẽ gọi — phải khớp từng chữ với cách registry dựng (khoá đã lưu được gắn/so với địa chỉ này):
   * hãng dựng sẵn và cổng Locaith = ghi đè trong `baseUrls` hoặc mặc định của hãng; API tuỳ chỉnh = "baseUrl" của chính nó (registry không áp `baseUrls` cho nó).
   */
  effectiveBaseUrl(id: string): string | undefined {
    const p = this.presetOf(id);
    if (p) return this.baseUrls()[id] || p.baseUrl;
    return this.customProviders().find((c) => c.id === id)?.baseUrl;
  }

  get overridden(): boolean {
    return !!this.override;
  }

  // ── khoá ────────────────────────────────────────────────────────────────────

  /** Token tài khoản Locaith (đọc mới mỗi lần: /login, /logout có hiệu lực ngay). */
  token(): string | undefined {
    return readLocaithKey(this.i.home, this.i.env);
  }

  private presetOf(id: string): ProviderPreset | undefined {
    return BUILTIN_PRESETS.find((p) => p.id === id) ?? ACCOUNT_PRESETS.find((p) => p.id === id);
  }

  /** Tên biến môi trường có thể chứa khoá của nhà cung cấp. */
  envNames(id: string): string[] {
    const p = this.presetOf(id);
    if (p) return p.credential === 'account' ? ['LOCAITH_API_KEY'] : p.envKeys;
    return [customEnvName(id)];
  }

  /** Có biến môi trường nào chứa khoá của nhà cung cấp này không (trả tên biến đầu tiên có giá trị). */
  envSet(id: string): string | undefined {
    return this.envNames(id).find((n) => (this.i.env[n] ?? '').trim().length > 0);
  }

  /**
   * Khoá đã lưu dùng được cho `id`? Chỉ khi biến môi trường KHÔNG đặt (env thắng) và địa chỉ hiện tại còn KHỚP địa chỉ lúc lưu
   * (đổi địa chỉ → khoá ngừng được gửi đi, xem providerStore.ts).
   */
  private savedKeyForUse(id: string): string | undefined {
    if (id === LOCAITH_PROVIDER_ID || this.envSet(id)) return undefined;
    const url = this.effectiveBaseUrl(id);
    if (!url) return undefined;
    const r = storedKeyFor(this.i.home, id, url);
    return 'key' in r ? r.key : undefined;
  }

  hasKey(id: string): boolean {
    if (this.override && id === this.override.id) return true;
    if (id === LOCAITH_PROVIDER_ID) return !!this.token();
    if (this.envSet(id)) return true;
    if (this.savedKeyForUse(id)) return true;
    // API tuỳ chỉnh không đòi khoá (Ollama, LM Studio…).
    if (!this.presetOf(id)) {
      const c = this.customProviders().find((x) => x.id === id);
      return !!c && c.requiresKey !== true;
    }
    return false;
  }

  /** Khoá của `id` đến từ đâu (cho `provider list`, /doctor): đăng nhập · biến môi trường · đã lưu · không cần · chưa có · lệch địa chỉ. */
  keySource(id: string): { source: 'login' | 'env' | 'saved' | 'not-required' | 'none' | 'mismatch'; env?: string; savedUrl?: string } {
    if (id === LOCAITH_PROVIDER_ID) return { source: this.token() ? 'login' : 'none' };
    const env = this.envSet(id);
    if (env) return { source: 'env', env };
    const url = this.effectiveBaseUrl(id);
    if (url) {
      const r = storedKeyFor(this.i.home, id, url);
      if ('key' in r) return { source: 'saved' };
      if ('mismatch' in r) return { source: 'mismatch', savedUrl: r.mismatch.savedUrl };
    }
    if (!this.presetOf(id)) {
      const c = this.customProviders().find((x) => x.id === id);
      if (c && c.requiresKey !== true) return { source: 'not-required' };
    }
    return { source: 'none' };
  }

  /** Bảng nhà cung cấp cho `provider list` và `/provider list`: mọi nhà cung cấp đã đăng ký (trừ demo/auto) kèm địa chỉ hiệu lực và nguồn khoá. */
  rows(): ProviderRow[] {
    const ids = this.service.registry.ids().filter((x) => x !== 'demo' && x !== 'auto' && (!this.override || x === this.override.id));
    return ids.map((id) => {
      let kind = '';
      try {
        kind = this.service.get(id).kind;
      } catch {
        /* nhà cung cấp biến mất giữa chừng */
      }
      return { id, label: this.label(id), baseUrl: this.effectiveBaseUrl(id) ?? '', kind, builtin: !!this.presetOf(id), key: this.keySource(id), usable: this.hasKey(id) };
    });
  }

  /** Mọi khoá đang có (đã lưu + biến môi trường của các nhà cung cấp biết trước) — để che khỏi nhật ký. */
  secrets(): string[] {
    const out = new Set<string>();
    for (const sk of Object.values(readStoredKeys(this.i.home).keys)) out.add(sk.key);
    const ids = [...BYOK_ORDER, ...this.customProviders().map((c) => c.id)];
    for (const id of ids) for (const n of this.envNames(id)) {
      const v = (this.i.env[n] ?? '').trim();
      if (v) out.add(v);
    }
    return [...out];
  }

  private probCache?: { at: number; list: string[] };

  /** Mô tả MỌI điều sai trong cấu hình nhà cung cấp (mục bị bỏ qua, địa chỉ bị từ chối, khoá đã lưu lệch địa chỉ, tệp khoá hỏng). Đệm 3 giây. */
  problems(): string[] {
    const now = Date.now();
    if (this.probCache && now - this.probCache.at < 3000) return this.probCache.list;
    const lang = this.i.lang();
    const out = [
      ...validateCustomProviders(this.i.settings.get<unknown>('customProviders', undefined), lang).problems,
      ...validateBaseUrls(this.i.settings.get<unknown>('baseUrls', undefined), lang).problems,
    ];
    const ks = readStoredKeys(this.i.home);
    if (ks.problem) out.push(ks.problem);
    for (const id of Object.keys(ks.keys)) {
      const url = this.effectiveBaseUrl(id);
      if (!url) continue; // khoá mồ côi (nhà cung cấp đã gỡ): không phải lỗi cấu hình
      const r = storedKeyFor(this.i.home, id, url);
      if ('mismatch' in r) out.push(cliT('cli.prov.cfg.keyMismatch', { id, saved: r.mismatch.savedUrl, now: url }, lang));
    }
    this.probCache = { at: now, list: out };
    return out;
  }

  /** API tuỳ chỉnh `id` có ghim sẵn danh sách model không (khi đó không cần /models để dùng). */
  hasPinnedModels(id: string): boolean {
    return (this.customProviders().find((c) => c.id === id)?.models?.length ?? 0) > 0;
  }

  /**
   * Thử kết nối tới `id` bằng `ping` (GET danh sách model, KHÔNG thử lại): lỗi thật — từ chối kết nối, sai khoá, quá giờ — hiện ngay và đúng
   * nguyên nhân, không bị che bởi vòng thử lại 1+2+4+8 giây của `fetchModels`. Ping qua thì đếm model (hỏng bước đếm không làm hỏng phép thử).
   * Hạn giờ tổng `timeoutMs`; huỷ được các yêu cầu đang bay. Không bao giờ ném.
   */
  async test(id: string, timeoutMs = 8000): Promise<ProviderTestResult> {
    const t0 = Date.now();
    const ctl = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
        rej(new Error(cliT('cli.prov.test.timeout', { s: Math.max(1, Math.round(timeoutMs / 1000)) }, this.i.lang())));
      }, timeoutMs);
      timer.unref?.();
    });
    deadline.catch(() => undefined); // phép thử xong trước hạn thì lời từ chối này không còn ai nghe
    try {
      const p = this.service.get(id);
      await Promise.race([p.ping(ctl.signal), deadline]);
      let models: number | undefined;
      try {
        models = (await Promise.race([p.fetchModels(ctl.signal), deadline])).length;
      } catch {
        /* /models trả lỗi sau khi ping qua (hiếm): vẫn tính là thông, chỉ không đếm được model */
      }
      return { ok: true, ...(models !== undefined ? { models } : {}), ms: Date.now() - t0 };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : undefined;
      const reason: ProviderTestResult['reason'] =
        timedOut || pe?.kind === 'network' || pe?.kind === 'timeout'
          ? 'unreachable'
          : pe?.kind === 'auth' || pe?.status === 401 || pe?.status === 403
            ? 'auth'
            : pe?.kind === 'not_found' || pe?.status === 404 || pe?.status === 405
              ? 'no-models'
              : 'other';
      return { ok: false, reason, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Các nhà cung cấp dùng được ngay (đã có khoá), theo thứ tự ưu tiên. */
  usableIds(): string[] {
    if (this.override) return [this.override.id];
    const ids = [LOCAITH_PROVIDER_ID, ...BYOK_ORDER, ...this.customProviders().map((c) => c.id)];
    return ids.filter((id) => this.service.has(id) && this.hasKey(id));
  }

  label(id: string): string {
    try {
      return this.service.get(id).label;
    } catch {
      return id;
    }
  }

  get(id: string): LLMProvider {
    return this.service.get(id);
  }

  // ── chọn nhà cung cấp / model ───────────────────────────────────────────────

  /** `provider:model` hoặc `model` trần → nhà cung cấp + model (không kiểm khoá). */
  parseSpec(spec: string): { providerId?: string; model: string } {
    const s = spec.trim();
    const i = s.indexOf(':');
    if (i > 0) {
      const p = s.slice(0, i);
      if (this.service.has(p)) return { providerId: p, model: s.slice(i + 1).trim() };
    }
    return { model: s };
  }

  private inferProvider(model: string): string | undefined {
    for (const id of this.service.registry.ids()) {
      if (this.service.models(id).some((m) => m.id === model)) return id;
      if (this.service.registry.catalog.fallbackOf(id).some((m) => m.id === model)) return id;
    }
    for (const [re, id] of MODEL_PREFIXES) if (re.test(model) && this.service.has(id)) return id;
    return undefined;
  }

  private missingKeyError(id: string): Error {
    if (id === LOCAITH_PROVIDER_ID) return new NotLoggedInError(this.i.lang(), { configFile: '~/.locaith/cli.json' });
    const names = this.envNames(id).join(' / ');
    const label = this.label(id);
    const ks = this.keySource(id);
    if (ks.source === 'mismatch') return new Error(cliT('cli.prov.cfg.keyMismatchErr', { id, label, saved: ks.savedUrl ?? '', now: this.effectiveBaseUrl(id) ?? '' }, this.i.lang()));
    return new Error(cliT('cli.prov.noKey', { label, names, id }, this.i.lang()));
  }

  /**
   * Chọn mục tiêu cho phiên mới: `requested` (cờ --model hoặc cài đặt) → mặc định (Locaith nếu đã đăng nhập, rồi hãng đầu tiên có khoá).
   * Ném `NotLoggedInError` khi không có khoá nào dùng được.
   */
  pickInitial(requested?: string): ProviderTarget {
    if (this.override) return { provider: this.override.id, model: requested?.trim() ? this.parseSpec(requested).model || this.overrideModel : this.overrideModel };
    const want = requested?.trim();
    if (want) return this.resolveSpec(want);
    const ids = this.usableIds();
    const first = ids[0];
    if (!first) throw new NotLoggedInError(this.i.lang(), { configFile: '~/.locaith/cli.json' });
    return { provider: first, model: this.defaultModel(first) };
  }

  /** Giải một đặc tả model do người dùng đưa; ném lỗi rõ ràng nếu thiếu khoá/không hiểu. */
  resolveSpec(spec: string): ProviderTarget {
    const { providerId, model } = this.parseSpec(spec);
    if (this.override) return { provider: this.override.id, model: model || this.overrideModel };
    let pid = providerId;
    if (!pid) pid = this.inferProvider(model);
    if (!pid) {
      // Tên model lạ (API tuỳ chỉnh/model mới chưa có trong danh mục): dùng nhà cung cấp mặc định.
      const first = this.usableIds()[0];
      if (!first) throw new NotLoggedInError(this.i.lang(), { configFile: '~/.locaith/cli.json' });
      pid = first;
    }
    if (!this.hasKey(pid)) throw this.missingKeyError(pid);
    return { provider: pid, model: model || this.defaultModel(pid) };
  }

  defaultModel(id: string): string {
    if (this.override && id === this.override.id) return this.overrideModel;
    return this.service.defaultModel(id) || (id === LOCAITH_PROVIDER_ID ? LOCAITH_MODEL_FLASH : '');
  }

  // ── thông số model ──────────────────────────────────────────────────────────

  private info(providerId: string, model: string): ModelInfo | undefined {
    return this.service.models(providerId).find((m) => m.id === model) ?? this.service.registry.catalog.fallbackOf(providerId).find((m) => m.id === model);
  }

  contextWindow(providerId: string, model: string): number {
    const forced = this.i.settings.get<number>('agent.contextWindow', 0);
    if (typeof forced === 'number' && Number.isFinite(forced) && forced >= 1000) return Math.floor(forced);
    return this.info(providerId, model)?.contextWindow ?? knownContextWindow(model) ?? DEFAULT_CONTEXT;
  }

  maxOutputTokens(providerId: string, model: string): number | undefined {
    const n = this.info(providerId, model)?.maxOutputTokens;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
  }

  pricing(providerId: string, model: string): ModelInfo['pricing'] | undefined {
    return this.info(providerId, model)?.pricing;
  }

  /** Model nhanh/rẻ cho bộ tóm tắt nền và nén ngữ cảnh. */
  async fastTarget(sessionProviderId: string, model: string): Promise<{ provider: LLMProvider; model: string } | null> {
    if (this.override && sessionProviderId === this.override.id) return { provider: this.override, model };
    return this.service.fastTarget(sessionProviderId);
  }

  /** Danh sách model cho `/model` (chỉ nhà cung cấp đã có khoá). Hỏi mạng có hạn giờ; lỗi → danh sách dự phòng. */
  async listModels(timeoutMs = 4000): Promise<ModelGroup[]> {
    const out: ModelGroup[] = [];
    for (const id of this.override ? [this.override.id] : this.service.registry.ids().filter((x) => x !== 'demo' && x !== 'auto')) {
      const has = this.hasKey(id);
      if (!has) continue;
      let res: { models: ModelInfo[]; source: 'live' | 'cache' | 'fallback' };
      try {
        res = await Promise.race([
          this.service.registry.catalog.list(id),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs).unref?.()),
        ]);
      } catch {
        const peek = this.service.registry.catalog.peek(id);
        res = { models: peek?.models ?? this.service.registry.catalog.fallbackOf(id), source: peek ? 'cache' : 'fallback' };
      }
      out.push({ providerId: id, label: this.label(id), models: res.models, hasKey: has, source: res.source });
    }
    return out;
  }
}
