/** Kênh sự kiện nhỏ để chuyển tin nhắn host → component cụ thể mà không phải truyền prop qua nhiều tầng. */
import type { AttachmentInfo, DocInfo, FileHit, MediaItem } from '../../src/shared/protocol';

type Handler<T> = (payload: T) => void;

export interface Channel<T> {
  emit(payload: T): void;
  on(handler: Handler<T>): () => void;
}

/**
 * `buffer`: số tin tối đa được giữ lại khi CHƯA có ai nghe. Giao diện chỉ dựng ô nhập sau khi nhận trạng thái `init`, mà host có thể gửi `insert`/`focus`
 * ngay sau `init` (khung chat vừa mở từ menu chuột phải) — lúc đó ô nhập chưa kịp đăng ký, tin sẽ mất. Có bộ đệm thì người nghe đầu tiên nhận lại chúng.
 */
export function createChannel<T>(opts: { buffer?: number } = {}): Channel<T> {
  const handlers = new Set<Handler<T>>();
  const held: T[] = [];
  return {
    emit(payload) {
      if (handlers.size === 0 && opts.buffer) {
        held.push(payload);
        if (held.length > opts.buffer) held.shift();
        return;
      }
      for (const h of [...handlers]) h(payload);
    },
    on(handler) {
      handlers.add(handler);
      if (held.length) {
        const pending = held.splice(0);
        queueMicrotask(() => pending.forEach((p) => handler(p))); // sau khi component đăng ký xong
      }
      return () => handlers.delete(handler);
    },
  };
}

export const bus = {
  files: createChannel<{ reqId: number; items: FileHit[] }>(),
  /** Tệp tải lên đã đọc xong (hoặc lỗi) — ô nhập đổi chip "đang đọc" thành chip tệp. */
  documentParsed: createChannel<{ reqId: number; name: string; doc?: DocInfo; error?: string }>(),
  insert: createChannel<{ text?: string; attachments?: AttachmentInfo[] }>({ buffer: 4 }),
  draft: createChannel<{ text: string; attachments?: AttachmentInfo[] }>({ buffer: 4 }),
  focus: createChannel<void>({ buffer: 1 }),
  testResult: createChannel<{ provider: string; ok: boolean; message: string }>(),
  /** Mở ảnh phóng to (ảnh chụp màn hình của trợ lý; ảnh kết quả có `mediaPath` thì hộp xem có nút mở tệp thay cho nút tải). */
  lightbox: createChannel<{ src: string; label: string; key?: string; mediaPath?: string }>(),
  /** (0.6.3) Host trả lời `resolve_media`: tệp xem trước nào có thật, địa chỉ hiển thị của chúng. */
  mediaResolved: createChannel<{ key: string; items: MediaItem[] }>(),
  /** Mở hộp xác nhận bật "Toàn quyền" (bản trình duyệt). */
  fullAccess: createChannel<void>(),
  /** Ảnh đầy đủ host gửi về theo khoá (sau `get_image`) — hộp xem ảnh đang mở tự đổi từ bản thu nhỏ sang bản đẹp. */
  imageData: createChannel<{ key: string; mediaType: string; data: string }>(),
  /** Điền sẵn gợi ý vào ô nhập (bấm vào gợi ý ở màn hình chào). */
  prefill: createChannel<string>(),
};
