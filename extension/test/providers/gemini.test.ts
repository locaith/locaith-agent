import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GeminiProvider,
  SKIP_SIGNATURE,
  buildThinkingConfig,
  geminiFamily,
  sanitizeSchemaForGemini,
  toFunctionDeclarations,
  toGeminiContents,
} from '../../src/core/providers/gemini';
import { resetParamMemory } from '../../src/core/providers/http';
import { selectGeminiModels, type GeminiApiModel } from '../../src/core/providers/modelFilters';
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

const gemini = (over: Record<string, unknown> = {}) =>
  new GeminiProvider(runtimeConfig(server, { id: 'gemini', label: 'Gemini', kind: 'gemini', flavor: 'gemini', ...over }));

// ── Bộ dựng chunk Gemini ─────────────────────────────────────────────────────
const g = (parts: Array<Record<string, unknown>>, extra: { finish?: string; usage?: Record<string, unknown> } = {}): SseEvent => ({
  data: {
    candidates: [{ content: { role: 'model', parts }, index: 0, ...(extra.finish ? { finishReason: extra.finish } : {}) }],
    ...(extra.usage ? { usageMetadata: extra.usage } : {}),
  },
});
const usage = { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7, cachedContentTokenCount: 3, totalTokenCount: 22 };

describe('geminiFamily / buildThinkingConfig', () => {
  it('phân họ model', () => {
    expect(geminiFamily('gemini-2.5-flash')).toBe('g25');
    expect(geminiFamily('models/gemini-2.5-pro')).toBe('g25');
    expect(geminiFamily('gemini-3.8-flash')).toBe('g3');
    expect(geminiFamily('gemini-4-argon')).toBe('g3');
    expect(geminiFamily('gemini-flash-latest')).toBe('g3');
    expect(geminiFamily('gemini-2.0-flash')).toBe('none');
    expect(geminiFamily('gemma-4-31b-it')).toBe('none');
  });

  it('gemini 2.5: thinkingBudget (off=0, pro off=128, max=-1) + includeThoughts khi xin tóm tắt', () => {
    const st = { noThinkingConfig: false };
    expect(buildThinkingConfig('gemini-2.5-flash', 'off', true, st)).toEqual({ thinkingBudget: 0 });
    expect(buildThinkingConfig('gemini-2.5-pro', 'off', true, st)).toEqual({ thinkingBudget: 128 });
    expect(buildThinkingConfig('gemini-2.5-flash', 'low', true, st)).toEqual({ thinkingBudget: 1024, includeThoughts: true });
    expect(buildThinkingConfig('gemini-2.5-flash', 'medium', false, st)).toEqual({ thinkingBudget: 8192 });
    expect(buildThinkingConfig('gemini-2.5-flash', 'high', true, st)).toEqual({ thinkingBudget: 24576, includeThoughts: true });
    expect(buildThinkingConfig('gemini-2.5-flash', 'max', true, st)).toEqual({ thinkingBudget: -1, includeThoughts: true });
  });

  it('gemini 3+: thinkingLevel viết thường (off=minimal, max=high) + includeThoughts', () => {
    const st = { noThinkingConfig: false };
    expect(buildThinkingConfig('gemini-3.8-flash', 'off', true, st)).toEqual({ thinkingLevel: 'minimal' });
    expect(buildThinkingConfig('gemini-3.8-flash', 'low', true, st)).toEqual({ thinkingLevel: 'low', includeThoughts: true });
    expect(buildThinkingConfig('gemini-4-argon', 'medium', true, st)).toEqual({ thinkingLevel: 'medium', includeThoughts: true });
    expect(buildThinkingConfig('gemini-4-argon', 'max', true, st)).toEqual({ thinkingLevel: 'high', includeThoughts: true });
  });

  it('không hỗ trợ / đã bị loại → không có thinkingConfig; override mức được tôn trọng', () => {
    expect(buildThinkingConfig('gemma-4-31b-it', 'high', true, { noThinkingConfig: false })).toBeUndefined();
    expect(buildThinkingConfig('gemini-3.8-flash', 'high', true, { noThinkingConfig: true })).toBeUndefined();
    expect(buildThinkingConfig('gemini-3.8-flash', 'off', true, { noThinkingConfig: false, levelOverride: 'low' })).toEqual({ thinkingLevel: 'low' });
  });
});

