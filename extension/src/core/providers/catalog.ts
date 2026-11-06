/**
 * Danh mục model: hỏi API của từng hãng bằng CHÍNH khoá đang dùng (chỉ model khoá đó gọi được mới hiện ra),
 * lưu đệm, và lùi về danh sách dự phòng khi không hỏi được. Tổng quát hoá hành vi của skill gemini-model-list:
 *
 *  - Bộ nhớ đệm khoá theo "dấu vân" (băm) của API key: danh sách lấy bằng khoá khác bị bỏ.
 *  - Đệm 1 giờ khi thành công; 2 phút khi lỗi (hãng sập không làm mọi lượt chờ đủ hạn mức).
 *  - Nhiều lượt hỏi cùng lúc dùng chung MỘT lượt gọi (không bắn dồn).
 *  - Hỏi lỗi mà còn danh sách cũ → dùng danh sách cũ (source:'cache' kèm `error`), tốt hơn dự phòng.
 *  - Danh sách dự phòng chỉ cần ĐÚNG, không cần ĐỦ; chưa có khoá thì không gọi mạng.
 *  - Model đã lưu mà hãng không còn cung cấp → thay bằng model mặc định (`resolveModel`) thay vì để lỗi 404
 *    nổ ra ở lượt gọi thật.
 *  - Danh sách thật được bổ sung nhãn/bậc/cửa sổ ngữ cảnh từ danh sách dự phòng theo id.
 */

import { createHash } from 'node:crypto';
import type { LLMProvider, ModelInfo, ModelListResult } from '../types';

export interface CatalogEntryConfig {
  provider: LLMProvider;
  getApiKey: () => Promise<string | undefined>;
  /** Không có khoá thì không gọi mạng, dùng danh sách dự phòng (mặc định true). */
  requiresKey?: boolean;
  fallback: ModelInfo[];
  /** Model người dùng ghim tay (API tuỳ chỉnh): luôn có mặt trong danh sách. */
  pinned?: ModelInfo[];
}

export interface CatalogOptions {
  now?: () => number;
  ttlMs?: number;
  failTtlMs?: number;
  log?: (message: string) => void;
}

interface CacheState {
  fp: string;
  at: number;
  failed: boolean;
  /** null = chưa từng lấy được. */
  models: ModelInfo[] | null;
  error?: string;
  /** Thời điểm lấy THÀNH CÔNG gần nhất. */
  fetchedAt?: number;
}

export const MODELS_TTL_MS = 60 * 60 * 1000;
export const MODELS_FAIL_TTL_MS = 2 * 60 * 1000;

function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Bổ sung thông tin từ danh sách dự phòng (theo id) vào danh sách thật; chỉ ghi đè trường còn thiếu. */
export function enrichModels(live: readonly ModelInfo[], fallback: readonly ModelInfo[]): ModelInfo[] {
  const fb = new Map(fallback.map((m) => [m.id, m]));
  return live.map((m) => {
    const base = fb.get(m.id);
    if (!base) return m;
    const merged: ModelInfo = { ...base, ...defined(m) };
    // Nhãn thật chỉ là chính id thì dùng nhãn đẹp của bản dự phòng.
    if (m.label === m.id) merged.label = base.label;
    if (!m.tier && base.tier) merged.tier = base.tier;
    return merged;
  });
}

function withPinned(models: readonly ModelInfo[], pinned: readonly ModelInfo[] | undefined): ModelInfo[] {
  if (!pinned || pinned.length === 0) return [...models];
  const ids = new Set(models.map((m) => m.id));
  return [...models, ...pinned.filter((p) => !ids.has(p.id))];
}

export class ModelCatalog {
  private readonly entries = new Map<string, CatalogEntryConfig>();
  private readonly state = new Map<string, CacheState>();
  private readonly inflight = new Map<string, { fp: string; promise: Promise<ModelListResult> }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failTtlMs: number;
  private readonly log?: (message: string) => void;

  constructor(opts: CatalogOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? MODELS_TTL_MS;
    this.failTtlMs = opts.failTtlMs ?? MODELS_FAIL_TTL_MS;
    this.log = opts.log;
  }

  register(cfg: CatalogEntryConfig): void {
    this.entries.set(cfg.provider.id, cfg);
    this.state.delete(cfg.provider.id);
    this.inflight.delete(cfg.provider.id);
  }

