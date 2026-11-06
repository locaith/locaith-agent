/**
 * "Locaith Auto": một nhà cung cấp ảo. Chọn nó trong danh sách model = giao cho bộ điều phối quyết định mỗi lượt gọi
 * dùng model nào trong số các khoá API người dùng đã nhập (cách "opusplan" của Claude Code, mở rộng ra nhiều hãng):
 *   • chế độ lập kế hoạch, hoặc mức suy luận cao/tối đa → hạng `top` (model mạnh nhất);
 *   • còn lại → hạng `balanced` (thợ chính, tiết kiệm hơn);
 *   • trong một vòng gọi công cụ thì giữ nguyên đích của lượt trước (không đổi hãng giữa chừng nếu không cần);
 *   • hãng nào bị giới hạn tốc độ/quá tải thì tự chuyển sang hãng khác (FailoverProvider).
 * Không bao giờ dùng nhà cung cấp chưa có khoá, nên dữ liệu chỉ đi tới các hãng người dùng đã tự cấu hình — và tới mô hình Locaith (đăng nhập bằng tài khoản, không cần khoá) CHỈ SAU KHI tài khoản
 * đã đồng ý thông báo dữ liệu của nó (ModelPool bỏ qua nhà cung cấp còn `needsConsent`).
 */

import {
  ProviderError,
  type CompleteRequest,
  type LLMProvider,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderEvent,
  type StreamRequest,
} from '../types';
import { FailoverProvider, type FailoverHooks } from './failover';
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, type ModelPool, type Target } from './pool';
import type { Tier } from './tiers';

export const AUTO_MODELS: ModelInfo[] = [
  {
    id: AUTO_MODEL_ID,
    label: 'Tự động điều phối (Locaith Auto)',
    tier: 'top',
    contextWindow: 128_000,
    reasoning: true,
    vision: true,
    note: 'Tự chọn model theo việc và theo các khoá API bạn đã nhập (và mô hình Locaith nếu bạn đã đồng ý thông báo dữ liệu của nó); tự chuyển hãng khi bị giới hạn tốc độ.',
  },
];

export interface AutoHooks extends FailoverHooks {
  /** Gọi khi đích được chọn khác lần trước của cùng phiên (để báo người dùng "Auto → Claude Opus"). */
  onPick?(t: Target, tier: Tier, sessionKey: string | undefined): void;
}

const EMPTY_POOL = 'Locaith Auto chưa có nhà cung cấp nào để điều phối: hãy nhập ít nhất một khoá API (Cài đặt → Nhà cung cấp).';

export function chooseTier(req: Pick<StreamRequest, 'tools' | 'thinking'>): Tier {
  if (req.tools.some((t) => t.name === 'exit_plan_mode')) return 'top';
  if (req.thinking.level === 'high' || req.thinking.level === 'max') return 'top';
  return 'balanced';
}

export class AutoProvider implements LLMProvider {
  readonly id = AUTO_PROVIDER_ID;
  readonly label = 'Locaith Auto';
  readonly kind = 'openai-chat' as const;
  readonly flavor = 'openai' as const;
  readonly capabilities: ProviderCapabilities = {
    reasoning: 'summary',
    parallelTools: true,
    vision: true,
    toolArgStreaming: 'whole',
    thinkingBoundToPrefix: true,
  };
  private readonly sticky = new Map<string, { providerId: string; tier: Tier }>();
  private readonly announced = new Map<string, string>();

  constructor(
    private readonly pool: ModelPool,
    private readonly hooks: AutoHooks = {},
  ) {}

  /** Cùng phiên + cùng hạng thì ở lại hãng cũ (giữ prompt-cache, không đổi giọng văn giữa chừng) trừ khi hãng đó đang nghỉ. */
  private async chain(tier: Tier, sessionKey: string | undefined): Promise<Target[]> {
    const sticky = sessionKey ? this.sticky.get(sessionKey) : undefined;
    const prefer = sticky && sticky.tier === tier ? { providerId: sticky.providerId } : undefined;
    return this.pool.rank(tier, { prefer });
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    const tier = chooseTier(req);
    const targets = await this.chain(tier, req.sessionKey);
    if (targets.length === 0) throw new ProviderError(EMPTY_POOL, { kind: 'auth', providerId: this.id, retryable: false });
    const fo = new FailoverProvider(targets, this.pool, this.hooks, { id: this.id, label: this.label });
    const first = targets[0];
    this.announce(first, tier, req.sessionKey);
    yield* fo.stream(req);
    const used = fo.lastUsed ?? first;
    if (req.sessionKey) this.sticky.set(req.sessionKey, { providerId: used.providerId, tier });
    if (used !== first) this.announce(used, tier, req.sessionKey);
  }

  async complete(req: CompleteRequest): Promise<string> {
    const targets = await this.pool.rank(req.fast ? 'fast' : 'balanced');
    if (targets.length === 0) throw new ProviderError(EMPTY_POOL, { kind: 'auth', providerId: this.id, retryable: false });
    return new FailoverProvider(targets, this.pool, this.hooks, { id: this.id, label: this.label }).complete(req);
  }

  async fetchModels(): Promise<ModelInfo[]> {
    return AUTO_MODELS;
  }

  async ping(): Promise<void> {
    if ((await this.pool.rank('balanced')).length === 0) throw new ProviderError(EMPTY_POOL, { kind: 'auth', providerId: this.id, retryable: false });
  }

  private announce(t: Target, tier: Tier, sessionKey: string | undefined): void {
    const key = `${t.providerId}:${t.model}`;
    const k = sessionKey ?? '';
    if (this.announced.get(k) === key) return;
    this.announced.set(k, key);
    this.hooks.onPick?.(t, tier, sessionKey);
  }
}
