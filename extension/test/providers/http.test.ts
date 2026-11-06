import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyHttpError,
  computeRetryDelay,
  extractErrorBody,
  findOffendingParam,
  parseRetryAfter,
  parseSupportedValues,
  pickNearest,
  redactSecrets,
  rememberRemoval,
  rememberedRemovals,
  resetParamMemory,
  sleep,
  toProviderError,
  withDegradation,
  withRetries,
  type RetryPolicy,
} from '../../src/core/providers/http';
import { ProviderError, type ProviderEvent } from '../../src/core/types';

beforeEach(() => resetParamMemory());

describe('redactSecrets', () => {
  it('che khoá cụ thể và các mẫu khoá phổ biến', () => {
    const text =
      'lỗi với sk-proj-abcdef1234567890XYZ và AIzaSyA1234567890abcdefghijklmnop, xai-abcdefghijklmnop12345, Bearer abcdefgh12345678, khoá-riêng-tôi-123456';
    const out = redactSecrets(text, ['khoá-riêng-tôi-123456']);
    expect(out).not.toMatch(/sk-proj|AIzaSy|xai-abcdef|abcdefgh12345678|khoá-riêng-tôi/);
    expect(out).toContain('***');
  });

  it('che giá trị của header x-api-key / authorization trong JSON', () => {
    const out = redactSecrets('{"x-api-key": "secretvalue12345", "authorization":"Bearer tokentokentoken"}');
    expect(out).not.toContain('secretvalue12345');
    expect(out).not.toContain('tokentokentoken');
  });

  it('không đụng tới văn bản bình thường', () => {
    expect(redactSecrets('Đã thêm tác vụ: gom điểm theo mô hình')).toBe('Đã thêm tác vụ: gom điểm theo mô hình');
  });
});

describe('parseSupportedValues', () => {
  it('kiểu OpenAI có dấu nháy', () => {
    expect(parseSupportedValues("Invalid value: 'none'. Supported values are: 'low', 'medium', and 'high'.")).toEqual(['low', 'medium', 'high']);
  });
  it('liệt kê không nháy', () => {
    expect(parseSupportedValues('Unsupported value. Supported values are: low, medium and high.')).toEqual(['low', 'medium', 'high']);
  });
  it('must be one of', () => {
    expect(parseSupportedValues('reasoning_effort must be one of: none, low, high, max')).toEqual(['none', 'low', 'high', 'max']);
  });
  it('không có danh sách → rỗng', () => {
    expect(parseSupportedValues('Bad request')).toEqual([]);
  });
});

describe('pickNearest', () => {
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  it('giữ nguyên nếu được hỗ trợ', () => expect(pickNearest('high', ['low', 'high'], order)).toBe('high'));
  it("'none' không được hỗ trợ → mức thấp nhất còn lại", () => expect(pickNearest('none', ['low', 'medium', 'high'], order)).toBe('low'));
  it("'max' không được hỗ trợ → mức cao nhất còn lại", () => expect(pickNearest('max', ['low', 'medium', 'high'], order)).toBe('high'));
  it('bằng khoảng cách thì ưu tiên mức thấp hơn', () => expect(pickNearest('medium', ['low', 'high'], order)).toBe('low'));
  it('danh sách rỗng → undefined', () => expect(pickNearest('low', [], order)).toBeUndefined());
});

describe('findOffendingParam', () => {
  const cands = ['reasoning.summary', 'reasoning.effort', 'reasoning', 'include', 'stream_options'];
  it('tìm tham số xuất hiện sớm nhất', () => {
    expect(findOffendingParam("Unsupported parameter: 'reasoning.summary' is not supported with this model.", cands)).toBe('reasoning.summary');
  });
  it('chấp nhận a_b ↔ a.b', () => {
    expect(findOffendingParam("Unknown parameter: 'reasoning_effort'", cands)).toBe('reasoning.effort');
  });
  it('không thấy → undefined', () => expect(findOffendingParam('Lỗi không liên quan', cands)).toBeUndefined());
});

