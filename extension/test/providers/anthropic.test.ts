import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  buildThinkingParams,
  thinkingStyleOf,
  toAnthropicMessages,
} from '../../src/core/providers/anthropic';
import { resetParamMemory } from '../../src/core/providers/http';
import { userText, type ChatMessage, type ProviderEvent } from '../../src/core/types';
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

const provider = (over: Record<string, unknown> = {}) =>
  new AnthropicProvider(runtimeConfig(server, { id: 'anthropic', label: 'Claude', kind: 'anthropic', flavor: 'anthropic', ...over }));

// ── Bộ dựng sự kiện SSE kiểu Anthropic ───────────────────────────────────────
const ev = (type: string, data: Record<string, unknown>): SseEvent => ({ event: type, data: { type, ...data } });
const msgStart = (input = 25, extra: Record<string, unknown> = {}): SseEvent =>
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: input, output_tokens: 1, ...extra } } });
const msgDelta = (stop: string, out = 10, extra: Record<string, unknown> = {}): SseEvent =>
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: out, ...extra } });
const msgStop = (): SseEvent => ev('message_stop', {});
const textBlock = (i: number, ...chunks: string[]): SseEvent[] => [
  ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }),
  ...chunks.map((t) => ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: t } })),
  ev('content_block_stop', { index: i }),
];
const thinkingBlock = (i: number, signature: string, ...chunks: string[]): SseEvent[] => [
  ev('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } }),
  ...chunks.map((t) => ev('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: t } })),
  ev('content_block_delta', { index: i, delta: { type: 'signature_delta', signature } }),
  ev('content_block_stop', { index: i }),
];
const toolBlock = (i: number, id: string, name: string, ...json: string[]): SseEvent[] => [
  ev('content_block_start', { index: i, content_block: { type: 'tool_use', id, name, input: {} } }),
  ...json.map((j) => ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: j } })),
  ev('content_block_stop', { index: i }),
];
const okStream = (...blocks: SseEvent[][]): SseEvent[] => [msgStart(), ...blocks.flat(), msgDelta('end_turn'), msgStop()];

describe('thinkingStyleOf / buildThinkingParams', () => {
  it('phân loại kiểu suy luận theo id model', () => {
    expect(thinkingStyleOf('claude-fable-5-1')).toBe('always-on');
    expect(thinkingStyleOf('claude-mythos-5-1')).toBe('always-on');
    expect(thinkingStyleOf('claude-opus-5-5')).toBe('always-on');
    expect(thinkingStyleOf('claude-sonnet-5-5')).toBe('sonnet-5-5');
    expect(thinkingStyleOf('claude-haiku-5-5')).toBe('adaptive');
    expect(thinkingStyleOf('claude-opus-5')).toBe('adaptive');
    expect(thinkingStyleOf('claude-sonnet-5')).toBe('adaptive');
    expect(thinkingStyleOf('claude-opus-4-8')).toBe('adaptive');
    expect(thinkingStyleOf('claude-opus-4-7')).toBe('adaptive');
    expect(thinkingStyleOf('claude-opus-4-6')).toBe('adaptive');
    expect(thinkingStyleOf('claude-sonnet-4-6')).toBe('adaptive');
    expect(thinkingStyleOf('claude-haiku-4-5')).toBe('budget');
    expect(thinkingStyleOf('claude-haiku-4-5-20251001')).toBe('budget');
    expect(thinkingStyleOf('claude-sonnet-4-5')).toBe('budget');
    expect(thinkingStyleOf('claude-opus-4-5-20251101')).toBe('budget');
    expect(thinkingStyleOf('claude-opus-4-1')).toBe('budget');
    expect(thinkingStyleOf('claude-3-7-sonnet-20250219')).toBe('budget');
    expect(thinkingStyleOf('claude-zeta-9')).toBe('always-on'); // id tương lai → hành vi mới nhất, an toàn nhất
  });

  it('always-on: bật = adaptive + effort; tắt = chỉ effort thấp (không bao giờ disabled/budget)', () => {
    expect(buildThinkingParams('claude-opus-5-5', 'high', true, 8000)).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
    });
    const off = buildThinkingParams('claude-opus-5-5', 'off', true, 8000);
    expect(off.thinking).toBeUndefined();
    expect(off.effort).toBe('low');
  });

  it('không xin tóm tắt → không gửi display', () => {
    expect(buildThinkingParams('claude-opus-5-5', 'medium', false, 8000).thinking).toEqual({ type: 'adaptive' });
  });

  it("sonnet-5-5: tắt = between_tools (không có trường nào khác)", () => {
    expect(buildThinkingParams('claude-sonnet-5-5', 'off', true, 8000)).toMatchObject({ thinking: { type: 'between_tools' }, effort: 'low' });
  });

  it('haiku-5-5 / opus-5: tắt = disabled', () => {
    expect(buildThinkingParams('claude-haiku-5-5', 'off', false, 8000).thinking).toEqual({ type: 'disabled' });
    expect(buildThinkingParams('claude-opus-5', 'off', false, 8000).thinking).toEqual({ type: 'disabled' });
  });

  it('dòng cũ: enabled + budget_tokens (2k/8k/24k), < max_tokens, kèm beta interleaved', () => {
    const t = (lvl: 'low' | 'medium' | 'high') => buildThinkingParams('claude-haiku-4-5', lvl, true, 64000);
    expect(t('low').thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(t('medium').thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(t('high').thinking).toEqual({ type: 'enabled', budget_tokens: 24576 });
    expect(t('low').interleavedBeta).toBe(true);
    expect(t('low').effort).toBeUndefined();
    // budget luôn nhỏ hơn max_tokens
    expect(buildThinkingParams('claude-haiku-4-5', 'high', true, 4000).thinking).toEqual({ type: 'enabled', budget_tokens: 3999 });
    // max_tokens quá nhỏ để chứa budget tối thiểu 1024 → bỏ suy luận
    expect(buildThinkingParams('claude-haiku-4-5', 'high', true, 1000).thinking).toBeUndefined();
    // Claude 3.x không có interleaved
    expect(buildThinkingParams('claude-3-7-sonnet-20250219', 'low', true, 8000).interleavedBeta).toBe(false);
  });
});

