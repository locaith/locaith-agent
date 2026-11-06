/**
 * Kiểm thử các lỗi độ đúng tìm thấy khi rà soát: lượt tổng kết cuối, đối số công cụ hỏng, trần token đầu ra,
 * luồng đứt giữa chừng, phát lại item Responses khi không có reasoning, chữ ký Gemini, cắt chuỗi UTF-16.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../../src/core/providers/anthropic';
import { GeminiProvider } from '../../src/core/providers/gemini';
import { parseOutputLimit, rememberedOutputCap, requestJson, resetParamMemory } from '../../src/core/providers/http';
import { OpenAIChatProvider } from '../../src/core/providers/openaiChat';
import { OpenAIResponsesProvider, toResponsesInput } from '../../src/core/providers/openaiResponses';
import { sliceSafe, wellFormed, wellFormedDeep } from '../../src/core/textSafe';
import { truncateForModel } from '../../src/core/engine/dispatcher';
import { ProviderError, userText, type ChatMessage, type ToolUseBlock } from '../../src/core/types';
import { MockServer, type SseEvent } from '../helpers/mockServer';
import { TEST_KEY, req, run, runtimeConfig, searchTool } from './util';

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

const anthropic = () => new AnthropicProvider(runtimeConfig(server, { id: 'anthropic', kind: 'anthropic', flavor: 'anthropic' }));
const openai = () => new OpenAIResponsesProvider(runtimeConfig(server, { id: 'openai', kind: 'openai-responses', flavor: 'openai' }));
const generic = () => new OpenAIChatProvider(runtimeConfig(server, { id: 'gw', kind: 'openai-chat', flavor: 'generic' }));
const gemini = () => new GeminiProvider(runtimeConfig(server, { id: 'gemini', kind: 'gemini', flavor: 'gemini' }));

const anthropicOk = (text = 'ok'): SseEvent[] => [
  ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }),
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  ev('content_block_stop', { index: 0 }),
  ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  ev('message_stop'),
];

/** Lịch sử có một vòng công cụ hoàn chỉnh. */
const toolHistory = (provider: string): ChatMessage[] => [
  userText('tìm giúp'),
  { role: 'assistant', provider, content: [{ type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'x' }, provider }] },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_1', name: 'web_search', content: 'kết quả' }] },
];

describe('Anthropic: lượt tổng kết cuối (hết maxTurns)', () => {
  it('toolChoice none → vẫn gửi đủ tools và tool_choice {type:none}', async () => {
    server.reply({ sse: anthropicOk() });
    await run(anthropic(), req({ model: 'claude-opus-5-5', messages: toolHistory('anthropic'), tools: [searchTool], toolChoice: 'none' }));
    const body = server.requests[0].json;
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toEqual({ type: 'none' });
  });

  it('lịch sử có tool_use mà tools rỗng → dựng định nghĩa rỗng cho tên đã dùng và cấm gọi (tránh 400 "must define tools")', async () => {
    server.reply({ sse: anthropicOk() });
    await run(anthropic(), req({ model: 'claude-opus-5-5', messages: toolHistory('anthropic'), tools: [] }));
    const body = server.requests[0].json;
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['web_search']);
    expect(body.tool_choice).toEqual({ type: 'none' });
  });

  it('không có công cụ nào trong lịch sử và tools rỗng → không gửi tools', async () => {
    server.reply({ sse: anthropicOk() });
    await run(anthropic(), req({ model: 'claude-opus-5-5', tools: [] }));
    expect(server.requests[0].json.tools).toBeUndefined();
    expect(server.requests[0].json.tool_choice).toBeUndefined();
  });
});

