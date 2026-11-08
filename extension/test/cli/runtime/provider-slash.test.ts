/**
 * `/provider` trong phiên (0.4.1): danh sách, thêm API tuỳ chỉnh, lưu khoá, gỡ, thử kết nối — dùng chung trình hướng dẫn với `locaith provider`,
 * và nhà cung cấp vừa thêm dùng được NGAY trong phiên đang chạy (không cần khởi động lại).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../../../src/cli/runtime';
import { readStoredKeys, readUserCustomRaw, saveStoredKey, upsertCustomProvider } from '../../../src/cli/providerStore';
import { cleanEnv, cleanupDirs, tmpDir } from './harness';

afterEach(() => cleanupDirs());

interface Seen {
  url: string;
  auth?: string;
}

function gateway() {
  const seen: Seen[] = [];
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    seen.push({ url, auth: headers.authorization });
    if (/\/models(\?|$)/.test(url)) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-coder', object: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/chat/completions')) {
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'qwen3-coder' };
      const body =
        sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) +
        sse({ ...base, choices: [{ index: 0, delta: { content: 'chào từ máy cục bộ' }, finish_reason: null }] }) +
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }) +
        'data: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

type Ask = { id: string; kind: string; title: string; secret?: boolean; items?: Array<{ id: string; label: string; detail?: string }> };

async function session(o: { interactive: boolean; env?: Record<string, string>; home?: string; answers?: Array<string | boolean | null>; verbose?: boolean }) {
  const home = o.home ?? tmpDir('lc-home-');
  const gw = gateway();
  const rt = await createRuntime({
    cwd: tmpDir('lc-cwd-'),
    home,
    version: '1.2.3',
    interactive: o.interactive,
    env: cleanEnv({ LOCAITH_API_KEY: 'lat_' + 'a'.repeat(43), ...(o.env ?? {}) }),
    features: [],
    trusted: true,
    fetchImpl: gw.fetchImpl,
    ...(o.verbose ? { verbose: true } : {}),
  });
  const outputs: Array<{ text: string; kind?: string }> = [];
  const asked: Ask[] = [];
  const answers = [...(o.answers ?? [])];
  rt.on((e) => {
    if (e.t === 'output') outputs.push({ text: e.text, kind: (e as { kind?: string }).kind });
    if (e.t === 'ask') {
      asked.push(e.ask as unknown as Ask);
      const a = answers.length ? answers.shift()! : null;
      queueMicrotask(() => rt.answer(e.ask.id, a));
    }
  });
  // `submit` trả về ngay khi lệnh trao quyền cho người dùng (ask): phải đợi `idle()` thì hội thoại mới chạy xong.
  const cmd = async (line: string): Promise<void> => {
    await rt.submit(line);
    await rt.idle();
  };
  return { rt, home, gw, outputs, asked, answers, cmd, last: () => outputs.at(-1)?.text ?? '', all: () => outputs.map((x) => x.text).join('\n') };
}

describe('/provider list', () => {
  it('có trong danh sách lệnh, có mô tả; chạy cả ở chế độ không tương tác', async () => {
    const s = await session({ interactive: false });
    expect(s.rt.slashCommands().map((c) => c.name)).toContain('provider');
    expect(s.rt.slashCommands().find((c) => c.name === 'provider')!.description).toMatch(/nhà cung cấp/i);
    await s.cmd('/provider list');
    const txt = s.last();
    for (const id of ['locaith', 'anthropic', 'openai', 'gemini', 'deepseek', 'xai']) expect(txt).toContain(id);
    expect(txt).toMatch(/- ✔ \*\*locaith\*\*/);
    await s.rt.dispose();
  });

  it('hiện nguồn khoá đúng: biến môi trường / đã lưu / không cần khoá / chưa có; khoá không lộ', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', requiresKey: false }, 'vi');
    upsertCustomProvider(home, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    saveStoredKey(home, 'deepseek', 'sk-ds-secret-0001', 'https://api.deepseek.com');
    const s = await session({ interactive: false, home, env: { OPENAI_API_KEY: 'sk-oa-secret-0002' } });
    await s.cmd('/provider');
    const txt = s.last();
    expect(txt).toMatch(/\*\*openai\*\*.*OPENAI_API_KEY/);
    expect(txt).toMatch(/\*\*deepseek\*\*.*đã lưu/);
    expect(txt).toMatch(/\*\*ollama\*\*.*không cần khoá/);
    expect(txt).toMatch(/- ○ \*\*groq\*\*/);
    expect(txt).not.toContain('sk-ds-secret-0001');
    expect(txt).not.toContain('sk-oa-secret-0002');
    await s.rt.dispose();
  });

  it('thêm/khoá/gỡ ngoài chế độ tương tác → nói rõ cần giao diện và chỉ lệnh thay thế; không ghi gì', async () => {
    const s = await session({ interactive: false });
    for (const sub of ['add', 'key openai', 'remove']) {
      await s.rt.submit(`/provider ${sub}`);
      expect(s.outputs.at(-1)!.kind).toBe('error');
      expect(s.last()).toMatch(/locaith provider add/);
    }
    expect(fs.existsSync(path.join(s.home, '.locaith', 'settings.json'))).toBe(false);
    await s.rt.dispose();
  });

  it('hành động lạ → in cách dùng', async () => {
    const s = await session({ interactive: false });
    await s.cmd('/provider frobnicate');
    expect(s.outputs.at(-1)!.kind).toBe('error');
    expect(s.last()).toMatch(/\/provider \[list/);
    await s.rt.dispose();
  });
});