describe('parseRetryAfter', () => {
  it('retry-after-ms', () => expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }))).toBe(250));
  it('retry-after giây', () => expect(parseRetryAfter(new Headers({ 'retry-after': '3' }))).toBe(3000));
  it('retry-after ngày HTTP', () => {
    const when = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter(new Headers({ 'retry-after': when }));
    expect(ms).toBeGreaterThan(2000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
  it('không có header → undefined', () => expect(parseRetryAfter(new Headers())).toBeUndefined());
});

describe('extractErrorBody', () => {
  it('OpenAI/DeepSeek', () => {
    expect(extractErrorBody('{"error":{"message":"bad","type":"invalid_request_error","code":"x"}}')).toMatchObject({ message: 'bad', code: 'x', type: 'invalid_request_error' });
  });
  it('Anthropic', () => {
    expect(extractErrorBody('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toMatchObject({ message: 'Overloaded', type: 'overloaded_error' });
  });
  it('Gemini (mảng)', () => {
    expect(extractErrorBody('[{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}]')).toMatchObject({ message: 'quota', code: '429' });
  });
  it('HTML → văn bản thuần, cắt ngắn', () => {
    expect(extractErrorBody('<html><body><h1>502 Bad Gateway</h1></body></html>').message).toBe('502 Bad Gateway');
  });
});

describe('classifyHttpError', () => {
  const c = (status: number, body: unknown, headers?: Headers) =>
    classifyHttpError('p', status, typeof body === 'string' ? body : JSON.stringify(body), headers, ['KEY123456789']);

  it('401 → auth, không retry, thông điệp tiếng Việt', () => {
    const e = c(401, { error: { message: 'invalid x-api-key' } });
    expect(e).toMatchObject({ kind: 'auth', status: 401, retryable: false });
    expect(e.message).toBe('Khóa API không hợp lệ hoặc đã bị thu hồi.');
  });
  it('403 → auth', () => expect(c(403, { error: { message: 'nope' } })).toMatchObject({ kind: 'auth', retryable: false }));
  it('404 → not_found', () => expect(c(404, {}).kind).toBe('not_found'));
  it('429 → rate_limit, retry, đọc retry-after', () => {
    const e = c(429, { error: { message: 'slow down' } }, new Headers({ 'retry-after-ms': '40' }));
    expect(e).toMatchObject({ kind: 'rate_limit', retryable: true, retryAfterMs: 40 });
  });
  it('429 hết hạn mức (insufficient_quota) → không retry', () => {
    const e = c(429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } });
    expect(e).toMatchObject({ kind: 'rate_limit', retryable: false });
  });
  it('402 (hết số dư) → không retry', () => expect(c(402, { error: { message: 'Insufficient Balance' } })).toMatchObject({ retryable: false }));
  it('400 có cụm từ ngữ cảnh → context_length', () => {
    expect(c(400, { error: { message: "This model's maximum context length is 128000 tokens" } }).kind).toBe('context_length');
    expect(c(400, { error: { message: 'prompt is too long: 250000 tokens > 200000 maximum' } }).kind).toBe('context_length');
  });
  it('413 → context_length', () => expect(c(413, '').kind).toBe('context_length'));
  it('400 thường → bad_request, kèm thông điệp gốc', () => {
    const e = c(400, { error: { message: "Unsupported parameter: 'foo'" } });
    expect(e.kind).toBe('bad_request');
    expect(e.message).toContain("Unsupported parameter: 'foo'");
  });
  it('Gemini 400 "API key not valid" → auth', () => {
    expect(c(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }).kind).toBe('auth');
  });
  it('503/529 → overloaded; 500 → server; đều retry', () => {
    expect(c(529, {})).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(c(503, {})).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(c(500, {})).toMatchObject({ kind: 'server', retryable: true });
  });
  it('che khoá xuất hiện trong thông điệp và details', () => {
    const e = c(400, { error: { message: 'bad key KEY123456789 here' } });
    expect(e.message).not.toContain('KEY123456789');
    expect(e.details).not.toContain('KEY123456789');
  });
});

