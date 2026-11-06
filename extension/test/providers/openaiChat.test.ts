import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetParamMemory } from '../../src/core/providers/http';
import { OpenAIChatProvider, toChatMessages } from '../../src/core/providers/openaiChat';
import { userText, type ChatMessage } from '../../src/core/types';
import { MockServer, type SseEvent } from '../helpers/mockServer';
import { TEST_KEY, kinds, req, run, runtimeConfig, searchTool, textOfEvents, thinkingOfEvents } from './util';

let server: MockServer;
beforeAll(async () => {
  server = await MockServer.start();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => resetParamMemory());
afterEach(() => server.reset());

const deepseek = (over: Record<string, unknown> = {}) =>
  new OpenAIChatProvider(runtimeConfig(server, { id: 'deepseek', label: 'DeepSeek', kind: 'openai-chat', flavor: 'deepseek', ...over }));
const generic = (over: Record<string, unknown> = {}) =>
  new OpenAIChatProvider(runtimeConfig(server, { id: 'openrouter', label: 'OpenRouter', kind: 'openai-chat', flavor: 'generic', ...over }));

// ── Bộ dựng chunk Chat Completions ───────────────────────────────────────────
const chunk = (delta: Record<string, unknown>, finish: string | null = null): SseEvent => ({
  data: { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] },
});
const usageChunk = (usage: Record<string, unknown>): SseEvent => ({ data: { id: 'c1', object: 'chat.completion.chunk', choices: [], usage } });
const DONE: SseEvent = { data: '[DONE]' };
const textStream = (...parts: string[]): SseEvent[] => [
  chunk({ role: 'assistant', content: '' }),
  ...parts.map((p) => chunk({ content: p })),
  chunk({}, 'stop'),
  usageChunk({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60, completion_tokens_details: { reasoning_tokens: 8 } }),
  DONE,
];
const toolCallChunks = (index: number, id: string, name: string, ...args: string[]): SseEvent[] => [
  chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: args[0] ?? '' } }] }),
  ...args.slice(1).map((a) => chunk({ tool_calls: [{ index, function: { arguments: a } }] })),
];

describe('stream — văn bản & suy luận', () => {
  it('văn bản tiếng Việt qua mọi kiểu cắt byte, usage (cache hit, reasoning)', async () => {
    const parts = ['Nguyễn Thị ', 'Thuỷ Tiên ₫ ', 'ướ ữ ặ ✓'];
    server.reply({ chunkBytes: 6, sse: textStream(...parts) });
    const { events, done } = await run(deepseek(), req({ model: 'deepseek-flash' }));
    expect(textOfEvents(events)).toBe(parts.join(''));
    expect(done.stopReason).toBe('end_turn');
    expect(done.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 8 });
    expect(done.message.content).toEqual([{ type: 'text', text: parts.join(''), provider: 'deepseek' }]);
    expect(kinds(events).at(-1)).toBe('done');
  });

  it('DeepSeek: reasoning_content → thinking_delta + khối thinking (để phát lại)', async () => {
    server.reply({
      sse: [chunk({ role: 'assistant', reasoning_content: 'Đang ' }), chunk({ reasoning_content: 'xem xét.' }), chunk({ content: 'Kết luận' }), chunk({}, 'stop'), DONE],
    });
    const { events, done } = await run(deepseek(), req());
    expect(thinkingOfEvents(events)).toBe('Đang xem xét.');
    expect(done.message.content).toEqual([
      { type: 'thinking', text: 'Đang xem xét.', provider: 'deepseek' },
      { type: 'text', text: 'Kết luận', provider: 'deepseek' },
    ]);
  });

  it('generic: chấp nhận suy luận ở delta.reasoning; thẻ <think> nằm lẫn trong nội dung được giữ nguyên', async () => {
    server.reply({ sse: [chunk({ reasoning: 'suy nghĩ…' }), chunk({ content: '<think>ẩn</think>Đáp án' }), chunk({}, 'stop'), DONE] });
    const { events, done } = await run(generic(), req());
    expect(thinkingOfEvents(events)).toBe('suy nghĩ…');
    expect(textOfEvents(events)).toBe('<think>ẩn</think>Đáp án');
    expect(done.message.content.map((b) => b.type)).toEqual(['thinking', 'text']);
  });
});

