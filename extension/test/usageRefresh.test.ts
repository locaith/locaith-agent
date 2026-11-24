import { describe, expect, it } from 'vitest';
import {
  USAGE_DEBOUNCE_MS,
  USAGE_MIN_GAP_MS,
  UsageCoalescer,
  dropExpiredWindows,
  msUntilNextReset,
  shouldRefresh,
} from '../src/core/account/usageRefresh';

const at = 1_000_000;

describe('dropExpiredWindows — cửa sổ đã reset thì bỏ, không hiện số cũ', () => {
  it('chưa tới resets_at thì giữ nguyên', () => {
    const u = { session: { percent: 40, resetsInS: 600 }, week: { percent: 10, resetsInS: 86400 } };
    expect(dropExpiredWindows(u, at, at + 60_000)).toEqual(u);
  });

  it('đã quá resets_at: bỏ đúng cửa sổ đó, giữ cửa sổ khác', () => {
    const u = { session: { percent: 100, resetsInS: 30 }, week: { percent: 55, resetsInS: 86400 } };
    const out = dropExpiredWindows(u, at, at + 31_000);
    expect(out.session).toBeUndefined();
    expect(out.week).toEqual({ percent: 55, resetsInS: 86400 });
  });

  it('cả hai quá hạn → bỏ cả hai; không có resetsInS thì giữ (không đoán)', () => {
    expect(dropExpiredWindows({ session: { percent: 9, resetsInS: 1 }, week: { percent: 9, resetsInS: 1 } }, at, at + 5000)).toEqual({
      session: undefined,
      week: undefined,
    });
    expect(dropExpiredWindows({ session: { percent: 9 } }, at, at + 10 ** 9)).toEqual({ session: { percent: 9 } });
  });
});

describe('msUntilNextReset — hẹn giờ đúng lúc cửa sổ làm mới (như Claude Code)', () => {
  it('lấy cửa sổ gần nhất + 1 giây', () => {
    expect(msUntilNextReset({ session: { percent: 10, resetsInS: 120 }, week: { percent: 5, resetsInS: 90000 } }, at)).toBe(121_000);
  });
  it('không có giờ thì không hẹn (null)', () => {
    expect(msUntilNextReset({}, at)).toBeNull();
    expect(msUntilNextReset({ session: null, week: null, credit: { percent: 3 } }, at)).toBeNull();
  });
});

describe('shouldRefresh — sự kiện như Claude Code, không polling', () => {
  const base = { now: at + 60_000, lastAt: at, signedIn: true, usingLocaith: true };

  it('chưa đăng nhập: không đọc', () => {
    expect(shouldRefresh({ ...base, trigger: 'turn-end', signedIn: false })).toBe(false);
    expect(shouldRefresh({ ...base, trigger: 'manual', signedIn: false })).toBe(false);
  });

  it('mỗi lượt trả lời xong: đọc, nhưng tôn trọng khoảng chặn', () => {
    expect(shouldRefresh({ ...base, trigger: 'turn-end' })).toBe(true);
    expect(shouldRefresh({ ...base, now: at + USAGE_MIN_GAP_MS - 1, trigger: 'turn-end' })).toBe(false);
  });

  it('không dùng model Locaith: không đọc (hạn mức không đổi)', () => {
    expect(shouldRefresh({ ...base, trigger: 'turn-end', usingLocaith: false })).toBe(false);
    // …trừ khi vừa mở khung chat / vừa đăng nhập.
    expect(shouldRefresh({ ...base, trigger: 'turn-end', usingLocaith: false, always: true })).toBe(true);
  });

  it('/usage (manual) và cửa sổ vừa reset: LUÔN đọc ngay, bỏ qua khoảng chặn', () => {
    expect(shouldRefresh({ ...base, now: at + 10, trigger: 'manual' })).toBe(true);
    expect(shouldRefresh({ ...base, now: at + 10, trigger: 'window-reset' })).toBe(true);
    expect(shouldRefresh({ ...base, now: at + 10, trigger: 'window-reset', usingLocaith: false })).toBe(true);
  });

  it('compact / đổi chế độ quyền / nhịp cố định: cùng luật với turn-end', () => {
    for (const trigger of ['compact', 'permission-mode', 'timer', 'session-start'] as const) {
      expect(shouldRefresh({ ...base, trigger }), trigger).toBe(true);
      expect(shouldRefresh({ ...base, now: at + 10, trigger }), trigger).toBe(false);
    }
  });
});