describe('stream — văn bản & suy luận', () => {
  it('stream văn bản tiếng Việt qua mọi kiểu cắt byte, kèm usage gồm cả cache', async () => {
    const text = ['Nguyễn Thị ', 'Thuỷ Tiên đã ', 'cấu hình tệp ₫ ✓'];
    server.reply({
      chunkBytes: 7,
      sse: [msgStart(100, { cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }), ...textBlock(0, ...text), msgDelta('end_turn', 33, { output_tokens_details: { thinking_tokens: 12 } }), msgStop()],
    });
    const { events, done } = await run(provider(), req({ model: 'claude-opus-5-5' }));
    expect(textOfEvents(events)).toBe(text.join(''));
    expect(done.stopReason).toBe('end_turn');
    expect(done.message).toMatchObject({ role: 'assistant', provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(done.message.content).toEqual([{ type: 'text', text: text.join(''), provider: 'anthropic' }]);
    // inputTokens = input + cache đọc + cache ghi
    expect(done.usage).toEqual({ inputTokens: 160, outputTokens: 33, cacheReadTokens: 50, cacheWriteTokens: 10, reasoningTokens: 12 });
    expect(events.filter((e) => e.type === 'usage').length).toBeGreaterThanOrEqual(1);
    expect(kinds(events).at(-1)).toBe('done');
  });

  it('thinking_delta + signature → ThinkingBlock có chữ ký, gắn provider', async () => {
    server.reply({ sse: okStream(thinkingBlock(0, 'SIG-xyz', 'Đang xem ', 'xét vấn đề'), textBlock(1, 'Kết luận')) });
    const { events, done } = await run(provider(), req({ model: 'claude-opus-5-5' }));
    expect(thinkingOfEvents(events)).toBe('Đang xem xét vấn đề');
    expect(done.message.content[0]).toEqual({ type: 'thinking', text: 'Đang xem xét vấn đề', signature: 'SIG-xyz', provider: 'anthropic' });
    expect(done.message.content[1]).toMatchObject({ type: 'text', text: 'Kết luận' });
  });

  it('redacted_thinking được giữ để phát lại', async () => {
    server.reply({
      sse: okStream([ev('content_block_start', { index: 0, content_block: { type: 'redacted_thinking', data: 'ENC123' } }), ev('content_block_stop', { index: 0 })], textBlock(1, 'ok')),
    });
    const { done } = await run(provider(), req());
    expect(done.message.content[0]).toMatchObject({ type: 'thinking', text: '', redactedData: 'ENC123', provider: 'anthropic' });
  });

  it('thinking bị ẩn (display omitted): khối rỗng nhưng vẫn có chữ ký', async () => {
    server.reply({ sse: okStream(thinkingBlock(0, 'SIG-only'), textBlock(1, 'x')) });
    const { done } = await run(provider(), req());
    expect(done.message.content[0]).toMatchObject({ type: 'thinking', text: '', signature: 'SIG-only' });
  });
});

describe('stream — yêu cầu gửi đi', () => {
  it('opus-5-5: adaptive + display + effort, KHÔNG temperature/top_p/top_k, header khoá, stream:true', async () => {
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(provider(), req({ model: 'claude-opus-5-5', thinking: { level: 'medium', summaries: true } }));
    const r = server.lastRequest;
    expect(r.path).toBe('/v1/messages');
    // SDK 1.x: Authorization Bearer; host không chính thức: gửi thêm x-api-key cho gateway tương thích.
    expect(r.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(r.headers['x-api-key']).toBe(TEST_KEY);
    expect(r.json).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 1000,
      stream: true,
      system: 'Bạn là trợ lý.',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
    });
    for (const k of ['temperature', 'top_p', 'top_k']) expect(r.json).not.toHaveProperty(k);
    // máy chủ giả không phải anthropic.com → không bật auto-cache
    expect(r.json).not.toHaveProperty('cache_control');
  });

  it('haiku-4-5 (dòng cũ): budget_tokens + header beta interleaved, không output_config', async () => {
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(provider(), req({ model: 'claude-haiku-4-5', maxOutputTokens: 30000, thinking: { level: 'high', summaries: true } }));
    const r = server.lastRequest;
    expect(r.json.thinking).toEqual({ type: 'enabled', budget_tokens: 24576 });
    expect(r.json).not.toHaveProperty('output_config');
    expect(r.headers['anthropic-beta']).toContain('interleaved-thinking-2025-05-14');
  });

  it('sonnet-5-5 tắt suy luận → between_tools', async () => {
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(provider(), req({ model: 'claude-sonnet-5-5', thinking: { level: 'off', summaries: false } }));
    expect(server.lastRequest.json.thinking).toEqual({ type: 'between_tools' });
  });

  it('công cụ: input_schema + eager_input_streaming chỉ khi eagerInput', async () => {
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(provider(), req({ tools: [searchTool, { ...searchTool, name: 'write_file', eagerInput: true }] }));
    const tools = server.lastRequest.json.tools;
    expect(tools[0]).toMatchObject({ name: 'web_search', input_schema: { type: 'object' } });
    expect(tools[0]).not.toHaveProperty('eager_input_streaming');
    expect(tools[1].eager_input_streaming).toBe(true);
  });

  it('tuỳ chọn eagerInputStreaming=false tắt hẳn trường này', async () => {
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    const p = new AnthropicProvider(runtimeConfig(server, { id: 'anthropic', kind: 'anthropic', flavor: 'anthropic', options: { eagerInputStreaming: false, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } } }));
    await run(p, req({ tools: [{ ...searchTool, eagerInput: true }] }));
    expect(server.lastRequest.json.tools[0]).not.toHaveProperty('eager_input_streaming');
  });

  it('parallelToolCalls=false → disable_parallel_tool_use', async () => {
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(provider(), req({ tools: [searchTool], parallelToolCalls: false }));
    expect(server.lastRequest.json.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('host chính thức của Anthropic mới bật cache_control tự động', async () => {
    // Dùng fetch giả để tránh gọi ra ngoài thật.
    let body: any;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      const text = [msgStart(), ...textBlock(0, 'ok'), msgDelta('end_turn'), msgStop()]
        .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
        .join('');
      return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const p = new AnthropicProvider({ ...runtimeConfig(server, { id: 'anthropic', kind: 'anthropic', flavor: 'anthropic' }), baseUrl: 'https://api.anthropic.com', fetchImpl });
    await run(p, req({ model: 'claude-opus-5-5' }));
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('stream — công cụ', () => {
  it('một lệnh gọi: tool_start → tool_args_delta… → tool_end, đối số được JSON.parse chặt', async () => {
    server.reply({
      sse: [msgStart(), ...toolBlock(0, 'toolu_1', 'web_search', '{"que', 'ry":"giá vàng ', 'hôm nay"}'), msgDelta('tool_use'), msgStop()],
    });
    const { events, done } = await run(provider(), req({ tools: [searchTool] }));
    expect(kinds(events).filter((k) => k !== 'usage')).toEqual(['tool_start', 'tool_args_delta', 'tool_args_delta', 'tool_args_delta', 'tool_end', 'done']);
    const args = events.filter((e): e is Extract<ProviderEvent, { type: 'tool_args_delta' }> => e.type === 'tool_args_delta').map((e) => e.delta).join('');
    expect(args).toBe('{"query":"giá vàng hôm nay"}');
    expect(done.stopReason).toBe('tool_use');
    expect(done.message.content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'giá vàng hôm nay' }, provider: 'anthropic' }]);
  });

  it('gọi song song 2 công cụ', async () => {
    server.reply({
      sse: [msgStart(), ...textBlock(0, 'Tôi sẽ tìm.'), ...toolBlock(1, 'toolu_a', 'web_search', '{"query":"A"}'), ...toolBlock(2, 'toolu_b', 'web_search', '{"query":"B"}'), msgDelta('tool_use'), msgStop()],
    });
    const { events, done } = await run(provider(), req({ tools: [searchTool] }));
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(2);
    expect(done.message.content.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_use']);
    expect(done.message.content.filter((b) => b.type === 'tool_use').map((b) => (b as any).input.query)).toEqual(['A', 'B']);
  });

  it('công cụ không tham số (không có input_json_delta) → input {}', async () => {
    server.reply({ sse: [msgStart(), ...toolBlock(0, 'toolu_z', 'list_artifact_types'), msgDelta('tool_use'), msgStop()] });
    const { done } = await run(provider(), req({ tools: [searchTool] }));
    expect(done.message.content[0]).toMatchObject({ type: 'tool_use', input: {} });
    expect((done.message.content[0] as any).parseError).toBeUndefined();
  });

  it('đối số JSON hỏng → parseError + rawArgs (engine báo lại cho model, không chạy tool)', async () => {
    server.reply({ sse: [msgStart(), ...toolBlock(0, 'toolu_1', 'write_file', '{"path":"a.ts","content":"abc'), msgDelta('max_tokens'), msgStop()] });
    const { done } = await run(provider(), req({ tools: [searchTool] }));
    expect(done.stopReason).toBe('max_tokens');
    const b = done.message.content[0] as any;
    expect(b.parseError).toBeTruthy();
    expect(b.rawArgs).toBe('{"path":"a.ts","content":"abc');
    expect(b.input).toEqual({});
  });

  it.each([
    ['end_turn', 'end_turn'],
    ['stop_sequence', 'end_turn'],
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['pause_turn', 'pause_turn'],
    ['model_context_window_exceeded', 'max_tokens'],
  ])('stop_reason %s → %s', async (raw, mapped) => {
    server.reply({ sse: [msgStart(), ...textBlock(0, 'x'), msgDelta(raw), msgStop()] });
    const { done } = await run(provider(), req());
    expect(done.stopReason).toBe(mapped);
  });
});

describe('chuyển đổi lịch sử', () => {
  const sig = (text = '', signature = 'SIG1'): ChatMessage['content'][number] => ({ type: 'thinking', text, signature, provider: 'anthropic' });

  it('tool_result nhóm trong một tin user, đứng TRƯỚC văn bản; ảnh dạng base64', () => {
    const history: ChatMessage[] = [
      userText('hỏi'),
      {
        role: 'assistant',
        provider: 'anthropic',
        content: [
          { type: 'tool_use', id: 'a', name: 't', input: { x: 1 }, provider: 'anthropic' },
          { type: 'tool_use', id: 'b', name: 't', input: { x: 2 }, provider: 'anthropic' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'nhắc thêm' },
          { type: 'image', mediaType: 'image/png', data: 'AAAA' },
          { type: 'tool_result', toolUseId: 'a', name: 't', content: 'A' },
          { type: 'tool_result', toolUseId: 'b', name: 't', content: 'B', isError: true },
        ],
      },
    ];
    const out = toAnthropicMessages(history, {});
    const last = out[2] as any;
    expect(last.role).toBe('user');
    expect(last.content.map((b: any) => b.type)).toEqual(['tool_result', 'tool_result', 'text', 'image']);
    expect(last.content[1]).toMatchObject({ tool_use_id: 'b', is_error: true });
    expect(last.content[3]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  });

  it('phát lại thinking của chính Anthropic (kèm chữ ký) và bỏ thinking của hãng khác', () => {
    const history: ChatMessage[] = [
      userText('q'),
      {
        role: 'assistant',
        content: [
          sig('suy nghĩ', 'SIG-A'),
          { type: 'thinking', text: 'của hãng khác', provider: 'openai', raw: { id: 'rs_1' } },
          { type: 'thinking', text: '', redactedData: 'ENC', provider: 'anthropic' },
          { type: 'text', text: 'trả lời' },
        ],
      },
      userText('tiếp'),
    ];
    const asst = (toAnthropicMessages(history, {})[1] as any).content;
    expect(asst).toEqual([
      { type: 'thinking', thinking: 'suy nghĩ', signature: 'SIG-A' },
      { type: 'redacted_thinking', data: 'ENC' },
      { type: 'text', text: 'trả lời' },
    ]);
  });

  it('historyEdited → bỏ HẾT thinking/redacted_thinking', () => {
    const history: ChatMessage[] = [
      userText('q'),
      { role: 'assistant', content: [sig('a'), { type: 'thinking', text: '', redactedData: 'ENC', provider: 'anthropic' }, { type: 'text', text: 'ok' }] },
      userText('tiếp'),
    ];
    const asst = (toAnthropicMessages(history, { historyEdited: true })[1] as any).content;
    expect(asst).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('id công cụ lạ được làm sạch nhất quán ở cả tool_use lẫn tool_result', () => {
    const history: ChatMessage[] = [
      userText('q'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call.1:x/ê', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call.1:x/ê', name: 't', content: 'ok' }] },
    ];
    const out = toAnthropicMessages(history, {}) as any[];
    const useId = out[1].content[0].id;
    expect(useId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(out[2].content[0].tool_use_id).toBe(useId);
  });

  it('bỏ text rỗng/khoảng trắng; kết thúc bằng assistant thì thêm lời nhắc tiếp tục', () => {
    const out = toAnthropicMessages([userText('q'), { role: 'assistant', content: [{ type: 'text', text: '   ' }, { type: 'text', text: 'ok' }] }], {}) as any[];
    expect(out[1].content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(out[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Hãy tiếp tục.' }] });
  });

  it('tool_use thiếu kết quả được vá bằng kết quả lỗi (tránh 400)', () => {
    const out = toAnthropicMessages([userText('q'), { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] }, userText('tiếp')], {}) as any[];
    expect(out[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'a', is_error: true });
  });

  it('request thật mang đúng cấu trúc tin nhắn', async () => {
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(
      provider(),
      req({
        model: 'claude-opus-5-5',
        messages: [
          userText('q'),
          { role: 'assistant', provider: 'anthropic', content: [sig('nghĩ', 'S1'), { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'x' }, provider: 'anthropic' }] },
          { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_1', name: 'web_search', content: 'kết quả' }] },
        ],
        tools: [searchTool],
      }),
    );
    const msgs = server.lastRequest.json.messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[1].content[0]).toMatchObject({ type: 'thinking', signature: 'S1' });
    expect(msgs[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'kết quả' });
  });

  it('req.historyEdited làm request bỏ thinking cũ', async () => {
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(
      provider(),
      req({
        historyEdited: true,
        messages: [userText('q'), { role: 'assistant', content: [sig('nghĩ'), { type: 'text', text: 'a' }] }, userText('tiếp')],
      }),
    );
    expect(JSON.stringify(server.lastRequest.json.messages)).not.toContain('thinking');
  });
});

describe('lỗi & thử lại', () => {
  const errBody = (type: string, message: string) => ({ type: 'error', error: { type, message } });

  it('401 → auth, không thử lại, thông điệp tiếng Việt, không lộ khoá', async () => {
    server.reply({ status: 401, json: errBody('authentication_error', `invalid x-api-key ${TEST_KEY}`) });
    const err: any = await run(provider(), req()).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProviderError', kind: 'auth', status: 401, retryable: false });
    expect(err.message).toBe('Khóa API không hợp lệ hoặc đã bị thu hồi.');
    expect(JSON.stringify(err.details)).not.toContain(TEST_KEY);
    expect(server.requests).toHaveLength(1);
  });

  it('429 kèm retry-after-ms → phát sự kiện retry rồi thành công', async () => {
    server.reply({ status: 429, headers: { 'retry-after-ms': '3' }, json: errBody('rate_limit_error', 'slow down') });
    server.reply({ sse: okStream(textBlock(0, 'xong')) });
    const { events } = await run(provider(), req());
    expect(kinds(events)[0]).toBe('retry');
    expect(events[0]).toMatchObject({ type: 'retry', attempt: 1, maxAttempts: 3 });
    expect(textOfEvents(events)).toBe('xong');
    expect(server.requests).toHaveLength(2);
  });

  it('529 quá tải 2 lần rồi thành công', async () => {
    server.reply({ status: 529, json: errBody('overloaded_error', 'Overloaded') });
    server.reply({ status: 529, json: errBody('overloaded_error', 'Overloaded') });
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    const { events } = await run(provider(), req());
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2);
  });

  it('400 vượt ngữ cảnh → context_length, không thử lại', async () => {
    server.reply({ status: 400, json: errBody('invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum') });
    await expect(run(provider(), req())).rejects.toMatchObject({ kind: 'context_length', retryable: false });
    expect(server.requests).toHaveLength(1);
  });

  it('sự kiện error giữa luồng TRƯỚC khi có nội dung → thử lại', async () => {
    server.reply({ sse: [msgStart(), ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })] });
    server.reply({ sse: okStream(textBlock(0, 'lần hai')) });
    const { events } = await run(provider(), req());
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
    expect(textOfEvents(events)).toBe('lần hai');
  });

  it('sự kiện error SAU khi đã có nội dung → ném lỗi, không thử lại', async () => {
    server.reply({ sse: [msgStart(), ...textBlock(0, 'Xin chào'), ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })] });
    const got: ProviderEvent[] = [];
    let error: any;
    try {
      for await (const e of provider().stream(req())) got.push(e);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ kind: 'overloaded' });
    expect(textOfEvents(got)).toBe('Xin chào');
    expect(server.requests).toHaveLength(1);
  });

  it('hủy giữa chừng → ProviderError aborted và máy chủ thấy kết nối bị đóng', async () => {
    server.reply({ sse: [msgStart(), ...textBlock(0, 'Đang ', 'viết ')].slice(0, 4), keepOpen: true });
    const ctrl = new AbortController();
    const gen = provider().stream(req({ signal: ctrl.signal }));
    let error: any;
    try {
      for await (const e of gen) {
        if (e.type === 'text_delta') ctrl.abort();
      }
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ name: 'ProviderError', kind: 'aborted' });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.lastRequest.clientClosed).toBe(true);
  });

  it('chưa có khoá → auth, không gọi mạng', async () => {
    const p = provider({ getApiKey: async () => undefined });
    await expect(run(p, req())).rejects.toMatchObject({ kind: 'auth' });
    expect(server.requests).toHaveLength(0);
  });

  it('không kết nối được → network (retry tới hết số lần)', async () => {
    const p = new AnthropicProvider({ ...runtimeConfig(server, { id: 'anthropic', kind: 'anthropic', flavor: 'anthropic' }), baseUrl: 'http://127.0.0.1:1' });
    const err: any = await run(p, req()).catch((e) => e);
    expect(err.name).toBe('ProviderError');
    expect(['network', 'timeout']).toContain(err.kind);
  });
});

