/**
 * Hồi quy: trong trình duyệt, `fetch` gốc chỉ gọi được như HÀM TRẦN — `obj.prop(...)` với prop = window.fetch ném
 * "TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation". Node bỏ qua `this` nên lỗi này không lộ ra ở bản VS Code,
 * nhưng ở bản Chrome/Edge nó khiến MỌI nhà cung cấp báo "Không kết nối được tới máy chủ" (người dùng gặp với DeepSeek).
 * Test thay `fetch` toàn cục bằng một bản cư xử như trình duyệt rồi chạy các adapter với cấu hình mặc định (không truyền fetchImpl).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/core/providers/anthropic';
import { GeminiProvider } from '../../src/core/providers/gemini';
import { OpenAIChatProvider } from '../../src/core/providers/openaiChat';
import { OpenAIResponsesProvider } from '../../src/core/providers/openaiResponses';
import { ProviderRegistry } from '../../src/core/providers/registry';
import { MockServer } from '../helpers/mockServer';
import { req, run, runtimeConfig } from './util';

const realFetch = globalThis.fetch;

/** `fetch` kiểu trình duyệt: ném "Illegal invocation" nếu `this` là một đối tượng bất kỳ khác toàn cục. */
function browserLikeFetch(this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  if (this !== undefined && this !== null && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
  return realFetch(input, init);
}

let server: MockServer;
beforeAll(async () => {
  server = await MockServer.start();
  vi.stubGlobal('fetch', browserLikeFetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await server.close();
});
afterEach(() => server.reset());

describe('fetch kiểu trình duyệt (gọi như phương thức của đối tượng là lỗi)', () => {
  it('bản giả lập thật sự tái hiện lỗi (kiểm tra chính bài kiểm tra, tránh test rỗng)', () => {
    const holder = { f: globalThis.fetch };
    expect(() => holder.f('http://127.0.0.1:1/')).toThrow(/Illegal invocation/);
    expect(() => globalThis.fetch('http://127.0.0.1:1/').catch(() => undefined)).not.toThrow(); // gọi trần thì được
  });

  it('OpenAI Chat (DeepSeek/tương thích): ping và lấy danh sách model không truyền fetchImpl', async () => {
    server.replyAlways({ json: { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] } });
    const p = new OpenAIChatProvider(runtimeConfig(server, { id: 'deepseek', kind: 'openai-chat', flavor: 'deepseek' }));
    await p.ping();
    const models = await p.fetchModels();
    expect(models.length).toBeGreaterThan(0);
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
  });

  it('OpenAI Chat: một lượt trả lời streaming đi qua đường SSE mặc định', async () => {
    server.reply({ sse: [{ data: { choices: [{ index: 0, delta: { content: 'Xin chào' } }] } }, { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } } }, { data: '[DONE]' }] });
    const p = new OpenAIChatProvider(runtimeConfig(server, { id: 'gw', kind: 'openai-chat', flavor: 'generic' }));
    const { done } = await run(p, req());
    expect(JSON.stringify(done.message.content)).toContain('Xin chào');
  });

  it('OpenAI Responses (GPT/Grok): ping không truyền fetchImpl', async () => {
    server.replyAlways({ json: { data: [{ id: 'gpt-6.1-sol' }] } });
    const p = new OpenAIResponsesProvider(runtimeConfig(server, { id: 'openai', kind: 'openai-responses', flavor: 'openai' }));
    await p.ping();
    expect(server.requests.length).toBeGreaterThanOrEqual(1);
  });

  it('Gemini: ping và danh sách model không truyền fetchImpl', async () => {
    server.replyAlways({ json: { models: [{ name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] }] } });
    const p = new GeminiProvider(runtimeConfig(server, { id: 'gemini', kind: 'gemini', flavor: 'gemini' }));
    await p.ping();
    expect((await p.fetchModels()).length).toBeGreaterThan(0);
  });

  it('Claude (SDK chính thức) với fetch mặc định cũng chạy được', async () => {
    server.reply({ json: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
    const p = new AnthropicProvider(runtimeConfig(server, { id: 'anthropic', kind: 'anthropic', flavor: 'anthropic' }));
    await p.ping();
    expect(server.requests.length).toBe(1);
  });

  it('ProviderRegistry dựng provider không truyền fetchImpl: kết nối được (đường đi của ProviderService trong tiện ích)', async () => {
    server.replyAlways({ json: { data: [{ id: 'deepseek-flash' }] } });
    const reg = new ProviderRegistry({ resolveApiKey: async () => 'sk-test-1234567890abcdef', baseUrlOverrides: { deepseek: `${server.url}/v1` }, env: {} });
    await reg.get('deepseek').ping();
    expect(server.lastRequest.path).toMatch(/\/v1\//);
    expect(server.lastRequest.headers.authorization).toBe('Bearer sk-test-1234567890abcdef');
  });
});
