/**
 * (0.7.2) Thu nhỏ ảnh đính kèm — kế hoạch THUẦN dùng chung (canvas nằm ở webview/src/imageShrink.ts).
 *
 * Vì sao: một ảnh chụp màn hình dán vào chat nặng ~1,7 MB (base64 ~2,3 MB) và nằm lại trong lịch sử gửi model của mọi lượt sau,
 * 40 ảnh làm một cuộc trò chuyện phình tới 69 MB. Model không cần ảnh quá 1568 px cạnh dài (các hãng tự thu nhỏ về cỡ đó),
 * nên thu nhỏ ngay lúc đính kèm: không mất chất lượng đọc được mà nhẹ hơn nhiều lần.
 */

/** Cạnh dài tối đa của ảnh gửi cho model. */
export const IMAGE_MAX_EDGE = 1568;
/** Chất lượng JPEG khi nén lại ảnh lớn. */
export const IMAGE_JPEG_QUALITY = 0.85;
/** Ảnh nhỏ hơn mức này (byte) mà cạnh dài trong hạn thì giữ nguyên, không đụng. */
export const IMAGE_KEEP_BYTES = 400 * 1024;
/** Bản xem trước lưu trong transcript: cạnh dài tối đa, và dung lượng (ký tự base64 ≈ 60 KB nhị phân). */
export const THUMB_MAX_EDGE = 480;
export const THUMB_MAX_B64 = 80_000;
/** Chế độ nhẹ: xem trước nhỏ hơn. */
export const THUMB_MAX_EDGE_LITE = 320;
export const THUMB_MAX_B64_LITE = 40_000;

export interface ImageFacts {
  width: number;
  height: number;
  /** Dung lượng nhị phân của ảnh gốc. */
  bytes: number;
  mime: string;
  /** Có điểm ảnh trong suốt (một phần). */
  hasAlpha: boolean;
}

export type ShrinkPlan =
  /** Giữ nguyên byte gốc. */
  | { action: 'keep'; width: number; height: number; mime: string }
  /** Vẽ lại ở kích thước mới rồi mã hoá theo `mime` (JPEG kèm `quality`; PNG giữ alpha). */
  | { action: 'reencode'; width: number; height: number; mime: 'image/jpeg' | 'image/png'; quality?: number };

/** Ảnh động: vẽ lại sẽ làm mất chuyển động → luôn giữ nguyên. */
const ANIMATED = new Set(['image/gif']);

/** Kích thước đích: cạnh dài ≤ `max`, giữ tỉ lệ, không phóng to. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const k = Math.min(1, max / Math.max(w, h));
  return k >= 1 ? { width: w, height: h } : { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * Quyết định thu nhỏ ảnh đính kèm:
 *  - GIF (có thể động) → giữ nguyên;
 *  - cạnh dài > 1568 → thu về 1568 (JPEG q0,85 nếu không trong suốt; PNG nếu có alpha);
 *  - cạnh trong hạn mà nặng > 400 KB và KHÔNG trong suốt → nén JPEG q0,85 (không đổi kích thước);
 *  - còn lại (nhỏ, hoặc PNG có alpha trong hạn) → giữ nguyên.
 */
export function planShrink(f: ImageFacts, opts: { maxEdge?: number; keepBytes?: number; quality?: number } = {}): ShrinkPlan {
  const maxEdge = opts.maxEdge ?? IMAGE_MAX_EDGE;
  const keepBytes = opts.keepBytes ?? IMAGE_KEEP_BYTES;
  const quality = opts.quality ?? IMAGE_JPEG_QUALITY;
  const mime = f.mime || 'image/png';
  const own = fitWithin(f.width, f.height, Number.MAX_SAFE_INTEGER);
  if (ANIMATED.has(mime) || !(f.width > 0) || !(f.height > 0)) return { action: 'keep', width: own.width, height: own.height, mime };
  const target = fitWithin(f.width, f.height, maxEdge);
  const resized = target.width !== own.width || target.height !== own.height;
  if (resized) {
    return f.hasAlpha ? { action: 'reencode', ...target, mime: 'image/png' } : { action: 'reencode', ...target, mime: 'image/jpeg', quality };
  }
  if (!f.hasAlpha && f.bytes > keepBytes && mime !== 'image/jpeg') return { action: 'reencode', ...target, mime: 'image/jpeg', quality };
  // JPEG sẵn rồi: nén lại chỉ có ích khi nặng hơn hẳn mức giữ nguyên (tránh nén đi nén lại ảnh vốn đã nhẹ).
  if (!f.hasAlpha && f.bytes > keepBytes * 2 && mime === 'image/jpeg') return { action: 'reencode', ...target, mime: 'image/jpeg', quality };
  return { action: 'keep', width: target.width, height: target.height, mime };
}

/** Chỉ nhận kết quả thu nhỏ khi NHẸ HƠN bản gốc (PNG đồ hoạ đôi khi nặng hơn sau khi vẽ lại): true = dùng bản mới. */
export function shrinkWorthIt(originalBytes: number, newBytes: number): boolean {
  return newBytes > 0 && newBytes < originalBytes * 0.95;
}

/** Cỡ xem trước theo chế độ. */
export function thumbSpec(lite: boolean): { edge: number; maxB64: number } {
  return lite ? { edge: THUMB_MAX_EDGE_LITE, maxB64: THUMB_MAX_B64_LITE } : { edge: THUMB_MAX_EDGE, maxB64: THUMB_MAX_B64 };
}

/** Các nấc thử khi bản xem trước còn quá nặng: giảm chất lượng trước, rồi giảm cạnh. */
export function thumbLadder(lite: boolean): { edge: number; quality: number }[] {
  const { edge } = thumbSpec(lite);
  return [
    { edge, quality: 0.72 },
    { edge, quality: 0.55 },
    { edge: Math.round(edge * 0.75), quality: 0.55 },
    { edge: Math.round(edge * 0.55), quality: 0.5 },
  ];
}

/** Ước lượng dung lượng nhị phân từ độ dài base64. */
export const b64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4);
