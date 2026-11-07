/**
 * (lane:output-timeouts) Watchdog theo bậc cho luồng model — chống TREO, không giết suy luận hợp lệ.
 *
 * Vì sao có: 44 lượt >60 s và 10 ca client_disconnect trong log thật; vài lần là máy chủ im lặng hẳn (kết nối còn mở nhưng không
 * có byte nào tới) và người dùng chỉ còn cách bấm Dừng. Nhưng model suy luận lâu ở ngữ cảnh lớn là chuyện bình thường, nên ngưỡng
 * phải theo cỡ ngữ cảnh và mức suy luận, và thời gian đứng HÀNG CHỜ của cổng Locaith (sự kiện `queue`/`retry`) không được tính.
 *
 * Hai ngưỡng:
 *   • im lặng (stall): không có sự kiện nào trong N giây — N = bậc theo `lastContextTokens` × hệ số theo mức suy luận;
 *   • tổng (total): tổng thời gian HOẠT ĐỘNG (không tính lúc xếp hàng/chờ thử lại) của một lần gọi.
 *
 * Hết ngưỡng ⇒ gọi `onTimeout()` (engine huỷ riêng lần stream đó bằng AbortController con — KHÁC với người dùng bấm Dừng) và ném
 * `StallError`. Phần chữ đã sinh engine giữ lại và tự thử lại đúng một lần; xem engine.ts.
 */

import type { ProviderEvent, ThinkingLevel } from '../types';
import type { EngineSettings, SessionState } from './types';

/** Bậc ngưỡng im lặng theo cỡ ngữ cảnh (token) → giây. */
export const STALL_TIERS: ReadonlyArray<{ upTo: number; seconds: number }> = [
  { upTo: 32_000, seconds: 20 },
  { upTo: 200_000, seconds: 45 },
  { upTo: 600_000, seconds: 70 },
  { upTo: Infinity, seconds: 90 },
];

/** Hệ số theo mức suy luận: off/low ×1, medium ×1,5, high ×2,5, max/swarm ×4. */
export function thinkingFactor(level: ThinkingLevel | undefined): number {
  switch (level) {
    case 'medium':
      return 1.5;
    case 'high':
      return 2.5;
    case 'max':
    case 'swarm':
      return 4;
    default:
      return 1;
  }
}

/** Ngưỡng im lặng tự động (ms) cho một cỡ ngữ cảnh và mức suy luận. */
export function autoStallMs(contextTokens: number, level: ThinkingLevel | undefined): number {
  const ctx = Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 0;
  const tier = STALL_TIERS.find((x) => ctx < x.upTo) ?? STALL_TIERS[STALL_TIERS.length - 1];
  return Math.round(tier.seconds * thinkingFactor(level) * 1000);
}

export interface StallPolicy {
  /** Ngưỡng im lặng (ms). */
  stallMs: number;
  /** Trần tổng thời gian hoạt động của một lần gọi (ms). */
  totalMs: number;
}

/** Mặc định của `agent.modelCallMaxSeconds`. */
export const DEFAULT_CALL_MAX_SECONDS = 600;

/**
 * Chính sách cho lần gọi sắp tới từ cài đặt + phiên. `null` = watchdog tắt (`modelStallSeconds` = 0).
 * `modelStallSeconds`: 'auto' (mặc định) | 0 (tắt) | số giây cố định. Số không hợp lệ → 'auto'.
 */
export function resolveStallPolicy(settings: Pick<EngineSettings, 'modelStallSeconds' | 'modelCallMaxSeconds'>, session: Pick<SessionState, 'lastContextTokens' | 'thinkingLevel' | 'swarm'>): StallPolicy | null {
  const raw = settings.modelStallSeconds;
  const level: ThinkingLevel | undefined = session.swarm ? 'swarm' : session.thinkingLevel;
  let stallMs: number;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 0) return null;
    stallMs = Math.max(5, raw) * 1000;
  } else {
    stallMs = autoStallMs(session.lastContextTokens, level);
  }
  const totalRaw = settings.modelCallMaxSeconds;
  const totalSec = typeof totalRaw === 'number' && Number.isFinite(totalRaw) && totalRaw > 0 ? Math.max(30, totalRaw) : DEFAULT_CALL_MAX_SECONDS;
  return { stallMs, totalMs: Math.max(stallMs, totalSec * 1000) };
}

export class StallError extends Error {
  constructor(
    /** 'stall' = im lặng quá ngưỡng; 'total' = vượt trần tổng. */
    readonly kind: 'stall' | 'total',
    /** Ngưỡng đã vượt (ms). */
    readonly limitMs: number,
  ) {
    super(kind === 'stall' ? `Model im lặng quá ${Math.round(limitMs / 1000)} giây` : `Lần gọi model vượt ${Math.round(limitMs / 1000)} giây`);
    this.name = 'StallError';
  }
}

export interface WatchOptions {
  /** Gọi NGAY khi hết ngưỡng, trước khi ném lỗi (engine huỷ lần stream đó). */
  onTimeout(err: StallError): void;
  now?: () => number;
}

/** Sự kiện mà thời gian chờ SAU nó không tính (đang đứng hàng chờ của cổng / nhà cung cấp đang ngủ trước khi thử lại). */
export function pausesClock(ev: ProviderEvent): boolean {
  return ev.type === 'queue' || ev.type === 'retry';
}

/**
 * Bọc luồng sự kiện của nhà cung cấp bằng watchdog. Mỗi lần chờ sự kiện kế tiếp đua với một bộ hẹn giờ; đang "tạm dừng đồng hồ"
 * (sau `queue`/`retry`) thì chờ không giới hạn cho tới sự kiện kế. Vượt ngưỡng → `onTimeout` rồi ném `StallError`;
 * promise `next()` còn treo được nuốt lỗi (nhà cung cấp sẽ ném 'aborted' khi engine huỷ).
 */
export async function* watchStream<T extends ProviderEvent>(source: AsyncIterable<T>, policy: StallPolicy, opts: WatchOptions): AsyncGenerator<T, void, void> {
  const now = opts.now ?? Date.now;
  const it = source[Symbol.asyncIterator]();
  let paused = false;
  let activeMs = 0;
  let segmentStart = now();
  try {
    while (true) {
      const pending = it.next();
      let result: IteratorResult<T>;
      if (paused) {
        result = await pending;
      } else {
        const budget = Math.max(1, Math.min(policy.stallMs, policy.totalMs - activeMs));
        const kind: StallError['kind'] = policy.totalMs - activeMs <= policy.stallMs ? 'total' : 'stall';
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StallError(kind, kind === 'total' ? policy.totalMs : policy.stallMs)), budget);
        });
        try {
          result = await Promise.race([pending, timeout]);
        } catch (err) {
          if (err instanceof StallError) {
            opts.onTimeout(err);
            pending.catch(() => undefined);
          }
          throw err;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      const t = now();
      if (!paused) activeMs += Math.max(0, t - segmentStart);
      segmentStart = t;
      if (result.done) return;
      const ev = result.value;
      paused = pausesClock(ev);
      yield ev;
      // Thời gian engine xử lý sự kiện (await trong vòng for) không phải lỗi của model: đặt lại mốc sau khi yield.
      segmentStart = now();
    }
  } finally {
    // Người tiêu thụ dừng sớm (break/throw): báo nguồn đóng để nhà cung cấp dọn kết nối. KHÔNG await: một `next()` còn treo
    // (model im hẳn) sẽ xếp `return()` phía sau nó và làm chính chỗ này treo theo.
    void it.return?.(undefined)?.catch(() => undefined);
  }
}