describe('hạ cấp thích nghi', () => {
  it('400 vì output_config → gọi lại không có effort, và nhớ cho các lượt sau', async () => {
    server.reply({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'output_config: Extra inputs are not permitted' } } });
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(provider(), req({ model: 'claude-opus-5-5' }));
    expect(server.requests[0].json).toHaveProperty('output_config');
    expect(server.requests[1].json).not.toHaveProperty('output_config');

    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(provider(), req({ model: 'claude-opus-5-5' }));
    expect(server.requests[2].json).not.toHaveProperty('output_config');
  });

  it('400 vì eager_input_streaming → bỏ trường đó', async () => {
    server.reply({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'tools.0.eager_input_streaming: Extra inputs are not permitted' } } });
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(provider(), req({ tools: [{ ...searchTool, eagerInput: true }] }));
    expect(server.requests[0].json.tools[0].eager_input_streaming).toBe(true);
    expect(server.requests[1].json.tools[0]).not.toHaveProperty('eager_input_streaming');
  });

  it('model lạ sai kiểu suy luận: server đòi budget_tokens → đổi sang enabled', async () => {
    server.reply({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'thinking.type: adaptive is not supported for this model; use enabled with budget_tokens' } } });
    server.reply({ sse: okStream(textBlock(0, 'ok')) });
    await run(provider(), req({ model: 'claude-zeta-9', maxOutputTokens: 20000 }));
    expect(server.requests[0].json.thinking.type).toBe('adaptive');
    expect(server.requests[1].json.thinking.type).toBe('enabled');
  });
});

