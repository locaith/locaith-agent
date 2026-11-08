import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageError, parseArgs } from '../../src/cli/args';
import { runProviderCommand, type ProviderCmdDeps } from '../../src/cli/providerCmd';
import { providerKeysFile, readStoredKeys, readUserCustomRaw, saveStoredKey, upsertCustomProvider, userSettingsFile } from '../../src/cli/providerStore';
import type { WizardIO } from '../../src/cli/providerWizard';

const dirs: string[] = [];
function tmp(prefix = 'lc-pcmd-'): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface Seen {
  url: string;
  auth?: string;
}

/** Máy chủ giả: GET .../models trả hai model (hoặc theo `behave`); ghi lại URL + Authorization. */
function fakeNet(behave: (url: string) => Response | Promise<Response> = () => new Response(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }, { id: 'm2', object: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    seen.push({ url: String(input), auth: headers.authorization });
    return behave(String(input));
  }) as typeof fetch;
  return { seen, fetchImpl };
}

interface RunOpts {
  home?: string;
  env?: Record<string, string>;
  stdin?: string;
  ui?: WizardIO;
  fetchImpl?: typeof fetch;
  lang?: 'vi' | 'en';
}

async function run(argv: string[], o: RunOpts = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const home = o.home ?? tmp('lc-home-');
  const d: ProviderCmdDeps = {
    home,
    env: o.env ?? {},
    cwd: tmp('lc-cwd-'),
    lang: o.lang ?? 'vi',
    version: '9.9.9-test',
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    isTTY: !!o.ui,
    readStdin: async () => o.stdin ?? '',
    ...(o.ui ? { withUi: <T>(fn: (io: WizardIO) => Promise<T>) => fn(o.ui!) } : {}),
    fetchImpl: o.fetchImpl ?? fakeNet().fetchImpl,
  };
  const code = await runProviderCommand(parseArgs(['provider', ...argv], d.cwd), d);
  return { code, out: out.join('\n'), err: err.join('\n'), all: [...out, ...err].join('\n'), home };
}

function scriptUi(answers: Array<string | boolean | null>) {
  let i = 0;
  const said: string[] = [];
  const asked: Array<{ kind: string; secret?: boolean }> = [];
  const take = (kind: string, secret?: boolean) => {
    asked.push({ kind, secret });
    if (i >= answers.length) throw new Error(`hết kịch bản (${kind})`);
    return answers[i++]!;
  };
  const io: WizardIO = {
    pick: async () => take('pick') as string | null,
    input: async (_t, _d, o) => take('input', o?.secret) as string | null,
    confirm: async () => take('confirm') as boolean | null,
    say: (_k, text) => void said.push(text),
  };
  return { io, said, asked };
}