describe('sanitizeSchemaForGemini', () => {
  it('rút về tập con OpenAPI: type VIẾT HOA, bỏ additionalProperties/$schema/default/pattern…', () => {
    const out = sanitizeSchemaForGemini({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Đường dẫn', pattern: '^/', default: 'a', minLength: 1 },
        count: { type: 'integer', minimum: 1, maximum: 10, default: 3, format: 'int32' },
        ratio: { type: 'number', format: 'double' },
        url: { type: 'string', format: 'uri' },
        mode: { type: 'string', enum: ['a', 'b'] },
        flag: { type: 'boolean' },
      },
      required: ['path', 'khong-co'],
    });
    expect(out).toEqual({
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Đường dẫn' },
        count: { type: 'INTEGER', format: 'int32' },
        ratio: { type: 'NUMBER', format: 'double' },
        url: { type: 'STRING' }, // format 'uri' không được hỗ trợ → bỏ
        mode: { type: 'STRING', enum: ['a', 'b'] },
        flag: { type: 'BOOLEAN' },
      },
      required: ['path'],
    });
  });

  it('type dạng mảng có null → nullable; oneOf → anyOf; const → enum', () => {
    expect(sanitizeSchemaForGemini({ type: ['string', 'null'] })).toEqual({ type: 'STRING', nullable: true });
    expect(sanitizeSchemaForGemini({ oneOf: [{ type: 'string' }, { type: 'integer' }] })).toEqual({ anyOf: [{ type: 'STRING' }, { type: 'INTEGER' }] });
    expect(sanitizeSchemaForGemini({ const: 'x' })).toEqual({ type: 'STRING', enum: ['x'] });
  });

  it('mảng lồng nhau và enum số trên kiểu không phải chuỗi bị bỏ enum', () => {
    expect(
      sanitizeSchemaForGemini({
        type: 'array',
        minItems: 1,
        items: { type: 'object', properties: { n: { type: 'integer', enum: [1, 2] }, s: { type: 'string', enum: [1, 'b'] } } },
      }),
    ).toEqual({ type: 'ARRAY', minItems: 1, items: { type: 'OBJECT', properties: { n: { type: 'INTEGER' }, s: { type: 'STRING', enum: ['1', 'b'] } } } });
  });

  it('tool không tham số → không có `parameters`', () => {
    const decls = toFunctionDeclarations([
      { name: 'list_artifact_types', description: 'Liệt kê', inputSchema: { type: 'object', properties: {} } },
      searchTool,
    ]);
    expect(decls[0]).toEqual({ name: 'list_artifact_types', description: 'Liệt kê' });
    expect(decls[1].parameters).toMatchObject({ type: 'OBJECT', required: ['query'] });
  });

  it('đầu vào không phải đối tượng → undefined', () => {
    expect(sanitizeSchemaForGemini(null)).toBeUndefined();
    expect(sanitizeSchemaForGemini('x')).toBeUndefined();
  });
});

