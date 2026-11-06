/** Hook nhỏ cho bộ đếm: số "chạy" mượt khi đang suy nghĩ, và đồng hồ giây đã trôi qua. */
import { useEffect, useRef, useState } from 'preact/hooks';

const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Số hiển thị đuổi theo `target` từng khung hình (nhanh dần khi cách xa) trong lúc `live`; hết `live` thì dừng ở đúng `target`.
 * Giảm chuyển động → nhảy thẳng tới giá trị mới.
 */
export function useCountUp(target: number, live: boolean): number {
  const [shown, setShown] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    if (!live || reduced()) {
      cur.current = target;
      setShown(target);
      return;
    }
    let raf = 0;
    const tick = () => {
      if (cur.current < target) {
        cur.current = Math.min(target, cur.current + Math.max(1, Math.ceil((target - cur.current) / 6)));
        setShown(cur.current);
      } else if (cur.current > target) {
        cur.current = target;
        setShown(target);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, live]);
  return live ? shown : target;
}

/** Số giây đã trôi qua kể từ lúc `live` bật (dừng đếm và giữ nguyên khi tắt). Trả null nếu chưa từng chạy. */
export function useElapsed(live: boolean): number | null {
  const start = useRef<number | null>(null);
  const [secs, setSecs] = useState<number | null>(null);
  useEffect(() => {
    if (!live) return;
    if (start.current === null) start.current = Date.now();
    const update = () => setSecs(Math.floor((Date.now() - (start.current ?? Date.now())) / 1000));
    update();
    const id = window.setInterval(update, 500);
    return () => {
      window.clearInterval(id);
      update();
    };
  }, [live]);
  return secs;
}
