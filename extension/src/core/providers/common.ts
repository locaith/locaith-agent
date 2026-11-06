/**
 * Phần dùng chung giữa các adapter không phải Anthropic.
 */

import { ProviderError, userText, type CompleteRequest, type LLMProvider, type ProviderEvent } from '../types';
import { linkSignal } from './http';

/**
 * Trần đầu ra tối thiểu cho `complete()`. Với model suy luận (OpenAI/Grok/Gemini/Claude), token suy luận tính
 * vào giới hạn đầu ra; một trần 40–60 token sẽ bị suy luận ăn hết và không còn chỗ cho câu trả lời. Đây chỉ là
 * trần — model dừng sớm khi xong — nên không làm tốn thêm token.
 */
export const COMPLETE_MIN_OUTPUT_TOKENS = 1024;

/**
 * Hiện thực `complete()` bằng cách chạy `stream()` không công cụ, tắt suy luận, rồi gom văn bản.
 * Dùng cho tóm tắt nền và nén ngữ cảnh — những lời gọi ngắn, ưu tiên rẻ/nhanh.
 */
export async function completeViaStream(
  provider: Pick<LLMProvider, 'stream' | 'id'>,
  req: CompleteRequest,
): Promise<string> {
  const timeoutMs = req.timeoutMs ?? 30_000;
  const { controller, dispose } = linkSignal(req.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('timeout', 'TimeoutError'));
  }, timeoutMs);
  let text = '';
  try {
    const gen = provider.stream({
      model: req.model,
      system: req.system,
      messages: [userText(req.prompt)],
      tools: [],
      maxOutputTokens: Math.max(req.maxOutputTokens, COMPLETE_MIN_OUTPUT_TOKENS),
      thinking: { level: 'off', summaries: false },
      signal: controller.signal,
    });
    for await (const ev of gen as AsyncGenerator<ProviderEvent, void, void>) {
      if (ev.type === 'text_delta') text += ev.text;
    }
    return text.trim();
  } catch (err) {
    if (timedOut) {
      throw new ProviderError(`Quá ${Math.round(timeoutMs / 1000)} giây chưa có phản hồi.`, {
        kind: 'timeout',
        providerId: provider.id,
        retryable: false,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    dispose();
  }
}

/** Sao chép sâu một đối tượng JSON thuần (dùng khi phát lại item thô của API mà không muốn sửa bản gốc). */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
