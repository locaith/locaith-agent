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

/** Kích hoạt "mạnh": người dùng đang chờ số mới nên không được gộp mất. */
function isStrong(t: UsageTrigger): boolean {
  return t === 'manual' || t === 'window-reset';
}

export interface CoalescerDeps {
  /** Gọi THẬT để đọc số liệu (đã bao gồm việc bỏ qua nếu không cần). */
  read: (trigger: UsageTrigger, force: boolean) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Gộp các lần "muốn đọc lại hạn mức" xảy ra dồn dập trong `USAGE_DEBOUNCE_MS` thành ĐÚNG MỘT lần đọc —
 * đúng hành vi Claude Code mô tả (mọi cập nhật của dải được gộp trong 300 ms).
 *
 * Vì sao cần lớp riêng: một lượt trả lời có thể kết thúc, đổi chế độ quyền và nén ngữ cảnh gần như cùng lúc;
 * không gộp thì mỗi sự kiện là một lần gọi cổng, còn gộp thì chỉ một. Kích hoạt mạnh hơn (`manual`,
 * `window-reset`) thắng khi gộp, và `force` được giữ nếu bất kỳ lần nào yêu cầu.
 *
 * Có thể test được: đồng hồ và hàm đọc đều được tiêm từ ngoài.
 */
export class UsageCoalescer {
  private timer: unknown;
  private pending: { trigger: UsageTrigger; force: boolean } | undefined;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly deps: CoalescerDeps,
    private readonly delayMs = USAGE_DEBOUNCE_MS,
  ) {}

  /** Yêu cầu đọc; trả về promise xong khi lần đọc (đã gộp) hoàn tất. */
  request(trigger: UsageTrigger, opts: { force?: boolean } = {}): Promise<void> {
    const cur = this.pending;
    const merged: { trigger: UsageTrigger; force: boolean } = {
      trigger: !cur ? trigger : isStrong(trigger) ? trigger : isStrong(cur.trigger) ? cur.trigger : trigger,
      force: opts.force === true || cur?.force === true,
    };
    this.pending = merged;
    const done = new Promise<void>((resolve) => this.waiters.push(resolve));
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (this.timer !== undefined) clearTimer(this.timer);
    this.timer = setTimer(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
    return done;
  }

  /** Có lần đọc đang chờ trong cửa sổ gộp (dùng cho test/chẩn đoán). */
  hasPending(): boolean {
    return this.pending !== undefined;
  }

  private async flush(): Promise<void> {
    const pend = this.pending;
    this.pending = undefined;
    const waiters = this.waiters;
    this.waiters = [];
    try {
      if (pend) await this.deps.read(pend.trigger, pend.force);
    } catch {
      // Lỗi mạng: không nuốt sự kiện kế tiếp, chỉ bỏ lần đọc này.
    } finally {
      for (const w of waiters) w();
    }
  }
}

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
