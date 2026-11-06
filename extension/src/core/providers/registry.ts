/**
 * Đăng ký và tạo các nhà cung cấp: dựng sẵn (Claude, ChatGPT, Gemini, DeepSeek, Grok) + API tuỳ chỉnh do
 * người dùng nạp thêm (mọi dịch vụ tương thích OpenAI/Anthropic/Gemini). Khoá API lấy qua `resolveApiKey`
 * (SecretStorage của VS Code) rồi mới lùi về biến môi trường.
 */

import type { LLMProvider, LogLevel, ModelInfo, ProviderError, ProviderFlavor, ProviderKind, ProviderRuntimeConfig } from '../types';
import { AnthropicProvider } from './anthropic';
import { ModelCatalog } from './catalog';
import { GeminiProvider } from './gemini';
import { OpenAIChatProvider } from './openaiChat';
import { OpenAIResponsesProvider } from './openaiResponses';
import { ACCOUNT_PRESETS, BUILTIN_PRESETS, type ProviderPreset } from './presets';

export interface CustomProviderConfig {
  /** a-z, 0-9 và dấu gạch ngang. */
  id: string;
  label: string;
  /** Mặc định 'openai-chat'. */
  kind?: ProviderKind;
  baseUrl: string;
  /** Model ghim tay (luôn hiện trong danh sách, kể cả khi API không liệt kê được). */
  models?: string[];
  /** Mặc định false: server cục bộ thường không cần khoá. */
  requiresKey?: boolean;
  keyUrl?: string;
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  kind: ProviderKind;
  flavor: ProviderFlavor;
  baseUrl: string;
  builtin: boolean;
  /** Có khoá (đã lưu hoặc từ biến môi trường). */
  hasKey: boolean;
  keyFromEnv: boolean;
  requiresKey: boolean;
  keyUrl?: string;
  defaultModel: string;
  fallbackModels: ModelInfo[];
  /** Nhà cung cấp dùng token tài khoản Locaith thay cho khoá API (không có ô nhập khoá). `hasKey` = đã đăng nhập. */
  account: boolean;
}

/**
 * Nơi chạy cấp token tài khoản Locaith cho các nhà cung cấp `credential: 'account'` (bản VS Code). Không truyền = các nhà cung cấp đó KHÔNG được đăng ký
 * (bản trình duyệt chưa có đăng nhập tài khoản).
 */
export interface AccountProviderHooks {
  /** Token thiết bị (`lat_…`) của tài khoản đang đăng nhập; undefined = chưa đăng nhập. */
  token(): string | undefined;
  /** Tiêu đề thêm cho MỖI lời gọi tới cổng (client, phiên, vé xếp hàng…). */
  headers(ctx: { sessionKey?: string; ticket?: string }): Record<string, string>;
  /** Chốt chặn trước lời gọi trò chuyện: trả lỗi thì không gửi gì (chưa đồng ý thông báo dữ liệu…). */
  guard?(): ProviderError | undefined;
}

export interface ProviderRegistryOptions {
  /** Đọc khoá đã lưu (SecretStorage). Trả undefined nếu chưa có. */
  resolveApiKey(providerId: string): Promise<string | undefined>;
  /** Ghi đè URL gốc của nhà cung cấp dựng sẵn. */
  baseUrlOverrides?: Record<string, string>;
  custom?: CustomProviderConfig[];
  fetchImpl?: typeof fetch;
  log?: (level: LogLevel, message: string) => void;
  /** Tuỳ chọn áp cho mọi nhà cung cấp (ví dụ `{ retry: {...} }`). */
  defaultOptions?: Record<string, unknown>;
  /** Tuỳ chọn riêng theo id (ví dụ `{ anthropic: { eagerInputStreaming: false } }`). */
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Mặc định `process.env`. */
  env?: Record<string, string | undefined>;
  catalog?: ModelCatalog;
  /** Tiêu đề HTTP thêm theo id nhà cung cấp. */
  extraHeaders?: Record<string, Record<string, string>>;
  /** Có = đăng ký thêm các nhà cung cấp dùng tài khoản Locaith (xem AccountProviderHooks). */
  account?: AccountProviderHooks;
}

export function createProvider(cfg: ProviderRuntimeConfig): LLMProvider {
  switch (cfg.kind) {
    case 'anthropic':
      return new AnthropicProvider(cfg);
    case 'openai-responses':
      return new OpenAIResponsesProvider(cfg);
    case 'openai-chat':
      return new OpenAIChatProvider(cfg);
    case 'gemini':
      return new GeminiProvider(cfg);
  }
}

function customFlavor(kind: ProviderKind): ProviderFlavor {
  return kind === 'anthropic' ? 'anthropic' : kind === 'gemini' ? 'gemini' : 'generic';
}

