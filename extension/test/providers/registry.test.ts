import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../../src/core/providers/anthropic';
import { GeminiProvider } from '../../src/core/providers/gemini';
import { resetParamMemory } from '../../src/core/providers/http';
import { OpenAIChatProvider } from '../../src/core/providers/openaiChat';
import { OpenAIResponsesProvider } from '../../src/core/providers/openaiResponses';
import { BUILTIN_PRESETS, CUSTOM_PRESETS } from '../../src/core/providers/presets';
import { ProviderRegistry, createProvider, type ProviderRegistryOptions } from '../../src/core/providers/registry';
import { MockServer } from '../helpers/mockServer';
import { req, run, TEST_KEY } from './util';

let server: MockServer;
beforeAll(async () => {
  server = await MockServer.start();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => resetParamMemory());
afterEach(() => server.reset());

const noKeys = async () => undefined;

/** Chỉ cho phép gọi tới máy chủ giả cục bộ; mọi địa chỉ khác lỗi ngay (test không phụ thuộc mạng, không chờ DNS). */
const guardedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('http://127.0.0.1')) {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }) });
  }
  return fetch(input, init);
};

const reg = (over: Partial<ProviderRegistryOptions> = {}) =>
  new ProviderRegistry({
    resolveApiKey: noKeys,
    env: {},
    fetchImpl: guardedFetch,
    defaultOptions: { retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 } },
    ...over,
  });