describe('parseArgs cho `provider`', () => {
  it('hành động mặc định là list; tên hành động hạ chữ thường; đối số đi theo sau', () => {
    expect(parseArgs(['provider']).provider).toMatchObject({ action: 'list', args: [] });
    expect(parseArgs(['provider', 'ADD', 'openrouter']).provider).toMatchObject({ action: 'add', args: ['openrouter'] });
  });
  it('các cờ: --url --id --label --models --kind --no-key --key-stdin --key-env --remove --no-test (cả dạng --cờ=giá-trị)', () => {
    const p = parseArgs(['provider', 'add', 'x', '--url', 'https://a.b/v1', '--id=my', '--label', 'Của tôi', '--models', 'a, b;c', '--kind=openai-chat', '--no-key', '--key-stdin', '--key-env', 'FOO', '--remove', '--no-test']).provider!;
    expect(p).toMatchObject({ action: 'add', args: ['x'], url: 'https://a.b/v1', id: 'my', label: 'Của tôi', models: ['a', 'b', 'c'], kind: 'openai-chat', noKey: true, keyStdin: true, keyEnv: 'FOO', remove: true, noTest: true });
  });
  it('cờ của provider ngoài lệnh provider → lỗi dùng sai', () => {
    expect(() => parseArgs(['--url', 'https://a.b'])).toThrow(UsageError);
    expect(() => parseArgs(['-p', 'xin chào', '--key-stdin'])).toThrow(/locaith provider/);
  });
  it('KHÔNG nhận khoá ở dòng lệnh: --key/--api-key/--token bị từ chối và không in lại giá trị', () => {
    for (const argv of [['provider', 'key', 'openai', '--key', 'sk-secret-AAAA'], ['provider', 'key', 'openai', '--key=sk-secret-AAAA'], ['provider', 'add', 'x', '--api-key=sk-secret-AAAA'], ['provider', 'add', 'x', '--token', 'sk-secret-AAAA']]) {
      let msg = '';
      try {
        parseArgs(argv);
      } catch (e) {
        msg = (e as Error).message;
        expect(e).toBeInstanceOf(UsageError);
      }
      expect(msg).toMatch(/không nhận khoá ở dòng lệnh/);
      expect(msg).not.toContain('sk-secret-AAAA');
    }
  });
  it('cờ lạ dạng --cờ=giá-trị chỉ in tên cờ (giá trị có thể là khoá)', () => {
    let msg = '';
    try {
      parseArgs(['provider', 'add', 'x', '--bearer=sk-secret-BBBB']);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('--bearer');
    expect(msg).not.toContain('sk-secret-BBBB');
  });
});

describe('provider list', () => {
  it('máy mới: liệt kê các hãng dựng sẵn, chưa có khoá, exit 0', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    for (const id of ['anthropic', 'openai', 'gemini', 'deepseek', 'xai']) expect(r.out).toContain(id);
    expect(r.out).not.toContain('demo');
  });
  it('--json: danh sách có cấu trúc + problems, không lộ khoá', async () => {
    const home = tmp('lc-home-');
    saveStoredKey(home, 'deepseek', 'sk-ds-secret-1234', 'https://api.deepseek.com');
    upsertCustomProvider(home, { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', requiresKey: false }, 'vi');
    const r = await run(['list', '--json'], { home, env: { OPENAI_API_KEY: 'sk-oa-secret-5678' } });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { providers: Array<{ id: string; usable: boolean; key: { source: string } }>; problems: string[] };
    const by = Object.fromEntries(j.providers.map((p) => [p.id, p]));
    expect(by.deepseek).toMatchObject({ usable: true, key: { source: 'saved' } });
    expect(by.openai).toMatchObject({ usable: true, key: { source: 'env' } });
    expect(by.ollama).toMatchObject({ usable: true, key: { source: 'not-required' } });
    expect(j.problems).toEqual([]);
    expect(r.out).not.toContain('sk-ds-secret-1234');
    expect(r.out).not.toContain('sk-oa-secret-5678');
  });
  it('mục cấu hình sai hiện ở phần vấn đề, kèm lý do', async () => {
    const home = tmp('lc-home-');
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(userSettingsFile(home), JSON.stringify({ customProviders: [{ id: 'bad', baseUrl: 'http://api.example.com/v1' }] }));
    const r = await run(['list'], { home });
    expect(r.out).toContain('api.example.com');
  });
});

describe('provider add', () => {
  it('OpenRouter + khoá từ stdin: ghi định nghĩa, lưu khoá gắn địa chỉ, thử kết nối bằng đúng khoá; khoá không lọt ra màn hình', async () => {
    const net = fakeNet();
    const r = await run(['add', 'openrouter', '--key-stdin'], { stdin: 'sk-or-v1-abc123456\n', fetchImpl: net.fetchImpl });
    expect(r.code).toBe(0);
    expect(readUserCustomRaw(r.home)).toEqual([{ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true, keyUrl: 'https://openrouter.ai/keys' }]);
    expect(readStoredKeys(r.home).keys.openrouter).toMatchObject({ key: 'sk-or-v1-abc123456', baseUrl: 'https://openrouter.ai/api/v1' });
    expect(net.seen.length).toBeGreaterThan(0);
    expect(net.seen.every((s) => s.url.startsWith('https://openrouter.ai/api/v1/models'))).toBe(true);
    expect(net.seen.every((s) => s.auth === 'Bearer sk-or-v1-abc123456')).toBe(true);
    expect(r.out).toMatch(/kết nối được/);
    expect(r.all).not.toContain('sk-or-v1-abc123456');
    if (process.platform !== 'win32') expect(fs.statSync(providerKeysFile(r.home)).mode & 0o777).toBe(0o600);
  });

  it('Ollama: không cần khoá, không tạo tệp khoá, thử kết nối không gửi Authorization, --models ghim model', async () => {
    const net = fakeNet();
    const r = await run(['add', 'ollama', '--models', 'qwen3-coder,llama3.3'], { fetchImpl: net.fetchImpl });
    expect(r.code).toBe(0);
    expect(readUserCustomRaw(r.home)).toEqual([{ id: 'ollama', label: 'Ollama (máy cục bộ)', baseUrl: 'http://localhost:11434/v1', models: ['qwen3-coder', 'llama3.3'], requiresKey: false }]);
    expect(fs.existsSync(providerKeysFile(r.home))).toBe(false);
    expect(net.seen[0]!.url.startsWith('http://localhost:11434/v1/models')).toBe(true);
    expect(net.seen[0]!.auth).toBeUndefined();
  });

  it('API riêng: --url + --key-env đọc khoá từ biến môi trường tên đó', async () => {
    const r = await run(['add', 'my-llm', '--url', 'https://llm.example.com/v1', '--label', 'LLM của tôi', '--key-env', 'MY_SECRET_VAR', '--no-test'], { env: { MY_SECRET_VAR: 'sk-mine-12345678' } });
    expect(r.code).toBe(0);
    expect(readUserCustomRaw(r.home)).toEqual([{ id: 'my-llm', label: 'LLM của tôi', baseUrl: 'https://llm.example.com/v1', requiresKey: true }]);
    expect(readStoredKeys(r.home).keys['my-llm']).toMatchObject({ key: 'sk-mine-12345678', baseUrl: 'https://llm.example.com/v1' });
    expect(r.all).not.toContain('sk-mine-12345678');
  });

  it('API https không có khoá, không có terminal → vẫn thêm, nhắc đặt biến <ID>_API_KEY hoặc `provider key`', async () => {
    const r = await run(['add', 'my-llm', '--url', 'https://llm.example.com/v1', '--no-test']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('MY_LLM_API_KEY');
    expect(r.out).toContain('locaith provider key my-llm');
    expect(readStoredKeys(r.home).keys).toEqual({});
  });

  it('http tới mạng nội bộ: mặc định KHÔNG cần khoá; http tới máy công cộng bị từ chối (exit 2, nêu máy chủ, không ghi gì)', async () => {
    const ok = await run(['add', 'nas', '--url', 'http://192.168.1.50:8000/v1', '--no-test']);
    expect(ok.code).toBe(0);
    expect(readUserCustomRaw(ok.home)).toEqual([{ id: 'nas', label: 'nas', baseUrl: 'http://192.168.1.50:8000/v1', requiresKey: false }]);
    const bad = await run(['add', 'pub', '--url', 'http://api.example.com/v1', '--no-test']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('api.example.com');
    expect(fs.existsSync(userSettingsFile(bad.home))).toBe(false);
  });

  it('đưa nguồn khoá cho địa chỉ http cục bộ → hiểu là API này CẦN khoá (proxy cục bộ có khoá); http mạng nội bộ + khoá bị từ chối vì khoá đi dạng thô', async () => {
    const ok = await run(['add', 'proxy', '--url', 'http://127.0.0.1:8080/v1', '--key-stdin', '--no-test'], { stdin: 'sk-proxy-12345678\n' });
    expect(ok.code).toBe(0);
    expect(readUserCustomRaw(ok.home)).toEqual([{ id: 'proxy', label: 'proxy', baseUrl: 'http://127.0.0.1:8080/v1', requiresKey: true }]);
    expect(readStoredKeys(ok.home).keys.proxy).toMatchObject({ key: 'sk-proxy-12345678', baseUrl: 'http://127.0.0.1:8080/v1' });
    const lan = await run(['add', 'proxy', '--url', 'http://192.168.1.5:8080/v1', '--key-stdin', '--no-test'], { stdin: 'sk-proxy-12345678\n' });
    expect(lan.code).toBe(2);
    expect(lan.err).toContain('192.168.1.5');
    expect(fs.existsSync(userSettingsFile(lan.home))).toBe(false);
    expect(fs.existsSync(providerKeysFile(lan.home))).toBe(false);
  });

  it('khoá không có nghĩa với API không cần khoá → exit 2', async () => {
    const r = await run(['add', 'ollama', '--key-stdin'], { stdin: 'sk-xyz-12345678\n' });
    expect(r.code).toBe(2);
    expect(fs.existsSync(userSettingsFile(r.home))).toBe(false);
  });

  it('id sai dạng / dành riêng / thiếu địa chỉ / kind lạ / hai nguồn khoá → exit 2, không ghi', async () => {
    const cases: string[][] = [
      ['add', 'BAD ID', '--url', 'https://a.example/v1'],
      ['add', 'locaith', '--url', 'https://a.example/v1'],
      ['add', 'no-url'],
      ['add', 'k1', '--url', 'https://a.example/v1', '--kind', 'soap'],
      ['add', 'k2', '--url', 'https://a.example/v1', '--key-stdin', '--key-env', 'X'],
    ];
    for (const argv of cases) {
      const r = await run(argv, { stdin: 'sk-x-12345678', env: { X: 'sk-y-12345678' } });
      expect(r.code, argv.join(' ')).toBe(2);
      expect(fs.existsSync(userSettingsFile(r.home)), argv.join(' ')).toBe(false);
    }
  });

  it('khoá từ stdin sai dạng hoặc rỗng → exit 2, không ghi định nghĩa, không in lại khoá', async () => {
    const bad = await run(['add', 'x1', '--url', 'https://a.example/v1', '--key-stdin'], { stdin: 'sk co khoang trang' });
    expect(bad.code).toBe(2);
    expect(bad.all).not.toContain('khoang trang');
    expect(fs.existsSync(userSettingsFile(bad.home))).toBe(false);
    const empty = await run(['add', 'x1', '--url', 'https://a.example/v1', '--key-stdin'], { stdin: '\n\n' });
    expect(empty.code).toBe(2);
    const noEnv = await run(['add', 'x1', '--url', 'https://a.example/v1', '--key-env', 'KHONG_CO']);
    expect(noEnv.code).toBe(2);
    expect(noEnv.err).toContain('KHONG_CO');
  });

  it('--kind hợp lệ được ghi; add hãng dựng sẵn (add openai) chuyển sang đặt khoá', async () => {
    const r = await run(['add', 'claude-proxy', '--url', 'https://proxy.example.com', '--kind', 'anthropic', '--no-test']);
    expect(r.code).toBe(0);
    expect(readUserCustomRaw(r.home)).toEqual([{ id: 'claude-proxy', label: 'claude-proxy', kind: 'anthropic', baseUrl: 'https://proxy.example.com', requiresKey: true }]);
    const v = await run(['add', 'openai', '--key-stdin', '--no-test'], { stdin: 'sk-oa-12345678\n' });
    expect(v.code).toBe(0);
    expect(readStoredKeys(v.home).keys.openai).toMatchObject({ key: 'sk-oa-12345678', baseUrl: 'https://api.openai.com/v1' });
    expect(fs.existsSync(userSettingsFile(v.home))).toBe(false);
  });

  it('thêm lại cùng id → thay định nghĩa (báo «đã cập nhật»), không nhân đôi', async () => {
    const home = tmp('lc-home-');
    await run(['add', 'ollama', '--no-test'], { home });
    const r = await run(['add', 'ollama', '--models', 'm9', '--no-test'], { home });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/cập nhật/);
    expect((readUserCustomRaw(home) as unknown[]).length).toBe(1);
  });

  it('không đối số và không có terminal → hướng dẫn cách dùng, exit 2', async () => {
    const r = await run(['add']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/locaith provider add/);
  });

  it('tệp cài đặt hỏng → không ghi đè (khỏi mất nội dung của người dùng), exit 1', async () => {
    const home = tmp('lc-home-');
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(userSettingsFile(home), '{ "language": ');
    const r = await run(['add', 'ollama', '--no-test'], { home });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/không ghi đè/);
    expect(fs.readFileSync(userSettingsFile(home), 'utf8')).toBe('{ "language": ');
  });

  it('thử kết nối thất bại KHÔNG làm lệnh thất bại (cấu hình vẫn được lưu); nói đúng nguyên nhân', async () => {
    const refuse = fakeNet(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    });
    const r = await run(['add', 'ollama'], { fetchImpl: refuse.fetchImpl });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/chưa kết nối được/);
    expect(readUserCustomRaw(r.home)).toHaveLength(1);
  });

  it('có terminal: thêm không đối số chạy trình hướng dẫn; add <mẫu> không kèm khoá thì hỏi khoá ở ô ẩn', async () => {
    const wiz = scriptUi(['p:groq', 'https://api.groq.com/openai/v1', 'groq', 'Groq', '', 'gsk-wiz-12345678']);
    const a = await run(['add'], { ui: wiz.io });
    expect(a.code).toBe(0);
    expect(readStoredKeys(a.home).keys.groq?.key).toBe('gsk-wiz-12345678');
    const ask = scriptUi(['gsk-ask-12345678']);
    const b = await run(['add', 'groq', '--no-test'], { ui: ask.io });
    expect(b.code).toBe(0);
    expect(ask.asked).toEqual([{ kind: 'input', secret: true }]);
    expect(readStoredKeys(b.home).keys.groq?.key).toBe('gsk-ask-12345678');
    // huỷ trình hướng dẫn → exit 1
    const c = await run(['add'], { ui: scriptUi([null]).io });
    expect(c.code).toBe(1);
  });
});