describe('Anthropic: đối số công cụ stream bị hỏng', () => {
  const toolStream = (json: string): SseEvent[] => [
    ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_9', name: 'web_search', input: {} } }),
    ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: json } }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
    ev('message_stop'),
  ];

  it.each([
    ['dấu phẩy thừa ở cuối', '{"query": "a",}'],
    ['thiếu dấu phẩy', '{"query": "a" "x": 1}'],
    ['xuống dòng thô trong chuỗi', '{"query": "dòng 1\ndòng 2"}'],
  ])('%s → parseError cho model sửa lại, KHÔNG làm hỏng cả lượt', async (_name, json) => {
    server.reply({ sse: toolStream(json) });
    const { done } = await run(anthropic(), req({ model: 'claude-opus-5-5', tools: [searchTool] }));
    expect(done.stopReason).toBe('tool_use');
    const call = done.message.content.find((b): b is ToolUseBlock => b.type === 'tool_use')!;
    expect(call.id).toBe('toolu_9');
    expect(call.parseError).toBeTruthy();
    expect(call.rawArgs).toBe(json);
  });

  it('đối số hợp lệ vẫn được parse bình thường', async () => {
    server.reply({ sse: toolStream('{"query": "xin chào"}') });
    const { done } = await run(anthropic(), req({ model: 'claude-opus-5-5', tools: [searchTool] }));
    const call = done.message.content.find((b): b is ToolUseBlock => b.type === 'tool_use')!;
    expect(call.parseError).toBeUndefined();
    expect(call.input).toEqual({ query: 'xin chào' });
  });
});

describe('trần token đầu ra vượt giới hạn model', () => {
  it('parseOutputLimit đọc đúng thông điệp của từng hãng', () => {
    expect(parseOutputLimit('max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-3-haiku')).toBe(8192);
    expect(parseOutputLimit('max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.')).toBe(16384);
    expect(parseOutputLimit('Invalid max_tokens value, the valid range of max_tokens is [1, 8192]')).toBe(8192);
    expect(parseOutputLimit('max_tokens must be less than or equal to 4096')).toBe(4096);
    expect(parseOutputLimit('Unsupported parameter: max_tokens is not supported with this model. Use max_completion_tokens instead.')).toBeUndefined();
    expect(parseOutputLimit('Invalid API key')).toBeUndefined();
    expect(rememberedOutputCap(new Set(['maxcap=8192', 'maxcap=4096', 'other']))).toBe(4096);
  });

  it('Anthropic: 400 nêu giới hạn → gọi lại với max_tokens đúng giới hạn và nhớ cho lần sau', async () => {
    server.reply({
      status: 400,
      json: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-test' } },
    });
    server.reply({ sse: anthropicOk() });
    await run(anthropic(), req({ model: 'claude-test', maxOutputTokens: 32000 }));
    expect(server.requests[0].json.max_tokens).toBe(32000);
    expect(server.requests[1].json.max_tokens).toBe(8192);

    server.reply({ sse: anthropicOk() });
    await run(anthropic(), req({ model: 'claude-test', maxOutputTokens: 32000 }));
    expect(server.requests[2].json.max_tokens).toBe(8192);
  });

  it('OpenAI-compatible: 400 nêu giới hạn → gọi lại với max_tokens nhỏ hơn', async () => {
    server.reply({
      status: 400,
      json: { error: { message: 'max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.' } },
    });
    server.reply({ sse: [{ data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] } }, { data: '[DONE]' }] });
    await run(generic(), req({ model: 'gw-model', maxOutputTokens: 32000 }));
    expect(server.requests[1].json.max_tokens).toBe(16384);
  });

  it('thông điệp về ngữ cảnh ("maximum context length is 128000 tokens") không bị nhầm là trần đầu ra', async () => {
    server.reply({ status: 400, json: { error: { message: "This model's maximum context length is 128000 tokens. However, you requested 150000 tokens" } } });
    await expect(run(generic(), req({ model: 'gw-model', maxOutputTokens: 32000 }))).rejects.toBeInstanceOf(ProviderError);
    expect(server.requests).toHaveLength(1); // không gọi lại vô ích
  });
});

describe('luồng đứt giữa chừng không được coi là câu trả lời hoàn chỉnh', () => {
  it('OpenAI chat: không finish_reason, không [DONE], không usage → lỗi mạng có thể thử lại', async () => {
    for (let i = 0; i < 5; i++) server.reply({ sse: [{ data: { choices: [{ index: 0, delta: { content: 'câu bị cụt' } }] } }] });
    await expect(run(generic(), req({ model: 'gw-model' }))).rejects.toThrow(/ngắt giữa chừng/);
  });

  it('OpenAI Responses: có item xong nhưng thiếu response.completed → lỗi mạng', async () => {
    for (let i = 0; i < 5; i++) {
      server.reply({
        sse: [
          ev('response.output_text.delta', { output_index: 0, delta: 'một phần' }),
          ev('response.output_item.done', { output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'một phần' }] } }),
        ],
      });
    }
    await expect(run(openai(), req({ model: 'gpt-test' }))).rejects.toThrow(/ngắt giữa chừng/);
  });

  it('Gemini: không có finishReason → lỗi mạng', async () => {
    for (let i = 0; i < 5; i++) server.reply({ sse: [{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'dở dang' }] } }] } }] });
    await expect(run(gemini(), req({ model: 'gemini-2.5-flash' }))).rejects.toThrow(/ngắt giữa chừng/);
  });
});

