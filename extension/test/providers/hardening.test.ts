/** Các tình huống chéo giữa nhiều adapter: khôi phục lỗi, trần đầu ra của complete(), thời gian chờ, system rỗng. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicProvider, toAnthropicMessages } from '../../src/core/providers/anthropic';
import { COMPLETE_MIN_OUTPUT_TOKENS } from '../../src/core/providers/common';
import { GeminiProvider } from '../../src/core/providers/gemini';
import { optNumber, resetParamMemory, withRetries, type RetryPolicy } from '../../src/core/providers/http';
import { OpenAIChatProvider } from '../../src/core/providers/openaiChat';
import { OpenAIResponsesProvider } from '../../src/core/providers/openaiResponses';
import { ProviderError, userText, type ChatMessage, type ProviderEvent } from '../../src/core/types';
import { MockServer, type SseEvent } from '../helpers/mockServer';
import { TEST_KEY, req, run, runtimeConfig, textOfEvents } from './util';

let server: MockServer;
beforeAll(async () => {
  server = await MockServer.start();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => resetParamMemory());
afterEach(() => server.reset());

const ev = (type: string, data: Record<string, unknown> = {}): SseEvent => ({ event: type, data: { type, ...data } });

// ── Dựng nhanh luồng cho từng hãng ───────────────────────────────────────────
const anthropicOk = (text = 'ok'): SseEvent[] => [
  ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }),
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  ev('content_block_stop', { index: 0 }),
  ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  ev('message_stop'),
];
const responsesOk = (text = 'ok'): SseEvent[] => [
  ev('response.output_text.delta', { output_index: 0, delta: text }),
  ev('response.completed', { response: { status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1 } } }),
];
const chatOk = (text = 'ok'): SseEvent[] => [{ data: { choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] } }, { data: '[DONE]' }];
const geminiOk = (text = 'ok'): SseEvent[] => [{ data: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] } }];

const anthropic = () => new AnthropicProvider(runtimeConfig(server, { id: 'anthropic', kind: 'anthropic', flavor: 'anthropic' }));
const openai = () => new OpenAIResponsesProvider(runtimeConfig(server, { id: 'openai', kind: 'openai-responses', flavor: 'openai' }));
const chat = () => new OpenAIChatProvider(runtimeConfig(server, { id: 'deepseek', kind: 'openai-chat', flavor: 'deepseek' }));
const gemini = () => new GeminiProvider(runtimeConfig(server, { id: 'gemini', kind: 'gemini', flavor: 'gemini' }));

describe('OpenAI: tổ chức chưa xác minh để xem tóm tắt suy luận', () => {
  it('chỉ bỏ reasoning.summary, GIỮ effort (không xoá cả reasoning)', async () => {
    server.reply({
      status: 400,
      json: { error: { message: 'Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization.', type: 'invalid_request_error', param: 'reasoning.summary' } },
    });
    server.reply({ sse: responsesOk() });
    await run(openai(), req({ model: 'gpt-6.1-sol', thinking: { level: 'high', summaries: true } }));
    expect(server.requests[0].json.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(server.requests[1].json.reasoning).toEqual({ effort: 'high' });
  });
});

describe('Anthropic: khối thinking cũ không còn hợp lệ', () => {
  const history: ChatMessage[] = [
    userText('q'),
    { role: 'assistant', provider: 'anthropic', content: [{ type: 'thinking', text: 'nghĩ', signature: 'SIG-CU', provider: 'anthropic' }, { type: 'text', text: 'a' }] },
    userText('tiếp'),
  ];

  it('400 về chữ ký thinking → gọi lại KHÔNG có thinking cũ và báo engine xoá chúng khỏi lịch sử; KHÔNG nhớ vĩnh viễn', async () => {
    server.reply({
      status: 400,
      json: { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } },
    });
    server.reply({ sse: anthropicOk() });
    const first = await run(anthropic(), req({ model: 'claude-opus-5-5', messages: history }));
    expect(JSON.stringify(server.requests[0].json.messages)).toContain('SIG-CU');
    expect(JSON.stringify(server.requests[1].json.messages)).not.toContain('thinking');
    // Khối suy luận MỚI được sinh ra khi không có khối cũ → engine phải xoá khối cũ khỏi lịch sử đã lưu.
    expect(first.done.droppedReplayedThinking).toBe(true);

    // Sự cố của MỘT cuộc trò chuyện không được tắt việc phát lại suy luận cho mọi cuộc trò chuyện lành mạnh khác.
    server.reply({ sse: anthropicOk() });
    const second = await run(anthropic(), req({ model: 'claude-opus-5-5', messages: history }));
    expect(JSON.stringify(server.requests[2].json.messages)).toContain('SIG-CU');
    expect(second.done.droppedReplayedThinking).toBeUndefined();
  });

  it('nhà cung cấp Anthropic tuỳ chỉnh (id khác) vẫn phát lại suy luận do CHÍNH nó sinh ra, và không phát lại của nhà khác', () => {
    const msgs: ChatMessage[] = [
      userText('q'),
      { role: 'assistant', content: [{ type: 'thinking', text: 'a', signature: 'S-OWN', provider: 'my-proxy' }, { type: 'thinking', text: 'b', signature: 'S-OTHER', provider: 'anthropic' }, { type: 'text', text: 'x' }] },
      userText('tiếp'),
    ];
    const own = JSON.stringify(toAnthropicMessages(msgs, { providerId: 'my-proxy' }));
    expect(own).toContain('S-OWN');
    expect(own).not.toContain('S-OTHER');
    // Mặc định (không truyền id) giữ hành vi cũ: chỉ id 'anthropic'.
    const def = JSON.stringify(toAnthropicMessages(msgs, {}));
    expect(def).toContain('S-OTHER');
    expect(def).not.toContain('S-OWN');
  });

  it('lỗi 400 khác có chữ "thinking" (vd. kiểu suy luận) KHÔNG bị nhầm là lỗi lịch sử', async () => {
    server.reply({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'thinking.type: adaptive is not supported for this model' } } });
    server.reply({ sse: anthropicOk() });
    await run(anthropic(), req({ model: 'claude-zeta-9', messages: history, maxOutputTokens: 20000 }));
    // vẫn phát lại thinking trong lần gọi lại (chỉ đổi kiểu suy luận)
    expect(JSON.stringify(server.requests[1].json.messages)).toContain('SIG-CU');
    expect(server.requests[1].json.thinking.type).toBe('enabled');
  });
});

describe('system rỗng không được gửi đi', () => {
  it('Anthropic / Responses / Gemini bỏ hẳn trường system khi trống', async () => {
    server.reply({ sse: anthropicOk() });
    await run(anthropic(), req({ system: '   ' }));
    expect(server.lastRequest.json).not.toHaveProperty('system');

    server.reply({ sse: responsesOk() });
    await run(openai(), req({ system: '' }));
    expect(server.lastRequest.json).not.toHaveProperty('instructions');

    server.reply({ sse: geminiOk() });
    await run(gemini(), req({ system: '' }));
    expect(server.lastRequest.json).not.toHaveProperty('systemInstruction');

    server.reply({ sse: chatOk() });
    await run(chat(), req({ system: '' }));
    expect(server.lastRequest.json.messages.some((m: any) => m.role === 'system')).toBe(false);
  });
});

describe('complete(): trần đầu ra có sàn (token suy luận không được ăn hết chỗ của câu trả lời)', () => {
  const ask = { system: 's', prompt: 'p', maxOutputTokens: 40 };

  it('Anthropic', async () => {
    server.reply({ json: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
    await anthropic().complete({ ...ask, model: 'claude-haiku-5-5' });
    expect(server.lastRequest.json.max_tokens).toBe(COMPLETE_MIN_OUTPUT_TOKENS);
  });
  it('OpenAI Responses', async () => {
    server.reply({ sse: responsesOk() });
    await openai().complete({ ...ask, model: 'gpt-6-luna' });
    expect(server.lastRequest.json.max_output_tokens).toBe(COMPLETE_MIN_OUTPUT_TOKENS);
  });
  it('Chat Completions', async () => {
    server.reply({ sse: chatOk() });
    await chat().complete({ ...ask, model: 'deepseek-flash' });
    expect(server.lastRequest.json.max_tokens).toBe(COMPLETE_MIN_OUTPUT_TOKENS);
  });
  it('Gemini', async () => {
    server.reply({ sse: geminiOk() });
    await gemini().complete({ ...ask, model: 'gemini-3.5-flash-lite' });
    expect(server.lastRequest.json.generationConfig.maxOutputTokens).toBe(COMPLETE_MIN_OUTPUT_TOKENS);
  });
  it('trần lớn hơn sàn được giữ nguyên', async () => {
    server.reply({ sse: chatOk() });
    await chat().complete({ ...ask, maxOutputTokens: 4000, model: 'deepseek-flash' });
    expect(server.lastRequest.json.max_tokens).toBe(4000);
  });
});

describe('Responses tương thích chạy cục bộ không cần khoá', () => {
  it('requiresKey=false → không gửi Authorization nhưng vẫn gọi được', async () => {
    server.reply({ sse: responsesOk('xin chào') });
    const p = new OpenAIResponsesProvider(
      runtimeConfig(server, { id: 'local-resp', kind: 'openai-responses', flavor: 'generic', getApiKey: async () => undefined, options: { requiresKey: false, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } } }),
    );
    const { events } = await run(p, req());
    expect(textOfEvents(events)).toBe('xin chào');
    expect(server.lastRequest.headers).not.toHaveProperty('authorization');
  });

  it('mặc định vẫn đòi khoá', async () => {
    const p = new OpenAIResponsesProvider(runtimeConfig(server, { id: 'x', kind: 'openai-responses', flavor: 'generic', getApiKey: async () => undefined }));
    await expect(run(p, req())).rejects.toMatchObject({ kind: 'auth' });
  });

  it('fetchModels không gửi header authorization rỗng', async () => {
    server.reply({ json: { data: [{ id: 'llama3.2' }] } });
    const p = new OpenAIResponsesProvider(
      runtimeConfig(server, { id: 'local-resp', kind: 'openai-responses', flavor: 'generic', getApiKey: async () => undefined, options: { requiresKey: false } }),
    );
    expect((await p.fetchModels()).map((m) => m.id)).toEqual(['llama3.2']);
    expect(server.lastRequest.headers).not.toHaveProperty('authorization');
  });
});

describe('thời gian chờ', () => {
  const policy: RetryPolicy = { maxRetries: 4, baseDelayMs: 1, maxDelayMs: 5 };

  it('lỗi timeout chỉ được thử lại MỘT lần (khỏi đợi nhiều lần chục phút)', async () => {
    let n = 0;
    const gen = withRetries({ providerId: 'p', signal: new AbortController().signal, policy }, async function* () {
      n++;
      throw new ProviderError('hết giờ', { kind: 'timeout', providerId: 'p', retryable: true });
    });
    const out: ProviderEvent[] = [];
    await expect(
      (async () => {
        for await (const e of gen) out.push(e);
      })(),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(n).toBe(2);
    expect(out.filter((e) => e.type === 'retry')).toHaveLength(1);
  });

  it('luồng im lặng quá idleTimeoutMs (tuỳ chọn adapter) → ProviderError timeout', async () => {
    server.replyAlways({ rawSse: 'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n', keepOpen: true });
    const p = new OpenAIChatProvider(
      runtimeConfig(server, { id: 'deepseek', kind: 'openai-chat', flavor: 'deepseek', options: { idleTimeoutMs: 80, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } } }),
    );
    const got: ProviderEvent[] = [];
    let error: any;
    try {
      for await (const e of p.stream(req())) got.push(e);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ name: 'ProviderError', kind: 'timeout' });
    expect(textOfEvents(got)).toBe('a');
  });

  it('server không trả header trong headerTimeoutMs → timeout', async () => {
    server.replyAlways({ delayMs: 400, sse: chatOk() });
    const p = new OpenAIChatProvider(
      runtimeConfig(server, { id: 'deepseek', kind: 'openai-chat', flavor: 'deepseek', options: { headerTimeoutMs: 60, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } } }),
    );
    await expect(run(p, req())).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('optNumber chỉ nhận số dương hữu hạn', () => {
    expect(optNumber({ a: 5 }, 'a')).toBe(5);
    expect(optNumber({ a: 0 }, 'a')).toBeUndefined();
    expect(optNumber({ a: -1 }, 'a')).toBeUndefined();
    expect(optNumber({ a: '5' }, 'a')).toBeUndefined();
    expect(optNumber({ a: Infinity }, 'a')).toBeUndefined();
    expect(optNumber(undefined, 'a')).toBeUndefined();
  });
});

describe('an toàn khoá API', () => {
  it('khoá không bao giờ xuất hiện trong thông điệp/chi tiết lỗi của bất kỳ hãng nào', async () => {
    const leak = `đây là khoá ${TEST_KEY} bị server in ra`;
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['anthropic', () => run(anthropic(), req())],
      ['openai', () => run(openai(), req())],
      ['deepseek', () => run(chat(), req())],
      ['gemini', () => run(gemini(), req())],
    ];
    for (const [name, call] of cases) {
      server.reply({ status: 400, json: { error: { message: leak, type: 'invalid_request_error' } } });
      const err: any = await call().catch((e) => e);
      expect(err, name).toBeInstanceOf(ProviderError);
      expect(JSON.stringify([err.message, err.details]), name).not.toContain(TEST_KEY);
    }
  });

  it('khoá không nằm trên URL của bất kỳ yêu cầu nào đã gửi', async () => {
    server.reply({ sse: anthropicOk() });
    await run(anthropic(), req());
    server.reply({ sse: responsesOk() });
    await run(openai(), req());
    server.reply({ sse: chatOk() });
    await run(chat(), req());
    server.reply({ sse: geminiOk() });
    await run(gemini(), req());
    server.reply({ json: { models: [] } });
    await gemini().fetchModels();
    for (const r of server.requests) expect(r.url).not.toContain(TEST_KEY);
  });
});
