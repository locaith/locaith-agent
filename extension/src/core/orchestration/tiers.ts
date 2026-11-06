/**
 * Phân hạng model: top (mạnh nhất, dùng để lập kế hoạch/phản biện), balanced (thợ chính), fast (rẻ/nhanh, do thám).
 * Adapter đã gắn `tier` cho model nào biết chắc (Claude, Gemini, bộ preset); còn lại suy ra từ tên.
 */

import type { ModelInfo } from '../types';

export type Tier = 'top' | 'balanced' | 'fast';
export const TIERS: readonly Tier[] = ['top', 'balanced', 'fast'];

/** `top` rồi `balanced` rồi `fast`: thứ tự thay thế khi nhà cung cấp không có model đúng hạng. */
export const TIER_FALLBACK: Record<Tier, Tier[]> = {
  top: ['top', 'balanced', 'fast'],
  balanced: ['balanced', 'top', 'fast'],
  fast: ['fast', 'balanced', 'top'],
};

const FAST = /(^|[^a-z])(haiku|mini|nano|flash|lite|small|instant|tiny|fast|turbo|distill|gemma|ministral)([^a-z]|$)|(^|[^a-z0-9])(1b|3b|7b|8b|9b)([^a-z0-9]|$)/;
const TOP =
  /opus|fable|ultra|reasoner|(^|[^a-z])pro([^a-z]|$)|deepseek-?r1|(^|[^a-z0-9])o[134]([^a-z0-9]|$)|gpt-?5|gpt-?4\.5|grok-?[4-9]|405b|(^|[^a-z])max([^a-z]|$)|large/;

export function classifyTier(m: Pick<ModelInfo, 'id' | 'label' | 'tier'>): Tier {
  if (m.tier) return m.tier;
  const s = `${m.id} ${m.label ?? ''}`.toLowerCase();
  if (FAST.test(s)) return 'fast';
  if (TOP.test(s)) return 'top';
  return 'balanced';
}

export function isTier(v: unknown): v is Tier {
  return v === 'top' || v === 'balanced' || v === 'fast';
}
