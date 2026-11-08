/**
 * Nhà cung cấp tuỳ chỉnh ở lõi CLI (0.4.1): API OpenAI-compatible qua `customProviders`, khoá hãng khác đã lưu (`~/.locaith/provider-keys.json`),
 * khoá GẮN với địa chỉ, cài đặt của KHO MÃ không đổi được địa chỉ/nhà cung cấp, nạp lại cấu hình, báo lỗi cấu hình.
 * Mọi gọi mạng đi qua fetch giả; mọi tệp nằm trong thư mục tạm (không đụng ~/.locaith thật).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotLoggedInError, createRuntime } from '../../../src/cli/runtime';
import { SettingsStore } from '../../../src/cli/runtime/config';
import { CliProviders } from '../../../src/cli/runtime/providers';
import { saveStoredKey, setBaseUrlOverride, upsertCustomProvider } from '../../../src/cli/providerStore';
import { cleanEnv, cleanupDirs, tmpDir } from './harness';

afterEach(() => cleanupDirs());

interface Seen {
  url: string;
  auth: string | undefined;
}

/** Cổng giả kiểu OpenAI-compatible: /models trả hai model, /chat/completions trả một câu trả lời. Ghi lại mọi URL + tiêu đề Authorization. */
function gateway() {
  const seen: Seen[] = [];
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    seen.push({ url, auth: headers.authorization });
    if (/\/models(\?|$)/.test(url)) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'm-one', object: 'model' }, { id: 'm-two', object: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/chat/completions')) {
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm-one' };
      const body =
        sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) +
        sse({ ...base, choices: [{ index: 0, delta: { content: 'Xin chào từ máy chủ giả' }, finish_reason: null }] }) +
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }) +
        'data: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { seen, fetchImpl, chat: () => seen.filter((s) => s.url.includes('/chat/completions')) };
}

type Rt = Awaited<ReturnType<typeof createRuntime>>;
const provOf = (r: Rt): CliProviders => (r as unknown as { providers: CliProviders }).providers;

async function rt(home: string, env: Record<string, string>, extra: Partial<Parameters<typeof createRuntime>[0]> = {}): Promise<Rt> {
  return createRuntime({ cwd: tmpDir('lc-cwd-'), home, version: '1.2.3', interactive: false, env: cleanEnv(env), features: [], trusted: true, ...extra });
}

async function say(r: Rt): Promise<string> {
  let text = '';
  r.on((e) => {
    if (e.t === 'ui' && e.ev.t === 'text') text += e.ev.delta;
  });
  await r.submit('xin chào');
  await r.idle();
  return text;
}

const OLLAMA = { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['qwen3-coder'], requiresKey: false };
const GROQ = { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true };

describe('API tuỳ chỉnh không cần khoá (Ollama)', () => {
  it('chọn bằng `ollama:model`, gọi đúng địa chỉ cục bộ, KHÔNG gửi tiêu đề Authorization', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, OLLAMA, 'vi');
    const gw = gateway();
    const r = await rt(home, {}, { model: 'ollama:qwen3-coder', fetchImpl: gw.fetchImpl });
    expect(r.status()).toMatchObject({ provider: 'ollama', model: 'qwen3-coder' });
    expect(await say(r)).toContain('Xin chào từ máy chủ giả');
    const c = gw.chat();
    expect(c).toHaveLength(1);
    expect(c[0]!.url.startsWith('http://localhost:11434/v1/chat/completions')).toBe(true);
    expect(c[0]!.auth).toBeUndefined();
    await r.dispose();
  });

  it('chưa chọn model: tự dùng API không cần khoá thay vì bắt đăng nhập Locaith', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, OLLAMA, 'vi');
    const r = await rt(home, {}, { fetchImpl: gateway().fetchImpl });
    expect(r.status().provider).toBe('ollama');
    await r.dispose();
  });

  it('địa chỉ http công cộng trong tệp bị bỏ qua + báo lý do; không có gì dùng được → NotLoggedInError', async () => {
    const home = tmpDir('lc-home-');
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(home, '.locaith', 'settings.json'), JSON.stringify({ customProviders: [{ id: 'bad-one', label: 'Xấu', baseUrl: 'http://api.example.com/v1', requiresKey: false }] }));
    await expect(rt(home, {})).rejects.toBeInstanceOf(NotLoggedInError);
    const prov = new CliProviders({ home, env: cleanEnv(), version: '1', settings: new SettingsStore({ home, cwd: tmpDir('lc-cwd-'), env: cleanEnv(), trusted: () => true }), log: () => undefined, lang: () => 'vi' });
    expect(prov.service.has('bad-one')).toBe(false);
    expect(prov.problems().join('\n')).toMatch(/api\.example\.com/);
  });
});

