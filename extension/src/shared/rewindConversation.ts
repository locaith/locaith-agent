/**
 * (lane:checkpoints-rewind) Cắt hội thoại về TRƯỚC một tin nhắn người dùng bất kỳ (khôi phục hội thoại).
 *
 * Thuần, không phụ thuộc môi trường. Ánh xạ mục transcript → tin nhắn gửi model bằng cách ĐẾM TỪ CUỐI (tin mở lượt thứ k tính từ cuối
 * ở transcript ↔ tin mở lượt thứ k tính từ cuối ở `session.messages`): vẫn đúng khi phần đầu đã bị nén thành tóm tắt hay transcript thiếu.
 * Cắt luôn dừng NGAY TRƯỚC một tin mở lượt nên phần còn lại là tiền tố nguyên vẹn (mọi tool_use đều có tool_result) — như `retryLast`.
 */

import type { ChatMessage, ContentBlock } from '../core/types';
import type { TItem, UserItem } from './protocol';
import { isTurnStart } from './transcriptRebuild';

export interface ConversationCut {
  /** Chỉ số trong `messages` của tin mở lượt bị cắt. */
  messageIndex: number;
  /** Chỉ số trong `transcript` của mục người dùng. */
  itemIndex: number;
  item: UserItem;
  /** Nội dung gốc gửi model của tin đó (để chạy lại nếu cần). */
  content: ContentBlock[];
  keptMessages: ChatMessage[];
  keptTranscript: TItem[];
  /** Số mục transcript bị cắt (từ tin này tới hết). */
  removedItems: number;
  /** Số lượt (tin mở lượt) bị cắt. */
  removedTurns: number;
}

export type CutFailure = 'not_found' | 'compacted';

export function cutConversation(messages: readonly ChatMessage[], transcript: readonly TItem[], promptId: string): ConversationCut | { error: CutFailure } {
  const itemIndex = transcript.findIndex((i) => i.kind === 'user' && i.id === promptId && !i.steer);
  if (itemIndex < 0) return { error: 'not_found' };
  let after = 0; // số mục mở lượt đứng SAU mục này trong transcript
  for (let i = itemIndex + 1; i < transcript.length; i++) {
    const it = transcript[i];
    if (it.kind === 'user' && !it.steer) after++;
  }
  const starts: number[] = [];
  messages.forEach((m, i) => {
    if (isTurnStart(m)) starts.push(i);
  });
  const at = starts.length - 1 - after;
  if (at < 0) return { error: 'compacted' };
  const messageIndex = starts[at];
  return {
    messageIndex,
    itemIndex,
    item: transcript[itemIndex] as UserItem,
    content: messages[messageIndex].content,
    keptMessages: messages.slice(0, messageIndex) as ChatMessage[],
    keptTranscript: transcript.slice(0, itemIndex) as TItem[],
    removedItems: transcript.length - itemIndex,
    removedTurns: after + 1,
  };
}

/** Mọi tool_use phải được trả lời ở tin người dùng NGAY SAU nó. Trả về id mồ côi (rỗng = hợp lệ). */
export function orphanToolUses(messages: readonly ChatMessage[]): string[] {
  const out: string[] = [];
  messages.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    const next = messages[i + 1];
    const answered = new Set(next && next.role === 'user' ? next.content.filter((b) => b.type === 'tool_result').map((b) => (b as { toolUseId: string }).toolUseId) : []);
    for (const b of m.content) if (b.type === 'tool_use' && !answered.has(b.id)) out.push(b.id);
  });
  return out;
}
