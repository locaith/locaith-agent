/**
 * Gửi MỘT đánh giá về Locaith (POST JSON tới RATING_ENDPOINT). Hàm thuần theo `fetch` truyền vào → test được không cần mạng.
 *
 * Kết quả cho người gọi biết nên làm gì với thứ đang chờ gửi:
 *  - 'sent'  : máy chủ nhận (2xx) → xoá khỏi hàng chờ;
 *  - 'retry' : lỗi tạm (mất mạng, hết giờ, 429, 5xx) → giữ lại, thử ở lần mở sau;
 *  - 'drop'  : máy chủ từ chối hẳn (4xx khác) → gửi lại cũng vô ích, bỏ để không lặp mãi.
 *
 * Không cookie, không tiêu đề xác thực, không Referer: yêu cầu ẩn danh (cổng nhận góp ý cho phép khách chưa đăng nhập).
 * Không bao giờ ném lỗi — gửi đánh giá hỏng không được làm hỏng khung chat.
 */

import { RATING_ENDPOINT, type RatingPayload } from './rating';

export type RatingSendResult = 'sent' | 'retry' | 'drop';

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status'>>;

/** Gọi `fetch` toàn cục NGAY LÚC GỬI (không cất vào biến/thuộc tính: trình duyệt ném «Illegal invocation»). */
const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export async function postRating(payload: RatingPayload, fetchImpl: FetchLike = globalFetch, timeoutMs = 10_000): Promise<RatingSendResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(RATING_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: ac.signal,
    });
    if (r.ok) return 'sent';
    return r.status === 429 || r.status >= 500 ? 'retry' : 'drop';
  } catch {
    return 'retry';
  } finally {
    clearTimeout(timer);
  }
}
