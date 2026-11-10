/**
 * (0.7.2) Giữ ngữ cảnh gọn khi cuộc trò chuyện có nhiều ảnh: khi dựng yêu cầu gửi model, ảnh CŨ ngoài `max` ảnh gần nhất được thay bằng một dòng chữ
 * («[ảnh đã lược để giữ ngữ cảnh gọn]») TRONG BẢN GỬI. Lịch sử đã lưu KHÔNG bị đổi (hàm không sửa tin nhắn gốc) nên người dùng vẫn xem lại được ảnh
 * và việc đổi cài đặt có hiệu lực ngay.
 *
 * An toàn với cặp tool_use/tool_result: chỉ bỏ phần `images` của kết quả công cụ (chữ của kết quả giữ nguyên, thêm dòng báo); khối `tool_result`
 * không bao giờ bị xoá hay đổi `toolUseId`. Khối `image` của người dùng được thay tại chỗ bằng khối chữ nên thứ tự và số khối không đổi.
 *
 * Lưu ý bộ nhớ đệm prompt: ảnh cũ nhất bị lược làm đoạn đầu của lịch sử đổi, tức bộ nhớ đệm hỏng từ chỗ đó. Trước 0.7.7 mỗi ảnh MỚI vượt ngưỡng lại lược thêm đúng một ảnh → hỏng ở MỖI ảnh
 * (nhật ký cổng Locaith: 135 lần ≈ 7% chi phí của client mới). Nay lược THEO ĐỢT (`imageDropCount`): làm tròn số ảnh bỏ lên bội của một bước ≈ max/3 nên ranh giới chỉ nhích mỗi `bước`
 * ảnh mới (mặc định 8 → 3). `max` vẫn là TRẦN cứng (không bao giờ gửi quá max ảnh); số ảnh được giữ dao động trong [max − bước + 1, max]. Ảnh nặng hơn chữ nhiều lần nên vẫn đáng lược.
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

/** Bước lược ảnh: ranh giới giữa ảnh bị bỏ và ảnh được giữ chỉ nhích mỗi `bước` ảnh mới. `max` nhỏ (≤ 3) → 1 (lược chính xác từng ảnh). */
export function imageDropStep(max: number): number {
  return Math.max(1, Math.ceil(max / 3));
}

/**
 * Số ảnh CŨ NHẤT phải bỏ khi lịch sử có `total` ảnh và trần là `max`: `total − max` làm tròn LÊN bội của `imageDropStep(max)`. Hàm thuần theo `total` nên không cần lưu trạng thái:
 * mọi `total` trong cùng một đợt cho cùng số ảnh bỏ → cùng ranh giới → tiền tố gửi model KHÔNG đổi (bộ nhớ đệm prompt còn nguyên) cho tới đợt kế.
 */
export function imageDropCount(total: number, max: number): number {
  if (total <= max) return 0;
  const step = imageDropStep(max);
  return Math.ceil((total - max) / step) * step;
}

/**
 * Bản gửi đã lược ảnh cũ. `max` ≤ 0 hoặc không phải số = không giới hạn (trả đúng mảng đầu vào). Không sửa `messages`.
 */
export function limitImagesInContext(messages: readonly ChatMessage[], max: number | undefined, lang: 'vi' | 'en' = 'vi'): ChatMessage[] {
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return messages as ChatMessage[];
  const total = countContextImages(messages);
  if (total <= max) return messages as ChatMessage[];
  const note = IMAGE_TRIMMED_NOTE[lang];
  let drop = imageDropCount(total, Math.floor(max)); // số ảnh CŨ NHẤT phải bỏ (theo đợt)
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
