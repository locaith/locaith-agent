/** Phép tính thuần cho dải hàng chờ của mô hình Locaith (tách khỏi component để kiểm thử bằng Node, không cần DOM). */

/** Số giây còn lại tới lần tự hỏi lại, làm tròn LÊN (còn 0,4 giây vẫn hiện «1»; hết giờ = 0). */
export function secondsLeft(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/** Tiến độ 0..1 của lần chờ hiện tại: mốc bắt đầu = retryAt − waitMs. */
export function queueProgress(retryAt: number, waitMs: number, now: number): number {
  if (retryAt - now <= 0) return 1;
  const waited = now - (retryAt - waitMs);
  return Math.min(1, Math.max(0, waited / Math.max(1, waitMs)));
}