  unregister(id: string): void {
    this.entries.delete(id);
    this.state.delete(id);
    this.inflight.delete(id);
  }

  invalidate(id: string): void {
    this.state.delete(id);
    this.inflight.delete(id);
  }

  /** Kết quả đã biết gần nhất mà KHÔNG gọi mạng (để vẽ giao diện lần đầu); undefined nếu chưa có gì. */
  peek(id: string): ModelListResult | undefined {
    const e = this.entries.get(id);
    const st = this.state.get(id);
    if (!e || !st) return undefined;
    return this.fromState(e, st, 'cache');
  }

  /** Danh sách dự phòng của nhà cung cấp (kèm model ghim). */
  fallbackOf(id: string): ModelInfo[] {
    const e = this.entries.get(id);
    return e ? withPinned(e.fallback, e.pinned) : [];
  }

  async list(id: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<ModelListResult> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Nhà cung cấp chưa đăng ký: ${id}`);

    const key = await e.getApiKey();
    if (!key && e.requiresKey !== false) {
      return { models: withPinned(e.fallback, e.pinned), source: 'fallback' };
    }
    const fp = fingerprint(key ?? '');

    let st = this.state.get(id);
    // Danh sách lấy bằng khoá khác không nói được gì về khoá này.
    if (st && st.fp !== fp) {
      this.state.delete(id);
      st = undefined;
    }

    if (!opts.force && st && this.now() - st.at < (st.failed ? this.failTtlMs : this.ttlMs)) {
      return this.fromState(e, st, 'cache');
    }

    const existing = this.inflight.get(id);
    if (existing && existing.fp === fp) return existing.promise;

    const promise = (async (): Promise<ModelListResult> => {
      try {
        const live = await e.provider.fetchModels(opts.signal);
        const next: CacheState = {
          fp,
          at: this.now(),
          failed: false,
          models: enrichModels(live, e.fallback),
          fetchedAt: this.now(),
        };
        this.state.set(id, next);
        const result = this.fromState(e, next, 'live');
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log?.(`[catalog] ${id}: không lấy được danh sách model: ${message}`);
        const prev = this.state.get(id);
        // Danh sách cũ còn dùng được thì giữ, chỉ đánh dấu lỗi để ít hỏi lại.
        const failed: CacheState = {
          fp,
          at: this.now(),
          failed: true,
          models: prev && prev.fp === fp ? prev.models : null,
          error: message,
          fetchedAt: prev && prev.fp === fp ? prev.fetchedAt : undefined,
        };
        this.state.set(id, failed);
        return this.fromState(e, failed, 'cache');
      } finally {
        const cur = this.inflight.get(id);
        if (cur && cur.fp === fp) this.inflight.delete(id);
      }
    })();
    this.inflight.set(id, { fp, promise });
    return promise;
  }

  /**
   * Model sẽ thật sự được gọi: `requested` nếu hãng còn cung cấp, không thì `preferred` (nếu còn), không thì
   * model đầu danh sách. Khi chỉ có danh sách dự phòng (không kiểm chứng được) thì giữ nguyên lựa chọn của
   * người dùng — kể cả tên model gõ tay.
   */
  async resolveModel(id: string, requested: string | undefined, opts: { preferred?: string } = {}): Promise<string> {
    const res = await this.list(id);
    const ids = res.models.map((m) => m.id);
    if (requested && ids.includes(requested)) return requested;
    if (requested && res.source === 'fallback') return requested;
    if (opts.preferred && ids.includes(opts.preferred)) return opts.preferred;
    return ids[0] ?? opts.preferred ?? requested ?? '';
  }

  private fromState(e: CatalogEntryConfig, st: CacheState, liveSource: 'live' | 'cache'): ModelListResult {
    if (st.models && st.models.length > 0) {
      const result: ModelListResult = {
        models: withPinned(st.models, e.pinned),
        source: liveSource,
        fetchedAt: st.fetchedAt,
      };
      if (st.failed && st.error) result.error = st.error;
      return result;
    }
    const result: ModelListResult = { models: withPinned(e.fallback, e.pinned), source: 'fallback' };
    if (st.error) result.error = st.error;
    return result;
  }
}
