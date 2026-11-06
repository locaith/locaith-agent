/**
 * Đồng hồ giây DÙNG CHUNG cho các dòng agent con đang chạy: mười sáu agent song song vẫn chỉ một `setInterval` (bật khi có người nghe đầu tiên, tắt khi hết).
 * Giảm chuyển động không liên quan ở đây — đây là số đếm chữ, không phải hiệu ứng; nó cũng không được đọc to mỗi giây (dòng không đặt aria-live).
 */
import { useEffect, useState } from 'preact/hooks';

const subscribers = new Set<() => void>();
let timer: number | undefined;

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (timer === undefined) timer = window.setInterval(() => subscribers.forEach((f) => f()), 1000);
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/** `Date.now()` cập nhật mỗi giây khi `active`; không active thì đứng yên (không giữ đồng hồ). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return subscribe(() => setNow(Date.now()));
  }, [active]);
  return now;
}
