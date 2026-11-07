import { describe, expect, it } from 'vitest';
import {
  CHROME_STORE_ID,
  RATING_AFTER_SENDS,
  RATING_COMMENT_MAX,
  RATING_ENDPOINT,
  RATING_PENDING_DAYS,
  RATING_SNOOZE_DAYS,
  RATING_URL,
  addComment,
  buildRatingPayload,
  countRatingSend,
  denyRating,
  markRated,
  markSent,
  sanitizeRating,
  shouldAskRating,
  snoozeRating,
  submitStars,
} from '../../src/browser/rating';

const DAY = 24 * 60 * 60 * 1000;

describe('shouldAskRating — chỉ mời sau khi đã dùng thật, và không làm phiền', () => {
  it('chưa đủ số lần dùng → không mời', () => {
    expect(shouldAskRating({ sends: RATING_AFTER_SENDS - 1 })).toBe(false);
    expect(shouldAskRating({ sends: RATING_AFTER_SENDS })).toBe(true);
  });

  it('đã tắt ("không hiện lại") → không bao giờ mời lại', () => {
    expect(shouldAskRating({ sends: 99, deniedAt: 1, snoozedAt: 1 })).toBe(false);
  });

  it('đã mở trang đánh giá → không mời lại', () => {
    expect(shouldAskRating({ sends: 99, ratedAt: 1 })).toBe(false);
  });

  it('"để sau" thì im trong RATING_SNOOZE_DAYS ngày rồi mới cân nhắc lại', () => {
    const now = Date.now();
    const s = snoozeRating({ sends: 5 }, now);
    expect(shouldAskRating(s, now + DAY)).toBe(false);
    expect(shouldAskRating(s, now + (RATING_SNOOZE_DAYS - 1) * DAY)).toBe(false);
    expect(shouldAskRating(s, now + (RATING_SNOOZE_DAYS + 1) * DAY)).toBe(true);
  });

  it('đếm gửi tin là hàm thuần, không sửa bản gốc', () => {
    const s = { sends: 0 };
    expect(countRatingSend(s).sends).toBe(1);
    expect(s.sends).toBe(0);
  });

  it('sanitize chịu được dữ liệu hỏng, không ném lỗi', () => {
    expect(sanitizeRating(null)).toEqual({ sends: 0 });
    expect(sanitizeRating('hỏng')).toEqual({ sends: 0 });
    expect(sanitizeRating({ sends: -5, deniedAt: 'x' })).toEqual({ sends: 0 });
    expect(sanitizeRating({ sends: 1e12 })).toEqual({ sends: 100_000 });
    expect(sanitizeRating({ sends: 4.7, ratedAt: 123 })).toEqual({ sends: 5, ratedAt: 123 });
  });

  it('đánh dấu đã đánh giá / từ chối giữ nguyên số lần dùng', () => {
    expect(markRated({ sends: 7 }, 10)).toMatchObject({ sends: 7, ratedAt: 10 });
    expect(denyRating({ sends: 7 }, 10)).toMatchObject({ sends: 7, deniedAt: 10 });
  });

  it('địa chỉ đánh giá trỏ đúng trang Chrome Web Store, có tham số ngôn ngữ', () => {
    for (const u of [RATING_URL.vi, RATING_URL.en] as string[]) {
      expect(u.startsWith('https://chromewebstore.google.com/detail/')).toBe(true);
      expect(u).toContain(CHROME_STORE_ID);
      expect(u).toMatch(/[?&]hl=(vi|en)$/);
    }
  });

  // Bản 0.6.27 mang mã mục SAI (29 ký tự, không tồn tại) và test cũ chép đúng mã sai đó → nút «Đánh giá» mở trang không có thật.
  it('mã mục cửa hàng đúng định dạng Chrome: 32 chữ cái a–p, và đúng mục «Locaith AI — Trợ lý trình duyệt»', () => {
    expect(CHROME_STORE_ID).toMatch(/^[a-p]{32}$/);
    expect(CHROME_STORE_ID).toBe('amngiccgboohakecgdiadjkdfcablkjc'); // mục đã tạo 05/11/2026 (xem trang cửa hàng của chủ dự án)
  });
});

