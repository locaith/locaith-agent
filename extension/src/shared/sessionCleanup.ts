/**
 * (0.7.2) Dọn bộ nhớ: tính dung lượng ảnh trong một phiên đã lưu và xoá ảnh (GIỮ CHỮ). Hàm THUẦN trên JSON thô của tệp phiên
 * (`{ session: { messages }, transcript }`) — không qua migrateSession nên không đổi định dạng/phiên bản của dữ liệu cũ.
 *
 * Một ảnh có thể nằm tới HAI nơi: lịch sử gửi model (`session.messages`: khối `image` của người dùng, `tool_result.images`) và transcript hiển thị
 * (`ToolBlock.images`; ảnh đính kèm chỉ còn `thumb`). Xoá ảnh = bỏ cả hai bản, để lại dòng chữ báo thay thế để model và người xem hiểu
 * chỗ đó từng có ảnh.
 */
import { imageKey } from './transcriptRebuild';

export const IMAGE_REMOVED_NOTE = '[ảnh đã xoá để giải phóng bộ nhớ]';

export interface ImageStats {
  /** Số ảnh (mỗi ảnh tính một lần dù có hai bản). */
  images: number;
  /** Tổng ký tự base64 của MỌI bản sao — xấp xỉ số byte trên đĩa mà xoá ảnh sẽ giải phóng. */
  chars: number;
}

type Raw = { session?: { messages?: unknown[]; historyEdited?: boolean }; transcript?: unknown[] };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Ảnh trong khối nội dung của một tin nhắn: gọi `fn` với mỗi mảng ảnh/khối ảnh tìm thấy. */
function eachModelImage(raw: Raw, fn: (data: string) => void): void {
  for (const m of raw.session?.messages ?? []) {
    if (!isObj(m) || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!isObj(b)) continue;
      if (b.type === 'image') fn(str(b.data));
      else if (b.type === 'tool_result' && Array.isArray(b.images)) for (const im of b.images) if (isObj(im)) fn(str(im.data));
    }
  }
}

function eachTranscriptImage(raw: Raw, fn: (kind: 'thumb' | 'tool', data: string) => void): void {
  for (const it of raw.transcript ?? []) {
    if (!isObj(it)) continue;
    if (it.kind === 'user' && Array.isArray(it.attachments)) {
      for (const a of it.attachments) if (isObj(a) && a.kind === 'image') {
        if (typeof a.thumb === 'string') fn('thumb', a.thumb);
        if (typeof a.data === 'string') fn('thumb', a.data);
      }
    } else if (it.kind === 'assistant' && Array.isArray(it.blocks)) {
      for (const b of it.blocks) if (isObj(b) && b.type === 'tool' && Array.isArray(b.images)) for (const im of b.images) if (isObj(im)) fn('tool', str(im.data));
    }
  }
}

/** Đếm ảnh + dung lượng base64 của một phiên (không sửa gì). */
export function countImages(raw: Raw): ImageStats {
  const keys = new Set<string>();
  let images = 0;
  let chars = 0;
  eachModelImage(raw, (d) => {
    if (!d) return;
    images++;
    chars += d.length;
    keys.add(imageKey(d));
  });
  eachTranscriptImage(raw, (kind, d) => {
    if (!d) return;
    chars += d.length;
    // ảnh công cụ chỉ có ở transcript (thẻ Trước|Sau) → tính là một ảnh riêng; bản sao của ảnh đã đếm ở lịch sử model thì không đếm lại
    if (kind === 'tool' && !keys.has(imageKey(d))) images++;
  });
  return { images, chars };
}

/**
 * Xoá MỌI ảnh khỏi một phiên đã lưu (SỬA TRỰC TIẾP đối tượng `raw` — gọi trên bản đọc từ đĩa), giữ nguyên chữ.
 * Có xoá → đánh dấu `session.historyEdited` (lịch sử đã đổi: khối suy luận có chữ ký bị bỏ ở lần chạy sau, đúng quy ước của compaction.ts).
 */
export function stripImages(raw: Raw): ImageStats {
  const before = countImages(raw);
  if (before.images === 0 && before.chars === 0) return before;
  for (const m of raw.session?.messages ?? []) {
    if (!isObj(m) || !Array.isArray(m.content)) continue;
    m.content = m.content.map((b) => {
      if (!isObj(b)) return b;
      if (b.type === 'image') return { type: 'text', text: IMAGE_REMOVED_NOTE };
      if (b.type === 'tool_result' && Array.isArray(b.images) && b.images.length > 0) {
        const { images: _gone, ...rest } = b;
        return { ...rest, content: `${str(b.content)}\n${IMAGE_REMOVED_NOTE}`.trim() };
      }
      return b;
    });
  }
  for (const it of raw.transcript ?? []) {
    if (!isObj(it)) continue;
    if (it.kind === 'user' && Array.isArray(it.attachments)) {
      it.attachments = it.attachments.map((a) => {
        if (!isObj(a) || a.kind !== 'image') return a;
        const { data: _d, thumb: _t, ...rest } = a;
        return rest;
      });
    } else if (it.kind === 'assistant' && Array.isArray(it.blocks)) {
      it.blocks = it.blocks.map((b) => {
        if (!isObj(b) || b.type !== 'tool' || !Array.isArray(b.images)) return b;
        const { images: _i, ...rest } = b;
        return rest;
      });
    }
  }
  if (raw.session) raw.session.historyEdited = true;
  return before;
}

/** Số byte ước lượng từ số ký tự base64. */
export const charsToBytes = (chars: number): number => Math.floor((chars * 3) / 4);
