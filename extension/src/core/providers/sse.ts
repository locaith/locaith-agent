/**
 * Bộ phân tích Server-Sent Events chạy trên `ReadableStream<Uint8Array>`.
 *
 * - Chịu được mọi cách cắt khúc: ký tự UTF-8 nhiều byte (tiếng Việt!) bị cắt giữa chừng giữa hai khúc,
 *   `\r\n` bị tách đôi, dòng `data:` nằm ở nhiều khúc.
 * - Theo đặc tả SSE: `data:` nhiều dòng nối bằng `\n`, `event:`, `id:`, dòng chú thích `:`, dòng trống = kết thúc sự kiện.
 * - `data: [DONE]` là dấu hiệu kết thúc của họ OpenAI → bộ phân tích dừng lại, không trả sự kiện này ra ngoài.
 * - Hết thời gian chờ không có dữ liệu (kể cả dòng keep-alive) → ProviderError('timeout').
 */

import { ProviderError } from '../types';

export interface SseMessage {
  /** Giá trị trường `event:` (nếu có). */
  event?: string;
  data: string;
  id?: string;
}

export interface ParseSseOptions {
  signal?: AbortSignal;
  /** Quá thời gian này không nhận được byte nào → ném timeout. Mặc định 5 phút (model suy luận mức cao có thể im lặng rất lâu). */
  idleTimeoutMs?: number;
  providerId?: string;
  /** Dấu kết thúc luồng (mặc định `[DONE]`). */
  doneSentinel?: string | null;
  /** Được gọi khi gặp dấu kết thúc (luồng kết thúc ĐÚNG cách, khác với việc kết nối bị đứt). */
  onSentinel?: () => void;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** Kết quả một lần `reader.read()` (lấy từ chính kiểu của reader để khớp với môi trường Node/DOM). */
type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

function abortedError(providerId: string): ProviderError {
  return new ProviderError('Đã hủy theo yêu cầu.', { kind: 'aborted', providerId, retryable: false });
}

async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  providerId: string,
  signal?: AbortSignal,
): Promise<ReadResult> {
  if (signal?.aborted) throw abortedError(providerId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const guards: Promise<never>[] = [];
    if (Number.isFinite(idleMs) && idleMs > 0) {
      guards.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new ProviderError(
                `Máy chủ không gửi thêm dữ liệu trong ${Math.round(idleMs / 1000)} giây nên kết nối bị ngắt.`,
                { kind: 'timeout', providerId, retryable: true },
              ),
            );
          }, idleMs);
        }),
      );
    }
    if (signal) {
      guards.push(
        new Promise<never>((_, reject) => {
          onAbort = () => reject(abortedError(providerId));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }
    return await Promise.race([reader.read(), ...guards]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Tách dòng theo `\r\n`, `\n` hoặc `\r` đơn lẻ. Trả về các dòng đầy đủ và phần dư chưa có ký tự xuống dòng. */
function splitLines(buffer: string, final: boolean): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  while (i < buffer.length) {
    const ch = buffer.charCodeAt(i);
    if (ch === 10) {
      lines.push(buffer.slice(start, i));
      start = ++i;
    } else if (ch === 13) {
      if (i + 1 >= buffer.length && !final) break; // có thể còn \n ở khúc sau
      lines.push(buffer.slice(start, i));
      i += buffer.charCodeAt(i + 1) === 10 ? 2 : 1;
      start = i;
    } else {
      i++;
    }
  }
  return { lines, rest: buffer.slice(start) };
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  opts: ParseSseOptions = {},
): AsyncGenerator<SseMessage, void, void> {
  const providerId = opts.providerId ?? 'unknown';
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sentinel = opts.doneSentinel === undefined ? '[DONE]' : opts.doneSentinel;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let first = true;
  let eventName: string | undefined;
  let eventId: string | undefined;
  let dataLines: string[] = [];
  let finished = false;

  const dispatch = (): SseMessage | null => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return null;
    }
    const msg: SseMessage = { data: dataLines.join('\n') };
    if (eventName !== undefined) msg.event = eventName;
    if (eventId !== undefined) msg.id = eventId;
    dataLines = [];
    eventName = undefined;
    return msg;
  };

  const feedLine = (line: string): SseMessage | null => {
    if (line === '') return dispatch();
    if (line.charCodeAt(0) === 58) return null; // ':' → chú thích/keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        eventId = value;
        break;
      default:
        break; // retry:, trường lạ → bỏ qua
    }
    return null;
  };

  try {
    for (;;) {
      let result: ReadResult;
      try {
        result = await readWithIdle(reader, idleMs, providerId, opts.signal);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        const aborted = opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
        if (aborted) throw abortedError(providerId);
        throw new ProviderError(
          `Kết nối bị ngắt giữa chừng khi nhận dữ liệu: ${err instanceof Error ? err.message : String(err)}`,
          { kind: 'network', providerId, retryable: true, cause: err },
        );
      }

      if (result.done) {
        buffer += decoder.decode(); // xả byte còn dư trong bộ giải mã
        finished = true;
      } else if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
        if (first) {
          if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
          first = false;
        }
      }

      const { lines, rest } = splitLines(buffer, finished);
      buffer = rest;
      for (const line of lines) {
        const msg = feedLine(line);
        if (!msg) continue;
        if (sentinel !== null && msg.data === sentinel) {
          opts.onSentinel?.();
          return;
        }
        yield msg;
      }

      if (finished) {
        // Dòng cuối không có ký tự xuống dòng, và sự kiện cuối chưa có dòng trống kết thúc.
        if (buffer.length > 0) {
          const msg = feedLine(buffer);
          buffer = '';
          if (msg && sentinel !== null && msg.data === sentinel) opts.onSentinel?.();
          else if (msg) yield msg;
        }
        const last = dispatch();
        if (last && sentinel !== null && last.data === sentinel) opts.onSentinel?.();
        else if (last) yield last;
        return;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* luồng đã đóng */
    }
    try {
      reader.releaseLock();
    } catch {
      /* đã giải phóng */
    }
  }
}
