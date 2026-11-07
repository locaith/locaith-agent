/**
 * (lane:ctx-compaction) Tham số điều chỉnh việc giữ ngữ cảnh gọn — và ngưỡng nén hiệu dụng.
 *
 * Vì sao có: ngưỡng nén tính theo PHẦN TRĂM cửa sổ (compactAtPercent) hợp lý với cửa sổ 128k–200k, nhưng với model 1M
 * thì 80% = 800k token: mỗi lượt chậm gấp ~6 lần và tiền tố prompt-cache gần như vô dụng. Claude Code giải quyết bằng
 * một TRẦN tuyệt đối. Ở đây: ngưỡng hiệu dụng = min(compactAtPercent × cửa sổ, trần), trần mặc định 300k CHỈ áp cho
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

/** Trần tự động áp cho cửa sổ rất lớn. */
export const AUTO_CAP_TOKENS = 300_000;
/** Cửa sổ lớn hơn mức này mới bị trần tự động. */
export const AUTO_CAP_WINDOW_ABOVE = 400_000;

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
 *  - không có, cửa sổ > 400k và người dùng KHÔNG tự đặt compactAtPercent → min(tỉ lệ × cửa sổ, 300k);
 *  - còn lại → tỉ lệ × cửa sổ (hành vi cũ).
 */
export function effectiveCompactThreshold(contextWindow: number, compactAt: number | undefined, tuning: CompactTuning = DEFAULT_COMPACT_TUNING): number {
  const ratio = clamp(compactAt ?? 0.8, 0.5, 0.95);
  const byPercent = Math.floor(contextWindow * ratio);
  if (tuning.compactAtTokens > 0) return Math.min(byPercent, tuning.compactAtTokens);
  if (contextWindow > AUTO_CAP_WINDOW_ABOVE && !tuning.compactAtUserSet) return Math.min(byPercent, AUTO_CAP_TOKENS);
  return byPercent;
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
