/**
 * Lịch làm mới hạn mức tài khoản — theo đúng cách Claude Code cập nhật dải rate-limit của họ.
 *
 * Tài liệu chính thức (code.claude.com/docs/en/statusline → "When the status line updates"): dải được vẽ lại
 *   1. khi phiên bắt đầu (kể cả resume),
 *   2. khi có tin nhắn assistant mới,
 *   3. khi /compact xong,
 *   4. khi đổi chế độ quyền,
 *   5. khi cửa sổ rate-limit ĐẠT `resets_at`,
 *   6. nếu đặt `refreshInterval` thì thêm một nhịp cố định (mặc định KHÔNG đặt),
 * và mọi cập nhật được GỘP trong 300 ms (debounce) để thay đổi dồn dập chỉ gây một lần chạy.
 *
 * Hai điều quan trọng:
 *   • Không polling liên tục — mỗi lần đọc là một lần gọi mạng, và hạn mức không đổi khi người dùng ngồi im.
 *   • Cửa sổ nào đã qua `resets_at` thì BỎ (như Claude Code): giữ lại chỉ hiện số cũ đã hết hiệu lực.
 *
 * Hàm thuần → test được, dùng chung cho VS Code và Remote.
 */

/** Gộp các lần kích hoạt trong khoảng này thành một lần đọc (giống debounce 300 ms của Claude Code). */
export const USAGE_DEBOUNCE_MS = 300;
/** Chặn dưới giữa hai lần đọc THẬT SỰ ra mạng: bảo vệ cổng Locaith khỏi bị gọi dồn. */
export const USAGE_MIN_GAP_MS = 5_000;

/** Một cửa sổ hạn mức: phần trăm đã dùng và số giây còn lại tới lúc làm mới. */
export interface UsageWindow {
  percent: number;
  /** Còn bao nhiêu giây nữa thì cửa sổ làm mới. Không có = không rõ. */
  resetsInS?: number;
}

export interface UsageWindows {
  session?: UsageWindow | null;
  week?: UsageWindow | null;
  credit?: UsageWindow | null;
}

/**
 * Bỏ những cửa sổ đã quá hạn làm mới. `at` là thời điểm dữ liệu được đọc (ms).
 * Ví dụ: đọc lúc 10:00, cửa sổ 5 giờ còn 30 giây → 10:01 cửa sổ đó coi như đã reset, không hiện nữa.
 */
export function dropExpiredWindows<T extends UsageWindows>(u: T, at: number, now = Date.now()): T {
  const dead = (w?: UsageWindow | null): boolean => !!w && typeof w.resetsInS === 'number' && (now - at) / 1000 >= w.resetsInS;
  if (!dead(u.session) && !dead(u.week) && !dead(u.credit)) return u;
  return {
    ...u,
    ...(dead(u.session) ? { session: undefined } : {}),
    ...(dead(u.week) ? { week: undefined } : {}),
    ...(dead(u.credit) ? { credit: undefined } : {}),
  };
}

/**
 * Số mili-giây tới lần làm mới TỰ NHIÊN gần nhất (một cửa sổ đạt resets_at), tính từ `at`.
 * `null` = không có cửa sổ nào báo giờ, nên không cần hẹn giờ (chỉ dựa vào sự kiện).
 * Cộng thêm 1 giây để chắc chắn máy chủ đã sang cửa sổ mới khi ta hỏi lại.
 */
export function msUntilNextReset(u: UsageWindows, at: number): number | null {
  const left = [u.session?.resetsInS, u.week?.resetsInS].filter((x): x is number => typeof x === 'number' && x >= 0);
  if (left.length === 0) return null;
  const soonest = Math.min(...left);
  return soonest * 1000 + 1000;
}

export type UsageTrigger = 'session-start' | 'turn-end' | 'compact' | 'permission-mode' | 'window-reset' | 'timer' | 'manual';

/**
 * Quyết định có nên đọc lại NGAY bây giờ không.
 *
 * - `manual` (người dùng gõ /usage hoặc mở Cài đặt) và `window-reset` luôn được đọc: họ đang chờ số mới.
 * - Các sự kiện còn lại chịu `USAGE_MIN_GAP_MS` để không đập vào cổng.
 * - Chỉ đọc khi dùng mô hình Locaith, trừ khi `always` (đang mở khung chat / vừa đăng nhập).
 */
export function shouldRefresh(input: {
  trigger: UsageTrigger;
  now: number;
  lastAt: number;
  signedIn: boolean;
  usingLocaith: boolean;
  always?: boolean;
}): boolean {
  if (!input.signedIn) return false;
  if (input.trigger === 'manual' || input.trigger === 'window-reset') return true;
  if (!input.always && !input.usingLocaith) return false;
  return input.now - input.lastAt >= USAGE_MIN_GAP_MS;
}