describe('API tuỳ chỉnh cần khoá (Groq)', () => {
  it('khoá từ biến <ID>_API_KEY được gửi đi', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, GROQ, 'vi');
    const gw = gateway();
    const r = await rt(home, { GROQ_API_KEY: 'gsk-from-env-0001' }, { model: 'groq:m-one', fetchImpl: gw.fetchImpl });
    await say(r);
    expect(gw.chat()[0]!.url.startsWith('https://api.groq.com/openai/v1/chat/completions')).toBe(true);
    expect(gw.chat()[0]!.auth).toBe('Bearer gsk-from-env-0001');
    await r.dispose();
  });

  it('khoá ĐÃ LƯU (provider-keys.json) được gửi đi khi không có biến môi trường', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, GROQ, 'vi');
    saveStoredKey(home, 'groq', 'gsk-saved-0002', GROQ.baseUrl);
    const gw = gateway();
    const r = await rt(home, {}, { model: 'groq:m-one', fetchImpl: gw.fetchImpl });
    await say(r);
    expect(gw.chat()[0]!.auth).toBe('Bearer gsk-saved-0002');
    await r.dispose();
  });

  it('biến môi trường THẮNG khoá đã lưu', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, GROQ, 'vi');
    saveStoredKey(home, 'groq', 'gsk-saved-0003', GROQ.baseUrl);
    const gw = gateway();
    const r = await rt(home, { GROQ_API_KEY: 'gsk-env-wins-0003' }, { model: 'groq:m-one', fetchImpl: gw.fetchImpl });
    await say(r);
    expect(gw.chat()[0]!.auth).toBe('Bearer gsk-env-wins-0003');
    await r.dispose();
  });

  it('chưa có khoá → lỗi chỉ đúng cách sửa (tên biến + lệnh lưu khoá); không rơi sang nhà cung cấp khác', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, GROQ, 'vi');
    const err = (await rt(home, { OPENAI_API_KEY: 'sk-test-0123456789abcdef' }, { model: 'groq:m-one', fetchImpl: gateway().fetchImpl }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('GROQ_API_KEY');
    expect(err.message).toContain('locaith provider key groq');
  });
});

