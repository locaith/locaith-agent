/**
 * Dựng lại transcript (phần HIỂN THỊ) từ lịch sử gửi model (`messages`) — nguồn dữ liệu đầy đủ nhất của một cuộc trò chuyện.
 *
 * Vì sao cần: transcript đã lưu có thể bị thiếu (trường hợp thật: phiên 495 tin có 23 lượt người dùng nhưng transcript chỉ còn 2 lượt cuối)
 * trong khi `messages` vẫn nguyên. Lịch sử là dữ liệu quan trọng nên khi mở một phiên hoặc lưu nó, nếu transcript có ÍT lượt hơn `messages`
 * thì phần thiếu được dựng lại; phần transcript hiện có (chi tiết hơn: thời lượng công cụ, diff, ảnh chụp…) được giữ nguyên ở đuôi.
 * Không bao giờ làm ngược lại: transcript nhiều lượt hơn `messages` (đã nén ngữ cảnh) được giữ nguyên.
 */

import type { ChatMessage, ContentBlock } from '../core/types';
import type { AssistantItem, TItem, ToolBlock, UserItem } from './protocol';

const STEER_HEADER = /^\[(?:Người dùng vừa gửi thêm tin nhắn|The user sent a new message)/;
const OUTPUT_CAP = 4000;
/** Khối bao quanh mà host gắn vào đầu tin nhắn người dùng (không phải chữ họ gõ). Chỉ bóc đúng các thẻ này, không đụng vào XML người dùng tự gõ. */
const WRAPPER = /^\s*<(ide_context|attached_[a-z]+|tep_tai_len|tab_[a-z_]+|tom_tat_hoi_thoai_truoc_do)\b[^>]*>[\s\S]*?<\/\1>\s*/;

/** Khoá nhẹ nhận diện một ảnh — webview và host tính cùng kết quả: độ dài + băm FNV-1a của 2 KB đầu và 2 KB cuối. */
export function imageKey(data: string): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  feed(data.slice(0, 2048));
  feed(data.slice(-2048));
  return `${data.length.toString(36)}-${h.toString(36)}`;
}

/** Bóc các khối bao quanh (`<ide_context>`, `<attached_file>`, `<tep_tai_len>`…) → còn lại chữ người dùng gõ. */
export function stripWrappers(text: string): string {
  let s = text;
  for (let i = 0; i < 16; i++) {
    const n = s.replace(WRAPPER, '');
    if (n === s) break;
    s = n;
  }
  return s.trim();
}

/** Tin người dùng MỞ ĐẦU một lượt: không phải tin tổng hợp, không chứa kết quả công cụ, có chữ thật hoặc ảnh. */
export function isTurnStart(m: ChatMessage): boolean {
  if (m.role !== 'user' || m.synthetic) return false;
  if (m.content.some((b) => b.type === 'tool_result')) return false;
  return m.content.some((b) => (b.type === 'text' && stripWrappers(b.text).length > 0) || b.type === 'image');
}

export function userTurnCount(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) if (isTurnStart(m)) n++;
  return n;
}

const cap = (s: string): string => (s.length <= OUTPUT_CAP ? s : `…${s.slice(s.length - OUTPUT_CAP + 1)}`);
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function rebuildTranscript(messages: readonly ChatMessage[]): TItem[] {
  const items: TItem[] = [];
  const pending = new Map<string, ToolBlock>();
  let cur: AssistantItem | null = null;
  let n = 0;

  for (const m of messages) {
    if (m.synthetic) continue;
    const ts = m.ts ?? 0;

    if (m.role === 'user') {
      const texts: string[] = [];
      const images: Extract<ContentBlock, { type: 'image' }>[] = [];
      let hasResult = false;
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          hasResult = true;
          const tb = pending.get(b.toolUseId);
          if (tb) {
            tb.state = b.isError ? 'error' : 'done';
            tb.output = cap(b.content);
            pending.delete(b.toolUseId);
          }
        } else if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'image') images.push(b);
      }
      // Tin chèn giữa vòng công cụ (đi chung tin kết quả): bỏ dòng báo của engine, phần còn lại là chữ người dùng.
      const body = stripWrappers((hasResult ? texts.filter((t) => !STEER_HEADER.test(t.trim())) : texts).join('\n\n'));
      if (!body && images.length === 0) continue;
      const item: UserItem = {
        kind: 'user',
        id: `rb_u${n++}`,
        text: body,
        attachments: images.map((im, i) => ({ kind: 'image' as const, label: `Ảnh ${i + 1}`, mediaType: im.mediaType, imgKey: imageKey(im.data) })),
        ts,
      };
      if (hasResult) item.steer = true;
      items.push(item);
      cur = null;
      continue;
    }

    if (!cur) {
      cur = { kind: 'assistant', id: `rb_a${n++}`, provider: m.provider ?? '', model: m.model ?? '', ts, blocks: [], done: true, stopReason: 'end_turn' };
      items.push(cur);
    }
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) cur.blocks.push({ type: 'text', id: `${cur.id}:t${cur.blocks.length}`, text: b.text });
      else if (b.type === 'tool_use') {
        const tb: ToolBlock = { type: 'tool', id: b.id, name: b.name, args: b.input, state: 'done', startedAt: ts };
        cur.blocks.push(tb);
        pending.set(b.id, tb);
      }
    }
  }
  for (const tb of pending.values()) tb.state = 'cancelled'; // lệnh gọi không có kết quả (bị dừng giữa chừng)
  return items.filter((it) => it.kind !== 'assistant' || it.blocks.length > 0);
}

export interface Reconciled {
  items: TItem[];
  rebuilt: boolean;
  /** Số lượt người dùng được dựng lại. */
  added: number;
}

const turnItems = (items: readonly TItem[]): UserItem[] => items.filter((i): i is UserItem => i.kind === 'user' && !i.steer);

/**
 * Nếu `transcript` có ít lượt người dùng hơn `messages` thì dựng lại phần thiếu. Giữ nguyên phần đuôi hiện có (nối vào đúng lượt đầu tiên của nó);
 * không nối được thì dùng bản dựng lại hoàn toàn. Ngược lại trả về chính `transcript` (cùng tham chiếu).
 */
export function reconcileTranscript(messages: readonly ChatMessage[], transcript: TItem[]): Reconciled {
  const have = turnItems(transcript).length;
  if (userTurnCount(messages) <= have) return { items: transcript, rebuilt: false, added: 0 };
  const rebuilt = rebuildTranscript(messages);
  const want = turnItems(rebuilt).length;
  if (want <= have) return { items: transcript, rebuilt: false, added: 0 };

  const first = turnItems(transcript)[0];
  if (first) {
    const key = norm(first.text).slice(0, 40);
    const idx = rebuilt.findIndex((i) => i.kind === 'user' && !i.steer && norm(i.text).startsWith(key) && (!first.ts || !i.ts || Math.abs(i.ts - first.ts) < 5 * 60_000));
    if (idx >= 0) return { items: [...rebuilt.slice(0, idx), ...transcript.slice(transcript.indexOf(first))], rebuilt: true, added: want - have };
  }
  return { items: rebuilt, rebuilt: true, added: want - have };
}
