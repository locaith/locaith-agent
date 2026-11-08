/**
 * (0.7.2) Giữ ngữ cảnh gọn khi cuộc trò chuyện có nhiều ảnh: khi dựng yêu cầu gửi model, ảnh CŨ ngoài `max` ảnh gần nhất được thay bằng một dòng chữ
 * («[ảnh đã lược để giữ ngữ cảnh gọn]») TRONG BẢN GỬI. Lịch sử đã lưu KHÔNG bị đổi (hàm không sửa tin nhắn gốc) nên người dùng vẫn xem lại được ảnh
 * và việc đổi cài đặt có hiệu lực ngay.
 *
 * An toàn với cặp tool_use/tool_result: chỉ bỏ phần `images` của kết quả công cụ (chữ của kết quả giữ nguyên, thêm dòng báo); khối `tool_result`
 * không bao giờ bị xoá hay đổi `toolUseId`. Khối `image` của người dùng được thay tại chỗ bằng khối chữ nên thứ tự và số khối không đổi.
 *
 * Lưu ý bộ nhớ đệm prompt: mỗi lần có ảnh MỚI vượt ngưỡng, ảnh cũ nhất bị lược nên đoạn đầu của lịch sử đổi một lần (bộ nhớ đệm hỏng một lần cho tới ảnh kế tiếp).
 * Đó là đánh đổi có chủ đích — ảnh nặng hơn chữ nhiều lần.
 */
import type { ChatMessage, ContentBlock, ToolResultBlock } from '../types';

export const DEFAULT_MAX_IMAGES_IN_CONTEXT = 8;

export const IMAGE_TRIMMED_NOTE = { vi: '[ảnh đã lược để giữ ngữ cảnh gọn]', en: '[image trimmed to keep context small]' } as const;

const imagesIn = (b: ContentBlock): number => (b.type === 'image' ? 1 : b.type === 'tool_result' ? (b.images?.length ?? 0) : 0);

/** Tổng số ảnh trong lịch sử (khối `image` + ảnh trong kết quả công cụ). */
export function countContextImages(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) for (const b of m.content) n += imagesIn(b);
  return n;
}

/**
 * Bản gửi đã lược ảnh cũ. `max` ≤ 0 hoặc không phải số = không giới hạn (trả đúng mảng đầu vào). Không sửa `messages`.
 */
export function limitImagesInContext(messages: readonly ChatMessage[], max: number | undefined, lang: 'vi' | 'en' = 'vi'): ChatMessage[] {
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return messages as ChatMessage[];
  const total = countContextImages(messages);
  if (total <= max) return messages as ChatMessage[];
  const note = IMAGE_TRIMMED_NOTE[lang];
  let drop = total - max; // số ảnh CŨ NHẤT phải bỏ
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (drop <= 0 || !m.content.some((b) => imagesIn(b) > 0)) {
      out.push(m);
      continue;
    }
    const content: ContentBlock[] = [];
    for (const b of m.content) {
      if (drop > 0 && b.type === 'image') {
        content.push({ type: 'text', text: note });
        drop--;
      } else if (b.type === 'tool_result' && b.images && b.images.length > 0 && drop > 0) {
        const gone = Math.min(drop, b.images.length);
        drop -= gone;
        const rest = b.images.slice(gone);
        const next: ToolResultBlock = { ...b, content: `${b.content}\n${gone > 1 ? `${note} ×${gone}` : note}`.trim() };
        if (rest.length > 0) next.images = rest;
        else delete next.images;
        content.push(next);
      } else content.push(b);
    }
    out.push({ ...m, content });
  }
  return out;
}