describe('stream — văn bản & suy luận', () => {
  it('văn bản tiếng Việt qua mọi kiểu cắt byte + usage (thoughts tính vào đầu ra)', async () => {
    const parts = ['Nguyễn Thị ', 'Thuỷ Tiên ₫ ', 'ướ ữ ặ ✓'];
    server.reply({ chunkBytes: 5, sse: [...parts.map((p) => g([{ text: p }])), g([{ text: '' }], { finish: 'STOP', usage })] });
    const { events, done } = await run(gemini(), req({ model: 'gemini-3.8-flash' }));
    expect(textOfEvents(events)).toBe(parts.join(''));
    expect(done.stopReason).toBe('end_turn');
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 12, cacheReadTokens: 3, reasoningTokens: 7 });
    expect(done.message.content).toEqual([{ type: 'text', text: parts.join(''), provider: 'gemini' }]);
  });

  it('phần thought:true → thinking_delta; chữ ký trên phần văn bản được giữ trong raw', async () => {
    server.reply({
      sse: [
        g([{ text: '**Đối chiếu** ', thought: true }]),
        g([{ text: 'các nguồn.', thought: true }]),
        g([{ text: 'Kết luận', thoughtSignature: 'SIG-T' }]),
        g([{ text: '' }], { finish: 'STOP', usage }),
      ],
    });
    const { events, done } = await run(gemini(), req({ model: 'gemini-3.8-flash' }));
    expect(thinkingOfEvents(events)).toBe('**Đối chiếu** các nguồn.');
    expect(done.message.content[0]).toMatchObject({ type: 'thinking', text: '**Đối chiếu** các nguồn.', provider: 'gemini' });
    expect((done.message.content[0] as any).raw).toBeUndefined(); // tóm tắt không có chữ ký → không cần phát lại
    expect(done.message.content[1]).toMatchObject({ type: 'text', text: 'Kết luận', raw: { text: 'Kết luận', thoughtSignature: 'SIG-T' } });
  });

  it('phần rỗng chỉ mang chữ ký ở cuối luồng được gắn vào khối văn bản trước đó', async () => {
    server.reply({ sse: [g([{ text: 'Xin chào' }]), g([{ text: '', thoughtSignature: 'SIG-END' }], { finish: 'STOP' })] });
    const { done } = await run(gemini(), req());
    expect(done.message.content).toHaveLength(1);
    expect((done.message.content[0] as any).raw).toEqual({ text: 'Xin chào', thoughtSignature: 'SIG-END' });
  });
});

describe('stream — yêu cầu gửi đi', () => {
  it('URL/headers: streamGenerateContent?alt=sse, khoá ở header x-goog-api-key và KHÔNG ở URL', async () => {
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ model: 'gemini-3.8-flash' }));
    const r = server.lastRequest;
    expect(r.path).toBe('/models/gemini-3.8-flash:streamGenerateContent');
    expect(r.url).toContain('alt=sse');
    expect(r.url).not.toContain('key=');
    expect(r.url).not.toContain(TEST_KEY);
    expect(r.headers['x-goog-api-key']).toBe(TEST_KEY);
  });

  it('body: systemInstruction, contents, generationConfig, thinkingConfig (g3)', async () => {
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ model: 'gemini-3.8-flash', maxOutputTokens: 9000 }));
    expect(server.lastRequest.json).toEqual({
      systemInstruction: { parts: [{ text: 'Bạn là trợ lý.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Xin chào' }] }],
      generationConfig: { maxOutputTokens: 9000, thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } },
    });
  });

  it('gemini-2.5-flash dùng thinkingBudget; gemma không có thinkingConfig; maxOutputTokens bị chặn ở 65536', async () => {
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ model: 'gemini-2.5-flash', maxOutputTokens: 200_000 }));
    expect(server.lastRequest.json.generationConfig).toEqual({ maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } });
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ model: 'gemma-4-31b-it' }));
    expect(server.lastRequest.json.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('công cụ: functionDeclarations đã làm sạch + toolConfig AUTO', async () => {
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ tools: [searchTool] }));
    const body = server.lastRequest.json;
    expect(body.tools).toEqual([
      { functionDeclarations: [{ name: 'web_search', description: 'Tìm trên web', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Từ khoá' } }, required: ['query'] } }] },
    ]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
  });
});

