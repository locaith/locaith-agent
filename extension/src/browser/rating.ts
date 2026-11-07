/**
 * Lời mời đánh giá trên Chrome Web Store — hiện MỘT lần, sau khi người dùng đã thực sự dùng vài lần.
 *
 * Vì sao làm ở tầng dữ liệu: cần đếm qua nhiều phiên và nhiều cửa sổ, phải nhớ "đã tắt" để không làm phiền,
 * và phải chịu được việc cấu hình bị đọc lại từ storage. Hàm thuần → test được từng luật.
 *
 * Nguyên tắc (theo chính sách của Chrome Web Store): không đổi tính năng lấy đánh giá, không hỏi lại khi người
 * dùng đã từ chối, chỉ hỏi sau khi họ đã có kết quả dùng được.
 */

/** Số lần gửi tối thiểu trước khi mời đánh giá (người dùng đã thực sự dùng, không phải mở lên rồi bỏ). */
export const RATING_AFTER_SENDS = 3;
/** Đã bấm "để sau" → im lặng bao lâu. Hết hạn mới cân nhắc hỏi lại; "không hiện lại" thì im vĩnh viễn. */
export const RATING_SNOOZE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Địa chỉ trang đánh giá của tiện ích trên Chrome Web Store. */
export const RATING_URL = {
  vi: 'https://chromewebstore.google.com/detail/locaith-ai-%E2%80%94-tr%E1%BB%A3-l%C3%BD-tr%C3%ACnh-duy%E1%BB%87t/amgjccgboohakecgdiajdkfcabkjc?hl=vi',
  en: 'https://chromewebstore.google.com/detail/locaith-ai-%E2%80%94-tr%E1%BB%A3-l%C3%BD-tr%C3%ACnh-duy%E1%BB%87t/amgjccgboohakecgdiajdkfcabkjc?hl=en',
} as const;

export interface RatingState {
  /** Số tin nhắn người dùng đã gửi (chỉ đếm tin thật, không đếm lần mở khung chat). */
  sends: number;
  /** Đã bấm "Không hiện lại" (null/không có = chưa). */
  deniedAt?: number;
  /** Đã mở trang đánh giá (null/không có = chưa). */
  ratedAt?: number;
  /** Đã bấm "Để sau" — sau RATING_SNOOZE_DAYS mới được hỏi lại. */
  snoozedAt?: number;
}

export const EMPTY_RATING: RatingState = { sends: 0 };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** Chuẩn hoá dữ liệu đọc từ storage (có thể bị sửa tay hoặc của bản cũ). */
export function sanitizeRating(v: unknown): RatingState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...EMPTY_RATING };
  const o = v as Record<string, unknown>;
  const sends = typeof o.sends === 'number' && Number.isFinite(o.sends) ? Math.max(0, Math.min(100_000, Math.round(o.sends))) : 0;
  return {
    sends,
    ...(num(o.deniedAt) ? { deniedAt: num(o.deniedAt) } : {}),
    ...(num(o.ratedAt) ? { ratedAt: num(o.ratedAt) } : {}),
    ...(num(o.snoozedAt) ? { snoozedAt: num(o.snoozedAt) } : {}),
  };
}

/** Có nên hiện lời mời đánh giá lúc này không. */
export function shouldAskRating(s: RatingState, now = Date.now()): boolean {
  if (s.deniedAt || s.ratedAt) return false;
  if (s.sends < RATING_AFTER_SENDS) return false;
  if (s.snoozedAt && now - s.snoozedAt < RATING_SNOOZE_DAYS * DAY_MS) return false;
  return true;
}

/** Ghi nhận một lần gửi tin: trả về trạng thái mới (không sửa bản gốc). */
export function countRatingSend(s: RatingState): RatingState {
  return { ...s, sends: Math.min(100_000, s.sends + 1) };
}

/** Người dùng đã bấm "Để sau". */
export function snoozeRating(s: RatingState, now = Date.now()): RatingState {
  return { ...s, snoozedAt: now };
}

/** Người dùng đã bấm "Không hiện lại". */
export function denyRating(s: RatingState, now = Date.now()): RatingState {
  return { ...s, deniedAt: now };
}

/** Người dùng đã mở trang đánh giá. */
export function markRated(s: RatingState, now = Date.now()): RatingState {
  return { ...s, ratedAt: now };
}