describe('đánh giá một chạm — chạm sao là ghi nhận và xếp hàng gửi NGAY, không mở trang nào', () => {
  const NOW = 1_000_000;
  it('submitStars: không mời lại, nhớ số sao, xếp một mục chờ gửi; số sao không hợp lệ thì giữ nguyên', () => {
    const s = submitStars({ sends: 5 }, 4, NOW);
    expect(s).toMatchObject({ sends: 5, ratedAt: NOW, stars: 4, pending: [{ kind: 'stars', stars: 4, at: NOW }] });
    expect(shouldAskRating(s, NOW + 1)).toBe(false);
    for (const bad of [0, 6, 2.5, -1, Number.NaN]) expect(submitStars({ sends: 5 }, bad, NOW)).toEqual({ sends: 5 });
  });

  it('nhận xét chữ chỉ có sau khi đã chấm sao, cắt đúng độ dài, rỗng thì bỏ qua', () => {
    expect(addComment({ sends: 5 }, 'hay', NOW)).toEqual({ sends: 5 }); // chưa chấm sao
    const rated = submitStars({ sends: 5 }, 2, NOW);
    expect(addComment(rated, '   ', NOW)).toEqual(rated);
    const withText = addComment(rated, 'x'.repeat(RATING_COMMENT_MAX + 80), NOW + 1);
    expect(withText.pending).toHaveLength(2);
    expect(withText.pending?.[1]).toMatchObject({ kind: 'comment', stars: 2, at: NOW + 1 });
    expect(withText.pending?.[1].comment).toHaveLength(RATING_COMMENT_MAX);
    // gửi nhận xét lần hai thay cho lần một, không chất đống
    const again = addComment(withText, 'nhận xét mới', NOW + 2);
    expect(again.pending?.filter((p) => p.kind === 'comment')).toEqual([{ kind: 'comment', stars: 2, comment: 'nhận xét mới', at: NOW + 2 }]);
  });

  it('markSent: bỏ đúng mục đã gửi, ghi thời điểm gửi, giữ mục còn lại', () => {
    const s = addComment(submitStars({ sends: 5 }, 5, NOW), 'tốt', NOW + 1);
    const a = markSent(s, 'stars', NOW + 5);
    expect(a.sentAt).toBe(NOW + 5);
    expect(a.pending).toEqual([{ kind: 'comment', stars: 5, comment: 'tốt', at: NOW + 1 }]);
    const b = markSent(a, 'comment', NOW + 6);
    expect(b.pending).toBeUndefined();
    expect(markSent(b, 'comment', NOW + 7)).toEqual(b); // không còn gì để bỏ
  });

  it('sanitize: đọc lại mục chờ gửi, bỏ mục hỏng/quá cũ/quá nhiều', () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const good = { kind: 'stars', stars: 3, at: now - 1000 };
    const old = { kind: 'stars', stars: 3, at: now - (RATING_PENDING_DAYS + 1) * 24 * 60 * 60 * 1000 };
    const noText = { kind: 'comment', stars: 3, at: now - 5 };
    const badStars = { kind: 'stars', stars: 9, at: now - 5 };
    const r = sanitizeRating({ sends: 4, stars: 3, sentAt: 77, pending: [good, old, noText, badStars, 'x', null, ...Array.from({ length: 8 }, () => good)] }, now);
    expect(r.stars).toBe(3);
    expect(r.sentAt).toBe(77);
    expect(r.pending?.length).toBe(3); // tối đa 3, mục hỏng/cũ bị bỏ
    expect(r.pending?.every((p) => p.kind === 'stars' && p.stars === 3)).toBe(true);
    expect(sanitizeRating({ sends: 4, stars: 'x', pending: 'hỏng' }, now)).toEqual({ sends: 4 });
  });

  it('nội dung gửi: đúng khuôn FeedbackRequest của backend, KHÔNG có danh tính (email, địa chỉ trang đang xem, khoá, mã máy)', () => {
    const ctx = { version: '0.7.0', lang: 'vi', sends: 12, browser: 'edge' } as const;
    const stars = buildRatingPayload({ kind: 'stars', stars: 5, at: 1 }, ctx);
    expect(stars).toEqual({ message: 'Đánh giá tiện ích Edge: 5★', rating: 5, page: 'tiện ích Edge · v0.7.0 · vi · 12 lượt dùng' });
    const cmt = buildRatingPayload({ kind: 'comment', stars: 2, comment: 'Chưa gửi được ảnh', at: 1 }, { ...ctx, browser: 'chrome', lang: 'en' });
    expect(cmt.message).toBe('Nhận xét kèm đánh giá 2★ (tiện ích Chrome): Chưa gửi được ảnh');
    expect(cmt.rating).toBe(2);
    expect(Object.keys(cmt).sort()).toEqual(['message', 'page', 'rating']);
    expect(cmt.page).not.toMatch(/https?:|@|key|token/i);
    // độ dài trong giới hạn của backend (message ≤ 4000, page cắt ở 300)
    const long = buildRatingPayload({ kind: 'comment', stars: 1, comment: 'x'.repeat(RATING_COMMENT_MAX), at: 1 }, ctx);
    expect(long.message.length).toBeLessThanOrEqual(3500);
    expect(long.page.length).toBeLessThan(300);
  });

  it('điểm nhận đánh giá là máy chủ Locaith đã khai báo trong manifest (HTTPS, đúng đường /api/feedback)', () => {
    expect(RATING_ENDPOINT).toBe('https://studio-api.locaith.com/api/feedback');
  });
});