describe('stream — công cụ', () => {
  it('functionCall đến nguyên cụm → tool_start + MỘT args delta + tool_end; raw giữ chữ ký', async () => {
    const part = { functionCall: { name: 'web_search', args: { query: 'giá vàng' } }, thoughtSignature: 'SIG-FC' };
    server.reply({ sse: [g([part], { finish: 'STOP', usage })] });
    const { events, done } = await run(gemini(), req({ model: 'gemini-3.8-flash', tools: [searchTool] }));
    expect(kinds(events).filter((k) => k !== 'usage')).toEqual(['tool_start', 'tool_args_delta', 'tool_end', 'done']);
    const start = events.find((e) => e.type === 'tool_start') as any;
    expect(start.id).toMatch(/^gemini_call_/); // API không cấp id → tự sinh
    expect((events.find((e) => e.type === 'tool_args_delta') as any).delta).toBe('{"query":"giá vàng"}');
    expect(done.stopReason).toBe('tool_use'); // finishReason STOP nhưng có functionCall
    const b = done.message.content[0] as any;
    expect(b).toMatchObject({ type: 'tool_use', id: start.id, name: 'web_search', input: { query: 'giá vàng' }, provider: 'gemini' });
    expect(b.raw).toEqual(part);
  });

  it('dùng id do Gemini cấp khi có', async () => {
    server.reply({ sse: [g([{ functionCall: { id: 'fc-777', name: 'web_search', args: { query: 'x' } } }], { finish: 'STOP' })] });
    const { done } = await run(gemini(), req({ tools: [searchTool] }));
    expect((done.message.content[0] as any).id).toBe('fc-777');
  });

  it('gọi song song: hai functionCall trong một chunk, chỉ lệnh đầu có chữ ký', async () => {
    server.reply({
      sse: [
        g([
          { functionCall: { name: 'web_search', args: { query: 'A' } }, thoughtSignature: 'SIG-1' },
          { functionCall: { name: 'web_search', args: { query: 'B' } } },
        ], { finish: 'STOP' }),
      ],
    });
    const { done } = await run(gemini(), req({ tools: [searchTool] }));
    const uses = done.message.content.filter((b) => b.type === 'tool_use') as any[];
    expect(uses.map((u) => u.input.query)).toEqual(['A', 'B']);
    expect(uses[0].raw.thoughtSignature).toBe('SIG-1');
    expect(uses[1].raw.thoughtSignature).toBeUndefined();
    expect(uses[0].id).not.toBe(uses[1].id);
  });

  it('thứ tự khối được giữ: suy luận → văn bản → lệnh gọi', async () => {
    server.reply({ sse: [g([{ text: 'nghĩ', thought: true }]), g([{ text: 'Để tôi tìm.' }]), g([{ functionCall: { name: 'web_search', args: { query: 'x' } }, thoughtSignature: 'S' }], { finish: 'STOP' })] });
    const { done } = await run(gemini(), req({ tools: [searchTool] }));
    expect(done.message.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
  });

  it.each([
    ['MAX_TOKENS', 'max_tokens'],
    ['SAFETY', 'content_filter'],
    ['RECITATION', 'content_filter'],
    ['PROHIBITED_CONTENT', 'content_filter'],
    ['STOP', 'end_turn'],
    ['OTHER', 'end_turn'],
  ])('finishReason %s → %s', async (finish, mapped) => {
    server.reply({ sse: [g([{ text: 'x' }], { finish })] });
    expect((await run(gemini(), req())).done.stopReason).toBe(mapped);
  });

  it('MALFORMED_FUNCTION_CALL → thử lại; hết lượt thì ném lỗi rõ ràng', async () => {
    server.reply({ sse: [{ data: { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', index: 0 }] } }] });
    server.reply({ sse: [g([{ text: 'lần hai' }], { finish: 'STOP' })] });
    const { events } = await run(gemini(), req());
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);

    server.replyAlways({ sse: [{ data: { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', index: 0 }] } }] });
    const err: any = await run(gemini(), req()).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProviderError', kind: 'server' });
    expect(err.message).toContain('MALFORMED_FUNCTION_CALL');
  });

  it('prompt bị chặn (promptFeedback.blockReason) → content_filter', async () => {
    server.reply({ sse: [{ data: { promptFeedback: { blockReason: 'SAFETY' } } }] });
    await expect(run(gemini(), req())).rejects.toMatchObject({ kind: 'content_filter' });
  });

  it('phản hồi rỗng với finishReason STOP → khối rỗng, end_turn (engine tự nhắc)', async () => {
    server.reply({ sse: [g([], { finish: 'STOP', usage })] });
    const { done } = await run(gemini(), req());
    expect(done.message.content).toEqual([]);
    expect(done.stopReason).toBe('end_turn');
  });
});

describe('chuyển đổi lịch sử (toGeminiContents)', () => {
  const fcRaw = { functionCall: { name: 'web_search', args: { query: 'x' } }, thoughtSignature: 'SIG-1' };
  const fcRaw2 = { functionCall: { name: 'web_search', args: { query: 'y' } } };
  const ownAssistant: ChatMessage = {
    role: 'assistant',
    provider: 'gemini',
    content: [
      { type: 'thinking', text: 'tóm tắt không chữ ký', provider: 'gemini' },
      { type: 'tool_use', id: 'gemini_call_1', name: 'web_search', input: { query: 'x' }, provider: 'gemini', raw: fcRaw },
      { type: 'tool_use', id: 'gemini_call_2', name: 'web_search', input: { query: 'y' }, provider: 'gemini', raw: fcRaw2 },
    ],
  };
  const results: ChatMessage = {
    role: 'user',
    content: [
      { type: 'tool_result', toolUseId: 'gemini_call_1', name: 'web_search', content: 'KQ1' },
      { type: 'tool_result', toolUseId: 'gemini_call_2', name: 'web_search', content: 'KQ2', isError: true },
    ],
  };

  it('phát lại part thô (kèm chữ ký) và gom các functionResponse vào MỘT tin user', () => {
    const out = toGeminiContents([userText('q'), ownAssistant, results], { providerId: 'gemini', model: 'gemini-3.8-flash' });
    expect(out).toEqual([
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: [fcRaw, fcRaw2] }, // thought summary không chữ ký bị bỏ
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'web_search', response: { result: 'KQ1' } } },
          { functionResponse: { name: 'web_search', response: { error: 'KQ2' } } },
        ],
      },
    ]);
  });

  it('id do Gemini cấp được echo trong functionResponse; id tự sinh thì không', () => {
    const withApiId: ChatMessage = {
      role: 'assistant',
      provider: 'gemini',
      content: [{ type: 'tool_use', id: 'fc-9', name: 'web_search', input: {}, provider: 'gemini', raw: { functionCall: { id: 'fc-9', name: 'web_search', args: {} }, thoughtSignature: 'S' } }],
    };
    const res: ChatMessage = { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fc-9', name: 'web_search', content: 'ok' }] };
    const out = toGeminiContents([userText('q'), withApiId, res], { providerId: 'gemini', model: 'gemini-3.8-flash' });
    expect((out[2].parts[0].functionResponse as any).id).toBe('fc-9');
  });

  it('lệnh gọi do hãng khác sinh ra: g3 đính chữ ký bỏ-qua-kiểm-tra ở lệnh ĐẦU của mỗi lượt; g2.5 thì không', () => {
    const foreign: ChatMessage = {
      role: 'assistant',
      provider: 'anthropic',
      content: [
        { type: 'thinking', text: 'của Claude', signature: 'X', provider: 'anthropic' },
        { type: 'text', text: 'Để tôi tìm.', provider: 'anthropic' },
        { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'a' }, provider: 'anthropic' },
        { type: 'tool_use', id: 'toolu_2', name: 'web_search', input: { query: 'b' }, provider: 'anthropic' },
      ],
    };
    const res: ChatMessage = { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_1', name: 'web_search', content: 'A' }, { type: 'tool_result', toolUseId: 'toolu_2', name: 'web_search', content: 'B' }] };
    const g3 = toGeminiContents([userText('q'), foreign, res], { providerId: 'gemini', model: 'gemini-3.8-flash' });
    expect(g3[1].parts).toEqual([
      { text: 'Để tôi tìm.' },
      { functionCall: { name: 'web_search', args: { query: 'a' } }, thoughtSignature: SKIP_SIGNATURE },
      { functionCall: { name: 'web_search', args: { query: 'b' } } },
    ]);
    // functionResponse của lệnh gọi do hãng khác sinh không mang id
    expect((g3[2].parts[0].functionResponse as any).id).toBeUndefined();
    const g25 = toGeminiContents([userText('q'), foreign, res], { providerId: 'gemini', model: 'gemini-2.5-flash' });
    expect(JSON.stringify(g25)).not.toContain(SKIP_SIGNATURE);
  });

  it('ảnh người dùng và ảnh trong kết quả công cụ → inlineData', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'xem' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'shot', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', name: 'shot', content: 'ok', images: [{ type: 'image', mediaType: 'image/jpeg', data: 'BBBB' }] }] },
    ];
    const out = toGeminiContents(history, { providerId: 'gemini', model: 'gemini-3.8-flash' });
    expect(out[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } });
    expect(out[2].parts[1]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } });
  });

  it('request thật mang chữ ký đã echo', async () => {
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ model: 'gemini-3.8-flash', tools: [searchTool], messages: [userText('q'), ownAssistant, results] }));
    const sent = server.lastRequest.json.contents;
    expect(sent[1].parts[0].thoughtSignature).toBe('SIG-1');
    expect(sent[2].parts).toHaveLength(2);
  });
});

