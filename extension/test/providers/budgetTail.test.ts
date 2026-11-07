/**
 * Dòng NGÂN SÁCH VÒNG LẶP ở CUỐI payload (0.6.31) đi qua TỪNG adapter thật (máy chủ HTTP giả, không gọi mạng).
 * Câu hỏi cần chứng minh cho mỗi hãng, trên đúng payload mà engine dựng (`withBudgetNote`):
 *   • không ném lỗi; không phá cặp tool_use ↔ tool_result (kết quả vẫn NGAY sau lệnh gọi của nó, đủ số lượng);
 *   • dòng ngân sách đến được model (ở cuối, sau mọi kết quả) và KHÔNG rò cờ nội bộ (`volatile`) ra dây;
 *   • vai trò vẫn xen kẽ — không sinh ra hai tin user liền nhau (nhiều máy chủ OpenAI-tương-thích / Gemma từ chối khuôn đó).
 * Cùng một lịch sử cho mọi hãng: 1 câu hỏi → assistant gọi HAI công cụ song song → 1 tin user chứa HAI kết quả (+ dòng ngân sách).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withBudgetNote } from '../../src/core/engine/completion';
import { AnthropicProvider, toAnthropicMessages } from '../../src/core/providers/anthropic';
import { DemoProvider } from '../../src/core/providers/demo';
import { GeminiProvider } from '../../src/core/providers/gemini';
import { resetParamMemory } from '../../src/core/providers/http';
import { OpenAIChatProvider } from '../../src/core/providers/openaiChat';
import { OpenAIResponsesProvider } from '../../src/core/providers/openaiResponses';
import { userText, type ChatMessage, type ProviderEvent } from '../../src/core/types';
import { MockServer, type SseEvent } from '../helpers/mockServer';
import { req, run, runtimeConfig, searchTool } from './util';

let server: MockServer;
beforeAll(async () => {
  server = await MockServer.start();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => resetParamMemory());
afterEach(() => server.reset());

const NOTE = '[vòng 2/8 · còn 6 vòng]';

/** Lịch sử của engine ở đầu vòng thứ hai: câu hỏi, hai lệnh gọi song song, hai kết quả. */
function history(providerId: string, extraAssistant: ChatMessage['content'] = []): ChatMessage[] {
  return [
    userText('Tìm giúp tôi hai nguồn'),
    {
      role: 'assistant',
      provider: providerId,
      content: [
        ...extraAssistant,
        { type: 'text', text: 'Tôi tìm hai nguồn.' },
        { type: 'tool_use', id: 'call_a', name: 'web_search', input: { query: 'a' } },
        { type: 'tool_use', id: 'call_b', name: 'web_search', input: { query: 'b' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_a', name: 'web_search', content: 'kết quả A' }, { type: 'tool_result', toolUseId: 'call_b', name: 'web_search', content: 'kết quả B' }] },
  ];
}
const withNote = (h: ChatMessage[]): ChatMessage[] => withBudgetNote(h, NOTE);

// ── Phản hồi tối thiểu hợp lệ của từng hãng ─────────────────────────────────────
const anthropicOk: SseEvent[] = [
  { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
];
const chatOk: SseEvent[] = [
  { data: { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] } },
  { data: { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
  { data: '[DONE]' },
];
const responsesOk: SseEvent[] = [
  { event: 'response.created', data: { type: 'response.created', response: { id: 'r', status: 'in_progress' } } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_0', role: 'assistant', status: 'in_progress', content: [] } } },
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_0', delta: 'ok' } },
  { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_0', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] } } },
  { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', id: 'msg_0', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 2 } } } },
];
const geminiOk: SseEvent[] = [{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } } }];

const lastBody = (): any => server.lastRequest.json;
const noLeak = (): void => {
  // cờ nội bộ của harness không bao giờ được rò ra dây
  expect(server.lastRequest.body).not.toContain('volatile');
};
const alternates = (roles: string[]): boolean => roles.every((r, i) => i === 0 || r !== roles[i - 1]);

describe('Anthropic', () => {
  const provider = () => new AnthropicProvider(runtimeConfig(server, { id: 'anthropic', label: 'Claude', kind: 'anthropic', flavor: 'anthropic' }));

  it('kết quả công cụ + dòng ngân sách nằm trong CÙNG tin user (tool_result đứng trước, chữ đứng sau); cặp tool_use/tool_result nguyên vẹn', async () => {
    server.reply({ sse: anthropicOk });
    const { done } = await run(provider(), req({ messages: withNote(history('anthropic')), tools: [searchTool] }));
    expect(done.stopReason).toBe('end_turn');
    const msgs = lastBody().messages as Array<{ role: string; content: any[] }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(alternates(msgs.map((m) => m.role))).toBe(true);
    const uses = msgs[1].content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    expect(uses).toEqual(['call_a', 'call_b']);
    expect(msgs[2].content.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
    expect(msgs[2].content.slice(0, 2).map((b) => b.tool_use_id)).toEqual(uses);
    expect(msgs[2].content[2]).toEqual({ type: 'text', text: NOTE });
    noLeak();
  });

  it('lượt đầu của một run (chưa có công cụ): dòng ngân sách là khối thứ hai trong tin của người dùng, câu hỏi còn nguyên', async () => {
    server.reply({ sse: anthropicOk });
    await run(provider(), req({ messages: withBudgetNote([userText('Xin chào')], '[vòng 1/8 · còn 7 vòng]') }));
    const msgs = lastBody().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'Xin chào' }, { type: 'text', text: '[vòng 1/8 · còn 7 vòng]' }]);
    noLeak();
  });

  it('khối suy luận đã ký của tin assistant TRƯỚC dòng ngân sách vẫn được phát lại nguyên (dòng ngân sách không làm đổi "ranh giới lượt")', async () => {
    server.reply({ sse: anthropicOk });
    const h = history('anthropic', [{ type: 'thinking', text: 'cần tìm', signature: 'SIG-1', provider: 'anthropic' }]);
    await run(provider(), req({ messages: withNote(h), tools: [searchTool] }));
    const asst = lastBody().messages[1].content;
    expect(asst[0]).toEqual({ type: 'thinking', thinking: 'cần tìm', signature: 'SIG-1' });
  });

  // ── prompt-cache: dòng ngân sách đổi ở MỌI lần gọi nên không được là nơi đặt điểm cache ──
  describe('prompt-cache', () => {
    const marks = (m: { content: any[] }): boolean[] => m.content.map((b) => b.cache_control !== undefined);

    it('host chính thức: điểm cache tường minh nằm ở khối thật CUỐI CÙNG (tool_result), không phải ở dòng ngân sách; dòng ngân sách không có cache_control', () => {
      const out = toAnthropicMessages(withNote(history('anthropic')), { cacheBeforeVolatile: true }) as Array<{ role: string; content: any[] }>;
      expect(marks(out[2])).toEqual([false, true, false]); // [tool_result a, tool_result b ← điểm cache, text ngân sách]
      expect(out[2].content[1].cache_control).toEqual({ type: 'ephemeral' });
      expect(out[2].content[2]).toEqual({ type: 'text', text: NOTE });
      // chỉ MỘT điểm tường minh trong cả payload (giới hạn của hãng là 4, và điểm tự động ở cấp yêu cầu cũng chiếm một)
      expect(out.flatMap((m) => m.content).filter((b) => b.cache_control).length).toBe(1);
    });

    it('lượt đầu của run: điểm cache ở chính câu hỏi của người dùng, ngay trước dòng ngân sách', () => {
      const out = toAnthropicMessages(withBudgetNote([userText('Xin chào')], '[vòng 1/8 · còn 7 vòng]'), { cacheBeforeVolatile: true }) as Array<{ content: any[] }>;
      expect(marks(out[0])).toEqual([true, false]);
    });

    it('dòng ngân sách đổi giữa hai lần gọi KHÔNG làm đổi phần tiền tố tính tới điểm cache (cùng khoá cache → lần sau đọc được bản ghi của lần trước)', () => {
      const a = toAnthropicMessages(withBudgetNote(history('anthropic'), '[vòng 2/8 · còn 6 vòng]'), { cacheBeforeVolatile: true }) as Array<{ content: any[] }>;
      const b = toAnthropicMessages(withBudgetNote(history('anthropic'), '[vòng 3/8 · còn 5 vòng]'), { cacheBeforeVolatile: true }) as Array<{ content: any[] }>;
      // mọi thứ tới hết khối có cache_control giống hệt nhau từng byte → cùng khoá cache
      const upToMark = (msgs: Array<{ content: any[] }>) => JSON.stringify(msgs.map((m) => m.content.filter((_, i) => i <= m.content.findIndex((x) => x.cache_control))).slice(0, 3));
      expect(upToMark(a)).toBe(upToMark(b));
    });

    it('không đặt điểm tường minh khi host không nhận cache_control (cổng trung gian) hoặc khi không có dòng ngân sách', () => {
      const text = (o: unknown) => JSON.stringify(o);
      expect(text(toAnthropicMessages(withNote(history('anthropic')), {}))).not.toContain('cache_control');
      expect(text(toAnthropicMessages(history('anthropic'), { cacheBeforeVolatile: true }))).not.toContain('cache_control'); // không volatile → để điểm tự động lo
    });

    it('qua adapter thật: host chính thức gửi cache_control tường minh + tự động; host khác (cổng trung gian) không gửi cache_control nào', async () => {
      let official: any;
      const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
        official = JSON.parse(String(init?.body));
        const text = anthropicOk.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
        return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch;
      const p = new AnthropicProvider({ ...runtimeConfig(server, { id: 'anthropic', kind: 'anthropic', flavor: 'anthropic' }), baseUrl: 'https://api.anthropic.com', fetchImpl });
      await run(p, req({ model: 'claude-opus-5-5', messages: withNote(history('anthropic')), tools: [searchTool] }));
      expect(official.cache_control).toEqual({ type: 'ephemeral' }); // điểm tự động ở cấp yêu cầu
      expect(official.messages[2].content.map((b: any) => b.cache_control !== undefined)).toEqual([false, true, false]);
      expect(official.messages[2].content[2]).toEqual({ type: 'text', text: NOTE });

      server.reply({ sse: anthropicOk });
      await run(provider(), req({ messages: withNote(history('anthropic')), tools: [searchTool] }));
      expect(server.lastRequest.body).not.toContain('cache_control');
    });
  });
});

describe('OpenAI Chat Completions', () => {
  const deepseek = (id = 'deepseek') => new OpenAIChatProvider(runtimeConfig(server, { id, label: 'DeepSeek', kind: 'openai-chat', flavor: 'deepseek' }));
  const generic = () => new OpenAIChatProvider(runtimeConfig(server, { id: 'openrouter', label: 'OpenRouter', kind: 'openai-chat', flavor: 'generic' }));

  for (const [name, make, pid] of [
    ['DeepSeek', () => deepseek('deepseek'), 'deepseek'],
    ['Locaith (cổng dùng giao thức + suy luận kiểu DeepSeek)', () => deepseek('locaith'), 'locaith'],
    ['generic (Ollama / LM Studio / OpenRouter…)', generic, 'openrouter'],
  ] as const) {
    it(`${name}: tool_calls ↔ tool khớp từng id, dòng ngân sách là tin user cuối duy nhất`, async () => {
      server.reply({ sse: chatOk });
      await run(make(), req({ model: 'm', messages: withNote(history(pid)), tools: [searchTool] }));
      const msgs = lastBody().messages as Array<Record<string, any>>;
      expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
      const calls = msgs[2].tool_calls.map((c: any) => c.id);
      expect(calls).toEqual(['call_a', 'call_b']);
      expect(msgs.slice(3, 5).map((m) => m.tool_call_id)).toEqual(calls); // mỗi lệnh gọi có kết quả ngay sau
      expect(msgs[5]).toEqual({ role: 'user', content: NOTE });
      noLeak();
    });
  }

  it('lượt đầu của một run: dòng ngân sách nằm TRONG tin user (không thành tin user thứ hai) — mẫu hội thoại chặt của Ollama/LM Studio chấp nhận', async () => {
    server.reply({ sse: chatOk });
    await run(generic(), req({ messages: [userText('trả lời trước'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ...withBudgetNote([userText('Xin chào')], '[vòng 1/8 · còn 7 vòng]')] }));
    const msgs = lastBody().messages as Array<Record<string, any>>;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[3].content).toBe('Xin chào\n\n[vòng 1/8 · còn 7 vòng]');
    expect(alternates(msgs.map((m) => m.role))).toBe(true);
  });

  it('DeepSeek/Locaith: suy luận (reasoning_content) của vòng công cụ phía trước vẫn được phát lại — dòng ngân sách không đổi ranh giới lượt', async () => {
    server.reply({ sse: chatOk });
    const h = history('locaith', [{ type: 'thinking', text: 'cần tra hai nguồn', provider: 'locaith' }]);
    await run(deepseek('locaith'), req({ messages: withNote(h), tools: [searchTool] }));
    const asst = (lastBody().messages as Array<Record<string, any>>)[2];
    expect(asst.reasoning_content).toBe('cần tra hai nguồn');
    // và tin user cuối cùng vẫn là tin kết quả + ghi chú, không có tin user nào chen giữa các tin `tool`
    const roles = (lastBody().messages as Array<{ role: string }>).map((m) => m.role);
    expect(roles.lastIndexOf('user')).toBe(roles.length - 1);
    expect(roles.indexOf('user', 2)).toBe(roles.length - 1);
  });
});

describe('OpenAI Responses', () => {
  const openai = () => new OpenAIResponsesProvider(runtimeConfig(server, { id: 'openai', label: 'ChatGPT', kind: 'openai-responses', flavor: 'openai' }));

  it('function_call ↔ function_call_output khớp call_id; dòng ngân sách là item user cuối cùng', async () => {
    server.reply({ sse: responsesOk });
    await run(openai(), req({ model: 'gpt-x', messages: withNote(history('openai')), tools: [searchTool] }));
    const input = lastBody().input as Array<Record<string, any>>;
    const calls = input.filter((i) => i.type === 'function_call');
    const outs = input.filter((i) => i.type === 'function_call_output');
    expect(calls.map((c) => c.call_id)).toEqual(['call_a', 'call_b']);
    expect(outs.map((o) => o.call_id)).toEqual(['call_a', 'call_b']);
    // mọi function_call_output đứng SAU lệnh gọi của nó và trước dòng ngân sách
    const last = input[input.length - 1];
    expect(last).toEqual({ role: 'user', content: [{ type: 'input_text', text: NOTE }] });
    expect(input.indexOf(outs[1])).toBeLessThan(input.length - 1);
    expect(input.indexOf(calls[1])).toBeLessThan(input.indexOf(outs[0]));
    noLeak();
  });
});

describe('Gemini', () => {
  const gemini = () => new GeminiProvider(runtimeConfig(server, { id: 'gemini', label: 'Gemini', kind: 'gemini', flavor: 'gemini' }));

  it('functionResponse khớp số lượng functionCall ngay sau lượt gọi; dòng ngân sách là phần chữ cuối cùng của CÙNG tin user (không có hai tin user liền nhau)', async () => {
    server.reply({ sse: geminiOk });
    await run(gemini(), req({ model: 'gemini-3.8-flash', messages: withNote(history('gemini')), tools: [searchTool] }));
    const contents = lastBody().contents as Array<{ role: string; parts: Array<Record<string, any>> }>;
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(alternates(contents.map((c) => c.role))).toBe(true);
    const calls = contents[1].parts.filter((p) => p.functionCall);
    const resps = contents[2].parts.filter((p) => p.functionResponse);
    expect(calls).toHaveLength(2);
    expect(resps).toHaveLength(2);
    expect(contents[2].parts.map((p) => (p.functionResponse ? 'fr' : 'text'))).toEqual(['fr', 'fr', 'text']);
    expect(contents[2].parts[2]).toEqual({ text: NOTE });
    noLeak();
  });
});

describe('Chế độ demo', () => {
  /** Chạy một bước và trả về tên các công cụ model (demo) định gọi. */
  async function toolsAt(messages: ChatMessage[]): Promise<string[]> {
    const demo = new DemoProvider({ speed: 1000 });
    const events: ProviderEvent[] = [];
    for await (const ev of demo.stream(req({ messages }))) events.push(ev);
    const done = events.find((e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done')!;
    return done.message.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name);
  }

  it('dòng ngân sách không làm demo mất bước: kịch bản đi tiếp đúng thứ tự, y như khi không có dòng đó', async () => {
    const ask = 'So sánh điểm các model rồi dựng bảng';
    const step0 = [userText(ask)];
    const step1: ChatMessage[] = [
      userText(ask),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'd1', name: 'todo_write', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'd1', name: 'todo_write', content: 'ok' }] },
    ];
    expect(await toolsAt(step0)).toEqual(['todo_write']);
    expect(await toolsAt(step1)).toEqual(['load_skill', 'scratchpad']);
    // cùng lịch sử + dòng ngân sách → cùng bước
    expect(await toolsAt(withBudgetNote(step0, NOTE))).toEqual(['todo_write']);
    expect(await toolsAt(withBudgetNote(step1, NOTE))).toEqual(['load_skill', 'scratchpad']);
  });
});
