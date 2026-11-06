/**
 * Dịch vụ nhà cung cấp dùng chung cho mọi bề mặt (VS Code, trình duyệt): bọc ProviderRegistry, cấp danh sách tóm tắt cho giao diện,
 * chọn model nhanh cho bộ tóm tắt nền. Mọi thứ phụ thuộc môi trường (cấu hình, kho khoá, nhật ký) đi qua `ProviderServiceDeps`.
 */

import type { LLMProvider, LogLevel, ModelInfo } from '../types';
import type { ProviderSummary } from '../../shared/protocol';
import { DEMO_MODELS, DEMO_PROVIDER_ID, DemoProvider } from './demo';
import { knownContextWindow } from './presets';
import { ProviderRegistry, type AccountProviderHooks, type CustomProviderConfig } from './registry';

const DEFAULT_CONTEXT = 128_000;

export interface ProviderServiceDeps {
  baseUrls(): Record<string, string>;
  customProviders(): CustomProviderConfig[];
  eagerInput(): boolean;
  /** 'auto' hoặc `nhà-cung-cấp:model`. */
  summarizerModel(): string;
  resolveKey(providerId: string): Promise<string | undefined>;
  log(level: LogLevel, message: string): void;
  /** Mặc định `process.env` (Node). Bản trình duyệt truyền `{}` — không có biến môi trường. */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Tiêu đề HTTP thêm theo từng nhà cung cấp (ví dụ cờ cho phép gọi trực tiếp từ trình duyệt của Anthropic). */
  extraHeaders?: Record<string, Record<string, string>>;
  /** Token tài khoản Locaith + tiêu đề + chốt chặn cho nhà cung cấp `locaith` (bản VS Code). Vắng = nhà cung cấp đó không được đăng ký (bản trình duyệt). */
  account?: AccountProviderHooks;
}

/** Lớp mỏng nối ProviderRegistry với cấu hình, kho khoá và nhật ký của bề mặt đang chạy. */
export class ProviderService {
  readonly registry: ProviderRegistry;

  constructor(private readonly deps: ProviderServiceDeps) {
    this.registry = new ProviderRegistry({
      resolveApiKey: (id) => deps.resolveKey(id),
      baseUrlOverrides: deps.baseUrls(),
      custom: deps.customProviders(),
      log: (level, msg) => deps.log(level, msg),
      providerOptions: { anthropic: { eagerInputStreaming: deps.eagerInput() } },
      env: deps.env,
      fetchImpl: deps.fetchImpl,
      extraHeaders: deps.extraHeaders,
      account: deps.account,
    });
    // Chế độ demo: chạy offline theo kịch bản, để thử giao diện ngay cả khi chưa có API key.
    this.registry.addExtraProvider(new DemoProvider(), DEMO_MODELS);
  }

  /** Đọc lại cấu hình (URL gốc, API tuỳ chỉnh, cờ riêng của adapter). */
  reconfigure(): void {
    this.registry.reconfigure({
      baseUrlOverrides: this.deps.baseUrls(),
      custom: this.deps.customProviders(),
      providerOptions: { anthropic: { eagerInputStreaming: this.deps.eagerInput() } },
    });
  }

  get(id: string): LLMProvider {
    return this.registry.get(id);
  }

  has(id: string): boolean {
    return this.registry.has(id);
  }

  async summaries(): Promise<ProviderSummary[]> {
    const out: ProviderSummary[] = [];
    for (const d of await this.registry.descriptors()) {
      const peek = this.registry.catalog.peek(d.id);
      out.push({
        id: d.id,
        label: d.label,
        kind: d.id === DEMO_PROVIDER_ID ? 'demo' : d.kind,
        baseUrl: d.baseUrl,
        hasKey: d.hasKey || !d.requiresKey,
        keyFromEnv: d.keyFromEnv,
        builtin: d.builtin,
        keyUrl: d.keyUrl,
        // Tài khoản Locaith: không có ô nhập khoá. `needsConsent` = chưa đồng ý thông báo dữ liệu → chưa được tính vào kho điều phối/failover.
        ...(d.account ? { account: true, needsConsent: !!this.deps.account?.guard?.() } : {}),
        models: peek?.models ?? d.fallbackModels,
        modelSource: peek?.source ?? 'fallback',
        modelError: peek?.error,
      });
    }
    return out;
  }

  /** Hỏi lại danh sách model của các nhà cung cấp đã có khoá. */
  async refresh(ids?: string[], force = false): Promise<void> {
    const descriptors = await this.registry.descriptors();
    const targets = descriptors.filter((d) => (ids ? ids.includes(d.id) : d.hasKey || !d.requiresKey));
    await Promise.all(
      targets.map((d) =>
        this.registry.catalog.list(d.id, { force }).catch((e) => this.deps.log('warn', `Không lấy được danh sách model của ${d.id}: ${e instanceof Error ? e.message : e}`)),
      ),
    );
  }

  models(id: string): ModelInfo[] {
    return this.registry.catalog.peek(id)?.models ?? [];
  }

  contextWindow(providerId: string, model: string): number {
    const info = this.models(providerId).find((m) => m.id === model);
    // Model chưa rõ cửa sổ (DeepSeek không trả context_length, tên cũ không có trong danh sách dự phòng): thử bảng theo tên rồi mới về 128K.
    return info?.contextWindow ?? knownContextWindow(model) ?? DEFAULT_CONTEXT;
  }

  defaultModel(providerId: string): string {
    return this.registry.defaultModel(providerId);
  }

  /** Model đã lưu mà hãng không còn cung cấp → thay bằng mặc định (không để lỗi 404 nổ ở lượt gọi thật). */
  async resolveModel(providerId: string, requested?: string): Promise<string> {
    try {
      return await this.registry.catalog.resolveModel(providerId, requested, { preferred: this.defaultModel(providerId) });
    } catch {
      return requested || this.defaultModel(providerId);
    }
  }

  async hasKey(providerId: string): Promise<boolean> {
    const d = (await this.registry.descriptors()).find((x) => x.id === providerId);
    return !!d && (d.hasKey || !d.requiresKey);
  }

  /**
   * Model nhỏ/nhanh cho bộ tóm tắt nền. `auto` = model rẻ của chính nhà cung cấp đang dùng;
   * hoặc đặt rõ `nhà-cung-cấp:model` trong cài đặt.
   */
  async fastTarget(sessionProviderId: string): Promise<{ provider: LLMProvider; model: string } | null> {
    const setting = this.deps.summarizerModel();
    const i = setting.indexOf(':');
    if (setting !== 'auto' && i > 0) {
      const p = setting.slice(0, i);
      if (this.registry.has(p) && (await this.hasKey(p))) return { provider: this.registry.get(p), model: setting.slice(i + 1) };
    }
    if (!this.registry.has(sessionProviderId)) return null;
    const fallback = this.registry.defaultModel(sessionProviderId);
    // Lần đầu có thể phải hỏi danh sách model qua mạng: đừng để việc này chặn tin nhắn quá 2,5 giây.
    const model = await Promise.race([
      this.registry.pickFastModel(sessionProviderId),
      new Promise<string>((r) => setTimeout(() => r(fallback), 2500)),
    ]);
    return model ? { provider: this.registry.get(sessionProviderId), model } : null;
  }
}
