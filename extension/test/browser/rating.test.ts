import { describe, expect, it } from 'vitest';
import {
  RATING_AFTER_SENDS,
  RATING_SNOOZE_DAYS,
  RATING_URL,
  countRatingSend,
  denyRating,
  markRated,
  sanitizeRating,
  shouldAskRating,
  snoozeRating,
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
      expect(u).toContain('amgjccgboohakecgdiajdkfcabkjc');
      expect(u).toMatch(/[?&]hl=(vi|en)$/);
    }
  });
});
