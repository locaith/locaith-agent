/**
 * Lời mời đánh giá — hiện MỘT lần, sau khi người dùng đã thực sự dùng vài lần.
 *
 * Chạm một ngôi sao là GỬI NGAY về Locaith (không mở trang nào, không bắt viết gì) — như nút 👍/👎 của Claude. Nhận xét bằng chữ là tuỳ chọn,
 * hiện SAU khi đã gửi sao; đánh giá công khai trên Chrome Web Store chỉ là lựa chọn thêm (nút riêng), không còn là việc bắt buộc.
 *
 * Vì sao làm ở tầng dữ liệu: cần đếm qua nhiều phiên và nhiều cửa sổ, phải nhớ "đã tắt" để không làm phiền, nhớ đánh giá chưa gửi được
 * (mất mạng) để gửi lại lần sau, và phải chịu được việc cấu hình bị đọc lại từ storage. Hàm thuần → test được từng luật.
 *
 * Nguyên tắc (theo chính sách của Chrome Web Store): không đổi tính năng lấy đánh giá, không hỏi lại khi người dùng đã từ chối,
 * chỉ hỏi sau khi họ đã có kết quả dùng được, và dữ liệu gửi đi chỉ gồm số sao + (nếu người dùng tự gõ) nhận xét + phiên bản/ngôn ngữ — không có danh tính.
 */

/** Số lần gửi tối thiểu trước khi mời đánh giá (người dùng đã thực sự dùng, không phải mở lên rồi bỏ). */
export const RATING_AFTER_SENDS = 3;
/** Đã bấm "để sau" → im lặng bao lâu. Hết hạn mới cân nhắc hỏi lại; "không hiện lại" thì im vĩnh viễn. */
export const RATING_SNOOZE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mã mục của tiện ích trên Chrome Web Store: 32 chữ cái a–p.
 * Bản 0.6.27 mang một mã gõ nhầm (29 ký tự, không tồn tại) và cả test cũng chép đúng mã sai đó — nút «Đánh giá» mở một trang không có thật.
 * Nay có test kiểm đúng định dạng; đổi mục cửa hàng thì sửa MỘT chỗ này.
 */
export const CHROME_STORE_ID = 'amngiccgboohakecgdiadjkdfcablkjc';

/** Địa chỉ trang đánh giá công khai của tiện ích trên Chrome Web Store (lựa chọn thêm, không bắt buộc). */
export const RATING_URL = {
  vi: `https://chromewebstore.google.com/detail/${CHROME_STORE_ID}/reviews?hl=vi`,
  en: `https://chromewebstore.google.com/detail/${CHROME_STORE_ID}/reviews?hl=en`,
} as const;

/** Nơi nhận đánh giá một chạm: cùng máy chủ với cổng Locaith; đi tới nhóm góp ý của đội (đã có sẵn, cho phép ẩn danh, có giới hạn tốc độ). */
export const RATING_ENDPOINT = 'https://studio-api.locaith.com/api/feedback';

/** Độ dài tối đa của nhận xét bằng chữ. */
export const RATING_COMMENT_MAX = 500;
/** Đánh giá chưa gửi được (mất mạng…) chỉ giữ chừng này ngày rồi bỏ. */
export const RATING_PENDING_DAYS = 30;
const PENDING_MAX = 3;

export type RatingKind = 'stars' | 'comment';

/** Một thứ chờ gửi về Locaith. */
export interface RatingPending {
  kind: RatingKind;
  stars: number;
  comment?: string;
  at: number;
}

export interface RatingState {
  /** Số tin nhắn người dùng đã gửi (chỉ đếm tin thật, không đếm lần mở khung chat). */
  sends: number;
  /** Đã bấm "Không hiện lại" (null/không có = chưa). */
  deniedAt?: number;
  /** Đã chấm sao (hoặc mở trang đánh giá) — không mời lại (null/không có = chưa). */
  ratedAt?: number;
  /** Đã bấm "Để sau" — sau RATING_SNOOZE_DAYS mới được hỏi lại. */
  snoozedAt?: number;
  /** Số sao người dùng đã chọn (1–5). */
  stars?: number;
  /** Lần gần nhất gửi được một thứ về Locaith. */
  sentAt?: number;
  /** Chưa gửi được (mất mạng, máy chủ bận…) — thử lại ở lần mở sau. */
  pending?: RatingPending[];
}

export const EMPTY_RATING: RatingState = { sends: 0 };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const starsOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5 ? v : undefined);

