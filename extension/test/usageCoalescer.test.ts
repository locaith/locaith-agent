import { describe, expect, it, vi } from 'vitest';
import { USAGE_DEBOUNCE_MS, UsageCoalescer } from '../src/core/account/usageRefresh';

/**
 * Gộp 300 ms là hành vi Claude Code mô tả ("updates are debounced by 300 ms"), nên phải được KIỂM bằng test,
 * không chỉ khai báo hằng số. Đồng hồ ở đây dùng fake timer để test chạy tức thì và xác định.
 */
function makeCoalescer() {
  const reads: Array<{ trigger: string; force: boolean }> = [];
  const c = new UsageCoalescer({
    read: async (trigger, force) => {
      reads.push({ trigger, force });
    },
  });
  return { c, reads };
}

describe('UsageCoalescer — gộp 300 ms thành MỘT lần đọc', () => {
  it('ba sự kiện dồn dập chỉ tạo một lần đọc', async () => {
    vi.useFakeTimers();
    try {
      const { c, reads } = makeCoalescer();
      void c.request('turn-end');
      void c.request('compact');
      void c.request('permission-mode');
      expect(reads).toHaveLength(0); // chưa đọc: còn trong cửa sổ gộp
      expect(c.hasPending()).toBe(true);
      await vi.advanceTimersByTimeAsync(USAGE_DEBOUNCE_MS - 1);
      expect(reads).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(reads).toHaveLength(1);
      expect(c.hasPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sự kiện tới sau cửa sổ gộp tạo lần đọc mới', async () => {
    vi.useFakeTimers();
    try {
      const { c, reads } = makeCoalescer();
      void c.request('turn-end');
      await vi.advanceTimersByTimeAsync(USAGE_DEBOUNCE_MS + 1);
      void c.request('turn-end');
      await vi.advanceTimersByTimeAsync(USAGE_DEBOUNCE_MS + 1);
      expect(reads).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kích hoạt MẠNH (manual / window-reset) thắng khi gộp, và force được giữ', async () => {
    vi.useFakeTimers();
    try {
      const { c, reads } = makeCoalescer();
      void c.request('turn-end');
      void c.request('manual', { force: true });
      await vi.advanceTimersByTimeAsync(USAGE_DEBOUNCE_MS + 1);
      expect(reads).toEqual([{ trigger: 'manual', force: true }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('mọi lời gọi đều được đánh thức khi lần đọc gộp xong', async () => {
    vi.useFakeTimers();
    try {
      const { c } = makeCoalescer();
      let finished = 0;
      const p1 = c.request('turn-end').then(() => finished++);
      const p2 = c.request('compact').then(() => finished++);
      await vi.advanceTimersByTimeAsync(USAGE_DEBOUNCE_MS + 1);
      await Promise.all([p1, p2]);
      expect(finished).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lần đọc lỗi không làm treo người gọi (promise vẫn xong)', async () => {
    vi.useFakeTimers();
    try {
      const c = new UsageCoalescer({
        read: async () => {
          throw new Error('mạng hỏng');
        },
      });
      let done = false;
      const p = c.request('turn-end').then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(USAGE_DEBOUNCE_MS + 1);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
