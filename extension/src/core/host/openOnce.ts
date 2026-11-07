/**
 * Chống nảy đúp khi mở liên kết ngoài (lane:customer-bugs) — MỘT chỗ duy nhất cho cả host VS Code, bản Chrome và đăng nhập.
 * Khách báo «bấm link mở 2 tab»: dù mỗi đường mở liên kết chỉ gọi một lần, chỉ cần hai tầng cùng xử lý một cú bấm
 * (ví dụ bộ xử lý liên kết có sẵn của webview VS Code + handler của ta) là ra hai tab. Cùng một URL trong cửa sổ
 * ngắn được coi là MỘT lần mở. Không import 'vscode' / 'node:*' — dùng chung cho bản trình duyệt.
 */

/** Cửa sổ khử trùng lặp (ms). Đủ dài cho hai sự kiện của cùng một cú bấm / bấm đúp, đủ ngắn để bấm lại có chủ đích vẫn mở. */
export const OPEN_ONCE_WINDOW_MS = 1500;

const MAX_TRACKED = 64;

export interface OpenOnce {
  /** Mở `url` bằng `open` trừ khi cùng URL vừa được mở trong cửa sổ. Trả true nếu đã gọi `open`. */
  (url: string, open: (url: string) => unknown): Promise<boolean>;
  /** Chỉ kiểm tra & ghi nhận (không mở): true nếu lần này được phép. */
  allow(url: string): boolean;
  reset(): void;
}

export function createOpenOnce(opts: { windowMs?: number; now?: () => number } = {}): OpenOnce {
  const windowMs = opts.windowMs ?? OPEN_ONCE_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number>();

  const allow = (raw: string): boolean => {
    const url = String(raw).trim();
    if (!url) return false;
    const t = now();
    const last = seen.get(url);
    if (last !== undefined && t - last >= 0 && t - last < windowMs) return false;
    seen.set(url, t);
    if (seen.size > MAX_TRACKED) {
      for (const [k, v] of seen) if (t - v >= windowMs) seen.delete(k);
      if (seen.size > MAX_TRACKED) seen.clear();
    }
    return true;
  };

  const fn = (async (url: string, open: (u: string) => unknown): Promise<boolean> => {
    if (!allow(url)) return false;
    await open(String(url).trim());
    return true;
  }) as OpenOnce;
  fn.allow = allow;
  fn.reset = () => seen.clear();
  return fn;
}

/** Bộ chống nảy đúp dùng chung của tiến trình (host hoặc trang bản trình duyệt). */
export const openExternalOnce: OpenOnce = createOpenOnce();
