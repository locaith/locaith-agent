/**
 * Kho model dùng chung (ModelPool): chỉ gồm các nhà cung cấp mà người dùng ĐÃ nhập khoá API.
 * Việc của nó: với một hạng (top/balanced/fast) trả về chuỗi đích theo thứ tự ưu tiên, bỏ qua nhà cung cấp đang bị
 * giới hạn tốc độ (cooldown), chia đều việc cho các nhà cung cấp (đếm lượt dùng) và giữ cổng đồng thời theo từng nhà cung cấp.
 */

import type { OrchestrationMode, OrchestrationPoolEntry } from '../../shared/protocol';
import { Semaphore } from '../agents/semaphore';
import { knownContextWindow } from '../providers/presets';
import type { LLMProvider, ModelInfo } from '../types';
import { classifyTier, TIER_FALLBACK, TIERS, type Tier } from './tiers';

export type { OrchestrationMode };

export const AUTO_PROVIDER_ID = 'locaith-auto';
export const AUTO_MODEL_ID = 'auto';
/** Không bao giờ nằm trong kho: chế độ demo và chính Auto. */
const NEVER = new Set(['demo', AUTO_PROVIDER_ID]);

export interface PoolProviderInfo {
  id: string;
  label: string;
  hasKey: boolean;
  /** Nhà cung cấp dùng tài khoản Locaith mà tài khoản chưa đồng ý thông báo dữ liệu: KHÔNG được tự chọn (Auto/failover/agent con) trước khi đồng ý. */
  needsConsent?: boolean;
  models: ModelInfo[];
}

/** Nguồn dữ liệu của kho; `ProviderService` thoả sẵn. */
export interface PoolSource {
  summaries(): Promise<PoolProviderInfo[]>;
  get(id: string): LLMProvider;
}

export interface Target {
  providerId: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  tier: Tier;
  contextWindow: number;
  provider: LLMProvider;
}

export interface RankOptions {
  /** Nhà cung cấp ưu tiên khi các ứng viên ngang nhau (thường là nhà cung cấp người dùng đang chọn). */
  prefer?: { providerId: string };
  exclude?: readonly string[];
  /** true = chia tải: ưu tiên nhà cung cấp ít được dùng nhất (dùng cho agent con chạy song song). */
  spread?: boolean;
}

export type PoolDescription = OrchestrationPoolEntry;

const DEFAULT_CONTEXT = 128_000;

/**
 * Số agent chạy CÙNG LÚC tối đa trên MỘT nhà cung cấp (cổng thứ hai, cạnh `agents.maxConcurrent` — tổng mọi hãng). 0.7.7 nâng 4 → 8: swarm thường chỉ có một hãng
 * (Locaith hoặc một khoá), nên trần 4 làm «16 chạy cùng lúc» chỉ còn 4 thật. 429 của hãng vẫn được thử lại + nghỉ (cooldown) như cũ.
 */
export const DEFAULT_MAX_PER_PROVIDER = 8;

export class ModelPool {
  private readonly cooldownUntil = new Map<string, number>();
  private readonly uses = new Map<string, number>();
  private readonly sems = new Map<string, Semaphore>();
  private readonly now: () => number;
  private readonly perProvider: number;

