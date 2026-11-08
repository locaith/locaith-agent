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
import type { LLMProvider, LogLevel, ModelInfo } from '../../core/types';
import type { SettingsStore } from './config';
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
      resolveKey: async () => undefined, // khoá hãng khác chỉ lấy từ biến môi trường (registry tự đọc `env`)
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
    const raw = this.i.settings.get<unknown>('baseUrls', {});
    const out: Record<string, string> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, url] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof url === 'string' && /^https:\/\//i.test(url.trim())) out[id] = url.trim();
        else if (typeof url === 'string' && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url.trim())) out[id] = url.trim();
      }
    }
    if (this.i.baseUrl && this.i.baseUrl.trim()) out[LOCAITH_PROVIDER_ID] = this.i.baseUrl.trim();
    return out;
  }

  private customProviders(): CustomProviderConfig[] {
    const raw = this.i.settings.get<unknown>('customProviders', []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (c): c is CustomProviderConfig => !!c && typeof c === 'object' && typeof (c as CustomProviderConfig).id === 'string' && typeof (c as CustomProviderConfig).baseUrl === 'string' && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1))/i.test((c as CustomProviderConfig).baseUrl),
    );
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
    return [`${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`];
  }

  hasKey(id: string): boolean {
    if (this.override && id === this.override.id) return true;
    if (id === LOCAITH_PROVIDER_ID) return !!this.token();
    const p = this.presetOf(id);
    const names = this.envNames(id);
    if (names.some((n) => (this.i.env[n] ?? '').trim())) return true;
    // API tuỳ chỉnh không đòi khoá (Ollama, LM Studio…).
    if (!p) {
      const c = this.customProviders().find((x) => x.id === id);
      return !!c && c.requiresKey !== true;
    }
    return false;
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
    return new Error(this.i.lang() === 'en' ? `No API key for ${label}: set ${names}.` : `Chưa có khoá API cho ${label}: đặt biến môi trường ${names}.`);
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
