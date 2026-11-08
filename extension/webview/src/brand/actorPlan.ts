/**
 * Lịch «logo Lo biến hình» ở dòng chờ — HÀM THUẦN, không đụng DOM/giờ máy (test ở test/webview/loActor.test.ts).
 *
 * Chu kỳ 80 giây (khớp bộ ảnh đã duyệt 08/11/2026):
 *   0–8 s logo phát sáng · chó robot 12 s · logo 6 s · robot người 12 s · logo 6 s · drone 12 s · logo 6 s · tên lửa 18 s.
 * Hết 80 s lặp lại từ đầu chu kỳ (8 s logo rồi bốn nhân vật), nhưng từ chu kỳ thứ hai thứ tự bốn nhân vật là ngẫu nhiên
 * (theo `seed`, nên render lại không đổi) và KHÔNG BAO GIỜ có hai lần liền cùng một nhân vật — kể cả ở chỗ nối giữa hai chu kỳ.
 * Mỗi nhân vật vào/ra bằng 0,5 s chuyển cảnh «vệt sáng quét» (WIPE_SEC).
 */

export type ActorKind = 'dog' | 'bot' | 'drone' | 'rocket';
export type ActorPhase = 'logo' | 'wipe-in' | 'char' | 'wipe-out';

export interface ActorPlan {
  phase: ActorPhase;
  /** Nhân vật của pha hiện tại; `null` ở pha `logo`. */
  actor: ActorKind | null;
  /** Tiến độ trong pha hiện tại, 0 → 1. */
  progress: number;
}

export const ACTOR_KINDS: readonly ActorKind[] = ['dog', 'bot', 'drone', 'rocket'];
/** Thời lượng mỗi nhân vật trên màn (giây), gồm cả hai lần chuyển cảnh. */
export const ACTOR_SECONDS: Record<ActorKind, number> = { dog: 12, bot: 12, drone: 12, rocket: 18 };
export const WARMUP_SEC = 8;
export const REST_SEC = 6;
export const WIPE_SEC = 0.5;
/** Tổng một chu kỳ: 8 + (12+12+12+18) + 3×6 = 80. */
export const CYCLE_SEC = WARMUP_SEC + ACTOR_KINDS.reduce((s, k) => s + ACTOR_SECONDS[k], 0) + REST_SEC * (ACTOR_KINDS.length - 1);

/** Số ngẫu nhiên giả (mulberry32): cùng hạt giống → cùng dãy. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const orderCache = new Map<number, ActorKind[][]>();

/** Thứ tự bốn nhân vật của chu kỳ thứ `cycle` (0 = thứ tự trong ảnh đã duyệt). */
export function cycleOrder(seed: number, cycle: number): ActorKind[] {
  const s = seed >>> 0;
  let orders = orderCache.get(s);
  if (!orders) {
    orders = [[...ACTOR_KINDS]];
    orderCache.set(s, orders);
    if (orderCache.size > 64) orderCache.delete(orderCache.keys().next().value as number); // dọn bớt, tránh phình
  }
  while (orders.length <= cycle) {
    const k = orders.length;
    const prevLast = orders[k - 1][ACTOR_KINDS.length - 1];
    const rand = rng((s ^ Math.imul(k, 0x9e3779b1)) >>> 0);
    const next = [...ACTOR_KINDS];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
    // Chỗ nối chu kỳ: nhân vật đầu không được trùng nhân vật cuối của chu kỳ trước.
    if (next[0] === prevLast) {
      const swap = 1 + Math.floor(rand() * (next.length - 1));
      [next[0], next[swap]] = [next[swap], next[0]];
    }
    orders.push(next);
  }
  return orders[cycle];
}

/** Pha hiện tại sau `elapsedSec` giây chờ (có thể lẻ). `seed`: hạt giống cố định theo lượt chạy. */
export function actorPlan(elapsedSec: number, seed: number): ActorPlan {
  const e = Number.isFinite(elapsedSec) && elapsedSec > 0 ? elapsedSec : 0;
  const cycle = Math.floor(e / CYCLE_SEC);
  const t = e - cycle * CYCLE_SEC;
  if (t < WARMUP_SEC) return { phase: 'logo', actor: null, progress: t / WARMUP_SEC };

  const order = cycleOrder(seed, cycle);
  let start = WARMUP_SEC;
  for (let i = 0; i < order.length; i++) {
    const kind = order[i];
    const end = start + ACTOR_SECONDS[kind];
    if (t < end) {
      const local = t - start;
      const dur = ACTOR_SECONDS[kind];
      if (local < WIPE_SEC) return { phase: 'wipe-in', actor: kind, progress: local / WIPE_SEC };
      if (local >= dur - WIPE_SEC) return { phase: 'wipe-out', actor: kind, progress: (local - (dur - WIPE_SEC)) / WIPE_SEC };
      return { phase: 'char', actor: kind, progress: (local - WIPE_SEC) / (dur - 2 * WIPE_SEC) };
    }
    start = end;
    if (i < order.length - 1) {
      if (t < start + REST_SEC) return { phase: 'logo', actor: null, progress: (t - start) / REST_SEC };
      start += REST_SEC;
    }
  }
  return { phase: 'logo', actor: null, progress: 0 }; // không tới được (t < CYCLE_SEC)
}

/** Nhân vật cần HIỆN lúc này (vào + đang chạy), `null` = logo. Pha ra đã tính là «về logo» để chạy chuyển cảnh ra. */
export function actorTarget(plan: ActorPlan): ActorKind | null {
  return plan.phase === 'wipe-in' || plan.phase === 'char' ? plan.actor : null;
}

/** Băm chuỗi (id lượt) thành hạt giống 32 bit. */
export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