describe('/provider add trong phiên tương tác', () => {
  it('thêm Ollama bằng trình hướng dẫn → dùng được NGAY: /model ollama:… rồi một lượt hỏi gọi đúng địa chỉ cục bộ, không gửi khoá', async () => {
    const s = await session({ interactive: true, answers: ['p:ollama', 'http://localhost:11434/v1', 'ollama', 'Ollama', 'qwen3-coder'] });
    await s.cmd('/provider add');
    expect(readUserCustomRaw(s.home)).toEqual([{ id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['qwen3-coder'], requiresKey: false }]);
    expect(s.asked.map((a) => a.kind)).toEqual(['pick', 'input', 'input', 'input', 'input']);
    expect(s.asked.some((a) => a.secret)).toBe(false);
    // đã nạp lại: nhà cung cấp có mặt trong phiên đang chạy
    await s.rt.submit('/model ollama:qwen3-coder');
    expect(s.rt.status()).toMatchObject({ provider: 'ollama', model: 'qwen3-coder' });
    s.gw.seen.length = 0;
    await s.rt.submit('xin chào');
    await s.rt.idle();
    const chat = s.gw.seen.filter((x) => x.url.includes('/chat/completions'));
    expect(chat).toHaveLength(1);
    expect(chat[0]!.url.startsWith('http://localhost:11434/v1/chat/completions')).toBe(true);
    expect(chat[0]!.auth).toBeUndefined();
    await s.rt.dispose();
  });

  it('API cần khoá: ô khoá là ô ẩn; khoá đã lưu gắn địa chỉ và được dùng ngay cho lượt hỏi kế tiếp; không lọt vào nhật ký', async () => {
    const s = await session({ interactive: true, verbose: true, answers: ['p:groq', 'https://api.groq.com/openai/v1', 'groq', 'Groq', 'llama-3.3-70b', 'gsk-slash-12345678'] });
    await s.cmd('/provider add');
    const secretAsks = s.asked.filter((a) => a.secret);
    expect(secretAsks).toHaveLength(1);
    expect(secretAsks[0]!.kind).toBe('input');
    expect(readStoredKeys(s.home).keys.groq).toMatchObject({ key: 'gsk-slash-12345678', baseUrl: 'https://api.groq.com/openai/v1' });
    await s.rt.submit('/model groq:llama-3.3-70b');
    expect(s.rt.status().provider).toBe('groq');
    s.gw.seen.length = 0;
    await s.rt.submit('xin chào');
    await s.rt.idle();
    expect(s.gw.seen.find((x) => x.url.includes('/chat/completions'))!.auth).toBe('Bearer gsk-slash-12345678');
    expect(s.all()).not.toContain('gsk-slash-12345678');
    await s.rt.dispose();
    const log = path.join(s.home, '.locaith', 'logs', 'cli.log');
    if (fs.existsSync(log)) expect(fs.readFileSync(log, 'utf8')).not.toContain('gsk-slash-12345678');
  });

  it('huỷ giữa chừng (Esc) → không ghi gì', async () => {
    const s = await session({ interactive: true, answers: ['p:groq', 'https://api.groq.com/openai/v1', 'groq', null] });
    await s.cmd('/provider add');
    expect(fs.existsSync(path.join(s.home, '.locaith', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(s.home, '.locaith', 'provider-keys.json'))).toBe(false);
    await s.rt.dispose();
  });

  it('menu /provider (không đối số, tương tác): chọn «danh sách» in danh sách', async () => {
    const s = await session({ interactive: true, answers: ['list'] });
    await s.cmd('/provider');
    expect(s.asked[0]!.kind).toBe('pick');
    expect(s.all()).toContain('anthropic');
    await s.rt.dispose();
  });
});

describe('/provider key, remove, test', () => {
  it('/provider key deepseek: hỏi khoá ở ô ẩn, lưu gắn địa chỉ mặc định, nạp lại để dùng được ngay', async () => {
    const s = await session({ interactive: true, answers: ['sk-ds-slash-12345678'] });
    await s.cmd('/provider key deepseek');
    expect(s.asked.map((a) => ({ kind: a.kind, secret: a.secret }))).toEqual([{ kind: 'input', secret: true }]);
    expect(readStoredKeys(s.home).keys.deepseek).toMatchObject({ key: 'sk-ds-slash-12345678', baseUrl: 'https://api.deepseek.com' });
    await s.rt.submit('/model deepseek:deepseek-v4-pro');
    expect(s.rt.status().provider).toBe('deepseek');
    await s.rt.dispose();
  });

  it('/provider remove: gỡ định nghĩa + khoá và nhà cung cấp biến mất khỏi phiên', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    saveStoredKey(home, 'groq', 'gsk-12345678', 'https://api.groq.com/openai/v1');
    const s = await session({ interactive: true, home, answers: ['groq', true] });
    await s.cmd('/provider remove');
    expect(readUserCustomRaw(home)).toEqual([]);
    expect(readStoredKeys(home).keys).toEqual({});
    await s.cmd('/provider list');
    expect(s.last()).not.toContain('groq');
    await s.rt.dispose();
  });

  it('/provider test: thử mọi nhà cung cấp dùng được (trừ Locaith), mỗi dòng ✔/✘', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', requiresKey: false }, 'vi');
    const s = await session({ interactive: false, home });
    s.gw.seen.length = 0;
    await s.cmd('/provider test');
    expect(s.last()).toMatch(/✔ ollama: kết nối được/);
    expect(s.gw.seen.every((x) => x.url.startsWith('http://localhost:11434/v1/models'))).toBe(true);
    await s.cmd('/provider test khong-co');
    expect(s.last()).toMatch(/✘/);
    await s.rt.dispose();
  });
});

describe('cảnh báo cấu hình', () => {
  it('/doctor nêu mục cấu hình nhà cung cấp bị bỏ qua (chỉ khi có)', async () => {
    const ok = await session({ interactive: false });
    await ok.cmd('/doctor');
    expect(ok.last()).not.toContain('Cấu hình nhà cung cấp');
    await ok.rt.dispose();
    const home = tmpDir('lc-home-');
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(home, '.locaith', 'settings.json'), JSON.stringify({ customProviders: [{ id: 'bad', baseUrl: 'http://api.example.com/v1' }] }));
    const bad = await session({ interactive: false, home });
    await bad.cmd('/doctor');
    expect(bad.last()).toMatch(/Cấu hình nhà cung cấp.*api\.example\.com/s);
    await bad.rt.dispose();
  });
});