describe('complete / fetchModels / ping', () => {
  it('complete: gọi không stream, haiku-5-5 → thinking disabled', async () => {
    server.reply({ json: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: ' Đang đối chiếu điểm số. ' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } } });
    const text = await provider().complete({ model: 'claude-haiku-5-5', system: 's', prompt: 'p', maxOutputTokens: 50 });
    expect(text).toBe('Đang đối chiếu điểm số.');
    const body = server.lastRequest.json;
    expect(body.stream).not.toBe(true);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.messages).toEqual([{ role: 'user', content: 'p' }]);
  });

  it('complete với model luôn bật suy luận: effort low, không có thinking', async () => {
    server.reply({ json: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
    await provider().complete({ model: 'claude-opus-5-5', system: 's', prompt: 'p', maxOutputTokens: 50 });
    const body = server.lastRequest.json;
    expect(body).not.toHaveProperty('thinking');
    expect(body.output_config).toEqual({ effort: 'low' });
  });

  it('complete: hết thời gian chờ → ProviderError timeout', async () => {
    server.reply({ delayMs: 400, json: { content: [] } });
    await expect(provider().complete({ model: 'claude-haiku-5-5', system: 's', prompt: 'p', maxOutputTokens: 50, timeoutMs: 60 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('fetchModels: ánh xạ trường, bỏ model đã retired, đánh dấu deprecated, bậc theo dòng', async () => {
    const m = (id: string, line: string, lifecycle: string, extra: Record<string, unknown> = {}) => ({
      type: 'model', id, display_name: `Tên ${id}`, created_at: '2026-08-01T00:00:00Z', lifecycle, line, max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { thinking: { supported: true }, image_input: { supported: true } }, ...extra,
    });
    server.reply({
      json: {
        data: [m('claude-opus-5-5', 'opus', 'active'), m('claude-haiku-5-5', 'haiku', 'active'), m('claude-sonnet-5-5', 'sonnet', 'active'), m('claude-old-1', 'sonnet', 'retired'), m('claude-dep-1', 'opus', 'deprecated')],
        has_more: false,
        first_id: 'a',
        last_id: 'b',
      },
    });
    const models = await provider().fetchModels();
    expect(models.map((x) => x.id)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-dep-1']);
    expect(models[0]).toMatchObject({ label: 'Tên claude-opus-5-5', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true, vision: true, tier: 'top' });
    expect(models[1].tier).toBe('fast');
    expect(models[2].tier).toBe('balanced');
    expect(models[3].note).toBeTruthy();
    expect(server.lastRequest.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('ping: gọi danh sách 1 model; lỗi 401 → ProviderError auth', async () => {
    server.reply({ json: { data: [], has_more: false, first_id: null, last_id: null } });
    await expect(provider().ping()).resolves.toBeUndefined();
    server.reply({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'bad' } } });
    await expect(provider().ping()).rejects.toMatchObject({ kind: 'auth' });
  });
});