  constructor(
    private readonly src: PoolSource,
    opts: { now?: () => number; maxPerProvider?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.perProvider = Math.max(1, opts.maxPerProvider ?? DEFAULT_MAX_PER_PROVIDER);
  }

  /** Nhà cung cấp đã có khoá (trừ demo/Auto). */
  async providers(): Promise<PoolProviderInfo[]> {
    return (await this.src.summaries()).filter((p) => p.hasKey && !p.needsConsent && !NEVER.has(p.id) && p.models.length > 0);
  }

  /** Model tốt nhất của một nhà cung cấp cho hạng `tier`, hoặc hạng gần nhất nếu thiếu. */
  pickModel(models: readonly ModelInfo[], tier: Tier): { model: ModelInfo; tier: Tier } | null {
    const byTier = new Map<Tier, ModelInfo[]>();
    for (const m of models) {
      const t = classifyTier(m);
      const list = byTier.get(t);
      if (list) list.push(m);
      else byTier.set(t, [m]);
    }
    for (const t of TIER_FALLBACK[tier]) {
      const list = byTier.get(t);
      if (!list?.length) continue;
      const best = (t === 'top' ? list.find((m) => m.reasoning) : undefined) ?? list[0];
      return { model: best, tier: t };
    }
    return null;
  }

  async rank(tier: Tier, o: RankOptions = {}): Promise<Target[]> {
    const rows: { t: Target; dist: number; cooling: boolean; uses: number; pref: boolean }[] = [];
    for (const p of await this.providers()) {
      if (o.exclude?.includes(p.id)) continue;
      const pick = this.pickModel(p.models, tier);
      if (!pick) continue;
      let provider: LLMProvider;
      try {
        provider = this.src.get(p.id);
      } catch {
        continue;
      }
      rows.push({
        t: {
          providerId: p.id,
          providerLabel: p.label,
          model: pick.model.id,
          modelLabel: pick.model.label || pick.model.id,
          tier: pick.tier,
          contextWindow: pick.model.contextWindow ?? knownContextWindow(pick.model.id) ?? DEFAULT_CONTEXT,
          provider,
        },
        dist: TIER_FALLBACK[tier].indexOf(pick.tier),
        cooling: this.isCooling(p.id),
        uses: this.uses.get(p.id) ?? 0,
        pref: o.prefer?.providerId === p.id,
      });
    }
    rows.sort((a, b) => {
      if (a.cooling !== b.cooling) return a.cooling ? 1 : -1;
      if (o.spread) {
        if (a.uses !== b.uses) return a.uses - b.uses;
        if (a.dist !== b.dist) return a.dist - b.dist;
        if (a.pref !== b.pref) return a.pref ? -1 : 1;
      } else {
        // Luồng chính: thứ tự ổn định (không xoay vòng giữa các hãng giữa hội thoại — mất prompt-cache và đổi giọng văn).
        if (a.dist !== b.dist) return a.dist - b.dist;
        if (a.pref !== b.pref) return a.pref ? -1 : 1;
      }
      return a.t.providerId.localeCompare(b.t.providerId);
    });
    return rows.map((r) => r.t);
  }

  isCooling(providerId: string): boolean {
    return (this.cooldownUntil.get(providerId) ?? 0) > this.now();
  }

  markCooldown(providerId: string, ms: number): void {
    this.cooldownUntil.set(providerId, this.now() + Math.max(1000, ms));
  }

  clearCooldown(providerId?: string): void {
    if (providerId) this.cooldownUntil.delete(providerId);
    else this.cooldownUntil.clear();
  }

  noteUse(providerId: string): void {
    this.uses.set(providerId, (this.uses.get(providerId) ?? 0) + 1);
  }

  usesOf(providerId: string): number {
    return this.uses.get(providerId) ?? 0;
  }

  limiter(providerId: string): Semaphore {
    let s = this.sems.get(providerId);
    if (!s) {
      s = new Semaphore(this.perProvider);
      this.sems.set(providerId, s);
    }
    return s;
  }

  /** Bảng "hạng → model" của từng nhà cung cấp, để hiện cho người dùng thấy Auto sẽ dùng gì. */
  async describe(): Promise<PoolDescription[]> {
    const out: PoolDescription[] = [];
    for (const p of await this.providers()) {
      const tiers: PoolDescription['tiers'] = {};
      for (const tier of TIERS) {
        const byTier = p.models.filter((m) => classifyTier(m) === tier);
        const best = (tier === 'top' ? byTier.find((m) => m.reasoning) : undefined) ?? byTier[0];
        if (best) tiers[tier] = { model: best.id, label: best.label || best.id };
      }
      out.push({ providerId: p.id, providerLabel: p.label, cooling: this.isCooling(p.id), tiers });
    }
    return out;
  }
}
