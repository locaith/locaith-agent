import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

/**
 * Đầu-cuối: một máy chủ giả OpenAI-compatible (gọi công cụ ở lần 1, trả lời ở lần 2) để chứng minh
 * vòng lặp agent + công cụ của CLI chạy đúng, mã thoát đúng, và không crash khi thoát (lỗi libuv trên Windows đã từng gặp).
 */
const root = path.resolve(__dirname, '..');
let dir = '';
let bin = '';
let server: http.Server;
let base = '';

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-cli-e2e-'));
  bin = path.join(dir, 'locaith.cjs');
  writeFileSync(path.join(dir, 'sample.txt'), 'ALPHA\nBETA\n');
  await build({ entryPoints: [path.join(root, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', loader: { '.md': 'text' }, outfile: bin, logLevel: 'silent' });
  let n = 0;
  const calls: Record<string, unknown>[] = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if ((req.url ?? '').includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'locaith-v5-flash', object: 'model' }] }));
      }
      const j = JSON.parse(body || '{}');
      calls.push({ model: j.model, tools: (j.tools ?? []).map((t: { function?: { name?: string } }) => t.function?.name), hasToolResult: JSON.stringify(j.messages ?? []).includes('tool_call_id') });
      n++;
      const toolRound = calls[calls.length - 1].hasToolResult !== true;
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (!j.stream) {
        const msg = toolRound
          ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"sample.txt"}' } }] }
          : { role: 'assistant', content: 'Tệp có 2 dòng: ALPHA và BETA.' };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: `c${n}`, object: 'chat.completion', created: 0, model: j.model, choices: [{ index: 0, message: msg, finish_reason: toolRound ? 'tool_calls' : 'stop' }], usage }));
      }
      // Bản thật đi đường stream (SSE): máy chủ giả phải trả đúng định dạng đó, nếu không CLI báo lỗi parse.
      const base = { id: `c${n}`, object: 'chat.completion.chunk', created: 0, model: j.model };
      const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ role: 'assistant', content: '' }, null));
      if (toolRound) {
        res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }, null));
        res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"sample.txt"}' } }] }, null));
        res.write(chunk({}, 'tool_calls', { usage }));
      } else {
        for (const piece of ['Tệp có 2 dòng: ', 'ALPHA và BETA.']) res.write(chunk({ content: piece }, null));
        res.write(chunk({}, 'stop', { usage }));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  void toolCalls;
  void apiCalls;
  // Ghi lại để bài kiểm đọc được
  (globalThis as Record<string, unknown>).__cliCalls = calls;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const toolCalls: unknown[] = [];
const apiCalls: unknown[] = [];

/** Chạy CLI, trả mã thoát + stdout/stderr (tách riêng để kiểm stderr rỗng). */
function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'LOCAITH_API_KEY' && k !== 'LOCAITH_TOKEN') env[k] = v;
  env.LOCAITH_API_KEY = 'lat_poc_fake';
  env.HOME = dir;
  env.USERPROFILE = dir;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('Locaith CLI — chạy đầu-cuối với API tương thích OpenAI', () => {
  it('--json: vòng lặp công cụ chạy 2 lượt, câu trả lời đúng, mã thoát 0, stderr rỗng', async () => {
    const r = await run(['ask', 'đọc sample.txt', '--base-url', base, '--cwd', dir, '--allow', 'reads', '--json', '--max-turns', '5']);
    expect(r.err.trim()).toBe(''); // không crash, không cảnh báo
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ ok: true, stopReason: 'end_turn', turns: 2, model: 'locaith-v5-flash' });
    expect(j.text).toBe('Tệp có 2 dòng: ALPHA và BETA.');
    const calls = (globalThis as Record<string, unknown>).__cliCalls as Record<string, unknown>[];
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe('locaith-v5-flash');
    expect(calls[0].tools).toEqual(expect.arrayContaining(['read_file']));
    expect(calls[1].hasToolResult).toBe(true); // lượt 2 phải mang kết quả công cụ về cho model
  });

  it('chế độ người đọc: in câu trả lời và dòng thống kê ở stderr, mã thoát 0', async () => {
    const r = await run(['ask', 'đọc sample.txt', '--base-url', base, '--cwd', dir, '--allow', 'reads', '--max-turns', '5']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ALPHA và BETA');
    expect(r.err).toMatch(/vòng · .* token/); // tiến trình/thống kê đi stderr để stdout sạch cho script
  });

  it('--quiet: chỉ câu trả lời trên stdout', async () => {
    const r = await run(['ask', 'đọc sample.txt', '--base-url', base, '--cwd', dir, '--allow', 'reads', '--quiet', '--max-turns', '5']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('Tệp có 2 dòng: ALPHA và BETA.');
  });

  // (0.4.4) Báo cáo đánh giá 08/11, mục 4: sai tham số in dòng lỗi rồi nối cả trang help (38 dòng) làm dòng lỗi chìm đi.
  it('sai tham số: CHỈ dòng lỗi + gợi ý --help (không in cả trang help), mã thoát 2', async () => {
    const bads: string[][] = [['--max-turns', 'abc'], ['--timeout', '-5'], ['--lang', 'fr'], ['--permission-mode', 'linhtinh'], ['--output-format', 'xml'], ['--khong-co-co-nay']];
    for (const bad of bads) {
      const r = await run(['-p', ...bad, 'hi']);
      expect(r.code, bad.join(' ')).toBe(2);
      const lines = r.err.trim().split(/\r?\n/);
      expect(lines.length, r.err).toBeLessThanOrEqual(3);
      expect(r.err, bad.join(' ')).toContain('--help');
      expect(r.err, 'không được in trang help').not.toContain('Locaith CLI ');
      expect(r.out).toBe('');
    }
  });

  // (0.4.4) mục 3: `--cwd` không tồn tại vẫn chạy với mã 0 / "success"; CI tưởng đã chạy đúng thư mục.
  it('--cwd không tồn tại hoặc không phải thư mục: dừng ngay với mã 2, KHÔNG gọi model', async () => {
    const calls = (globalThis as Record<string, unknown>).__cliCalls as unknown[];
    const before = calls.length;
    const missing = path.join(dir, 'khong-co-thu-muc-nay');
    const r = await run(['-p', 'hi', '--cwd', missing, '--base-url', base]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--cwd');
    expect(r.err).toContain(missing);
    const j = await run(['-p', '--output-format', 'json', 'hi', '--cwd', missing, '--base-url', base]);
    expect(j.code).toBe(2);
    expect(JSON.parse(j.out)).toMatchObject({ ok: false });
    expect(String(JSON.parse(j.out).error)).toContain(missing);
    const f = await run(['-p', 'hi', '--cwd', path.join(dir, 'sample.txt'), '--base-url', base]); // một TỆP, không phải thư mục
    expect(f.code).toBe(2);
    expect(f.err).toContain('--cwd');
    expect(calls.length, 'không được gọi model khi --cwd sai').toBe(before);
  });

  it('--cwd là thư mục thật vẫn chạy bình thường (không làm hỏng ca đúng)', async () => {
    const r = await run(['-p', 'đọc sample.txt', '--cwd', dir, '--base-url', base, '--allow', 'reads', '--max-turns', '5']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ALPHA và BETA');
  });

  it('--json: lỗi mạng được báo bằng JSON và mã thoát 1', async () => {
    const r = await run(['ask', 'x', '--base-url', 'http://127.0.0.1:1/v1', '--cwd', dir, '--json']);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(false);
    expect(String(j.error).length).toBeGreaterThan(3);
    // Cổng không tới được: bộ thử lại dùng chung với extension (4 lần, 1+2+4+8 giây) rồi mới báo lỗi; cộng 3 giây chờ stdin ngỏ.
  }, 60_000);
});
