/**
 * Ước lượng token thô — chỉ để quyết định khi nào nén ngữ cảnh. Số liệu thật lấy từ `usage` của hãng.
 * Tiếng Việt có nhiều ký tự ngoài ASCII (dấu thanh) nên tokenizer thường tốn token hơn tiếng Anh;
 * ký tự ngoài ASCII được tính nặng hơn.
 */

import type { ChatMessage, ContentBlock } from '../types';

export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3.8 + other / 1.4);
}

const IMAGE_TOKENS = 1500;

export function estimateBlockTokens(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
      return estimateTokens(b.text);
    case 'thinking':
      return estimateTokens(b.text) + (b.signature ? 200 : 0);
    case 'image':
      return IMAGE_TOKENS;
    case 'tool_use':
      return estimateTokens(b.name) + estimateTokens(JSON.stringify(b.input)) + 10;
    case 'tool_result':
      return estimateTokens(b.content) + (b.images?.length ?? 0) * IMAGE_TOKENS + 10;
  }
}

export function estimateMessageTokens(m: ChatMessage): number {
  let n = 4;
  for (const b of m.content) n += estimateBlockTokens(b);
  return n;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}
