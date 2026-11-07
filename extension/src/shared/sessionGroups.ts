/**
 * (lane:sessions-ux) Nhóm danh sách lịch sử theo ngày: Đã ghim · Hôm nay · Hôm qua · 7 ngày qua · 30 ngày qua · Cũ hơn.
 * Thuần tuý — dùng cho màn Lịch sử (webview) và kiểm thử.
 */

export type SessionGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'older';

export interface SessionGroup<T> {
  key: SessionGroupKey;
  items: T[];
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupKeyFor(updatedAt: number, now: number): Exclude<SessionGroupKey, 'pinned'> {
  const today = startOfDay(now);
  if (updatedAt >= today) return 'today';
  if (updatedAt >= today - DAY) return 'yesterday';
  if (updatedAt >= today - 6 * DAY) return 'week';
  if (updatedAt >= today - 29 * DAY) return 'month';
  return 'older';
}

/** `items` đã xếp mới nhất lên trước; giữ nguyên thứ tự trong từng nhóm. Nhóm rỗng bị bỏ. */
export function groupSessions<T extends { updatedAt: number; pinned?: boolean }>(items: readonly T[], now: number, opts: { pinFirst?: boolean } = {}): SessionGroup<T>[] {
  const order: SessionGroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'month', 'older'];
  const map = new Map<SessionGroupKey, T[]>();
  for (const it of items) {
    const key: SessionGroupKey = opts.pinFirst !== false && it.pinned ? 'pinned' : groupKeyFor(it.updatedAt, now);
    const arr = map.get(key);
    if (arr) arr.push(it);
    else map.set(key, [it]);
  }
  return order.filter((k) => map.has(k)).map((k) => ({ key: k, items: map.get(k)! }));
}