function envName(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

interface Slot {
  provider: LLMProvider;
  preset?: ProviderPreset;
  custom?: CustomProviderConfig;
  /** Dùng token tài khoản Locaith làm khoá. */
  account?: boolean;
  /** Nhà cung cấp do code đăng ký sẵn (ví dụ chế độ demo), không cấu hình qua cài đặt. */
  extra?: boolean;
  requiresKey: boolean;
  envKeys: string[];
  keyUrl?: string;
  fallback: ModelInfo[];
}

const GENERIC_FAST_HINT = [/mini|flash|haiku|nano|small|lite|fast|8b|7b|3b/i];

export class ProviderRegistry {
  readonly catalog: ModelCatalog;
  private readonly slots = new Map<string, Slot>();
  private readonly extras: { provider: LLMProvider; models: ModelInfo[] }[] = [];
  private opts: ProviderRegistryOptions;

  constructor(opts: ProviderRegistryOptions) {
    this.opts = opts;
    this.catalog = opts.catalog ?? new ModelCatalog({ log: opts.log ? (m) => opts.log!('warn', m) : undefined });
    this.build();
  }

  /** Dựng lại khi cài đặt đổi (URL gốc, API tuỳ chỉnh). Danh sách model đã đệm của nhà cung cấp bị đổi sẽ bị bỏ. */
  reconfigure(patch: Partial<Pick<ProviderRegistryOptions, 'baseUrlOverrides' | 'custom' | 'providerOptions' | 'defaultOptions' | 'account'>>): void {
    this.opts = { ...this.opts, ...patch };
    for (const id of [...this.slots.keys()]) this.catalog.unregister(id);
    this.slots.clear();
    this.build();
  }

  private env(): Record<string, string | undefined> {
    return this.opts.env ?? (process.env as Record<string, string | undefined>);
  }

  private envKey(envKeys: string[]): string | undefined {
    for (const name of envKeys) {
      const v = this.env()[name];
      if (v && v.trim()) return v.trim();
    }
    return undefined;
  }

  private build(): void {
    // Nhà cung cấp dùng tài khoản Locaith đứng đầu danh sách (chỉ khi nơi chạy cấp được token); rồi tới các hãng dùng khoá API.
    const presets = [...(this.opts.account ? ACCOUNT_PRESETS : []), ...BUILTIN_PRESETS];
    for (const preset of presets) {
      const baseUrl = (this.opts.baseUrlOverrides?.[preset.id] || preset.baseUrl).trim();
      this.addSlot({
        id: preset.id,
        label: preset.label,
        kind: preset.kind,
        flavor: preset.flavor,
        baseUrl,
        requiresKey: preset.requiresKey,
        envKeys: preset.envKeys,
        keyUrl: preset.keyUrl,
        fallback: preset.fallbackModels,
        preset,
        account: preset.credential === 'account',
      });
    }
    for (const c of this.opts.custom ?? []) {
      if (!c.id || this.slots.has(c.id)) continue; // id trùng với mục dựng sẵn/đã có → bỏ qua
      const kind = c.kind ?? 'openai-chat';
      const pinned = (c.models ?? []).map<ModelInfo>((id) => ({ id, label: id }));
      this.addSlot({
        id: c.id,
        label: c.label || c.id,
        kind,
        flavor: customFlavor(kind),
        baseUrl: c.baseUrl,
        requiresKey: c.requiresKey ?? false,
        envKeys: [envName(c.id)],
        keyUrl: c.keyUrl,
        fallback: pinned,
        custom: c,
      });
    }
    for (const e of this.extras) this.addExtraSlot(e.provider, e.models);
  }

  /** Đăng ký một nhà cung cấp dựng sẵn bằng code (không cần khoá, không đổi được qua cài đặt) — ví dụ chế độ demo. */
  addExtraProvider(provider: LLMProvider, models: ModelInfo[]): void {
    this.extras.push({ provider, models });
    this.addExtraSlot(provider, models);
  }

  private addExtraSlot(provider: LLMProvider, models: ModelInfo[]): void {
    this.slots.set(provider.id, { provider, extra: true, requiresKey: false, envKeys: [], fallback: models });
    this.catalog.register({ provider, getApiKey: async () => undefined, requiresKey: false, fallback: models });
  }

  private addSlot(s: {
    id: string;
    label: string;
    kind: ProviderKind;
    flavor: ProviderFlavor;
    baseUrl: string;
    requiresKey: boolean;
    envKeys: string[];
    keyUrl?: string;
    fallback: ModelInfo[];
    preset?: ProviderPreset;
    custom?: CustomProviderConfig;
    account?: boolean;
  }): void {
    const hooks = s.account ? this.opts.account : undefined;
    const getApiKey = async (): Promise<string | undefined> => {
      // Tài khoản Locaith: "khoá" là token đăng nhập, lấy từ nơi chạy lúc gọi (đăng xuất/đăng nhập đổi ngay, không lưu trong đối tượng).
      if (s.account) return hooks?.token();
      const stored = await this.opts.resolveApiKey(s.id);
      if (stored && stored.trim()) return stored.trim();
      return this.envKey(s.envKeys);
    };
    const provider = createProvider({
      id: s.id,
      label: s.label,
      kind: s.kind,
      flavor: s.flavor,
      baseUrl: s.baseUrl,
      getApiKey,
      fetchImpl: this.opts.fetchImpl,
      log: this.opts.log,
      extraHeaders: this.opts.extraHeaders?.[s.id],
      ...(hooks ? { requestHeaders: (c: { sessionKey?: string; ticket?: string }) => hooks.headers(c), guard: hooks.guard ? () => hooks.guard!() : undefined, credential: 'account' as const } : {}),
      options: { requiresKey: s.requiresKey, ...(this.opts.defaultOptions ?? {}), ...(this.opts.providerOptions?.[s.id] ?? {}) },
    });
    this.slots.set(s.id, {
      provider,
      preset: s.preset,
      custom: s.custom,
      account: s.account,
      requiresKey: s.requiresKey,
      envKeys: s.envKeys,
      keyUrl: s.keyUrl,
      fallback: s.fallback,
    });
    this.catalog.register({
      provider,
      getApiKey,
      requiresKey: s.requiresKey,
      fallback: s.preset ? s.fallback : [],
      pinned: s.custom ? s.fallback : undefined,
    });
  }

  ids(): string[] {
    return [...this.slots.keys()];
  }

  has(id: string): boolean {
    return this.slots.has(id);
  }

  get(id: string): LLMProvider {
    const s = this.slots.get(id);
    if (!s) throw new Error(`Nhà cung cấp không tồn tại: ${id}`);
    return s.provider;
  }

  defaultModel(id: string): string {
    const s = this.slots.get(id);
    if (!s) return '';
    return s.preset?.defaultModel ?? s.custom?.models?.[0] ?? (s.extra ? s.fallback[0]?.id : undefined) ?? '';
  }

  async descriptors(): Promise<ProviderDescriptor[]> {
    const out: ProviderDescriptor[] = [];
    for (const [id, s] of this.slots) {
      // Tài khoản Locaith: có "khoá" khi đã đăng nhập; không đọc kho khoá API và không đọc biến môi trường.
      if (s.account) {
        out.push({
          id,
          label: s.provider.label,
          kind: s.provider.kind,
          flavor: s.provider.flavor,
          baseUrl: s.preset ? this.opts.baseUrlOverrides?.[id] || s.preset.baseUrl : '',
          builtin: true,
          hasKey: !!this.opts.account?.token(),
          keyFromEnv: false,
          requiresKey: s.requiresKey,
          keyUrl: undefined,
          defaultModel: this.defaultModel(id),
          fallbackModels: s.fallback,
          account: true,
        });
        continue;
      }
      const stored = await this.opts.resolveApiKey(id);
      const hasStored = !!(stored && stored.trim());
      const env = this.envKey(s.envKeys);
      out.push({
        id,
        label: s.provider.label,
        kind: s.provider.kind,
        flavor: s.provider.flavor,
        baseUrl: s.preset ? (this.opts.baseUrlOverrides?.[id] || s.preset.baseUrl) : (s.custom?.baseUrl ?? ''),
        builtin: !!s.preset || !!s.extra,
        hasKey: hasStored || !!env,
        keyFromEnv: !hasStored && !!env,
        requiresKey: s.requiresKey,
        keyUrl: s.keyUrl,
        defaultModel: this.defaultModel(id),
        fallbackModels: s.fallback,
        account: false,
      });
    }
    return out;
  }

  /**
   * Model rẻ/nhanh cho bộ tóm tắt nền: ưu tiên gợi ý của nhà cung cấp trên danh sách model (thật hoặc dự phòng,
   * mới nhất trước), sau đó model bậc 'fast', cuối cùng là model mặc định.
   */
  async pickFastModel(id: string): Promise<string> {
    const s = this.slots.get(id);
    if (!s) return '';
    const res = await this.catalog.list(id);
    const hints = s.preset?.fastModelHint ?? GENERIC_FAST_HINT;
    for (const re of hints) {
      const m = res.models.find((x) => re.test(x.id));
      if (m) return m.id;
    }
    const fast = res.models.find((m) => m.tier === 'fast');
    if (fast) return fast.id;
    return this.defaultModel(id) || res.models[0]?.id || '';
  }
}