describe('khoá đã lưu của hãng dựng sẵn', () => {
  it('khoá DeepSeek đã lưu → tự chọn deepseek, gọi đúng địa chỉ mặc định của hãng với khoá đó', async () => {
    const home = tmpDir('lc-home-');
    saveStoredKey(home, 'deepseek', 'sk-ds-saved-0004', 'https://api.deepseek.com');
    const gw = gateway();
    const r = await rt(home, {}, { fetchImpl: gw.fetchImpl });
    expect(r.status().provider).toBe('deepseek');
    await say(r);
    expect(gw.chat()[0]!.url.startsWith('https://api.deepseek.com/')).toBe(true);
    expect(gw.chat()[0]!.auth).toBe('Bearer sk-ds-saved-0004');
    await r.dispose();
  });

  it('khoá chỉ gắn với MỘT địa chỉ: đổi baseUrls → khoá ngừng được gửi, lỗi nói rõ hai địa chỉ + cách lưu lại', async () => {
    const home = tmpDir('lc-home-');
    saveStoredKey(home, 'deepseek', 'sk-ds-saved-0005', 'https://api.deepseek.com');
    setBaseUrlOverride(home, 'deepseek', 'https://proxy.example.com/v1');
    const gw = gateway();
    const err = (await rt(home, {}, { model: 'deepseek:deepseek-v4-pro', fetchImpl: gw.fetchImpl }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('https://api.deepseek.com');
    expect(err.message).toContain('https://proxy.example.com/v1');
    expect(err.message).toContain('locaith provider key deepseek');
    expect(gw.seen.some((s) => s.auth?.includes('sk-ds-saved-0005'))).toBe(false);

    const prov = new CliProviders({ home, env: cleanEnv(), version: '1', settings: new SettingsStore({ home, cwd: tmpDir('lc-cwd-'), env: cleanEnv(), trusted: () => true }), fetchImpl: gw.fetchImpl, log: () => undefined, lang: () => 'vi' });
    expect(prov.hasKey('deepseek')).toBe(false);
    expect(prov.keySource('deepseek')).toEqual({ source: 'mismatch', savedUrl: 'https://api.deepseek.com' });
    expect(prov.problems().join('\n')).toContain('proxy.example.com');
  });

  it('`baseUrls` không áp cho API tuỳ chỉnh: bị bỏ qua + báo; địa chỉ gắn khoá chính là địa chỉ THẬT mà yêu cầu đi tới', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, GROQ, 'vi');
    saveStoredKey(home, 'groq', 'gsk-bound-0013', GROQ.baseUrl);
    setBaseUrlOverride(home, 'groq', 'https://evil.example/v1');
    const gw = gateway();
    const r = await rt(home, {}, { model: 'groq:m-one', fetchImpl: gw.fetchImpl });
    expect(provOf(r).effectiveBaseUrl('groq')).toBe(GROQ.baseUrl);
    expect(provOf(r).keySource('groq')).toEqual({ source: 'saved' });
    expect(provOf(r).problems().join('\n')).toMatch(/baseUrls\.groq/);
    await say(r);
    expect(gw.seen.every((s) => !s.url.includes('evil.example'))).toBe(true);
    expect(gw.chat()[0]!.url.startsWith('https://api.groq.com/openai/v1/')).toBe(true);
    expect(gw.chat()[0]!.auth).toBe('Bearer gsk-bound-0013');
    await r.dispose();
  });

  it('địa chỉ đổi mà vẫn có khoá trong biến môi trường → dùng biến (người dùng tự đặt, không phải khoá đã lưu)', async () => {
    const home = tmpDir('lc-home-');
    saveStoredKey(home, 'deepseek', 'sk-ds-saved-0006', 'https://api.deepseek.com');
    setBaseUrlOverride(home, 'deepseek', 'https://proxy.example.com/v1');
    const gw = gateway();
    const r = await rt(home, { DEEPSEEK_API_KEY: 'sk-ds-env-0006' }, { model: 'deepseek:deepseek-v4-pro', fetchImpl: gw.fetchImpl });
    await say(r);
    expect(gw.chat()[0]!.url.startsWith('https://proxy.example.com/v1/')).toBe(true);
    expect(gw.chat()[0]!.auth).toBe('Bearer sk-ds-env-0006');
    await r.dispose();
  });
});