function sanitizePending(v: unknown, now: number): RatingPending[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: RatingPending[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const kind: RatingKind | undefined = o.kind === 'stars' || o.kind === 'comment' ? o.kind : undefined;
    const stars = starsOf(o.stars);
    const at = num(o.at);
    if (!kind || !stars || !at || now - at > RATING_PENDING_DAYS * DAY_MS) continue;
    const comment = typeof o.comment === 'string' ? o.comment.trim().slice(0, RATING_COMMENT_MAX) : '';
    if (kind === 'comment' && !comment) continue;
    out.push({ kind, stars, at, ...(comment ? { comment } : {}) });
    if (out.length >= PENDING_MAX) break;
  }
  return out.length ? out : undefined;
}

/** Chuẩn hoá dữ liệu đọc từ storage (có thể bị sửa tay hoặc của bản cũ). */
export function sanitizeRating(v: unknown, now = Date.now()): RatingState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...EMPTY_RATING };
  const o = v as Record<string, unknown>;
  const sends = typeof o.sends === 'number' && Number.isFinite(o.sends) ? Math.max(0, Math.min(100_000, Math.round(o.sends))) : 0;
  const pending = sanitizePending(o.pending, now);
  return {
    sends,
    ...(num(o.deniedAt) ? { deniedAt: num(o.deniedAt) } : {}),
    ...(num(o.ratedAt) ? { ratedAt: num(o.ratedAt) } : {}),
    ...(num(o.snoozedAt) ? { snoozedAt: num(o.snoozedAt) } : {}),
    ...(starsOf(o.stars) ? { stars: starsOf(o.stars) } : {}),
    ...(num(o.sentAt) ? { sentAt: num(o.sentAt) } : {}),
    ...(pending ? { pending } : {}),
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

/** Người dùng đã mở trang đánh giá trên cửa hàng (lựa chọn thêm). */
export function markRated(s: RatingState, now = Date.now()): RatingState {
  return { ...s, ratedAt: s.ratedAt ?? now };
}

/** Người dùng chạm một ngôi sao: ghi nhận NGAY (không mời lại) và xếp hàng gửi về Locaith. Số sao không hợp lệ → giữ nguyên. */
export function submitStars(s: RatingState, stars: number, now = Date.now()): RatingState {
  const n = starsOf(stars);
  if (!n) return s;
  return { ...s, ratedAt: now, stars: n, pending: [{ kind: 'stars', stars: n, at: now }] };
}

/** Nhận xét bằng chữ (tuỳ chọn) đi kèm số sao đã chấm. Rỗng hoặc chưa chấm sao → giữ nguyên. */
export function addComment(s: RatingState, text: string, now = Date.now()): RatingState {
  const comment = text.trim().slice(0, RATING_COMMENT_MAX);
  if (!comment || !s.stars) return s;
  const rest = (s.pending ?? []).filter((p) => p.kind !== 'comment');
  const item: RatingPending = { kind: 'comment', stars: s.stars, comment, at: now };
  return { ...s, pending: [...rest, item].slice(-PENDING_MAX) };
}

/** Đã gửi xong thứ đầu hàng loại `kind` (hoặc bỏ vì máy chủ từ chối hẳn). */
export function markSent(s: RatingState, kind: RatingKind, now = Date.now()): RatingState {
  const idx = (s.pending ?? []).findIndex((p) => p.kind === kind);
  if (idx < 0) return s;
  const left = (s.pending ?? []).filter((_, i) => i !== idx);
  const { pending: _drop, ...rest } = s;
  void _drop;
  return { ...rest, sentAt: now, ...(left.length ? { pending: left } : {}) };
}

/** Nội dung gửi về nhóm góp ý của Locaith (khớp `FeedbackRequest` của backend: message, rating, page). */
export interface RatingPayload {
  message: string;
  rating: number;
  page: string;
}

export interface RatingContext {
  version: string;
  lang: 'vi' | 'en';
  sends: number;
  browser: 'chrome' | 'edge';
}

/**
 * Dựng nội dung gửi. KHÔNG có danh tính nào: không email, không địa chỉ trang đang xem, không khoá, không mã máy — chỉ số sao,
 * nhận xét người dùng tự gõ (nếu có) và dòng «tiện ích · phiên bản · ngôn ngữ · số lần dùng» để đội biết đánh giá từ đâu.
 */
export function buildRatingPayload(p: RatingPending, ctx: RatingContext): RatingPayload {
  const where = ctx.browser === 'edge' ? 'Edge' : 'Chrome';
  const message =
    p.kind === 'comment' && p.comment
      ? `Nhận xét kèm đánh giá ${p.stars}★ (tiện ích ${where}): ${p.comment}`
      : `Đánh giá tiện ích ${where}: ${p.stars}★`;
  return { message: message.slice(0, 3500), rating: p.stars, page: `tiện ích ${where} · v${ctx.version.slice(0, 20)} · ${ctx.lang} · ${ctx.sends} lượt dùng` };
}
