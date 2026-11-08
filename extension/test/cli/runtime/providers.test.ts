import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotLoggedInError, createRuntime } from '../../../src/cli/runtime';
import { LOCAITH_CONTEXT_WINDOW } from '../../../src/core/providers/locaithGateway';
import { cleanEnv, cleanupDirs, tmpDir } from './harness';

afterEach(() => cleanupDirs());

async function rt(env: Record<string, string>, extra: Partial<Parameters<typeof createRuntime>[0]> = {}) {
  const home = extra.home ?? tmpDir('lc-home-');
  // fetch giả: KHÔNG gọi mạng thật (làm mới tài khoản/consent ở nền sẽ rơi vào đây)
  const fetchImpl = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
  return createRuntime({ cwd: tmpDir('lc-cwd-'), home, version: '1.2.3', interactive: false, env: cleanEnv(env), features: [], trusted: true, fetchImpl, ...extra });
}

describe('chọn nhà cung cấp', () => {
  it('thiếu mọi khoá và không có providerOverride → NotLoggedInError (lớp riêng, hướng dẫn locaith login)', async () => {
    await expect(rt({})).rejects.toBeInstanceOf(NotLoggedInError);
    try {
      await rt({});
    } catch (e) {
      const err = e as NotLoggedInError;
      expect(err.code).toBe('not_logged_in');
      expect(err.vi).toContain('locaith login');
      expect(err.en).toContain('locaith login');
      expect(err.message).toContain('LOCAITH_API_KEY');
    }
    const en = await rt({}, { lang: 'en' }).catch((e) => e as NotLoggedInError);
    expect((en as Error).message).toMatch(/Not logged in/);
  });

  it('LOCAITH_API_KEY → nhà cung cấp locaith, model flash, cửa sổ 1.000.000', async () => {
    const r = await rt({ LOCAITH_API_KEY: 'lat_' + 'a'.repeat(43) });
    const st = r.status();
    expect(st.provider).toBe('locaith');
    expect(st.model).toBe('locaith-v5-flash');
    expect(st.context.window).toBe(LOCAITH_CONTEXT_WINDOW);
    expect(st.account?.loggedIn).toBe(true);
    await r.dispose();
  });

  it('khoá trong ~/.locaith/cli.json (đúng định dạng CLI cũ) cũng được dùng', async () => {
    const home = tmpDir('lc-home-');
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(home, '.locaith', 'cli.json'), JSON.stringify({ apiKey: 'lat_' + 'b'.repeat(43) }));
    const r = await rt({}, { home });
    expect(r.status().provider).toBe('locaith');
    await r.dispose();
  });

  it('BYOK: ANTHROPIC_API_KEY → anthropic và model mặc định của hãng', async () => {
    const r = await rt({ ANTHROPIC_API_KEY: 'sk-ant-test-1234567890' });
    expect(r.status().provider).toBe('anthropic');
    expect(r.status().model).toBe('claude-opus-5-5');
    expect(r.status().context.window).toBe(1_000_000);
    await r.dispose();
  });

  it('BYOK: --model gpt-… chọn đúng openai; gemini nhận cả GOOGLE_API_KEY', async () => {
    const a = await rt({ OPENAI_API_KEY: 'sk-test-0123456789abcdef', ANTHROPIC_API_KEY: 'sk-ant-test-1234567890' }, { model: 'gpt-6-astra' });
    expect(a.status()).toMatchObject({ provider: 'openai', model: 'gpt-6-astra' });
    await a.dispose();
    const g = await rt({ GOOGLE_API_KEY: 'AIza-test-0123456789' });
    expect(g.status()).toMatchObject({ provider: 'gemini', model: 'gemini-3.8-flash' });
    await g.dispose();
    const d = await rt({ DEEPSEEK_API_KEY: 'sk-deepseek-0123456789' }, { model: 'deepseek:deepseek-v4-pro' });
    expect(d.status()).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    await d.dispose();
    const x = await rt({ XAI_API_KEY: 'xai-test-0123456789' });
    expect(x.status().provider).toBe('xai');
    await x.dispose();
  });

  it('có cả Locaith lẫn BYOK mà không chọn model → Locaith (sản phẩm mặc định)', async () => {
    const r = await rt({ LOCAITH_API_KEY: 'lat_' + 'c'.repeat(43), OPENAI_API_KEY: 'sk-test-0123456789abcdef' });
    expect(r.status().provider).toBe('locaith');
    await r.dispose();
  });

  it('--model của hãng chưa có khoá → lỗi rõ ràng chỉ đúng biến môi trường (không rơi âm thầm sang hãng khác)', async () => {
    await expect(rt({ ANTHROPIC_API_KEY: 'sk-ant-test-1234567890' }, { model: 'gpt-6-astra' })).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(rt({ OPENAI_API_KEY: 'sk-test-0123456789abcdef' }, { model: 'locaith-v5-si' })).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('cài đặt model đã lưu mà không dùng được thì rơi về mặc định (không phải lỗi)', async () => {
    const home = tmpDir('lc-home-');
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(home, '.locaith', 'settings.json'), JSON.stringify({ defaultModel: 'openai:gpt-6-astra' }));
    const r = await rt({ ANTHROPIC_API_KEY: 'sk-ant-test-1234567890' }, { home });
    expect(r.status().provider).toBe('anthropic');
    await r.dispose();
  });

  it('khoá không bao giờ xuất hiện trong nhật ký', async () => {
    const home = tmpDir('lc-home-');
    const key = 'lat_' + 'z'.repeat(43);
    const r = await rt({ LOCAITH_API_KEY: key }, { home, verbose: true });
    await r.dispose();
    const log = path.join(home, '.locaith', 'logs', 'cli.log');
    if (fs.existsSync(log)) expect(fs.readFileSync(log, 'utf8')).not.toContain(key);
  });
});

describe('gọi cổng Locaith qua fetch giả', () => {
  it('gửi Authorization, header chẩn đoán family=cli, hàng chờ ticket; mô hình chạy được một lượt', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      seen.push({ url, headers });
      if (url.includes('/models')) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'locaith-v5-flash', object: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/account') || url.endsWith('/consent')) return new Response(JSON.stringify({ ok: true, accepted: true, version: 1, current: 1, account: { name: 'Anh Tuấn', email_masked: 't***@x.vn', plan: 'pro' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'locaith-v5-flash' };
      const body =
        sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) +
        sse({ ...base, choices: [{ index: 0, delta: { content: 'Chào từ cổng giả' }, finish_reason: null }] }) +
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) +
        'data: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const key = 'lat_' + 'q'.repeat(43);
    const r = await rt({ LOCAITH_API_KEY: key }, { fetchImpl, interactive: false, version: '7.7.7' });
    const events: string[] = [];
    r.on((e) => {
      if (e.t === 'ui' && e.ev.t === 'text') events.push(e.ev.delta);
    });
    await r.submit('xin chào');
    await r.idle();
    expect(events.join('')).toContain('Chào từ cổng giả');
    const chat = seen.find((s) => s.url.includes('/chat/completions'));
    expect(chat).toBeTruthy();
    expect(chat!.headers.authorization).toBe(`Bearer ${key}`);
    expect(chat!.headers['x-locaith-client']).toBe('cli/7.7.7');
    expect(chat!.headers['x-locaith-session']).toMatch(/^[0-9a-f]{16}$/);
    expect(chat!.headers['x-locaith-queue']).toBe('ticket');
    await r.dispose();
  });
});
