import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetParamMemory } from '../../src/core/providers/http';
import {
  OpenAIResponsesProvider,
  dropOrphanReasoning,
  initialEffort,
  toResponsesInput,
} from '../../src/core/providers/openaiResponses';
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

const openai = (over: Record<string, unknown> = {}) =>
  new OpenAIResponsesProvider(runtimeConfig(server, { id: 'openai', label: 'ChatGPT', kind: 'openai-responses', flavor: 'openai', ...over }));
const xai = (over: Record<string, unknown> = {}) =>
  new OpenAIResponsesProvider(runtimeConfig(server, { id: 'xai', label: 'Grok', kind: 'openai-responses', flavor: 'xai', ...over }));

// ── Bộ dựng sự kiện Responses API ────────────────────────────────────────────
type Item = Record<string, any>;
const ev = (type: string, data: Record<string, unknown> = {}): SseEvent => ({ event: type, data: { type, ...data } });

const msgItem = (idx: number, text: string): Item => ({
  type: 'message', id: `msg_${idx}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }],
});
const reasoningItem = (id: string, summary: string[], enc = 'ENC-' + id): Item => ({
  type: 'reasoning', id, summary: summary.map((text) => ({ type: 'summary_text', text })), encrypted_content: enc,
});
const fnItem = (idx: number, callId: string, name: string, args: string): Item => ({
  type: 'function_call', id: `fc_${idx}`, call_id: callId, name, arguments: args, status: 'completed',
});

/** Sinh luồng sự kiện cho danh sách item đầu ra, rồi response.completed. */
function streamOf(items: Item[], opts: { usage?: Record<string, unknown>; whole?: boolean; status?: string; incompleteReason?: string; split?: number } = {}): SseEvent[] {
  const out: SseEvent[] = [ev('response.created', { response: { id: 'resp_1', status: 'in_progress' } })];
  items.forEach((it, i) => {
    if (it.type === 'message') {
      out.push(ev('response.output_item.added', { output_index: i, item: { ...it, status: 'in_progress', content: [] } }));
      const text: string = it.content[0].text;
      const cut = opts.split ?? Math.ceil(text.length / 2);
      for (const chunk of [text.slice(0, cut), text.slice(cut)].filter(Boolean)) {
        out.push(ev('response.output_text.delta', { output_index: i, content_index: 0, item_id: it.id, delta: chunk }));
      }
      out.push(ev('response.output_item.done', { output_index: i, item: it }));
    } else if (it.type === 'reasoning') {
      out.push(ev('response.output_item.added', { output_index: i, item: { type: 'reasoning', id: it.id, summary: [] } }));
      (it.summary as Item[]).forEach((s, si) => {
        out.push(ev('response.reasoning_summary_part.added', { output_index: i, summary_index: si, part: { type: 'summary_text', text: '' } }));
        out.push(ev('response.reasoning_summary_text.delta', { output_index: i, summary_index: si, delta: s.text }));
        out.push(ev('response.reasoning_summary_text.done', { output_index: i, summary_index: si, text: s.text }));
      });
      out.push(ev('response.output_item.done', { output_index: i, item: it }));
    } else if (it.type === 'function_call') {
      if (opts.whole) {
        // xAI: không có added/delta — nguyên cụm chỉ xuất hiện khi item hoàn tất
        out.push(ev('response.output_item.done', { output_index: i, item: it }));
      } else {
        out.push(ev('response.output_item.added', { output_index: i, item: { ...it, arguments: '', status: 'in_progress' } }));
        const args: string = it.arguments;
        const cut = Math.ceil(args.length / 2);
        for (const chunk of [args.slice(0, cut), args.slice(cut)].filter(Boolean)) {
          out.push(ev('response.function_call_arguments.delta', { output_index: i, item_id: it.id, delta: chunk }));
        }
        out.push(ev('response.function_call_arguments.done', { output_index: i, item_id: it.id, arguments: args }));
        out.push(ev('response.output_item.done', { output_index: i, item: it }));
      }
    }
  });
  const final: Record<string, unknown> = {
    id: 'resp_1',
    status: opts.status ?? 'completed',
    output: items,
    usage: opts.usage ?? { input_tokens: 100, output_tokens: 40, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 15 } },
  };
  if (opts.incompleteReason) final.incomplete_details = { reason: opts.incompleteReason };
  out.push(ev(opts.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: final }));
  return out;
}

describe('initialEffort', () => {
  it('OpenAI: off → none, max → max', () => {
    expect(['off', 'low', 'medium', 'high', 'max'].map((l) => initialEffort('openai', 'gpt-6-astra', l as any))).toEqual(['none', 'low', 'medium', 'high', 'max']);
  });
  it('xAI: không tắt được suy luận (off → low), max → xhigh', () => {
    expect(['off', 'low', 'medium', 'high', 'max'].map((l) => initialEffort('xai', 'grok-4.7', l as any))).toEqual(['low', 'low', 'medium', 'high', 'xhigh']);
  });
  it('model non-reasoning → không có reasoning', () => {
    expect(initialEffort('xai', 'grok-4.20-0309-non-reasoning', 'high')).toBeUndefined();
  });
});

describe('stream — văn bản & suy luận', () => {
  it('văn bản tiếng Việt qua mọi kiểu cắt byte + usage (cache, reasoning)', async () => {
    const text = 'Nguyễn Thị Thuỷ Tiên đã cấu hình tệp ₫ — ướ ữ ặ ổ ệ ✓';
    server.reply({ chunkBytes: 5, sse: streamOf([msgItem(0, text)], { split: 11 }) });
    const { events, done } = await run(openai(), req({ model: 'gpt-6.1-sol' }));
    expect(textOfEvents(events)).toBe(text);
    expect(done.stopReason).toBe('end_turn');
    expect(done.usage).toEqual({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 30, reasoningTokens: 15 });
    expect(done.message).toMatchObject({ role: 'assistant', provider: 'openai', model: 'gpt-6.1-sol' });
    const block = done.message.content[0] as any;
    expect(block).toMatchObject({ type: 'text', text, provider: 'openai' });
    expect(block.raw).toMatchObject({ type: 'message', id: 'msg_0' }); // item thô để phát lại
    expect(kinds(events).at(-1)).toBe('done');
  });

  it('tóm tắt suy luận → thinking_delta (ngắt đoạn) + khối thinking mang item mã hoá', async () => {
    server.reply({ sse: streamOf([reasoningItem('rs_1', ['Đối chiếu phiên bản chỉ số.', 'Chọn một phiên bản.']), msgItem(1, 'Xong')]) });
    const { events, done } = await run(openai(), req());
    expect(thinkingOfEvents(events)).toBe('Đối chiếu phiên bản chỉ số.\n\nChọn một phiên bản.');
    const th = done.message.content[0] as any;
    expect(th).toMatchObject({ type: 'thinking', text: 'Đối chiếu phiên bản chỉ số.\n\nChọn một phiên bản.', provider: 'openai' });
    expect(th.raw).toMatchObject({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC-rs_1' });
  });
});

describe('stream — yêu cầu gửi đi', () => {
  it('OpenAI: instructions, store:false, include, effort+summary, parallel_tool_calls, strict:false', async () => {
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(openai(), req({ model: 'gpt-6.1-sol', tools: [searchTool], sessionKey: 'sess-1', maxOutputTokens: 32000 }));
    const r = server.lastRequest;
    expect(r.path).toBe('/responses');
    expect(r.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(r.json).toMatchObject({
      model: 'gpt-6.1-sol',
      instructions: 'Bạn là trợ lý.',
      store: false,
      stream: true,
      max_output_tokens: 32000,
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'medium', summary: 'auto' },
      prompt_cache_key: 'sess-1',
    });
    expect(r.json.tools[0]).toEqual({ type: 'function', name: 'web_search', description: 'Tìm trên web', parameters: searchTool.inputSchema, strict: false });
    expect(r.json.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'Xin chào' }] }]);
  });

  it('OpenAI tắt suy luận → effort none, không summary', async () => {
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(openai(), req({ model: 'gpt-6-luna', thinking: { level: 'off', summaries: true } }));
    expect(server.lastRequest.json.reasoning).toEqual({ effort: 'none' });
  });

  it('xAI: không summary, không strict, off → low, max → xhigh', async () => {
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(xai(), req({ model: 'grok-4.7', tools: [searchTool], thinking: { level: 'max', summaries: true } }));
    const body = server.lastRequest.json;
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
    expect(body.tools[0]).not.toHaveProperty('strict');
    expect(body).not.toHaveProperty('prompt_cache_key');
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(xai(), req({ model: 'grok-4.7', thinking: { level: 'off', summaries: false } }));
    expect(server.lastRequest.json.reasoning).toEqual({ effort: 'low' });
  });

  it('xAI model non-reasoning → không gửi reasoning', async () => {
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(xai(), req({ model: 'grok-4.20-0309-non-reasoning' }));
    expect(server.lastRequest.json).not.toHaveProperty('reasoning');
  });

  it('flavor generic (Responses tương thích): không include/summary/strict', async () => {
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    const p = new OpenAIResponsesProvider(runtimeConfig(server, { id: 'litellm', kind: 'openai-responses', flavor: 'generic' }));
    await run(p, req({ tools: [searchTool] }));
    const body = server.lastRequest.json;
    expect(body).not.toHaveProperty('include');
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.tools[0]).not.toHaveProperty('strict');
  });
});

describe('stream — công cụ', () => {
  it('OpenAI stream đối số từng mảnh; raw giữ nguyên item function_call', async () => {
    const call = fnItem(0, 'call_abc', 'web_search', '{"query":"giá vàng hôm nay"}');
    server.reply({ sse: streamOf([call]) });
    const { events, done } = await run(openai(), req({ tools: [searchTool] }));
    expect(kinds(events).filter((k) => k !== 'usage')).toEqual(['tool_start', 'tool_args_delta', 'tool_args_delta', 'tool_end', 'done']);
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({ id: 'call_abc', name: 'web_search' });
    const args = events.filter((e): e is Extract<ProviderEvent, { type: 'tool_args_delta' }> => e.type === 'tool_args_delta').map((e) => e.delta).join('');
    expect(args).toBe('{"query":"giá vàng hôm nay"}');
    expect(done.stopReason).toBe('tool_use');
    const b = done.message.content[0] as any;
    expect(b).toMatchObject({ type: 'tool_use', id: 'call_abc', name: 'web_search', input: { query: 'giá vàng hôm nay' }, provider: 'openai' });
    expect(b.raw).toMatchObject({ type: 'function_call', id: 'fc_0', call_id: 'call_abc' });
  });

  it('gọi song song 2 công cụ (kèm reasoning đứng trước)', async () => {
    server.reply({ sse: streamOf([reasoningItem('rs_1', ['Cần tra hai nguồn.']), fnItem(1, 'call_a', 'web_search', '{"query":"A"}'), fnItem(2, 'call_b', 'web_search', '{"query":"B"}')]) });
    const { events, done } = await run(openai(), req({ tools: [searchTool] }));
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(2);
    expect(done.message.content.map((b) => b.type)).toEqual(['thinking', 'tool_use', 'tool_use']);
    expect(done.stopReason).toBe('tool_use');
  });

  it('xAI giao nguyên cụm (chỉ có output_item.done) → tool_start + MỘT args delta + tool_end', async () => {
    server.reply({ sse: streamOf([fnItem(0, 'call_x', 'web_search', '{"query":"Grok"}')], { whole: true }) });
    const { events, done } = await run(xai(), req({ model: 'grok-4.7', tools: [searchTool] }));
    expect(kinds(events).filter((k) => k !== 'usage')).toEqual(['tool_start', 'tool_args_delta', 'tool_end', 'done']);
    expect((events.find((e) => e.type === 'tool_args_delta') as any).delta).toBe('{"query":"Grok"}');
    expect(done.message.content[0]).toMatchObject({ type: 'tool_use', input: { query: 'Grok' } });
  });

  it('xAI: output_item.added đã chứa đủ đối số → vẫn đúng một args delta', async () => {
    const call = fnItem(0, 'call_x', 'web_search', '{"query":"Grok"}');
    server.reply({
      sse: [
        ev('response.output_item.added', { output_index: 0, item: call }),
        ev('response.output_item.done', { output_index: 0, item: call }),
        ev('response.completed', { response: { status: 'completed', output: [call], usage: { input_tokens: 1, output_tokens: 1 } } }),
      ],
    });
    const { events } = await run(xai(), req({ tools: [searchTool] }));
    expect(events.filter((e) => e.type === 'tool_args_delta')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(1);
  });

  it('đối số hỏng → parseError + rawArgs', async () => {
    server.reply({ sse: streamOf([fnItem(0, 'call_1', 'write_file', '{"path":"a.ts","content":"abc')], { status: 'incomplete', incompleteReason: 'max_output_tokens' }) });
    const { done } = await run(openai(), req({ tools: [searchTool] }));
    expect(done.stopReason).toBe('max_tokens');
    const b = done.message.content[0] as any;
    expect(b.parseError).toBeTruthy();
    expect(b.rawArgs).toBe('{"path":"a.ts","content":"abc');
  });
});

describe('stream — lý do dừng & lỗi trong luồng', () => {
  it('incomplete: max_output_tokens → max_tokens; content_filter → content_filter', async () => {
    server.reply({ sse: streamOf([msgItem(0, 'cụt')], { status: 'incomplete', incompleteReason: 'max_output_tokens' }) });
    expect((await run(openai(), req())).done.stopReason).toBe('max_tokens');
    server.reply({ sse: streamOf([msgItem(0, 'x')], { status: 'incomplete', incompleteReason: 'content_filter' }) });
    expect((await run(openai(), req())).done.stopReason).toBe('content_filter');
  });

  it('response.failed (rate_limit_exceeded) trước nội dung → thử lại rồi thành công', async () => {
    server.reply({ sse: [ev('response.created', {}), ev('response.failed', { response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } } })] });
    server.reply({ sse: streamOf([msgItem(0, 'lần hai')]) });
    const { events } = await run(openai(), req());
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
    expect(textOfEvents(events)).toBe('lần hai');
  });

  it('sự kiện error giữa luồng (server_error) sau nội dung → ném lỗi, không thử lại', async () => {
    server.reply({
      sse: [ev('response.output_text.delta', { output_index: 0, delta: 'Xin chào' }), ev('error', { code: 'server_error', message: 'boom' })],
    });
    const got: ProviderEvent[] = [];
    let error: any;
    try {
      for await (const e of openai().stream(req())) got.push(e);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ kind: 'server' });
    expect(textOfEvents(got)).toBe('Xin chào');
    expect(server.requests).toHaveLength(1);
  });

  it('response.failed vì vượt ngữ cảnh → context_length', async () => {
    server.reply({ sse: [ev('response.failed', { response: { error: { code: 'context_length_exceeded', message: "This model's maximum context length is 1050000 tokens" } } })] });
    await expect(run(openai(), req())).rejects.toMatchObject({ kind: 'context_length' });
  });

  it('luồng đóng sớm không có response.completed → network (retryable)', async () => {
    server.replyAlways({ sse: [ev('response.created', {})] });
    const err: any = await run(openai(), req()).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProviderError', kind: 'network' });
  });

  it('hủy giữa chừng → aborted và đóng kết nối', async () => {
    server.reply({ sse: [ev('response.output_text.delta', { output_index: 0, delta: 'Đang viết' })], keepOpen: true });
    const ctrl = new AbortController();
    let error: any;
    try {
      for await (const e of openai().stream(req({ signal: ctrl.signal }))) {
        if (e.type === 'text_delta') ctrl.abort();
      }
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ name: 'ProviderError', kind: 'aborted' });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.lastRequest.clientClosed).toBe(true);
  });
});

describe('hạ cấp thích nghi', () => {
  const badEffort = (msg: string) => ({ status: 400, json: { error: { message: msg, type: 'invalid_request_error', param: 'reasoning.effort', code: 'invalid_value' } } });

  it("GPT-6 Astra từ chối 'none' → chọn mức gần nhất được hỗ trợ ('low') và nhớ cho lượt sau", async () => {
    server.reply(badEffort("Invalid value: 'none'. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'."));
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(openai(), req({ model: 'gpt-6-astra', thinking: { level: 'off', summaries: false } }));
    expect(server.requests[0].json.reasoning.effort).toBe('none');
    expect(server.requests[1].json.reasoning.effort).toBe('low');

    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(openai(), req({ model: 'gpt-6-astra', thinking: { level: 'off', summaries: false } }));
    expect(server.requests[2].json.reasoning.effort).toBe('low'); // đã nhớ → không phải thử sai lần nữa
  });

  it("Sol từ chối 'none'/'minimal' (level off) → 'low'", async () => {
    server.reply(badEffort("Invalid value: 'none'. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'."));
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(openai(), req({ model: 'gpt-6.1-sol', thinking: { level: 'off', summaries: false } }));
    expect(server.requests[1].json.reasoning.effort).toBe('low');
  });

  it("'max' không được hỗ trợ → mức cao nhất còn lại", async () => {
    server.reply(badEffort("Invalid value: 'max'. Supported values are: 'low', 'medium', and 'high'."));
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(openai(), req({ model: 'gpt-5.5', thinking: { level: 'max', summaries: false } }));
    expect(server.requests[1].json.reasoning.effort).toBe('high');
  });

  it('server từ chối reasoning.summary → gọi lại không có summary', async () => {
    server.reply({ status: 400, json: { error: { message: "Unsupported parameter: 'reasoning.summary' is not supported with this model.", type: 'invalid_request_error' } } });
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(openai(), req({ model: 'gpt-6-luna' }));
    expect(server.requests[0].json.reasoning.summary).toBe('auto');
    expect(server.requests[1].json.reasoning).toEqual({ effort: 'medium' });
  });

  it('model không hỗ trợ reasoning → bỏ hẳn tham số reasoning', async () => {
    server.reply({ status: 400, json: { error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", type: 'invalid_request_error' } } });
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    await run(openai(), req({ model: 'gpt-4.1' }));
    expect(server.requests[1].json).not.toHaveProperty('reasoning');
  });

  it("404 \"Item with id 'rs_…' not found\" → thôi phát lại reasoning trong lịch sử", async () => {
    server.reply({ status: 404, json: { error: { message: "Item with id 'rs_1' not found. Items are not persisted when `store` is set to false.", type: 'invalid_request_error' } } });
    server.reply({ sse: streamOf([msgItem(0, 'ok')]) });
    const history: ChatMessage[] = [
      userText('q'),
      { role: 'assistant', provider: 'openai', content: [{ type: 'thinking', text: 'nghĩ', provider: 'openai', raw: reasoningItem('rs_1', ['nghĩ']) }, { type: 'text', text: 'trả lời', provider: 'openai', raw: msgItem(1, 'trả lời') }] },
      userText('tiếp'),
    ];
    await run(openai(), req({ messages: history }));
    expect(JSON.stringify(server.requests[0].json.input)).toContain('rs_1');
    expect(JSON.stringify(server.requests[1].json.input)).not.toContain('"reasoning"');
  });

  it('400 không nhận ra được tham số → ném lỗi bad_request', async () => {
    server.reply({ status: 400, json: { error: { message: 'Lỗi không rõ ràng', type: 'invalid_request_error' } } });
    await expect(run(openai(), req())).rejects.toMatchObject({ kind: 'bad_request' });
    expect(server.requests).toHaveLength(1);
  });
});

describe('chuyển đổi lịch sử (toResponsesInput)', () => {
  const rs = reasoningItem('rs_1', ['nghĩ']);
  const fc = fnItem(1, 'call_1', 'web_search', '{"query":"x"}');
  const ownAssistant: ChatMessage = {
    role: 'assistant',
    provider: 'openai',
    content: [
      { type: 'thinking', text: 'nghĩ', provider: 'openai', raw: rs },
      { type: 'tool_use', id: 'call_1', name: 'web_search', input: { query: 'x' }, provider: 'openai', raw: fc },
    ],
  };
  const resultMsg: ChatMessage = { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', name: 'web_search', content: 'kết quả' }] };

  it('phát lại item thô của chính hãng ĐÚNG thứ tự, rồi function_call_output', () => {
    const input = toResponsesInput([userText('Câu hỏi'), ownAssistant, resultMsg], 'openai');
    expect(input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Câu hỏi' }] },
      rs,
      fc,
      { type: 'function_call_output', call_id: 'call_1', output: 'kết quả' },
    ]);
  });

  it('bản sao: sửa input không làm đổi item gốc trong lịch sử', () => {
    const input = toResponsesInput([userText('q'), ownAssistant, resultMsg], 'openai');
    (input[1] as any).id = 'bi-sua';
    expect((ownAssistant.content[0] as any).raw.id).toBe('rs_1');
  });

  it('khối của hãng khác: bỏ thinking, tool_use → function_call không có id', () => {
    const foreign: ChatMessage = {
      role: 'assistant',
      provider: 'anthropic',
      content: [
        { type: 'thinking', text: 'của Claude', signature: 'S', provider: 'anthropic' },
        { type: 'text', text: 'Để tôi tìm.', provider: 'anthropic' },
        { type: 'tool_use', id: 'toolu_9', name: 'web_search', input: { query: 'y' }, provider: 'anthropic' },
      ],
    };
    const res: ChatMessage = { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_9', name: 'web_search', content: 'ok' }] };
    expect(toResponsesInput([userText('q'), foreign, res], 'openai')).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { role: 'assistant', content: 'Để tôi tìm.' },
      { type: 'function_call', call_id: 'toolu_9', name: 'web_search', arguments: '{"query":"y"}' },
      { type: 'function_call_output', call_id: 'toolu_9', output: 'ok' },
    ]);
  });

  it('reasoning mồ côi (phản hồi bị cắt) bị bỏ', () => {
    const truncated: ChatMessage = { role: 'assistant', provider: 'openai', content: [{ type: 'thinking', text: 'nghĩ dở', provider: 'openai', raw: rs }] };
    expect(toResponsesInput([userText('q'), truncated, userText('tiếp')], 'openai')).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'tiếp' }] },
    ]);
    expect(dropOrphanReasoning([rs, { role: 'assistant', content: 'x' }])).toHaveLength(2);
    expect(dropOrphanReasoning([rs])).toHaveLength(0);
  });

  it('ảnh người dùng và ảnh trong kết quả công cụ → input_image data URL', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'xem ảnh' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'screenshot', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', name: 'screenshot', content: 'đã chụp', images: [{ type: 'image', mediaType: 'image/jpeg', data: 'BBBB' }] }] },
    ];
    const input = toResponsesInput(history, 'openai') as any[];
    expect(input[0].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,AAAA' });
    expect(input[2].output).toEqual([{ type: 'input_text', text: 'đã chụp' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB' }]);
  });

  it('tool_use thiếu kết quả được vá; call_id dài bị cắt 64 ký tự nhất quán', () => {
    const longId = 'x'.repeat(80);
    const input = toResponsesInput(
      [userText('q'), { role: 'assistant', content: [{ type: 'tool_use', id: longId, name: 't', input: {} }] }, userText('tiếp')],
      'openai',
    ) as any[];
    const call = input.find((i) => i.type === 'function_call');
    const out = input.find((i) => i.type === 'function_call_output');
    expect(call.call_id).toHaveLength(64);
    expect(out.call_id).toBe(call.call_id);
    expect(out.output).toContain('bị gián đoạn');
  });
});

describe('fetchModels / ping', () => {
  const data = [
    { id: 'gpt-6-astra', created: 1_780_000_000 },
    { id: 'gpt-6.1-sol', created: 1_790_000_000 },
    { id: 'gpt-6-luna', created: 1_785_000_000 },
    { id: 'gpt-6-astra-2026-05-01', created: 1_780_000_001 },
    { id: 'text-embedding-4-large', created: 1_790_000_000 },
    { id: 'gpt-image-2', created: 1_790_000_000 },
    { id: 'gpt-6-realtime', created: 1_790_000_000 },
    { id: 'whisper-2', created: 1_790_000_000 },
    { id: 'gpt-6-tts', created: 1_790_000_000 },
    { id: 'dall-e-4', created: 1_790_000_000 },
    { id: 'o9', created: 1_770_000_000 },
    { id: 'babbage-002', created: 1_000_000_000 },
    { id: 'omni-moderation-latest', created: 1_790_000_000 },
  ];

  it('OpenAI: chỉ giữ model trò chuyện, bỏ bản chụp có ngày, mới nhất trước', async () => {
    server.reply({ json: { object: 'list', data } });
    const models = await openai().fetchModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra', 'o9']);
    expect(server.lastRequest.path).toBe('/models');
    expect(server.lastRequest.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('xAI: giữ grok-*, bỏ ảnh/video/multi-agent, mới nhất (theo số phiên bản) trước', async () => {
    server.reply({
      json: {
        data: [
          { id: 'grok-4.5' }, { id: 'grok-4.7' }, { id: 'grok-4.20-0309-reasoning' }, { id: 'grok-4.20-multi-agent-0309' },
          { id: 'grok-imagine-image' }, { id: 'grok-imagine-video' }, { id: 'grok-build-0.1' }, { id: 'grok-4.3' },
        ],
      },
    });
    const models = await xai().fetchModels();
    // "4.20" là bản tháng 3/2026, cũ hơn 4.3 → xếp theo số thập phân (4.2 < 4.3).
    expect(models.map((m) => m.id)).toEqual(['grok-4.7', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-build-0.1']);
  });

  it('401 → ProviderError auth', async () => {
    server.reply({ status: 401, json: { error: { message: 'Incorrect API key provided' } } });
    await expect(openai().fetchModels()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('ping OK và ping lỗi', async () => {
    server.reply({ json: { data: [] } });
    await expect(openai().ping()).resolves.toBeUndefined();
    server.reply({ status: 401, json: { error: { message: 'bad' } } });
    await expect(openai().ping()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('chưa có khoá → auth, không gọi mạng', async () => {
    const p = openai({ getApiKey: async () => undefined });
    await expect(p.fetchModels()).rejects.toMatchObject({ kind: 'auth' });
    await expect(run(p, req())).rejects.toMatchObject({ kind: 'auth' });
    expect(server.requests).toHaveLength(0);
  });
});

describe('complete', () => {
  it('gom văn bản, tắt suy luận, không công cụ', async () => {
    server.reply({ sse: streamOf([msgItem(0, ' Đang viết hàm vẽ bảng. ')]) });
    const text = await openai().complete({ model: 'gpt-6-luna', system: 's', prompt: 'p', maxOutputTokens: 60 });
    expect(text).toBe('Đang viết hàm vẽ bảng.');
    const body = server.lastRequest.json;
    expect(body).not.toHaveProperty('tools');
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'p' }] }]);
  });
});