describe('stream — yêu cầu gửi đi', () => {
  it('DeepSeek: thinking enabled + reasoning_effort (medium→high), max_tokens, stream_options, khoá Bearer', async () => {
    server.reply({ sse: textStream('ok') });
    await run(deepseek(), req({ model: 'deepseek-v4-pro', maxOutputTokens: 500_000 }));
    const r = server.lastRequest;
    expect(r.path).toBe('/chat/completions');
    expect(r.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(r.json).toMatchObject({
      model: 'deepseek-v4-pro',
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      max_tokens: 393_216, // chặn ở trần của DeepSeek
    });
    expect(r.json.messages[0]).toEqual({ role: 'system', content: 'Bạn là trợ lý.' });
    expect(r.json).not.toHaveProperty('tool_choice');
  });

  it("DeepSeek: mức suy luận 'max' → reasoning_effort max; 'low' → low", async () => {
    server.reply({ sse: textStream('ok') });
    await run(deepseek(), req({ thinking: { level: 'max', summaries: true } }));
    expect(server.lastRequest.json.reasoning_effort).toBe('max');
    server.reply({ sse: textStream('ok') });
    await run(deepseek(), req({ thinking: { level: 'low', summaries: true } }));
    expect(server.lastRequest.json.reasoning_effort).toBe('low');
  });

  it('DeepSeek tắt suy luận → thinking disabled, không reasoning_effort', async () => {
    server.reply({ sse: textStream('ok') });
    await run(deepseek(), req({ thinking: { level: 'off', summaries: false } }));
    const body = server.lastRequest.json;
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('công cụ ở dạng function; parallel_tool_calls:false chỉ khi bị tắt', async () => {
    server.reply({ sse: textStream('ok') });
    await run(deepseek(), req({ tools: [searchTool] }));
    expect(server.lastRequest.json.tools[0]).toEqual({ type: 'function', function: { name: 'web_search', description: 'Tìm trên web', parameters: searchTool.inputSchema } });
    expect(server.lastRequest.json).not.toHaveProperty('parallel_tool_calls');
    server.reply({ sse: textStream('ok') });
    await run(deepseek(), req({ tools: [searchTool], parallelToolCalls: false }));
    expect(server.lastRequest.json.parallel_tool_calls).toBe(false);
  });

  it('generic: max_tokens + reasoning_effort (max→high), không có thinking', async () => {
    server.reply({ sse: textStream('ok') });
    await run(generic(), req({ model: 'meta/llama', thinking: { level: 'max', summaries: true } }));
    const body = server.lastRequest.json;
    expect(body.max_tokens).toBe(1000);
    expect(body.reasoning_effort).toBe('high');
    expect(body).not.toHaveProperty('thinking');
  });
});

describe('stream — công cụ', () => {
  it('một lệnh gọi: tool_start (id+tên ở chunk đầu) → các mảnh đối số → tool_end; đối số được parse chặt', async () => {
    server.reply({
      sse: [chunk({ role: 'assistant', content: null }), ...toolCallChunks(0, 'call_1', 'web_search', '{"que', 'ry":"giá ', 'vàng"}'), chunk({}, 'tool_calls'), DONE],
    });
    const { events, done } = await run(deepseek(), req({ tools: [searchTool] }));
    expect(kinds(events).filter((k) => k !== 'usage')).toEqual(['tool_start', 'tool_args_delta', 'tool_args_delta', 'tool_args_delta', 'tool_end', 'done']);
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({ id: 'call_1', name: 'web_search' });
    expect(done.stopReason).toBe('tool_use');
    expect(done.message.content[0]).toEqual({ type: 'tool_use', id: 'call_1', name: 'web_search', input: { query: 'giá vàng' }, provider: 'deepseek' });
  });

  it('gọi song song: tool_end của lệnh 0 phát ngay khi lệnh 1 bắt đầu', async () => {
    server.reply({
      sse: [...toolCallChunks(0, 'call_a', 'web_search', '{"query":"A"}'), ...toolCallChunks(1, 'call_b', 'web_search', '{"query":"B"}'), chunk({}, 'tool_calls'), DONE],
    });
    const { events, done } = await run(deepseek(), req({ tools: [searchTool] }));
    const seq = events.filter((e) => ['tool_start', 'tool_end'].includes(e.type)).map((e: any) => `${e.type}:${e.id}`);
    expect(seq).toEqual(['tool_start:call_a', 'tool_end:call_a', 'tool_start:call_b', 'tool_end:call_b']);
    expect(done.message.content.filter((b) => b.type === 'tool_use')).toHaveLength(2);
  });

  it('server gửi cả cụm một chunk, thiếu index và id → tự sinh id', async () => {
    server.reply({ sse: [chunk({ tool_calls: [{ type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }] }, 'tool_calls'), DONE] });
    const { events, done } = await run(generic(), req({ tools: [searchTool] }));
    const start = events.find((e) => e.type === 'tool_start') as any;
    expect(start.id).toMatch(/^call_/);
    expect(done.message.content[0]).toMatchObject({ type: 'tool_use', id: start.id, input: { query: 'x' } });
  });

  it('lớp tương thích gửi mọi lệnh gọi với index 0 nhưng id khác nhau → tách thành hai lệnh', async () => {
    server.reply({
      sse: [
        chunk({ tool_calls: [{ index: 0, id: 'g1', type: 'function', function: { name: 'web_search', arguments: '{"query":"A"}' } }] }),
        chunk({ tool_calls: [{ index: 0, id: 'g2', type: 'function', function: { name: 'web_search', arguments: '{"query":"B"}' } }] }),
        chunk({}, 'tool_calls'),
        DONE,
      ],
    });
    const { done } = await run(generic(), req({ tools: [searchTool] }));
    const uses = done.message.content.filter((b) => b.type === 'tool_use') as any[];
    expect(uses.map((u) => [u.id, u.input.query])).toEqual([['g1', 'A'], ['g2', 'B']]);
  });

  it("Ollama báo finish_reason 'stop' dù có tool_calls → vẫn là tool_use", async () => {
    server.reply({ sse: [...toolCallChunks(0, 'call_o', 'web_search', '{"query":"x"}'), chunk({}, 'stop'), DONE] });
    const { done } = await run(generic(), req({ tools: [searchTool] }));
    expect(done.stopReason).toBe('tool_use');
  });

  it('đối số bị cắt vì length → parseError + stopReason max_tokens', async () => {
    server.reply({ sse: [...toolCallChunks(0, 'call_1', 'write_file', '{"path":"a.ts","content":"abc'), chunk({}, 'length'), DONE] });
    const { done } = await run(deepseek(), req({ tools: [searchTool] }));
    expect(done.stopReason).toBe('max_tokens');
    expect((done.message.content[0] as any).parseError).toBeTruthy();
  });

  it.each([
    ['length', 'max_tokens'],
    ['content_filter', 'content_filter'],
    ['stop', 'end_turn'],
  ])('finish_reason %s → %s', async (finish, mapped) => {
    server.reply({ sse: [chunk({ content: 'x' }), chunk({}, finish), DONE] });
    expect((await run(deepseek(), req())).done.stopReason).toBe(mapped);
  });

  it('không có finish_reason nhưng có [DONE] → suy ra end_turn', async () => {
    server.reply({ sse: [chunk({ content: 'x' }), DONE] });
    expect((await run(generic(), req())).done.stopReason).toBe('end_turn');
  });
});

describe('lỗi & thử lại', () => {
  it('finish_reason insufficient_system_resource trước nội dung → thử lại rồi thành công', async () => {
    server.reply({ sse: [chunk({}, 'insufficient_system_resource'), DONE] });
    server.reply({ sse: textStream('lần hai') });
    const { events } = await run(deepseek(), req());
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
    expect(textOfEvents(events)).toBe('lần hai');
  });

  it('401 → auth, không lộ khoá', async () => {
    server.reply({ status: 401, json: { error: { message: `Authentication Fails, key ${TEST_KEY}`, type: 'authentication_error' } } });
    const err: any = await run(deepseek(), req()).catch((e) => e);
    expect(err).toMatchObject({ kind: 'auth', retryable: false });
    expect(JSON.stringify([err.message, err.details])).not.toContain(TEST_KEY);
  });

  it('402 hết số dư → không thử lại', async () => {
    server.reply({ status: 402, json: { error: { message: 'Insufficient Balance' } } });
    await expect(run(deepseek(), req())).rejects.toMatchObject({ kind: 'rate_limit', retryable: false });
    expect(server.requests).toHaveLength(1);
  });

  it('429 kèm retry-after-ms → retry rồi thành công', async () => {
    server.reply({ status: 429, headers: { 'retry-after-ms': '3' }, json: { error: { message: 'slow' } } });
    server.reply({ sse: textStream('ok') });
    const { events } = await run(deepseek(), req());
    expect(events[0]).toMatchObject({ type: 'retry', attempt: 1 });
  });

  it('lỗi nằm trong luồng ({error:{…}}) → ProviderError', async () => {
    server.reply({ sse: [{ data: { error: { message: 'Server overloaded', code: 503 } } }] });
    server.replyAlways({ sse: [{ data: { error: { message: 'Server overloaded', code: 503 } } }] });
    await expect(run(deepseek(), req())).rejects.toMatchObject({ kind: 'overloaded' });
  });

  it('luồng không có dữ liệu → server (retryable)', async () => {
    server.replyAlways({ sse: [DONE] });
    await expect(run(generic(), req())).rejects.toMatchObject({ kind: 'server' });
  });

  it('hủy giữa chừng → aborted', async () => {
    server.reply({ sse: [chunk({ content: 'Đang viết' })], keepOpen: true });
    const ctrl = new AbortController();
    let error: any;
    try {
      for await (const e of generic().stream(req({ signal: ctrl.signal }))) {
        if (e.type === 'text_delta') ctrl.abort();
      }
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ kind: 'aborted' });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.lastRequest.clientClosed).toBe(true);
  });

  it('DeepSeek không có khoá → auth, không gọi mạng', async () => {
    await expect(run(deepseek({ getApiKey: async () => undefined }), req())).rejects.toMatchObject({ kind: 'auth' });
    expect(server.requests).toHaveLength(0);
  });
});

describe('server cục bộ không cần khoá (Ollama, LM Studio)', () => {
  it('không có khoá → không gửi Authorization nhưng vẫn gọi được', async () => {
    server.reply({ sse: textStream('xin chào') });
    const p = generic({ id: 'ollama', getApiKey: async () => undefined });
    const { events } = await run(p, req());
    expect(textOfEvents(events)).toBe('xin chào');
    expect(server.lastRequest.headers).not.toHaveProperty('authorization');
  });

  it('401 khi không có khoá → thông điệp nói rõ chưa đặt khoá', async () => {
    server.reply({ status: 401, json: { error: { message: 'unauthorized' } } });
    const p = generic({ id: 'hosted', label: 'Dịch vụ X', getApiKey: async () => undefined });
    await expect(run(p, req())).rejects.toThrow(/chưa có khóa nào được đặt/);
  });

  it('options.requiresKey=true và chưa có khoá → auth, không gọi mạng', async () => {
    const p = generic({ getApiKey: async () => undefined, options: { requiresKey: true, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } } });
    await expect(run(p, req())).rejects.toMatchObject({ kind: 'auth' });
    expect(server.requests).toHaveLength(0);
  });
});