describe('toProviderError', () => {
  it('lỗi fetch có mã ECONNREFUSED → network, thông điệp tiếng Việt', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    const e = toProviderError(err, 'p');
    expect(e).toMatchObject({ kind: 'network', retryable: true });
    expect(e.message).toContain('từ chối kết nối');
  });
  it('AbortError → aborted', () => {
    expect(toProviderError(new DOMException('x', 'AbortError'), 'p').kind).toBe('aborted');
  });
  it('tín hiệu đã hủy → aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(toProviderError(new Error('bất kỳ'), 'p', ctrl.signal).kind).toBe('aborted');
  });
  it('TimeoutError → timeout', () => {
    expect(toProviderError(new DOMException('x', 'TimeoutError'), 'p').kind).toBe('timeout');
  });
  it('giữ nguyên ProviderError', () => {
    const e = new ProviderError('x', { kind: 'auth', providerId: 'p' });
    expect(toProviderError(e, 'p')).toBe(e);
  });
});

describe('computeRetryDelay', () => {
  const policy: RetryPolicy = { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 60_000 };
  const err = (retryAfterMs?: number) => new ProviderError('x', { kind: 'rate_limit', providerId: 'p', retryAfterMs });
  it('backoff mũ 1s,2s,4s,8s (random=0.5 → hệ số 1)', () => {
    expect([0, 1, 2, 3].map((n) => computeRetryDelay(err(), n, policy, () => 0.5))).toEqual([1000, 2000, 4000, 8000]);
  });
  it('chặn trên maxDelayMs', () => {
    expect(computeRetryDelay(err(), 10, policy, () => 0.5)).toBe(60_000);
  });
  it('theo retry-after khi hợp lý', () => {
    expect(computeRetryDelay(err(5000), 0, policy, () => 0)).toBe(5000);
  });
  it('retry-after vượt trần → null (không đáng chờ)', () => {
    expect(computeRetryDelay(err(10 * 60_000), 0, policy)).toBeNull();
  });
});

describe('withRetries', () => {
  const policy: RetryPolicy = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 };
  const mk = (signal = new AbortController().signal) => ({ providerId: 'p', signal, policy, random: () => 0.5 });
  const collectAll = async (gen: AsyncGenerator<ProviderEvent, void, void>) => {
    const out: ProviderEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  };
  const retryable = () => new ProviderError('quá tải', { kind: 'overloaded', providerId: 'p', retryable: true });
  const done: ProviderEvent = { type: 'done', message: { role: 'assistant', content: [] }, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };

  it('thử lại khi chưa có nội dung, phát sự kiện retry rồi thành công', async () => {
    let n = 0;
    const events = await collectAll(
      withRetries(mk(), async function* () {
        n++;
        if (n < 3) throw retryable();
        yield done;
      }),
    );
    expect(n).toBe(3);
    expect(events.map((e) => e.type)).toEqual(['retry', 'retry', 'done']);
    expect(events[0]).toMatchObject({ type: 'retry', attempt: 1, maxAttempts: 3 });
    expect(events[1]).toMatchObject({ type: 'retry', attempt: 2 });
  });

  it('KHÔNG thử lại sau khi đã có nội dung', async () => {
    let n = 0;
    const run = collectAll(
      withRetries(mk(), async function* () {
        n++;
        yield { type: 'text_delta', text: 'Xin' };
        throw retryable();
      }),
    );
    await expect(run).rejects.toMatchObject({ kind: 'overloaded' });
    expect(n).toBe(1);
  });

  it('usage/retry không tính là nội dung', async () => {
    let n = 0;
    const events = await collectAll(
      withRetries(mk(), async function* () {
        n++;
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } };
        if (n === 1) throw retryable();
        yield done;
      }),
    );
    expect(n).toBe(2);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
  });

  it('lỗi không thể thử lại → ném ngay', async () => {
    let n = 0;
    const run = collectAll(
      withRetries(mk(), async function* () {
        n++;
        throw new ProviderError('sai khoá', { kind: 'auth', providerId: 'p' });
      }),
    );
    await expect(run).rejects.toMatchObject({ kind: 'auth' });
    expect(n).toBe(1);
  });

  it('hết số lần thử → ném lỗi cuối', async () => {
    let n = 0;
    const run = collectAll(
      withRetries(mk(), async function* () {
        n++;
        throw retryable();
      }),
    );
    await expect(run).rejects.toMatchObject({ kind: 'overloaded' });
    expect(n).toBe(4); // 1 lần đầu + 3 lần thử lại
  });

  it('retry-after quá dài → không thử lại và nêu thời gian chờ', async () => {
    const run = collectAll(
      withRetries(mk(), async function* () {
        throw new ProviderError('Hết hạn mức ngày', { kind: 'rate_limit', providerId: 'p', retryable: true, retryAfterMs: 20 * 60_000 });
      }),
    );
    await expect(run).rejects.toThrow(/khoảng 20 phút/);
  });

  it('hủy trong lúc chờ backoff → aborted', async () => {
    const ctrl = new AbortController();
    const slow: RetryPolicy = { maxRetries: 3, baseDelayMs: 5000, maxDelayMs: 5000 };
    const gen = withRetries({ providerId: 'p', signal: ctrl.signal, policy: slow }, async function* () {
      throw retryable();
    });
    const run = collectAll(gen);
    setTimeout(() => ctrl.abort(), 30);
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
  });
});