describe('toolChoice none ở các adapter khác', () => {
  it('OpenAI chat → tool_choice "none"', async () => {
    server.reply({ sse: [{ data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] } }, { data: '[DONE]' }] });
    await run(generic(), req({ model: 'gw-model', tools: [searchTool], toolChoice: 'none' }));
    expect(server.requests[0].json.tool_choice).toBe('none');
  });

  it('OpenAI Responses → tool_choice "none"', async () => {
    server.reply({
      sse: [ev('response.completed', { response: { status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } } })],
    });
    await run(openai(), req({ model: 'gpt-test', tools: [searchTool], toolChoice: 'none' }));
    expect(server.requests[0].json.tool_choice).toBe('none');
  });

  it('Gemini → functionCallingConfig.mode NONE', async () => {
    server.reply({ sse: [{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }] });
    await run(gemini(), req({ model: 'gemini-2.5-flash', tools: [searchTool], toolChoice: 'none' }));
    expect(server.requests[0].json.toolConfig.functionCallingConfig.mode).toBe('NONE');
  });
});

describe('OpenAI Responses: phát lại item khi không còn reasoning đi kèm', () => {
  const history = (withReasoning: boolean): ChatMessage[] => [
    userText('hỏi'),
    {
      role: 'assistant',
      provider: 'openai',
      content: [
        ...(withReasoning ? [{ type: 'thinking' as const, text: 'nghĩ', provider: 'openai', raw: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] } }] : []),
        { type: 'text', text: 'trả lời', provider: 'openai', raw: { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'trả lời' }] } },
        { type: 'tool_use', id: 'call_1', name: 'web_search', input: { query: 'x' }, provider: 'openai', raw: { type: 'function_call', id: 'fc_1', status: 'completed', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', name: 'web_search', content: 'kq' }] },
  ];

  it('còn reasoning → giữ nguyên item thô kèm id (cặp reasoning/function_call đi cùng nhau)', () => {
    const items = toResponsesInput(history(true), 'openai');
    expect(items.find((i) => i.type === 'reasoning')).toBeTruthy();
    const fc = items.find((i) => i.type === 'function_call')!;
    expect(fc.id).toBe('fc_1');
    expect(items.some((i) => i.type === 'message' && i.id === 'msg_1')).toBe(true);
  });

  it('không còn reasoning (đã nén/cắt tỉa) → bỏ id/status của function_call và dùng tin nhắn assistant dạng văn bản', () => {
    const items = toResponsesInput(history(false), 'openai');
    expect(items.some((i) => i.type === 'reasoning')).toBe(false);
    const fc = items.find((i) => i.type === 'function_call')!;
    expect(fc.id).toBeUndefined();
    expect(fc.status).toBeUndefined();
    expect(fc.call_id).toBe('call_1');
    expect(items.some((i) => i.type === 'message')).toBe(false);
    expect(items.some((i) => i.role === 'assistant' && i.content === 'trả lời')).toBe(true);
  });

  it('400 "provided without its required reasoning item" → gọi lại không kèm reasoning/id, KHÔNG xoá reasoning.effort vĩnh viễn', async () => {
    server.reply({
      status: 400,
      json: { error: { message: "Item 'fc_1' of type 'function_call' was provided without its required 'reasoning' item: 'rs_1'.", type: 'invalid_request_error' } },
    });
    server.reply({
      sse: [ev('response.completed', { response: { status: 'completed', output: [{ type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } } })],
    });
    await run(openai(), req({ model: 'gpt-test', messages: history(true) }));
    expect(server.requests[1].json.input.some((i: { type?: string }) => i.type === 'reasoning')).toBe(false);
    const fc = server.requests[1].json.input.find((i: { type?: string }) => i.type === 'function_call');
    expect(fc.id).toBeUndefined();
    expect(server.requests[1].json.reasoning).toBeTruthy(); // reasoning.effort vẫn còn
  });
});

describe('Gemini: lỗi chữ ký không bị nhầm là lỗi cấu hình suy luận', () => {
  it('"Corrupted thought signature" → không gọi lại với thinkingConfig bị xoá', async () => {
    server.reply({ status: 400, json: { error: { code: 400, message: 'Corrupted thought signature.', status: 'INVALID_ARGUMENT' } } });
    await expect(run(gemini(), req({ model: 'gemini-2.5-flash' }))).rejects.toBeInstanceOf(ProviderError);
    expect(server.requests).toHaveLength(1);
  });

  it('lỗi thật về thinkingConfig vẫn được hạ cấp', async () => {
    server.reply({ status: 400, json: { error: { code: 400, message: 'thinking_budget is not supported for this model', status: 'INVALID_ARGUMENT' } } });
    server.reply({ sse: [{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }] });
    await run(gemini(), req({ model: 'gemini-2.5-flash' }));
    expect(server.requests[1].json.generationConfig.thinkingConfig).toBeUndefined();
  });
});

describe('requestJson: thân phản hồi thành công không bị cắt', () => {
  it('đọc trọn danh sách model > 64 KB', async () => {
    const big = { data: Array.from({ length: 4000 }, (_, i) => ({ id: `model-${i}`, name: 'x'.repeat(40) })) };
    expect(JSON.stringify(big).length).toBeGreaterThan(150_000);
    server.reply({ json: big });
    const out = await requestJson<typeof big>({ providerId: 'p', fetchImpl: fetch, secrets: [TEST_KEY] }, `${server.url}/models`, { method: 'GET' });
    expect(out.data).toHaveLength(4000);
  });
});

describe('chuỗi UTF-16: không bao giờ để lại nửa cặp thay thế', () => {
  const emoji = '😀'; // cặp thay thế: 2 đơn vị mã
  const lone = (s: string) => wellFormed(s) !== s;

  it('sliceSafe lùi/tiến khi biên rơi giữa cặp', () => {
    const s = 'ab' + emoji + 'cd';
    expect(sliceSafe(s, 0, 3)).toBe('ab'); // cắt giữa emoji → bỏ cả emoji
    expect(sliceSafe(s, 3)).toBe('cd'); // bắt đầu giữa emoji → bỏ nửa sau
    expect(sliceSafe(s, 0, 4)).toBe('ab' + emoji);
    expect(sliceSafe(s, -3)).toBe('cd'); // -3 rơi vào nửa sau của emoji → bỏ nửa mồ côi
    expect(lone(sliceSafe(s, 0, 3))).toBe(false);
  });

  it('wellFormed / wellFormedDeep thay nửa cặp mồ côi bằng U+FFFD', () => {
    const broken = 'x' + emoji.slice(0, 1) + 'y';
    expect(wellFormed(broken)).toBe('x�y');
    expect(wellFormed('Việt Nam 😀')).toBe('Việt Nam 😀');
    const deep = wellFormedDeep({ a: [broken, { b: broken }], n: 1 });
    expect(JSON.stringify(deep)).not.toMatch(/\\ud8/i);
  });

  it('truncateForModel không cắt đôi emoji ở biên cắt', () => {
    // pad dịch biên cắt phần đầu; hậu tố 'b' đổi tính chẵn lẻ của biên cắt phần đuôi → cả hai phía đều từng rơi giữa cặp.
    for (const suffix of ['', 'b']) {
      for (let pad = 0; pad < 4; pad++) {
        const text = 'a'.repeat(23_998 + pad) + emoji.repeat(40_000) + suffix;
        const out = truncateForModel(text);
        expect(out.length).toBeLessThan(text.length);
        expect(lone(out), `pad=${pad} suffix=${suffix}`).toBe(false);
      }
    }
  });

  it('thân yêu cầu gửi nhà cung cấp không chứa nửa cặp mồ côi', async () => {
    server.reply({ sse: anthropicOk() });
    const broken = 'trước ' + emoji.slice(0, 1) + ' sau';
    await run(anthropic(), req({ model: 'claude-opus-5-5', messages: [userText(broken)] }));
    expect(JSON.stringify(server.requests[0].json)).not.toMatch(/\\ud8/i);
  });
});
