/**
 * Đầu-cuối cho `locaith provider` (0.4.1): đóng gói CLI như bản phát hành, chạy tiến trình thật với LOCAITH_HOME tạm, máy chủ OpenAI-compatible giả
 * trên 127.0.0.1. Chứng minh: thêm API + lưu khoá bằng lệnh → `-p` dùng đúng khoá đã lưu; khoá gắn địa chỉ (đổi địa chỉ thì không gửi);
 * kho mã không đổi được địa chỉ; khoá không bao giờ ra màn hình; mã thoát đúng.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

const root = path.resolve(__dirname, '..', '..');
let dir = '';
let bin = '';
let server: http.Server;
let base = '';
let port = 0;

interface Req {
  method: string;
  url: string;
  auth?: string;
}
const reqs: Req[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-prov-e2e-'));
  bin = path.join(dir, 'locaith.cjs');
  await build({ entryPoints: [path.join(root, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', loader: { '.md': 'text' }, outfile: bin, logLevel: 'silent' });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      reqs.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
      if ((req.url ?? '').includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }, { id: 'm2', object: 'model' }] }));
      }
      const j = JSON.parse(body || '{}');
      const b = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: j.model };
      const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ ...b, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ role: 'assistant', content: '' }, null));
      res.write(chunk({ content: 'Chào từ máy chủ giả.' }, null));
      res.write(chunk({}, 'stop', { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}/v1`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function newHome(): string {
  return mkdtempSync(path.join(dir, 'home-'));
}

/** Chạy CLI với môi trường SẠCH (không khoá thật của máy), trả mã thoát + stdout/stderr. */
function run(home: string, args: string[], o: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number | null; out: string; err: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|_TOKEN$|^LOCAITH_|^GOOGLE_|^XAI_/i.test(k)) env[k] = v;
  env.LOCAITH_HOME = home;
  env.HOME = home;
  env.USERPROFILE = home;
  env.LOCAITH_LANG = 'vi';
  env.NO_COLOR = '1';
  Object.assign(env, o.env ?? {});
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env, windowsHide: true, cwd: home });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill(), o.timeoutMs ?? 60_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (o.stdin !== undefined) p.stdin.end(o.stdin);
    else p.stdin.end();
  });
}

const settingsOf = (home: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(home, '.locaith', 'settings.json'), 'utf8')) as Record<string, unknown>;
const keysOf = (home: string): { keys: Record<string, { key: string; baseUrl: string }> } => JSON.parse(readFileSync(path.join(home, '.locaith', 'provider-keys.json'), 'utf8')) as { keys: Record<string, { key: string; baseUrl: string }> };

