/**
 * Hàng chờ khi relay (Supabase Realtime) từ chối vì QUÁ TẢI.
 *
 * Gói Free của Supabase Realtime chỉ cho 200 kết nối đồng thời / dự án (100 lượt vào kênh mỗi giây, 100 tin mỗi giây) — mỗi máy bật Remote và mỗi trình duyệt
 * đang xem chiếm một kết nối. Khi vượt giới hạn, Realtime từ chối lượt vào kênh (`too_many_connections`, `too_many_joins`…) hoặc từ chối cả bước bắt tay HTTP.
 * Thay vì thử lại âm thầm hoặc báo "mất mạng" (sai sự thật), máy khách:
 *   1. nhận ra đó là lỗi QUÁ TẢI (khác với mất mạng/sai khoá);
 *   2. báo rõ cho người dùng: "máy chủ relay đang quá tải, bạn đang xếp hàng, tự thử lại sau mm:ss";
 *   3. chờ theo lịch tăng dần có xáo trộn (jitter) để hàng nghìn máy không đồng loạt gõ cửa lại cùng lúc;
 *   4. cho phép "thử ngay" (không quá 1 lần / 5 giây) hoặc thôi chờ.
 *
 * LƯU Ý TRUNG THỰC: đây là hàng chờ PHÍA MÁY KHÁCH (đếm ngược tới lần thử kế tiếp), không phải hàng chờ có thứ tự toàn cục — relay không có máy chủ nào biết
 * "bạn đứng thứ mấy" nên không bịa số thứ tự. Chuỗi lỗi chính xác của Realtime thật khi chạm trần chưa được quan sát (không thể thử trên dịch vụ thật mà không làm
 * sập nó), nên bộ nhận diện dựa vào tài liệu của Supabase (các mã too_many_*, ConnectionRateLimitReached…) và rộng tay về từ khoá.
 *
 * Tệp THUẦN (không phụ thuộc gì) — trang web chép nguyên văn để hai đầu hành xử giống hệt nhau.
 */

export type QueueKind = 'connections' | 'rate' | 'channels';

export interface QueueState {
  /** Nhóm giới hạn: hết chỗ kết nối đồng thời / quá nhiều lượt vào hoặc tin mỗi giây / quá nhiều kênh. */
  kind: QueueKind;
  /** Chuỗi gốc Realtime trả về (đã cắt ngắn) — chỉ để ghi nhật ký và hiện chi tiết kỹ thuật. */
  reason: string;
  /** Lần thứ mấy bị từ chối liên tiếp (1, 2, 3…). */
  attempt: number;
  /** Bắt đầu xếp hàng lúc (epoch ms) — giữ nguyên qua các lần thử lại. */
  since: number;
  /** Tự thử lại lúc (epoch ms). */
  retryAt: number;
  /** Thời gian chờ đã định cho lần này (ms) — để vẽ thanh tiến trình. */
  waitMs: number;
  /** true trong lúc đang thử vào lại (từ lúc hết giờ chờ đến lúc có kết quả). */
  trying: boolean;
}

const asText = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const CONNECTIONS = /too[_ ]many[_ ](?:total[_ ])?(?:concurrent[_ ])?(?:connected[_ ])?(?:connections|users|clients)|connectionratelimitreached|number of connected clients|concurrent (?:peak )?connections?|max(?:imum)? (?:concurrent )?(?:connections|users|clients)/i;
const CHANNELS = /too[_ ]many[_ ]channels|channelratelimitreached|number of channels/i;
const RATE =
  /too[_ ]many[_ ]joins|joinsratelimitreached|clientjoinratelimitreached|joins per second|messagepersecondratelimitreached|messages per second|tenant_events|presenceratelimitreached|clientpresenceratelimitreached|too many (?:messages|requests)|rate[ _-]?limit|(?:http|response)[: ]+429/i;

/**
 * Lỗi Realtime có phải "quá tải / chạm giới hạn gói" không? Nhận mọi thứ có thể mang lý do: `phx_reply.response`, thông điệp hệ thống, lỗi bắt tay HTTP
 * ("HTTP 403: {…}"). Trả nhóm giới hạn, hoặc null nếu là lỗi khác (mất mạng, sai khoá, máy chủ khởi động lại…) — những lỗi đó dùng cách nối lại thường.
 */
export function classifyRealtimeFailure(...parts: unknown[]): { kind: QueueKind; reason: string } | null {
  const text = parts.map(asText).filter(Boolean).join(' | ');
  if (!text) return null;
  const reason = text.length > 200 ? `${text.slice(0, 197)}…` : text;
  if (CONNECTIONS.test(text)) return { kind: 'connections', reason };
  if (CHANNELS.test(text)) return { kind: 'channels', reason };
  if (RATE.test(text)) return { kind: 'rate', reason };
  return null;
}

/** [chờ lần đầu, hệ số tăng, trần] (ms). Hết chỗ kết nối thì lâu mới có chỗ trống → chờ dài; quá nhiều lượt/giây chỉ là cơn dồn nhất thời → chờ ngắn. */
const WAIT: Record<QueueKind, readonly [number, number, number]> = {
  connections: [20_000, 1.5, 120_000],
  channels: [20_000, 1.5, 120_000],
  rate: [6_000, 1.6, 45_000],
};

/** Thời gian chờ trước lần thử thứ `attempt` (1, 2, 3…), xáo trộn ±20% để các máy không gõ cửa lại đồng loạt. */
export function queueWaitMs(attempt: number, kind: QueueKind, rnd: () => number = Math.random): number {
  const [base, mult, cap] = WAIT[kind];
  const w = Math.min(cap, base * mult ** (Math.max(1, Math.floor(attempt)) - 1));
  return Math.round(w * (0.8 + rnd() * 0.4));
}

/** Khoảng tối thiểu giữa hai lần thử (kể cả "thử ngay" do người dùng bấm) — không để một nút bấm biến thành đòn dội vào relay đang quá tải. */
export const QUEUE_MIN_RETRY_GAP_MS = 5_000;

/** Đếm ngược "m:ss" (làm tròn lên: còn 0,3 giây vẫn hiện 0:01 chứ không phải 0:00). */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