describe('withDegradation', () => {
  const bad = (msg: string) => new ProviderError(msg, { kind: 'bad_request', providerId: 'p' });
  const done: ProviderEvent = { type: 'done', message: { role: 'assistant', content: [] }, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
  const collectAll = async (gen: AsyncGenerator<ProviderEvent, void, void>) => {
    const out: ProviderEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  };

  it('chỉnh yêu cầu rồi chạy lại', async () => {
    const state = { stripped: false };
    const rounds: number[] = [];
    const events = await collectAll(
      withDegradation(
        async function* (round) {
          rounds.push(round);
          if (!state.stripped) throw bad('Unsupported parameter');
          yield done;
        },
        () => {
          state.stripped = true;
          return true;
        },
      ),
    );
    expect(rounds).toEqual([0, 1]);
    expect(events).toHaveLength(1);
  });

  it('degrade trả false → ném lỗi gốc', async () => {
    const run = collectAll(
      withDegradation(
        async function* () {
          throw bad('không sửa được');
        },
        () => false,
      ),
    );
    await expect(run).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('không chỉnh sau khi đã có nội dung', async () => {
    const degrade = vi.fn(() => true);
    const run = collectAll(
      withDegradation(
        async function* () {
          yield { type: 'text_delta', text: 'a' };
          throw bad('x');
        },
        degrade,
      ),
    );
    await expect(run).rejects.toBeInstanceOf(ProviderError);
    expect(degrade).not.toHaveBeenCalled();
  });

  it('giới hạn số vòng chỉnh', async () => {
    let n = 0;
    const run = collectAll(
      withDegradation(
        async function* () {
          n++;
          throw bad('x');
        },
        () => true,
        2,
      ),
    );
    await expect(run).rejects.toBeInstanceOf(ProviderError);
    expect(n).toBe(3);
  });

  it('chỉ xử lý các loại lỗi được chỉ định', async () => {
    const run = collectAll(
      withDegradation(
        async function* () {
          throw new ProviderError('x', { kind: 'server', providerId: 'p' });
        },
        () => true,
      ),
    );
    await expect(run).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('bộ nhớ tham số bị loại', () => {
  it('nhớ theo provider+model', () => {
    rememberRemoval('p', 'm1', 'reasoning');
    expect(rememberedRemovals('p', 'm1').has('reasoning')).toBe(true);
    expect(rememberedRemovals('p', 'm2').has('reasoning')).toBe(false);
    expect(rememberedRemovals('q', 'm1').has('reasoning')).toBe(false);
  });
});

describe('sleep', () => {
  it('bị hủy → AbortError', async () => {
    const ctrl = new AbortController();
    const p = sleep(5000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