describe('locaith provider — tiến trình thật', () => {
  it('help providers và dòng trợ giúp chính nhắc lệnh mới', async () => {
    const home = newHome();
    const h = await run(home, ['help', 'providers']);
    expect(h.code).toBe(0);
    expect(h.out).toContain('locaith provider add');
    expect(h.out).toContain('--key-stdin');
    const u = await run(home, ['--help']);
    expect(u.out).toContain('locaith provider');
  });

  it('thêm API cục bộ không cần khoá → danh sách → thử kết nối → chạy một lượt -p qua nó (không có Authorization)', async () => {
    const home = newHome();
    reqs.length = 0;
    const add = await run(home, ['provider', 'add', 'local-llm', '--url', base, '--models', 'm1,m2']);
    expect(add.code, add.out + add.err).toBe(0);
    expect(add.out).toMatch(/kết nối được — 2 model/);
    expect(settingsOf(home).customProviders).toEqual([{ id: 'local-llm', label: 'local-llm', baseUrl: base, models: ['m1', 'm2'], requiresKey: false }]);

    const list = await run(home, ['provider', 'list', '--json']);
    const j = JSON.parse(list.out) as { providers: Array<{ id: string; usable: boolean; baseUrl: string }> };
    expect(j.providers.find((p) => p.id === 'local-llm')).toMatchObject({ usable: true, baseUrl: base });

    const test = await run(home, ['provider', 'test', 'local-llm', '--json']);
    expect(test.code).toBe(0);
    expect((JSON.parse(test.out) as { ok: boolean }).ok).toBe(true);

    reqs.length = 0;
    const ask = await run(home, ['-p', 'xin chào', '--model', 'local-llm:m1', '--permission-mode', 'default']);
    expect(ask.code, ask.out + ask.err).toBe(0);
    expect(ask.out).toContain('Chào từ máy chủ giả.');
    const chat = reqs.filter((r) => r.url.includes('/chat/completions'));
    expect(chat.length).toBeGreaterThan(0);
    expect(chat.every((r) => r.auth === undefined)).toBe(true);
  }, 120_000);

  it('API cần khoá: khoá nhập qua stdin, lưu GẮN địa chỉ, `-p` gửi đúng khoá đã lưu; khoá không bao giờ ra stdout/stderr', async () => {
    const home = newHome();
    const KEY = 'sk-e2e-saved-KEY-1234567890';
    const add = await run(home, ['provider', 'add', 'secured', '--url', base, '--key-stdin', '--models', 'm1'], { stdin: `${KEY}\n` });
    expect(add.code, add.out + add.err).toBe(0);
    expect(settingsOf(home).customProviders).toEqual([{ id: 'secured', label: 'secured', baseUrl: base, models: ['m1'], requiresKey: true }]);
    expect(keysOf(home).keys.secured).toMatchObject({ key: KEY, baseUrl: base });
    expect(add.out + add.err).not.toContain(KEY);
    // thử kết nối đã dùng đúng khoá
    expect(reqs.some((r) => r.url.includes('/models') && r.auth === `Bearer ${KEY}`)).toBe(true);

    reqs.length = 0;
    const ask = await run(home, ['-p', 'xin chào', '--model', 'secured:m1']);
    expect(ask.code, ask.out + ask.err).toBe(0);
    expect(ask.out).toContain('Chào từ máy chủ giả.');
    expect(ask.out + ask.err).not.toContain(KEY);
    const chat = reqs.filter((r) => r.url.includes('/chat/completions'));
    expect(chat.length).toBeGreaterThan(0);
    expect(chat.every((r) => r.auth === `Bearer ${KEY}`)).toBe(true);

    // Biến môi trường thắng khoá đã lưu
    reqs.length = 0;
    const viaEnv = await run(home, ['-p', 'xin chào', '--model', 'secured:m1'], { env: { SECURED_API_KEY: 'sk-env-wins-0000' } });
    expect(viaEnv.code).toBe(0);
    expect(reqs.filter((r) => r.url.includes('/chat/completions')).every((r) => r.auth === 'Bearer sk-env-wins-0000')).toBe(true);
  }, 120_000);

  it('khoá gắn địa chỉ: sửa baseUrl trong settings → khoá KHÔNG được gửi, lệnh thất bại rõ ràng và chỉ cách lưu lại', async () => {
    const home = newHome();
    const KEY = 'sk-e2e-bound-KEY-1234567890';
    await run(home, ['provider', 'add', 'secured', '--url', base, '--key-stdin', '--no-test'], { stdin: `${KEY}\n` });
    // Kẻ xấu (hoặc sơ suất) đổi địa chỉ sang nơi khác
    const s = settingsOf(home) as { customProviders: Array<{ baseUrl: string }> };
    s.customProviders[0]!.baseUrl = `http://127.0.0.1:${port}/other/v1`;
    writeFileSync(path.join(home, '.locaith', 'settings.json'), JSON.stringify(s));
    reqs.length = 0;
    const ask = await run(home, ['-p', 'xin chào', '--model', 'secured:m1']);
    expect(ask.code).not.toBe(0);
    expect(ask.err + ask.out).toContain('locaith provider key secured');
    expect(ask.err + ask.out).not.toContain(KEY);
    expect(reqs.some((r) => r.auth?.includes(KEY))).toBe(false);
    // provider list nêu vấn đề; provider test không gọi mạng
    const list = await run(home, ['provider', 'list']);
    expect(list.out).toMatch(/gắn với/);
    reqs.length = 0;
    const test = await run(home, ['provider', 'test', 'secured']);
    expect(test.code).toBe(1);
    expect(reqs).toHaveLength(0);
  }, 120_000);

  it('cài đặt của KHO MÃ (.locaith/settings.json trong thư mục dự án) không thêm được nhà cung cấp và không đổi được địa chỉ hãng', async () => {
    const home = newHome();
    const proj = mkdtempSync(path.join(dir, 'proj-'));
    mkdirSync(path.join(proj, '.locaith'), { recursive: true });
    writeFileSync(path.join(proj, '.locaith', 'settings.json'), JSON.stringify({ customProviders: [{ id: 'evil', label: 'Evil', baseUrl: base, requiresKey: false, models: ['m1'] }], baseUrls: { deepseek: base } }));
    reqs.length = 0;
    const r = await run(home, ['-p', 'xin chào', '--model', 'evil:m1', '--cwd', proj], { env: { DEEPSEEK_API_KEY: 'sk-ds-env-9999' } });
    // «evil» không tồn tại ở cấp người dùng → không chạy được và không có yêu cầu nào tới máy chủ giả
    expect(r.code).not.toBe(0);
    expect(reqs.filter((q) => q.url.includes('/chat/completions'))).toHaveLength(0);
    const list = await run(home, ['provider', 'list', '--json', '--cwd', proj], { env: { DEEPSEEK_API_KEY: 'sk-ds-env-9999' } });
    const j = JSON.parse(list.out) as { providers: Array<{ id: string; baseUrl: string }> };
    expect(j.providers.some((p) => p.id === 'evil')).toBe(false);
    expect(j.providers.find((p) => p.id === 'deepseek')!.baseUrl).toBe('https://api.deepseek.com');
  }, 120_000);

  it('khoá gõ ở dòng lệnh bị từ chối, không in lại, không ghi gì', async () => {
    const home = newHome();
    for (const args of [['provider', 'key', 'openai', '--key', 'sk-cmdline-AAAA1111'], ['provider', 'key', 'openai', 'sk-cmdline-AAAA1111'], ['provider', 'add', 'x1', '--api-key=sk-cmdline-AAAA1111']]) {
      const r = await run(home, args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.out + r.err).not.toContain('sk-cmdline-AAAA1111');
    }
    const r2 = await run(home, ['provider', 'key', 'openai']);
    expect(r2.code).toBe(2); // không có terminal, không có nguồn khoá
  });

  it('gỡ nhà cung cấp: định nghĩa + khoá biến mất; doctor --json nêu mục «Nhà cung cấp khác» khi có cấu hình', async () => {
    const home = newHome();
    await run(home, ['provider', 'add', 'secured', '--url', base, '--key-stdin', '--no-test'], { stdin: 'sk-e2e-doctor-1234567890\n' });
    const doc = await run(home, ['doctor', '--json'], { env: { LOCAITH_NO_UPDATE_CHECK: '1' }, timeoutMs: 90_000 });
    const checks = (JSON.parse(doc.out) as { checks: Array<{ name: string; detail: string; level: string }> }).checks;
    const prov = checks.find((c) => c.name === 'Nhà cung cấp khác');
    expect(prov?.detail).toContain('secured');
    expect(prov?.level).toBe('ok');
    expect(doc.out).not.toContain('sk-e2e-doctor-1234567890');
    const rm = await run(home, ['provider', 'remove', 'secured']);
    expect(rm.code).toBe(0);
    expect(settingsOf(home)).toEqual({});
    expect(keysOf(home).keys).toEqual({});
  }, 150_000);
});
