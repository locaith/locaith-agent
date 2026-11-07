import { describe, expect, it, vi } from 'vitest';
import { RATING_ENDPOINT, type RatingPayload } from '../../src/browser/rating';
import { postRating } from '../../src/browser/ratingSend';

const payload: RatingPayload = { message: 'Đánh giá tiện ích Chrome: 5★', rating: 5, page: 'tiện ích Chrome · v0.7.0 · vi · 3 lượt dùng' };
const ok = (status: number) => ({ ok: status >= 200 && status < 300, status });

describe('postRating — gửi MỘT đánh giá về Locaith, ẩn danh, không bao giờ ném lỗi', () => {
  it('2xx → sent; gửi đúng URL, JSON, không cookie/Referer/xác thực', async () => {
    const f = vi.fn(async () => ok(200));
    expect(await postRating(payload, f)).toBe('sent');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RATING_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(JSON.parse(String(init.body))).toEqual(payload);
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).toEqual(['content-type']); // không Authorization/Cookie
  });

  it('429 / 5xx / mất mạng / hết giờ → retry (giữ lại, thử lần mở sau)', async () => {
    expect(await postRating(payload, async () => ok(429))).toBe('retry');
    expect(await postRating(payload, async () => ok(503))).toBe('retry');
    expect(await postRating(payload, async () => Promise.reject(new TypeError('Failed to fetch')))).toBe('retry');
    const hang = (_u: string, init?: RequestInit) => new Promise<never>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    expect(await postRating(payload, hang, 20)).toBe('retry');
  });

  it('4xx khác (máy chủ từ chối hẳn) → drop, để không lặp mãi', async () => {
    expect(await postRating(payload, async () => ok(400))).toBe('drop');
    expect(await postRating(payload, async () => ok(422))).toBe('drop');
    expect(await postRating(payload, async () => ok(404))).toBe('drop');
  });
});