describe('presets', () => {
  it('đủ 5 nhà cung cấp dựng sẵn, id duy nhất, model mặc định nằm trong danh sách dự phòng', () => {
    expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual(['anthropic', 'openai', 'gemini', 'deepseek', 'xai']);
    for (const p of BUILTIN_PRESETS) {
      expect(p.fallbackModels.map((m) => m.id)).toContain(p.defaultModel);
      expect(p.fallbackModels.length).toBeGreaterThan(0);
      expect(p.keyUrl).toMatch(/^https:\/\//);
    }
  });

  it('mặc định theo tài liệu: opus-5-5, gemini-3.8-flash, grok-4.7, deepseek-flash', () => {
    const def = Object.fromEntries(BUILTIN_PRESETS.map((p) => [p.id, p.defaultModel]));
    expect(def).toMatchObject({ anthropic: 'claude-opus-5-5', gemini: 'gemini-3.8-flash', xai: 'grok-4.7', deepseek: 'deepseek-flash' });
  });

  it('mẫu API tuỳ chỉnh: Ollama/LM Studio không cần khoá', () => {
    const byId = Object.fromEntries(CUSTOM_PRESETS.map((p) => [p.id, p]));
    expect(byId.ollama.requiresKey).toBe(false);
    expect(byId.lmstudio.requiresKey).toBe(false);
    expect(byId.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(byId.groq.baseUrl).toBe('https://api.groq.com/openai/v1');
  });
});

describe('createProvider', () => {
  it('chọn đúng adapter theo kind', () => {
    const base = { id: 'x', label: 'X', baseUrl: 'http://x', getApiKey: noKeys };
    expect(createProvider({ ...base, kind: 'anthropic', flavor: 'anthropic' })).toBeInstanceOf(AnthropicProvider);
    expect(createProvider({ ...base, kind: 'openai-responses', flavor: 'openai' })).toBeInstanceOf(OpenAIResponsesProvider);
    expect(createProvider({ ...base, kind: 'openai-chat', flavor: 'generic' })).toBeInstanceOf(OpenAIChatProvider);
    expect(createProvider({ ...base, kind: 'gemini', flavor: 'gemini' })).toBeInstanceOf(GeminiProvider);
  });
});

describe('ProviderRegistry — mô tả nhà cung cấp', () => {
  it('liệt kê đủ nhà cung cấp dựng sẵn với kind/flavor đúng và chưa có khoá', async () => {
    const d = await reg().descriptors();
    const by = Object.fromEntries(d.map((x) => [x.id, x]));
    expect(d.map((x) => x.id)).toEqual(['anthropic', 'openai', 'gemini', 'deepseek', 'xai']);
    expect(by.anthropic).toMatchObject({ kind: 'anthropic', flavor: 'anthropic', builtin: true, hasKey: false, requiresKey: true });
    expect(by.openai).toMatchObject({ kind: 'openai-responses', flavor: 'openai' });
    expect(by.gemini).toMatchObject({ kind: 'gemini', flavor: 'gemini' });
    expect(by.deepseek).toMatchObject({ kind: 'openai-chat', flavor: 'deepseek' });
    expect(by.xai).toMatchObject({ kind: 'openai-responses', flavor: 'xai' });
    expect(by.openai.defaultModel).toBe('gpt-6.1-sol');
    expect(by.openai.fallbackModels.length).toBeGreaterThan(0);
  });

  it('khoá đã lưu → hasKey, không phải từ môi trường; khoá chỉ có trong env → keyFromEnv', async () => {
    const r = reg({
      resolveApiKey: async (id) => (id === 'openai' ? '  sk-luu  ' : undefined),
      env: { GOOGLE_API_KEY: 'g-env', XAI_API_KEY: '   ' },
    });
    const by = Object.fromEntries((await r.descriptors()).map((x) => [x.id, x]));
    expect(by.openai).toMatchObject({ hasKey: true, keyFromEnv: false });
    expect(by.gemini).toMatchObject({ hasKey: true, keyFromEnv: true });
    expect(by.xai).toMatchObject({ hasKey: false, keyFromEnv: false }); // env toàn khoảng trắng = không có
    expect(by.anthropic.hasKey).toBe(false);
  });

  it('ghi đè URL gốc của nhà cung cấp dựng sẵn hiện trong mô tả', async () => {
    const r = reg({ baseUrlOverrides: { openai: 'https://proxy.example.com/v1' } });
    const d = (await r.descriptors()).find((x) => x.id === 'openai')!;
    expect(d.baseUrl).toBe('https://proxy.example.com/v1');
  });

  it('API tuỳ chỉnh: id trùng mục dựng sẵn bị bỏ; flavor suy từ kind; model ghim làm danh sách dự phòng', async () => {
    const r = reg({
      custom: [
        { id: 'openai', label: 'Giả mạo', baseUrl: 'http://evil' }, // trùng id → bỏ qua
        { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['llama3.2', 'qwen3'] },
        { id: 'gw-claude', label: 'Cổng Claude', kind: 'anthropic', baseUrl: 'https://gw.example.com' },
        { id: 'gw-gemini', label: 'Cổng Gemini', kind: 'gemini', baseUrl: 'https://gw2.example.com/v1beta' },
        { id: 'resp', label: 'Responses', kind: 'openai-responses', baseUrl: 'https://r.example.com/v1', requiresKey: true },
      ],
    });
    const by = Object.fromEntries((await r.descriptors()).map((x) => [x.id, x]));
    expect(by.openai.label).toBe('ChatGPT (OpenAI)');
    expect(by.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(by.ollama).toMatchObject({ builtin: false, kind: 'openai-chat', flavor: 'generic', requiresKey: false, baseUrl: 'http://localhost:11434/v1' });
    expect(by.ollama.fallbackModels.map((m) => m.id)).toEqual(['llama3.2', 'qwen3']);
    expect(by['gw-claude']).toMatchObject({ kind: 'anthropic', flavor: 'anthropic' });
    expect(by['gw-gemini']).toMatchObject({ kind: 'gemini', flavor: 'gemini' });
    expect(by.resp).toMatchObject({ kind: 'openai-responses', flavor: 'generic', requiresKey: true });
    expect(r.get('gw-claude')).toBeInstanceOf(AnthropicProvider);
    expect(r.has('nope')).toBe(false);
    expect(() => r.get('nope')).toThrow(/không tồn tại/);
  });

  it('defaultModel: dựng sẵn theo preset, tuỳ chỉnh lấy model ghim đầu tiên', () => {
    const r = reg({ custom: [{ id: 'ollama', label: 'O', baseUrl: 'http://x', models: ['llama3.2'] }, { id: 'rong', label: 'R', baseUrl: 'http://y' }] });
    expect(r.defaultModel('anthropic')).toBe('claude-opus-5-5');
    expect(r.defaultModel('ollama')).toBe('llama3.2');
    expect(r.defaultModel('rong')).toBe('');
    expect(r.defaultModel('khong-co')).toBe('');
  });
});

describe('ProviderRegistry — gọi thật qua URL gốc đã ghi đè', () => {
  it('khoá lưu → dùng; không có → rơi về biến môi trường; không có gì → lỗi auth', async () => {
    server.reply({ sse: [{ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 0, delta: 'ok' } }, { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } } }] });
    const stored = reg({ resolveApiKey: async (id) => (id === 'openai' ? 'khoa-da-luu-123456' : undefined), baseUrlOverrides: { openai: server.url } });
    await run(stored.get('openai'), req({ model: 'gpt-6.1-sol' }));
    expect(server.lastRequest.headers.authorization).toBe('Bearer khoa-da-luu-123456');

    server.reply({ sse: [{ event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } } }] });
    const fromEnv = reg({ env: { OPENAI_API_KEY: TEST_KEY }, baseUrlOverrides: { openai: server.url } });
    await run(fromEnv.get('openai'), req({ model: 'gpt-6.1-sol' }));
    expect(server.lastRequest.headers.authorization).toBe(`Bearer ${TEST_KEY}`);

    const none = reg({ baseUrlOverrides: { openai: server.url } });
    await expect(run(none.get('openai'), req())).rejects.toMatchObject({ kind: 'auth' });
  });

  it('API tuỳ chỉnh Ollama (không khoá) chạy thẳng tới máy chủ cục bộ', async () => {
    server.reply({ sse: [{ data: { choices: [{ index: 0, delta: { content: 'Xin chào từ Ollama' }, finish_reason: 'stop' }] } }, { data: '[DONE]' }] });
    const r = reg({ custom: [{ id: 'ollama', label: 'Ollama', baseUrl: server.url, models: ['llama3.2'] }] });
    const { events } = await run(r.get('ollama'), req({ model: 'llama3.2' }));
    expect(events.map((e) => (e.type === 'text_delta' ? e.text : '')).join('')).toBe('Xin chào từ Ollama');
    expect(server.lastRequest.headers).not.toHaveProperty('authorization');
  });

  it('khoá của API tuỳ chỉnh lấy từ biến môi trường <ID>_API_KEY', async () => {
    server.reply({ sse: [{ data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] } }, { data: '[DONE]' }] });
    const r = reg({ env: { MY_GW_API_KEY: 'khoa-gw-123456' }, custom: [{ id: 'my-gw', label: 'GW', baseUrl: server.url }] });
    await run(r.get('my-gw'), req());
    expect(server.lastRequest.headers.authorization).toBe('Bearer khoa-gw-123456');
  });
});

