/**
 * (lane:ctx-compaction) Tham số điều chỉnh việc giữ ngữ cảnh gọn — và ngưỡng nén hiệu dụng.
 *
 * Vì sao có: ngưỡng nén tính theo PHẦN TRĂM cửa sổ (compactAtPercent) hợp lý với cửa sổ 128k–200k, nhưng với model 1M
 * thì 80% = 800k token: mỗi lượt chậm gấp ~6 lần và tiền tố prompt-cache gần như vô dụng. Claude Code giải quyết bằng
 * một TRẦN tuyệt đối. Ở đây: ngưỡng hiệu dụng = min(compactAtPercent × cửa sổ, trần), trần mặc định 400k (0.7.7; trước đó 300k) CHỈ áp cho
 * cửa sổ > 400k và khi người dùng không tự đặt compactAtPercent (họ đã có ý kiến riêng thì tôn trọng).
 */

import type { EngineSettings } from './types';

export interface CompactTuning {
  /** Ngưỡng bắt đầu lược kết quả công cụ cũ, theo phần trăm cửa sổ (0 = tắt). */
  clearAtPercent: number;
  /** Lược theo đợt cho tới khi còn ≤ phần trăm này của cửa sổ. */
  clearTargetPercent: number;
  /** Số kết quả công cụ gần nhất luôn được giữ nguyên văn. */
  keepRecentResults: number;
  /** Số tin nhắn gần nhất giữ nguyên khi tóm tắt toàn bộ. */
  keepRecentMessages: number;
  /** Trần tuyệt đối cho ngưỡng nén (token). 0 = tự động theo quy tắc cửa sổ lớn. */
  compactAtTokens: number;
  /** Người dùng đã tự đặt compactAtPercent (ở bất kỳ cấp nào). */
  compactAtUserSet: boolean;
}

/**
 * Trần tự động áp cho cửa sổ rất lớn. 0.7.7: 300k → 400k, đi cùng độ trễ `CLEAR_TO_RATIO` (xem dưới): nhật ký cổng Locaith 04–10/11 cho thấy 51% chi phí của client mới là
 * token bị MẤT bộ nhớ đệm do lược kết quả công cụ NGAY SÁT trần mỗi lượt. Mô phỏng lại trên 8 phiên dài nhất (1.678 lần phá → 731): trần 400k + độ trễ 0,93 giữ gần nguyên
 * lượng kết quả cũ còn nguyên văn (−1,6%) và ngữ cảnh trung bình (+3%) mà chi phí miss ước tính giảm ~75%. (Trần 360k/độ trễ 0,83 rẻ tương đương nhưng mất 42% kết quả cũ — bị loại vì đụng chất lượng.)
 */
export const AUTO_CAP_TOKENS = 400_000;
/** Cửa sổ lớn hơn mức này mới bị trần tự động. */
export const AUTO_CAP_WINDOW_ABOVE = 400_000;
/**
 * Độ trễ khi lược vì chạm ngưỡng nén bị TRẦN chặn: lược xuống còn ~93% ngưỡng (không phải sát ngưỡng). Lược sát ngưỡng làm lịch sử đổi ở ĐẦU hội thoại mỗi lượt
 * → cả tiền tố ~300k token mất bộ nhớ đệm mỗi lượt (giá miss gấp 50 lần hit ở cổng Locaith). Chừa khoảng trống thì ~10–15 lượt mới phải lược một lần.
 */
export const CLEAR_TO_RATIO = 0.93;