describe('lỗi & hạ cấp thích nghi', () => {
  const gErr = (code: number, message: string, status: string) => ({ status: code, json: { error: { code, message, status } } });

  it('400 "API key not valid" → auth, không lộ khoá', async () => {
    server.reply(gErr(400, `API key not valid. Please pass a valid API key. (${TEST_KEY})`, 'INVALID_ARGUMENT'));
    const err: any = await run(gemini(), req()).catch((e) => e);
    expect(err).toMatchObject({ kind: 'auth', retryable: false });
    expect(JSON.stringify([err.message, err.details])).not.toContain(TEST_KEY);
  });

  it('429 RESOURCE_EXHAUSTED kèm retry-after-ms → retry rồi thành công', async () => {
    server.reply({ ...gErr(429, 'Resource has been exhausted', 'RESOURCE_EXHAUSTED'), headers: { 'retry-after-ms': '3' } });
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    const { events } = await run(gemini(), req());
    expect(events[0]).toMatchObject({ type: 'retry', attempt: 1 });
  });

  it('400 thinkingLevel kèm danh sách giá trị hợp lệ → chọn mức gần nhất và nhớ', async () => {
    server.reply(gErr(400, "Invalid value for thinkingLevel: 'minimal'. Supported values are: 'low', 'medium', 'high'.", 'INVALID_ARGUMENT'));
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ model: 'gemini-3.8-flash', thinking: { level: 'off', summaries: true } }));
    expect(server.requests[0].json.generationConfig.thinkingConfig.thinkingLevel).toBe('minimal');
    expect(server.requests[1].json.generationConfig.thinkingConfig.thinkingLevel).toBe('low');

    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ model: 'gemini-3.8-flash', thinking: { level: 'off', summaries: true } }));
    expect(server.requests[2].json.generationConfig.thinkingConfig.thinkingLevel).toBe('low');
  });

  it("'minimal' không hỗ trợ mà không có danh sách → thử 'low', vẫn lỗi thì bỏ hẳn thinkingConfig", async () => {
    server.reply(gErr(400, 'thinking level MINIMAL is not supported for this model', 'INVALID_ARGUMENT'));
    server.reply(gErr(400, 'thinking_level is not supported for this model', 'INVALID_ARGUMENT'));
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ model: 'gemini-3.8-flash', thinking: { level: 'off', summaries: false } }));
    expect(server.requests[1].json.generationConfig.thinkingConfig.thinkingLevel).toBe('low');
    expect(server.requests[2].json.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('gemini 2.5: lỗi thinkingBudget → bỏ thinkingConfig', async () => {
    server.reply(gErr(400, 'Budget 0 is invalid. This model only works in thinking mode. thinkingBudget', 'INVALID_ARGUMENT'));
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ model: 'gemini-2.5-pro', thinking: { level: 'off', summaries: false } }));
    expect(server.requests[1].json.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('lỗi maxOutputTokens → hạ trần theo giới hạn server báo', async () => {
    server.reply(gErr(400, 'Unable to submit request because maxOutputTokens must be less than or equal to 8192', 'INVALID_ARGUMENT'));
    server.reply({ sse: [g([{ text: 'ok' }], { finish: 'STOP' })] });
    await run(gemini(), req({ model: 'gemini-3.8-flash', maxOutputTokens: 30000 }));
    expect(server.requests[0].json.generationConfig.maxOutputTokens).toBe(30000);
    expect(server.requests[1].json.generationConfig.maxOutputTokens).toBe(8192);
  });

  it('lỗi trong luồng ({error}) → ProviderError', async () => {
    server.replyAlways({ sse: [{ data: { error: { code: 503, message: 'The model is overloaded', status: 'UNAVAILABLE' } } }] });
    await expect(run(gemini(), req())).rejects.toMatchObject({ kind: 'overloaded' });
  });

  it('hủy giữa chừng → aborted', async () => {
    server.reply({ sse: [g([{ text: 'Đang viết' }])], keepOpen: true });
    const ctrl = new AbortController();
    let error: any;
    try {
      for await (const e of gemini().stream(req({ signal: ctrl.signal }))) {
        if (e.type === 'text_delta') ctrl.abort();
      }
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ kind: 'aborted' });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.lastRequest.clientClosed).toBe(true);
  });

  it('chưa có khoá → auth, không gọi mạng', async () => {
    await expect(run(gemini({ getApiKey: async () => undefined }), req())).rejects.toMatchObject({ kind: 'auth' });
    expect(server.requests).toHaveLength(0);
  });
});