describe('ProviderRegistry — model nhanh cho bộ tóm tắt', () => {
  it('chọn theo gợi ý của từng hãng trên danh sách dự phòng (chưa có khoá)', async () => {
    const r = reg();
    expect(await r.pickFastModel('anthropic')).toBe('claude-haiku-5-5');
    expect(await r.pickFastModel('openai')).toBe('gpt-6-luna');
    expect(await r.pickFastModel('gemini')).toBe('gemini-3.5-flash-lite');
    expect(await r.pickFastModel('deepseek')).toBe('deepseek-flash');
    expect(await r.pickFastModel('xai')).toBe('grok-4.20-0309-non-reasoning');
  });

  it('có danh sách thật: lấy model khớp gợi ý MỚI NHẤT trong danh sách thật', async () => {
    server.reply({ json: { data: [{ id: 'gpt-6.2-luna', created: 1_800_000_000 }, { id: 'gpt-6-luna', created: 1_780_000_000 }, { id: 'gpt-6.2-sol', created: 1_800_000_000 }] } });
    const r = reg({ resolveApiKey: async () => 'k-123456', baseUrlOverrides: { openai: server.url } });
    expect(await r.pickFastModel('openai')).toBe('gpt-6.2-luna');
  });

  it('API tuỳ chỉnh: gợi ý chung (mini/flash/lite…), nếu không có thì model mặc định', async () => {
    const r = reg({
      custom: [
        { id: 'a', label: 'A', baseUrl: 'http://a', models: ['big-70b', 'tiny-3b-instruct'] },
        { id: 'b', label: 'B', baseUrl: 'http://b', models: ['chi-co-mot'] },
      ],
    });
    expect(await r.pickFastModel('a')).toBe('tiny-3b-instruct');
    expect(await r.pickFastModel('b')).toBe('chi-co-mot');
    expect(await r.pickFastModel('khong-co')).toBe('');
  });
});

describe('ProviderRegistry — cấu hình lại', () => {
  it('reconfigure: thêm API tuỳ chỉnh mới và đổi URL gốc; danh sách model đã đệm của mục bị dựng lại bị bỏ', async () => {
    const r = reg();
    expect(r.has('moi')).toBe(false);
    r.reconfigure({ custom: [{ id: 'moi', label: 'Mới', baseUrl: 'http://moi', models: ['m1'] }], baseUrlOverrides: { xai: 'http://xai-proxy' } });
    expect(r.has('moi')).toBe(true);
    expect((await r.descriptors()).find((d) => d.id === 'xai')!.baseUrl).toBe('http://xai-proxy');
    expect((await r.catalog.list('moi')).models.map((m) => m.id)).toEqual(['m1']);
  });
});