describe('kho mã (cài đặt dự án) KHÔNG đổi được nhà cung cấp hay địa chỉ', () => {
  it('customProviders và baseUrls trong .locaith/settings.json + settings.local.json bị bỏ qua dù thư mục đã tin cậy', async () => {
    const home = tmpDir('lc-home-');
    const cwd = tmpDir('lc-cwd-');
    const evil = { customProviders: [{ id: 'evil', label: 'Evil', baseUrl: 'https://evil.example/v1', requiresKey: false }], baseUrls: { deepseek: 'https://evil.example/v1' } };
    fs.mkdirSync(path.join(cwd, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.locaith', 'settings.json'), JSON.stringify(evil));
    fs.writeFileSync(path.join(cwd, '.locaith', 'settings.local.json'), JSON.stringify(evil));
    const gw = gateway();
    const r = await rt(home, { DEEPSEEK_API_KEY: 'sk-ds-env-0007' }, { cwd, model: 'deepseek:deepseek-v4-pro', fetchImpl: gw.fetchImpl });
    expect(provOf(r).service.has('evil')).toBe(false);
    expect(provOf(r).rows().map((x) => x.id)).not.toContain('evil');
    await say(r);
    expect(gw.seen.every((s) => !s.url.includes('evil.example'))).toBe(true);
    expect(gw.chat()[0]!.url.startsWith('https://api.deepseek.com/')).toBe(true);
    await r.dispose();
  });
});

describe('nạp lại cấu hình và báo lỗi', () => {
  it('reload(): nhà cung cấp/khoá vừa ghi vào tệp dùng được NGAY (không chờ hết đệm cài đặt)', async () => {
    const home = tmpDir('lc-home-');
    const r = await rt(home, { LOCAITH_API_KEY: 'lat_' + 'r'.repeat(43) }, { fetchImpl: gateway().fetchImpl });
    const prov = provOf(r);
    expect(prov.service.has('ollama')).toBe(false);
    upsertCustomProvider(home, OLLAMA, 'vi');
    upsertCustomProvider(home, GROQ, 'vi');
    saveStoredKey(home, 'groq', 'gsk-saved-0008', GROQ.baseUrl);
    prov.reload();
    expect(prov.service.has('ollama')).toBe(true);
    expect(prov.hasKey('ollama')).toBe(true);
    expect(prov.hasKey('groq')).toBe(true);
    expect(prov.keySource('groq')).toEqual({ source: 'saved' });
    expect(prov.keySource('ollama')).toEqual({ source: 'not-required' });
    expect(prov.usableIds()).toEqual(expect.arrayContaining(['locaith', 'groq', 'ollama']));
    expect(prov.effectiveBaseUrl('ollama')).toBe('http://localhost:11434/v1');
    expect(prov.effectiveBaseUrl('deepseek')).toBe('https://api.deepseek.com');
    await r.dispose();
  });

  it('rows(): địa chỉ hiệu lực + nguồn khoá cho từng nhà cung cấp', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, OLLAMA, 'vi');
    upsertCustomProvider(home, GROQ, 'vi');
    saveStoredKey(home, 'deepseek', 'sk-ds-saved-0009', 'https://api.deepseek.com');
    const env = cleanEnv({ OPENAI_API_KEY: 'sk-oa-env-0009' });
    const prov = new CliProviders({ home, env, version: '1', settings: new SettingsStore({ home, cwd: tmpDir('lc-cwd-'), env, trusted: () => true }), log: () => undefined, lang: () => 'vi' });
    const by = Object.fromEntries(prov.rows().map((x) => [x.id, x]));
    expect(by.openai).toMatchObject({ usable: true, builtin: true, key: { source: 'env', env: 'OPENAI_API_KEY' } });
    expect(by.deepseek).toMatchObject({ usable: true, builtin: true, key: { source: 'saved' } });
    expect(by.anthropic).toMatchObject({ usable: false, key: { source: 'none' } });
    expect(by.ollama).toMatchObject({ usable: true, builtin: false, baseUrl: 'http://localhost:11434/v1', key: { source: 'not-required' } });
    expect(by.groq).toMatchObject({ usable: false, builtin: false, key: { source: 'none' } });
    expect(by.demo).toBeUndefined();
    expect(by.auto).toBeUndefined();
  });

  it('secrets(): gom khoá đã lưu + khoá trong môi trường để che khỏi nhật ký', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, GROQ, 'vi');
    saveStoredKey(home, 'deepseek', 'sk-ds-saved-0010', 'https://api.deepseek.com');
    const env = cleanEnv({ GROQ_API_KEY: 'gsk-env-0010', ANTHROPIC_API_KEY: 'sk-ant-env-0010' });
    const prov = new CliProviders({ home, env, version: '1', settings: new SettingsStore({ home, cwd: tmpDir('lc-cwd-'), env, trusted: () => true }), log: () => undefined, lang: () => 'vi' });
    expect(prov.secrets().sort()).toEqual(['gsk-env-0010', 'sk-ant-env-0010', 'sk-ds-saved-0010'].sort());
  });

  it('khoá không bao giờ rơi vào tệp nhật ký, kể cả khi lỗi mạng làm in ra tiêu đề', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, GROQ, 'vi');
    saveStoredKey(home, 'groq', 'gsk-never-in-logs-0011', GROQ.baseUrl);
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED Authorization: Bearer gsk-never-in-logs-0011');
    }) as unknown as typeof fetch;
    const r = await rt(home, {}, { model: 'groq:m-one', fetchImpl: failing, verbose: true });
    await r.submit('xin chào').catch(() => undefined);
    await r.idle().catch(() => undefined);
    await r.dispose();
    const log = path.join(home, '.locaith', 'logs', 'cli.log');
    if (fs.existsSync(log)) expect(fs.readFileSync(log, 'utf8')).not.toContain('gsk-never-in-logs-0011');
  });

  it('status().notices nhắc có mục cấu hình bị bỏ qua (và không nhắc khi mọi thứ đúng)', async () => {
    const home = tmpDir('lc-home-');
    const ok = await rt(home, { LOCAITH_API_KEY: 'lat_' + 's'.repeat(43) }, { fetchImpl: gateway().fetchImpl });
    expect(ok.status().notices.join('\n')).not.toMatch(/nhà cung cấp/i);
    await ok.dispose();
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(home, '.locaith', 'settings.json'), JSON.stringify({ customProviders: [{ id: 'x1', baseUrl: 'ftp://nope' }] }));
    const bad = await rt(home, { LOCAITH_API_KEY: 'lat_' + 's'.repeat(43) }, { fetchImpl: gateway().fetchImpl });
    expect(bad.status().notices.join('\n')).toMatch(/nhà cung cấp/i);
    await bad.dispose();
  });

  it('test(): thành công trả số model; lỗi mạng/HTTP trả ok=false kèm lý do, không ném', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, OLLAMA, 'vi');
    const good = gateway();
    const mk = (fetchImpl: typeof fetch) => new CliProviders({ home, env: cleanEnv(), version: '1', settings: new SettingsStore({ home, cwd: tmpDir('lc-cwd-'), env: cleanEnv(), trusted: () => true }), fetchImpl, log: () => undefined, lang: () => 'vi' });
    const a = await mk(good.fetchImpl).test('ollama');
    expect(a).toMatchObject({ ok: true, models: 2 });
    expect(good.seen[0]!.url.startsWith('http://localhost:11434/v1/models')).toBe(true);
    // Từ chối kết nối: báo NGAY (không đợi vòng thử lại 1+2+4+8 giây) và đúng nguyên nhân.
    const refused = await mk((async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }) });
    }) as unknown as typeof fetch).test('ollama');
    expect(refused).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(refused.error).toMatch(/ECONNREFUSED|từ chối|kết nối/i);
    expect(refused.ms).toBeLessThan(2000);
    // Máy chủ từ chối khoá
    const unauthorized = await mk((async () => new Response('{"error":"bad key"}', { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch).test('ollama');
    expect(unauthorized).toMatchObject({ ok: false, reason: 'auth' });
    // Máy chủ trả lời nhưng không có /models
    const noModels = await mk((async () => new Response('not found', { status: 404 })) as unknown as typeof fetch).test('ollama');
    expect(noModels).toMatchObject({ ok: false, reason: 'no-models' });
    // Treo mãi: bị cắt đúng hạn, nói rõ là quá giờ
    const slow = await mk((() => new Promise(() => undefined)) as unknown as typeof fetch).test('ollama', 120);
    expect(slow).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(slow.error).toMatch(/Quá 1 giây/);
    expect(slow.ms).toBeLessThan(2000);
    // Ping qua, /models hỏng sau đó: vẫn tính là thông (chỉ không đếm được model)
    let calls = 0;
    const flaky = await mk((async () => {
      calls++;
      return calls === 1 ? new Response('{"object":"list","data":[]}', { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('boom', { status: 500 });
    }) as unknown as typeof fetch).test('ollama', 600);
    expect(flaky.ok).toBe(true);
  });

  it('listModels() (cho /model): API ghim model hiện đủ model ghim dù /models hỏng; API cần khoá mà chưa có khoá thì không hiện; có khoá đã lưu thì hiện', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, OLLAMA, 'vi');
    upsertCustomProvider(home, GROQ, 'vi');
    const notFound = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const mk = () => new CliProviders({ home, env: cleanEnv(), version: '1', settings: new SettingsStore({ home, cwd: tmpDir('lc-cwd-'), env: cleanEnv(), trusted: () => true }), fetchImpl: notFound, log: () => undefined, lang: () => 'vi' });
    const before = await mk().listModels(1500);
    expect(before.map((g) => g.providerId)).toEqual(['ollama']);
    expect(before[0]!.models.map((m) => m.id)).toEqual(['qwen3-coder']);
    saveStoredKey(home, 'groq', 'gsk-list-0012', GROQ.baseUrl);
    const after = mk();
    expect((await after.listModels(1500)).map((g) => g.providerId).sort()).toEqual(['groq', 'ollama']);
  });

  it('hasPinnedModels(): chỉ API tuỳ chỉnh có "models" mới tính', async () => {
    const home = tmpDir('lc-home-');
    upsertCustomProvider(home, OLLAMA, 'vi');
    upsertCustomProvider(home, GROQ, 'vi');
    const prov = new CliProviders({ home, env: cleanEnv(), version: '1', settings: new SettingsStore({ home, cwd: tmpDir('lc-cwd-'), env: cleanEnv(), trusted: () => true }), log: () => undefined, lang: () => 'vi' });
    expect(prov.hasPinnedModels('ollama')).toBe(true);
    expect(prov.hasPinnedModels('groq')).toBe(false);
    expect(prov.hasPinnedModels('deepseek')).toBe(false);
    expect(prov.hasPinnedModels('không-có')).toBe(false);
  });
});