// ── Danh sách model (port từ skill gemini-model-list) ────────────────────────
const gen = ['generateContent', 'countTokens'];
const m = (name: string, displayName = name, methods = gen): GeminiApiModel => ({
  name: `models/${name}`,
  displayName,
  supportedGenerationMethods: methods,
});
const values = (list: { value: string }[]) => list.map((o) => o.value).join(',');

describe('selectGeminiModels — text', () => {
  const list = [
    m('gemini-2.5-pro'),
    m('gemini-3.5-flash'),
    m('gemini-3.1-flash-lite'),
    m('gemini-3.5-pro-preview', 'Gemini 3.5 Pro'),
    m('gemini-2.5-flash-image', 'Nano Banana'),
    m('gemini-2.5-flash-preview-tts', 'TTS'),
    m('gemini-embedding-001', 'Embedding', ['embedContent']),
    m('gemini-2.0-flash-001'),
    m('gemini-flash-latest'),
    m('gemma-3-27b-it'),
    m('gemini-omni-1.1-flash'),
    m('gemini-nano-banana-2.1'),
    m('gemini-3.5-transcribe'),
    m('gemini-4-argon'),
    m('gemini-3.1-flash-lite-preview'),
    m('gemini-3.5-flash', 'trùng'),
  ];

  it('giữ model viết chữ, mới nhất trước, flash trước flash-lite trước pro; gemini-4-argon (flagship, không có flash/pro) được GIỮ', () => {
    const got = selectGeminiModels(list, 'text');
    expect(values(got)).toBe('gemini-4-argon,gemini-3.5-flash,gemini-3.5-pro-preview,gemini-3.1-flash-lite,gemini-2.5-pro');
    expect(got[0].label.endsWith('mới nhất')).toBe(true);
    expect(got[0].tier).toBe('top');
    expect(got.find((o) => o.value === 'gemini-3.5-pro-preview')!.label).toContain('preview');
  });

  it('tên mã KHÔNG có số phiên bản vẫn bị bỏ (không đoán); tts/live/image/embedding bị bỏ', () => {
    const got = selectGeminiModels(
      [m('gemini-zeta-core'), m('gemini-3.8-live'), m('gemini-3.1-flash-tts-preview'), m('gemini-3-pro-image'), m('gemini-3.8-flash'), m('gemini-3.8-live-extended-thinking')],
      'text',
    );
    expect(values(got)).toBe('gemini-3.8-flash');
  });

  it('bậc: flash = balanced, flash-lite = fast, pro = top', () => {
    const got = selectGeminiModels([m('gemini-3.5-flash'), m('gemini-3.5-flash-lite'), m('gemini-3.5-pro')], 'text');
    expect(got.map((o) => [o.value, o.tier])).toEqual([['gemini-3.5-flash', 'balanced'], ['gemini-3.5-flash-lite', 'fast'], ['gemini-3.5-pro', 'top']]);
  });

  it('cắt tối đa 12 model', () => {
    const many = Array.from({ length: 20 }, (_, i) => m(`gemini-${i + 10}.0-flash`));
    expect(selectGeminiModels(many, 'text')).toHaveLength(12);
  });
});

