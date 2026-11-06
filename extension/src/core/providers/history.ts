/**
 * Tiện ích lịch sử dùng chung cho mọi adapter.
 *
 * - `normalizeHistory`: vá những chỗ lịch sử không hợp lệ với API của bất kỳ hãng nào
 *   (tool_use thiếu kết quả, kết quả mồ côi, tin nhắn rỗng…) trước khi chuyển đổi sang định dạng riêng.
 * - `parseToolArgs`: phân tích chuỗi JSON đối số tool một cách chặt chẽ nhưng không ném lỗi.
 *
 * Quy ước Usage chung của lớp provider (để engine tính cỡ ngữ cảnh nhất quán):
 *   `inputTokens`  = TỔNG token đầu vào của yêu cầu (đã gồm phần đọc từ cache và phần ghi cache);
 *   `cacheReadTokens` / `cacheWriteTokens` = phần trong đó phục vụ từ / ghi vào cache.
 */

import type { ChatMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from '../types';

/** Nội dung báo cho model khi một lệnh gọi công cụ không có kết quả (bị hủy/gián đoạn). */
export const MISSING_TOOL_RESULT_TEXT = 'Không có kết quả — lượt gọi công cụ này bị gián đoạn hoặc đã bị hủy.';

export function isBlank(text: string | undefined): boolean {
  return !text || text.trim().length === 0;
}

export function dataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

export interface ParsedToolArgs {
  input: Record<string, unknown>;
  rawArgs: string;
  error?: string;
}

/** Chuỗi rỗng = {} (tool không tham số). Không phải đối tượng JSON hoặc JSON hỏng/cụt → trả `error`. */
export function parseToolArgs(raw: string | undefined | null | Record<string, unknown>): ParsedToolArgs {
  if (raw && typeof raw === 'object') return { input: raw as Record<string, unknown>, rawArgs: JSON.stringify(raw) };
  const text = typeof raw === 'string' ? raw : '';
  if (text.trim() === '') return { input: {}, rawArgs: text };
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { input: value as Record<string, unknown>, rawArgs: text };
    }
    return { input: {}, rawArgs: text, error: 'Đối số công cụ phải là một đối tượng JSON.' };
  } catch (err) {
    return {
      input: {},
      rawArgs: text,
      error: `JSON đối số hỏng hoặc bị cắt cụt: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Dựng ToolUseBlock từ chuỗi đối số thô; đối số lỗi → `parseError` + `rawArgs`. */
export function makeToolUse(
  provider: string,
  id: string,
  name: string,
  rawArgs: string | Record<string, unknown> | undefined | null,
  raw?: unknown,
): ToolUseBlock {
  const parsed = parseToolArgs(rawArgs);
  const block: ToolUseBlock = { type: 'tool_use', id, name, input: parsed.input, provider };
  if (raw !== undefined) block.raw = raw;
  if (parsed.error) {
    block.parseError = parsed.error;
    block.rawArgs = parsed.rawArgs;
  }
  return block;
}

export function splitToolResults(message: ChatMessage): { results: ToolResultBlock[]; others: ContentBlock[] } {
  const results: ToolResultBlock[] = [];
  const others: ContentBlock[] = [];
  for (const b of message.content) {
    if (b.type === 'tool_result') results.push(b);
    else others.push(b);
  }
  return { results, others };
}

function toolUsesOf(message: ChatMessage): ToolUseBlock[] {
  return message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

function syntheticResult(use: ToolUseBlock): ToolResultBlock {
  return { type: 'tool_result', toolUseId: use.id, name: use.name, content: MISSING_TOOL_RESULT_TEXT, isError: true };
}

/**
 * Bảo đảm lịch sử hợp lệ với mọi hãng:
 *  1. mỗi tool_use của assistant đều có tool_result ở tin nhắn user NGAY SAU nó (thiếu → chèn kết quả lỗi);
 *  2. tool_result không có tool_use tương ứng ở tin nhắn assistant ngay trước nó → bị bỏ;
 *  3. tin nhắn không còn nội dung → bị bỏ.
 * Không sửa mảng đầu vào.
 */
export function normalizeHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  /** tool_use của assistant gần nhất mà chưa gặp kết quả. */
  let pending: ToolUseBlock[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    out.push({
      role: 'user',
      content: pending.map(syntheticResult),
      synthetic: true,
    });
    pending = [];
  };

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      flushPending();
      const content = msg.content.filter((b) => b.type !== 'tool_result');
      if (content.length === 0) continue;
      out.push(content.length === msg.content.length ? msg : { ...msg, content });
      pending = toolUsesOf(msg);
      continue;
    }

    // user
    const { results, others } = splitToolResults(msg);
    const answered = new Set<string>();
    const kept: ToolResultBlock[] = [];
    for (const r of results) {
      if (pending.some((p) => p.id === r.toolUseId) && !answered.has(r.toolUseId)) {
        kept.push(r);
        answered.add(r.toolUseId);
      }
    }
    const missing = pending.filter((p) => !answered.has(p.id)).map(syntheticResult);
    pending = [];
    const content: ContentBlock[] = [...kept, ...missing, ...others];
    if (content.length === 0) continue;
    out.push({ ...msg, content });
  }

  flushPending();
  return out;
}
