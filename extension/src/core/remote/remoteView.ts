/**
 * Từ trạng thái Remote của host → `RemoteView` hiển thị trong khung chat (thuần túy, không phụ thuộc `vscode`, để kiểm thử đơn vị).
 * Lưu ý riêng tư: chuỗi lỗi thô của relay (`QueueState.reason`) KHÔNG đi xuống giao diện — chỉ nhóm giới hạn và mốc thời gian.
 */

import type { RemoteView } from '../../shared/protocol';
import type { QueueState } from './queue';
import type { RelayStatus } from './relayHost';

export interface RemoteViewInput {
  /** Cài đặt `locaithAgent.remote.enabled`. */
  enabled: boolean;
  /** Đã đăng nhập tài khoản Locaith (kể cả đang trong thời gian ân hạn mất mạng). */
  signedIn: boolean;
  /** Đường Internet; vắng = không chạy (tắt, chưa đăng nhập, hoặc `remote.cloud` tắt). */
  relay?: { status: RelayStatus; queue?: QueueState | null };
  devices: number;
  streams: number;
  /** Tin cậy theo tài khoản đang HOẠT ĐỘNG: có khoá và danh bạ tài khoản đã giữ khoá (trình duyệt đăng nhập cùng tài khoản mở được máy, không ghép đôi). */
  trust?: boolean;
}

export function buildRemoteView(i: RemoteViewInput): RemoteView {
  const q = i.relay?.queue ?? undefined;
  const relay: RemoteView['relay'] = !i.relay ? 'off' : q ? 'queued' : i.relay.status === 'online' ? 'online' : i.relay.status === 'offline' ? 'offline' : 'connecting';
  return {
    enabled: i.enabled,
    signedIn: i.signedIn,
    relay,
    ...(q ? { queue: { kind: q.kind, attempt: q.attempt, retryAt: q.retryAt, waitMs: q.waitMs, since: q.since, trying: q.trying } } : {}),
    devices: i.devices,
    streams: i.streams,
    ...(i.trust ? { trust: true } : {}),
  };
}