export const DEFAULT_COMPACT_TUNING: CompactTuning = {
  clearAtPercent: 40,
  clearTargetPercent: 30,
  keepRecentResults: 8,
  keepRecentMessages: 20,
  compactAtTokens: 0,
  compactAtUserSet: false,
};

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Đọc tham số từ EngineSettings (trường tuỳ chọn; thiếu → mặc định an toàn). */
export function compactTuningFrom(s: Partial<Pick<EngineSettings, 'clearToolResultsAtPercent' | 'keepRecentMessages' | 'compactAtTokens' | 'compactAtUserSet'>> | undefined): CompactTuning {
  const d = DEFAULT_COMPACT_TUNING;
  const clearAt = clamp(Math.floor(num(s?.clearToolResultsAtPercent, d.clearAtPercent)), 0, 90);
  return {
    clearAtPercent: clearAt,
    // Mục tiêu sau khi lược luôn thấp hơn ngưỡng bắt đầu một khoảng (tránh lược lắt nhắt mỗi vòng).
    clearTargetPercent: clearAt === 0 ? 0 : Math.max(5, Math.min(d.clearTargetPercent, clearAt - 10)),
    keepRecentResults: d.keepRecentResults,
    keepRecentMessages: clamp(Math.floor(num(s?.keepRecentMessages, d.keepRecentMessages)), 4, 200),
    compactAtTokens: Math.max(0, Math.floor(num(s?.compactAtTokens, d.compactAtTokens))),
    compactAtUserSet: s?.compactAtUserSet === true,
  };
}

/**
 * Ngưỡng nén hiệu dụng (token). `compactAt` là tỉ lệ 0,5–0,95 (thiếu = 0,8).
 *  - có `compactAtTokens` > 0 → min(tỉ lệ × cửa sổ, compactAtTokens);
 *  - không có, cửa sổ > 400k và người dùng KHÔNG tự đặt compactAtPercent → min(tỉ lệ × cửa sổ, 400k);
 *  - còn lại → tỉ lệ × cửa sổ (hành vi cũ).
 */
export function effectiveCompactThreshold(contextWindow: number, compactAt: number | undefined, tuning: CompactTuning = DEFAULT_COMPACT_TUNING): number {
  const ratio = clamp(compactAt ?? 0.8, 0.5, 0.95);
  const byPercent = Math.floor(contextWindow * ratio);
  if (tuning.compactAtTokens > 0) return Math.min(byPercent, tuning.compactAtTokens);
  if (contextWindow > AUTO_CAP_WINDOW_ABOVE && !tuning.compactAtUserSet) return Math.min(byPercent, AUTO_CAP_TOKENS);
  return byPercent;
}

/**
 * Đích lược (token ƯỚC LƯỢNG, cùng thước đo với `estimateMessagesTokens`) khi nén TỰ ĐỘNG chạm ngưỡng mà ngưỡng đó đang bị TRẦN chặn (cửa sổ lớn / `compactAtTokens`).
 * Trả `undefined` = giữ đích theo phần trăm cửa sổ như cũ: khi `force` (/compact, tràn ngữ cảnh — người dùng muốn nén mạnh) và khi ngưỡng không bị trần chặn (cửa sổ ≤ 400k,
 * nơi đợt lược 40% → 30% cửa sổ vốn đã có độ trễ).
 *
 * Vì sao cần: ngưỡng so với token THẬT của lần gọi trước (gồm system + công cụ, `before`), còn việc lược đo bằng ƯỚC LƯỢNG tin nhắn. Đích cũ (30% cửa sổ = 300k ƯỚC LƯỢNG ≈ 340k
 * THẬT) lại nằm TRÊN ngưỡng 300k thật → lược xong vẫn ≥ ngưỡng → lượt sau lược tiếp, mỗi lượt. Ở đây đích = ngưỡng × CLEAR_TO_RATIO quy về thước ước lượng bằng `estimated / before`.
 */
export function autoClearTarget(o: { contextWindow: number; compactAt: number | undefined; threshold: number; estimated: number; before: number; force: boolean }): number | undefined {
  if (o.force) return undefined;
  const byPercent = Math.floor(o.contextWindow * clamp(o.compactAt ?? 0.8, 0.5, 0.95));
  if (o.threshold >= byPercent) return undefined;
  const toEst = o.before > 0 ? Math.min(1, o.estimated / o.before) : 1;
  return Math.max(0, Math.floor(o.threshold * CLEAR_TO_RATIO * toEst));
}

/** 968_000 → "968k", 1_234_567 → "1,2M" (vi) / "1.2M" (en), 850 → "850". */
export function formatTokens(n: number, lang: 'vi' | 'en' = 'vi'): string {
  const v = Math.max(0, Math.floor(n));
  const sep = lang === 'vi' ? ',' : '.';
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `${(m >= 10 ? Math.round(m).toString() : (Math.round(m * 10) / 10).toString()).replace('.', sep)}M`;
  }
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(v);
}