describe('provider key', () => {
  it('lưu khoá hãng dựng sẵn từ stdin (gắn địa chỉ mặc định), đổi khoá, xoá khoá', async () => {
    const home = tmp('lc-home-');
    const net = fakeNet();
    const a = await run(['key', 'openai', '--key-stdin'], { home, stdin: 'sk-oa-first-1234\n', fetchImpl: net.fetchImpl });
    expect(a.code).toBe(0);
    expect(readStoredKeys(home).keys.openai).toMatchObject({ key: 'sk-oa-first-1234', baseUrl: 'https://api.openai.com/v1' });
    expect(net.seen[0]!.auth).toBe('Bearer sk-oa-first-1234');
    await run(['key', 'openai', '--key-stdin', '--no-test'], { home, stdin: 'sk-oa-second-5678' });
    expect(readStoredKeys(home).keys.openai!.key).toBe('sk-oa-second-5678');
    const rm = await run(['key', 'openai', '--remove'], { home });
    expect(rm.code).toBe(0);
    expect(readStoredKeys(home).keys).toEqual({});
    const again = await run(['key', 'openai', '--remove'], { home });
    expect(again.code).toBe(1);
  });

  it('biến môi trường đang đặt thì nhắc rằng nó thắng khoá vừa lưu (khỏi khó hiểu vì sao khoá lưu không được dùng); không đặt thì không nhắc', async () => {
    const wins = await run(['key', 'openai', '--key-stdin', '--no-test'], { stdin: 'sk-oa-12345678\n', env: { OPENAI_API_KEY: 'sk-env-87654321' } });
    expect(wins.code).toBe(0);
    expect(wins.out).toMatch(/OPENAI_API_KEY.*ưu tiên/);
    expect(wins.all).not.toContain('sk-env-87654321');
    const plain = await run(['key', 'openai', '--key-stdin', '--no-test'], { stdin: 'sk-oa-12345678\n' });
    expect(plain.out).not.toContain('ưu tiên');
    const custom = await run(['add', 'my-llm', '--url', 'https://llm.example.com/v1', '--key-stdin', '--no-test'], { stdin: 'sk-mine-12345678\n', env: { MY_LLM_API_KEY: 'sk-env-0000' } });
    expect(custom.out).toMatch(/MY_LLM_API_KEY.*ưu tiên/);
  });

  it('--key-stdin khi stdin rỗng (người dùng quên đưa khoá qua ống) → exit 2 chỉ cách làm', async () => {
    const r = await run(['key', 'openai', '--key-stdin'], { stdin: '' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/echo/);
  });

  it('khoá cho API tuỳ chỉnh gắn địa chỉ của API đó; --key-env hoạt động', async () => {
    const home = tmp('lc-home-');
    upsertCustomProvider(home, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    const r = await run(['key', 'groq', '--key-env', 'MY_GROQ', '--no-test'], { home, env: { MY_GROQ: 'gsk-env-12345678' } });
    expect(r.code).toBe(0);
    expect(readStoredKeys(home).keys.groq).toMatchObject({ key: 'gsk-env-12345678', baseUrl: 'https://api.groq.com/openai/v1' });
  });

  it('hãng đã đổi địa chỉ bằng baseUrls → khoá mới gắn địa chỉ MỚI', async () => {
    const home = tmp('lc-home-');
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(userSettingsFile(home), JSON.stringify({ baseUrls: { deepseek: 'https://proxy.example.com/v1' } }));
    await run(['key', 'deepseek', '--key-stdin', '--no-test'], { home, stdin: 'sk-ds-12345678' });
    expect(readStoredKeys(home).keys.deepseek!.baseUrl).toBe('https://proxy.example.com/v1');
  });

  it('lỗi dùng sai: id lạ (1), «locaith» (2), thiếu nguồn khoá khi không có terminal (2), hai nguồn (2), đối số thừa/khoá gõ ở dòng lệnh (2, không in lại)', async () => {
    expect((await run(['key', 'khong-co', '--key-stdin'], { stdin: 'sk-x-12345678' })).code).toBe(1);
    expect((await run(['key', 'locaith', '--key-stdin'], { stdin: 'sk-x-12345678' })).code).toBe(2);
    expect((await run(['key', 'openai'])).code).toBe(2);
    expect((await run(['key'])).code).toBe(2);
    expect((await run(['key', 'openai', '--key-stdin', '--key-env', 'X'], { stdin: 'sk-x-12345678', env: { X: 'sk-y-12345678' } })).code).toBe(2);
    const extra = await run(['key', 'openai', 'sk-typed-on-cmdline-9999']);
    expect(extra.code).toBe(2);
    expect(extra.all).not.toContain('sk-typed-on-cmdline-9999');
    expect(extra.err).toMatch(/lịch sử shell/);
    expect(fs.existsSync(providerKeysFile(extra.home))).toBe(false);
  });

  it('có terminal: hỏi khoá ở ô ẩn; huỷ → exit 1; không có id → chọn từ danh sách', async () => {
    const ui = scriptUi(['sk-oa-typed-1234']);
    const a = await run(['key', 'openai', '--no-test'], { ui: ui.io });
    expect(a.code).toBe(0);
    expect(ui.asked).toEqual([{ kind: 'input', secret: true }]);
    expect(readStoredKeys(a.home).keys.openai!.key).toBe('sk-oa-typed-1234');
    expect((await run(['key', 'openai'], { ui: scriptUi([null]).io })).code).toBe(1);
    const pick = scriptUi(['deepseek', 'sk-ds-picked-1234']);
    const b = await run(['key', '--no-test'], { ui: pick.io });
    expect(b.code).toBe(0);
    expect(readStoredKeys(b.home).keys.deepseek!.key).toBe('sk-ds-picked-1234');
  });
});

describe('provider remove', () => {
  it('gỡ API tuỳ chỉnh + khoá của nó; nhắc nếu biến môi trường vẫn còn khoá', async () => {
    const home = tmp('lc-home-');
    upsertCustomProvider(home, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    saveStoredKey(home, 'groq', 'gsk-12345678', 'https://api.groq.com/openai/v1');
    const r = await run(['remove', 'groq'], { home, env: { GROQ_API_KEY: 'gsk-env-12345678' } });
    expect(r.code).toBe(0);
    expect(readUserCustomRaw(home)).toEqual([]);
    expect(readStoredKeys(home).keys).toEqual({});
    expect(r.out).toContain('GROQ_API_KEY');
  });
  it('lỗi: thiếu id (2), «locaith» (2), không có gì để gỡ (1)', async () => {
    expect((await run(['remove'])).code).toBe(2);
    expect((await run(['remove', 'locaith'])).code).toBe(2);
    expect((await run(['remove', 'khong-co'])).code).toBe(1);
  });
  it('bí danh rm/delete hoạt động', async () => {
    const home = tmp('lc-home-');
    saveStoredKey(home, 'openai', 'sk-oa-12345678', 'https://api.openai.com/v1');
    expect((await run(['rm', 'openai'], { home })).code).toBe(0);
  });
});

describe('provider test', () => {
  it('không có nhà cung cấp nào dùng được → nói rõ, exit 0', async () => {
    const r = await run(['test']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/chưa có|không có/i);
  });
  it('thử tất cả nhà cung cấp dùng được; thành công exit 0; --json có cấu trúc', async () => {
    const home = tmp('lc-home-');
    upsertCustomProvider(home, { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', requiresKey: false }, 'vi');
    saveStoredKey(home, 'deepseek', 'sk-ds-12345678', 'https://api.deepseek.com');
    const net = fakeNet();
    const r = await run(['test', '--json'], { home, fetchImpl: net.fetchImpl });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { ok: boolean; results: Array<{ id: string; ok: boolean; models?: number }> };
    expect(j.ok).toBe(true);
    expect(j.results.map((x) => x.id).sort()).toEqual(['deepseek', 'ollama']);
    expect(j.results.every((x) => x.ok && x.models === 2)).toBe(true);
    expect(r.out).not.toContain('sk-ds-12345678');
    expect(net.seen.find((s) => s.url.startsWith('https://api.deepseek.com'))!.auth).toBe('Bearer sk-ds-12345678');
  });
  it('một nhà cung cấp hỏng → exit 1 và nói đúng nguyên nhân từng cái', async () => {
    const home = tmp('lc-home-');
    upsertCustomProvider(home, { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', requiresKey: false }, 'vi');
    saveStoredKey(home, 'deepseek', 'sk-ds-12345678', 'https://api.deepseek.com');
    const net = fakeNet((url) => (url.includes('deepseek') ? new Response('{"error":"bad"}', { status: 401, headers: { 'content-type': 'application/json' } }) : new Response('{"object":"list","data":[]}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const r = await run(['test'], { home, fetchImpl: net.fetchImpl });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/✘ deepseek: máy chủ từ chối khoá/);
    expect(r.out).toMatch(/✔ ollama: kết nối được/);
  });
  it('test <id> chưa có khoá → exit 1, chỉ cách lưu khoá, KHÔNG gọi mạng; id lạ → exit 1', async () => {
    const home = tmp('lc-home-');
    upsertCustomProvider(home, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    const net = fakeNet();
    const r = await run(['test', 'groq'], { home, fetchImpl: net.fetchImpl });
    expect(r.code).toBe(1);
    expect(r.out).toContain('locaith provider key groq');
    expect(net.seen).toHaveLength(0);
    expect((await run(['test', 'khong-co'], { home })).code).toBe(1);
  });
  it('khoá đã lưu nhưng địa chỉ đã đổi → test báo chưa có khoá (khoá không được gửi), KHÔNG gọi mạng', async () => {
    const home = tmp('lc-home-');
    saveStoredKey(home, 'deepseek', 'sk-ds-12345678', 'https://api.deepseek.com');
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    fs.writeFileSync(userSettingsFile(home), JSON.stringify({ baseUrls: { deepseek: 'https://proxy.example.com/v1' } }));
    const net = fakeNet();
    const r = await run(['test', 'deepseek'], { home, fetchImpl: net.fetchImpl });
    expect(r.code).toBe(1);
    expect(net.seen).toHaveLength(0);
  });
});

describe('khác', () => {
  it('hành động lạ → exit 2 kèm cách dùng; tiếng Anh hoạt động', async () => {
    const r = await run(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('frobnicate');
    const en = await run(['add', 'xx', '--url', 'ftp://a.example'], { lang: 'en' });
    expect(en.code).toBe(2);
    expect(en.err).toMatch(/http/i);
  });
});