describe('hạ cấp thích nghi', () => {
  it("generic: 400 'stream_options' → gọi lại không có và nhớ", async () => {
    server.reply({ status: 400, json: { error: { message: "Unrecognized request argument supplied: stream_options", type: 'invalid_request_error' } } });
    server.reply({ sse: textStream('ok') });
    await run(generic(), req({ model: 'local-model' }));
    expect(server.requests[0].json).toHaveProperty('stream_options');
    expect(server.requests[1].json).not.toHaveProperty('stream_options');
    server.reply({ sse: textStream('ok') });
    await run(generic(), req({ model: 'local-model' }));
    expect(server.requests[2].json).not.toHaveProperty('stream_options');
  });

  it("generic: 'max_tokens' bị từ chối → chuyển sang max_completion_tokens", async () => {
    server.reply({ status: 400, json: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error' } } });
    server.reply({ sse: textStream('ok') });
    await run(generic(), req());
    expect(server.requests[0].json).toHaveProperty('max_tokens');
    expect(server.requests[1].json).not.toHaveProperty('max_tokens');
    expect(server.requests[1].json.max_completion_tokens).toBe(1000);
  });

  it('generic: reasoning_effort không được hỗ trợ → bỏ', async () => {
    server.reply({ status: 400, json: { error: { message: "Unknown parameter: 'reasoning_effort'.", type: 'invalid_request_error' } } });
    server.reply({ sse: textStream('ok') });
    await run(generic(), req());
    expect(server.requests[1].json).not.toHaveProperty('reasoning_effort');
  });

  it('DeepSeek: 400 nhắc tới reasoning_content → gọi lại với suy luận TẮT', async () => {
    server.reply({ status: 400, json: { error: { message: 'Missing reasoning_content in assistant message at index 2', type: 'invalid_request_error' } } });
    server.reply({ sse: textStream('ok') });
    await run(deepseek(), req({ tools: [searchTool] }));
    expect(server.requests[0].json.thinking).toEqual({ type: 'enabled' });
    expect(server.requests[1].json.thinking).toEqual({ type: 'disabled' });
    expect(server.requests[1].json).not.toHaveProperty('reasoning_effort');
    expect(JSON.stringify(server.requests[1].json.messages)).not.toContain('reasoning_content');
  });

  it('400 không nhận ra tham số nào → ném bad_request', async () => {
    server.reply({ status: 400, json: { error: { message: 'Lỗi mơ hồ' } } });
    await expect(run(generic(), req())).rejects.toMatchObject({ kind: 'bad_request' });
    expect(server.requests).toHaveLength(1);
  });
});

describe('chuyển đổi lịch sử (toChatMessages)', () => {
  const asst = (provider: string, text: string, reasoning?: string, calls: Array<{ id: string; name?: string }> = []): ChatMessage => ({
    role: 'assistant',
    provider,
    content: [
      ...(reasoning !== undefined ? [{ type: 'thinking' as const, text: reasoning, provider }] : []),
      ...(text ? [{ type: 'text' as const, text, provider }] : []),
      ...calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name ?? 'web_search', input: { query: 'x' }, provider })),
    ],
  });
  const res = (id: string, content = 'kết quả'): ChatMessage => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: id, name: 'web_search', content }] });

  it('DeepSeek + tools + thinking bật: MỌI tin nhắn assistant mang reasoning_content (rỗng nếu không có)', () => {
    const history = [userText('q1'), asst('deepseek', 'trả lời 1', 'nghĩ 1'), userText('q2'), asst('deepseek', 'trả lời 2'), userText('q3'), asst('anthropic', 'của hãng khác', 'nghĩ khác')];
    const out = toChatMessages('sys', history, { providerId: 'deepseek', echoReasoning: true });
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.reasoning_content)).toEqual(['nghĩ 1', '', '']); // thinking của hãng khác KHÔNG được phát lại
  });

  it('echoReasoning=false → không có trường reasoning_content', () => {
    const out = toChatMessages('sys', [userText('q'), asst('deepseek', 'a', 'nghĩ')], { providerId: 'deepseek', echoReasoning: false });
    expect(JSON.stringify(out)).not.toContain('reasoning_content');
  });

  it('request thật: reasoning_content trên mọi assistant khi có tools; không có khi không có tools', async () => {
    const history: ChatMessage[] = [userText('q1'), asst('deepseek', 'a1', 'r1'), userText('q2')];
    server.reply({ sse: textStream('ok') });
    await run(deepseek(), req({ messages: history, tools: [searchTool] }));
    expect(server.lastRequest.json.messages.filter((m: any) => m.role === 'assistant')[0].reasoning_content).toBe('r1');
    server.reply({ sse: textStream('ok') });
    await run(deepseek(), req({ messages: history, tools: [] }));
    expect(JSON.stringify(server.lastRequest.json.messages)).not.toContain('reasoning_content');
  });

  it('kết quả công cụ → các tin role:tool ĐỨNG TRƯỚC văn bản user; tool_calls đúng định dạng; content null khi chỉ có lệnh gọi', () => {
    const history: ChatMessage[] = [
      userText('q'),
      asst('deepseek', '', undefined, [{ id: 'call_a' }, { id: 'call_b' }]),
      { role: 'user', content: [{ type: 'text', text: 'nhắc thêm' }, { type: 'tool_result', toolUseId: 'call_a', name: 'web_search', content: 'A' }, { type: 'tool_result', toolUseId: 'call_b', name: 'web_search', content: 'B', isError: true }] },
    ];
    const out = toChatMessages('sys', history, { providerId: 'deepseek', echoReasoning: false });
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(out[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
        { id: 'call_b', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
      ],
    });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: 'A' });
    expect(out[5]).toEqual({ role: 'user', content: 'nhắc thêm' });
  });

  it('id lệnh gọi dài bị cắt 40 ký tự nhất quán ở assistant và tool', () => {
    const id = 'toolu_' + 'a'.repeat(60);
    const out = toChatMessages('s', [userText('q'), asst('x', '', undefined, [{ id }]), res(id)], { providerId: 'x', echoReasoning: false });
    const callId = (out[2] as any).tool_calls[0].id;
    expect(callId).toHaveLength(40);
    expect((out[3] as any).tool_call_id).toBe(callId);
  });

  it('ảnh → image_url; tool_use thiếu kết quả được vá', () => {
    const out = toChatMessages(
      'sys',
      [{ role: 'user', content: [{ type: 'text', text: 'xem' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] }, asst('x', '', undefined, [{ id: 'c1' }]), userText('tiếp')],
      { providerId: 'x', echoReasoning: false },
    ) as any[];
    expect(out[1].content).toEqual([{ type: 'text', text: 'xem' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
    expect(out.find((m) => m.role === 'tool').content).toContain('bị gián đoạn');
  });
});

describe('fetchModels / ping / complete', () => {
  it('DeepSeek: danh sách thô, bỏ -exp, nhãn = id', async () => {
    server.reply({ json: { object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash-vision-exp' }] } });
    const models = await deepseek().fetchModels();
    expect(models.map((m) => m.id).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(server.lastRequest.path).toBe('/models');
  });

  it('OpenRouter: dùng name/context_length/top_provider, mới nhất trước, bỏ embedding', async () => {
    server.reply({
      json: {
        data: [
          { id: 'a/old', name: 'Cũ', created: 1_700_000_000, context_length: 8000 },
          { id: 'b/new', name: 'Mới', created: 1_790_000_000, context_length: 200_000, top_provider: { max_completion_tokens: 16_000 } },
          { id: 'c/text-embedding-x', created: 1_800_000_000 },
        ],
      },
    });
    const models = await generic().fetchModels();
    expect(models.map((m) => m.id)).toEqual(['b/new', 'a/old']);
    expect(models[0]).toMatchObject({ label: 'Mới', contextWindow: 200_000, maxOutputTokens: 16_000 });
  });

  it('ping OK / lỗi 401', async () => {
    server.reply({ json: { data: [] } });
    await expect(deepseek().ping()).resolves.toBeUndefined();
    server.reply({ status: 401, json: { error: { message: 'bad' } } });
    await expect(deepseek().ping()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('complete: gom văn bản, tắt suy luận, không công cụ', async () => {
    server.reply({ sse: textStream(' Đang đối chiếu điểm số. ') });
    const text = await deepseek().complete({ model: 'deepseek-flash', system: 's', prompt: 'p', maxOutputTokens: 60 });
    expect(text).toBe('Đang đối chiếu điểm số.');
    const body = server.lastRequest.json;
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('tools');
  });
});