describe('selectGeminiModels — image', () => {
  it('chỉ giữ model sinh ảnh gọi được bằng generateContent', () => {
    const got = selectGeminiModels(
      [
        m('gemini-2.5-flash-image'),
        m('gemini-3-pro-image-preview', 'Nano Banana Pro'),
        m('gemini-nano-banana-2.1'),
        m('gemini-2.5-flash'),
        m('gemini-2.5-flash-preview-tts'),
        m('gemini-2.0-flash-exp-image-generation'),
        m('imagen-4.0-generate-001', 'Imagen', ['predict']),
        m('gemini-2.5-flash-image-001'),
        m('gemini-3-pro-image'),
        m('gemini-2.5-flash-image-latest'),
      ],
      'image',
    );
    // gemini-3-pro-image ra mắt chính thức nên bản preview của nó bị bỏ.
    expect(values(got)).toBe('gemini-3-pro-image,gemini-2.5-flash-image,gemini-nano-banana-2.1');
  });
});

describe('fetchModels / ping', () => {
  it('đi hết các trang, gửi khoá bằng header, pageSize=200, ánh xạ giới hạn token', async () => {
    server.reply({ json: { models: [{ ...m('gemini-3.8-flash', 'Gemini 3.8 Flash'), inputTokenLimit: 1_000_000, outputTokenLimit: 65_536, thinking: true }], nextPageToken: 'T2' } });
    server.reply({ json: { models: [m('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'), m('gemini-4-argon', 'Gemini 4 Argon')] } });
    const models = await gemini().fetchModels();
    expect(models.map((x) => x.id)).toEqual(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']);
    expect(models.find((x) => x.id === 'gemini-3.8-flash')).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 65_536, reasoning: true, tier: 'balanced' });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0].url).toContain('pageSize=200');
    expect(server.requests[1].url).toContain('pageToken=T2');
    for (const r of server.requests) {
      expect(r.headers['x-goog-api-key']).toBe(TEST_KEY);
      expect(r.url).not.toContain('key=');
    }
  });

  it('khoá bị từ chối là lỗi (auth), không phải danh sách rỗng', async () => {
    server.reply({ status: 403, json: { error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } } });
    await expect(gemini().fetchModels()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('ping OK / lỗi', async () => {
    server.reply({ json: { models: [] } });
    await expect(gemini().ping()).resolves.toBeUndefined();
    expect(server.lastRequest.url).toContain('pageSize=1');
    server.reply({ status: 400, json: { error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } } });
    await expect(gemini().ping()).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('complete', () => {
  it('gom văn bản, tắt suy luận (minimal), không công cụ', async () => {
    server.reply({ sse: [g([{ text: ' Viết hàm xếp hạng. ' }], { finish: 'STOP' })] });
    const text = await gemini().complete({ model: 'gemini-3.5-flash-lite', system: 's', prompt: 'p', maxOutputTokens: 60 });
    expect(text).toBe('Viết hàm xếp hạng.');
    const body = server.lastRequest.json;
    expect(body).not.toHaveProperty('tools');
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });
});
