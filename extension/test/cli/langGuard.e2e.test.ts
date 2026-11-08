/**
 * Đầu-cuối (0.7.4) cho CLI đóng gói như bản phát hành, tiến trình thật + máy chủ OpenAI-compatible giả trên 127.0.0.1:
 *  • «bị ra cả tiếng tàu»: model trả lời tiếng Trung sau «tiếp tục» → bị bỏ, hỏi lại một lần, người dùng chỉ thấy câu tiếng Việt;
 *    người dùng viết tiếng Trung thì không can thiệp;
 *  • KHÔNG còn trần vòng khi chạy tương tác: giá trị `agent.maxTurns` cũ trong settings.json (anh từng đặt 50) bị bỏ qua;
 *    cờ `--max-turns N` của chế độ in vẫn hoạt động.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

const root = path.resolve(__dirname, '..', '..');
const ZH = '好的，我继续完成这项工作。我会先检查文件，然后运行测试，最后向你报告结果。';
const VI = 'Đã làm tiếp: mọi thứ đều ổn.';

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
let dir = '';
let bin = '';
let server: http.Server;
let base = '';
/** Kịch bản cho các lần gọi /chat/completions theo thứ tự; hết thì trả `VI`. */
let script: Reply[] = [];
let bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-lang-e2e-'));
  bin = path.join(dir, 'locaith.cjs');
  await build({ entryPoints: [path.join(root, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', loader: { '.md': 'text' }, outfile: bin, logLevel: 'silent' });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if ((req.url ?? '').includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] }));
      }
      const j = JSON.parse(body || '{}');
      bodies.push(j);
      const next: Reply = script.shift() ?? { text: VI };
      const b = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: j.model };
      const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ ...b, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ role: 'assistant', content: '' }, null));
      const usage = { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
      if ('text' in next) {
        res.write(chunk({ content: next.text }, null));
        res.write(chunk({}, 'stop', usage));
      } else {
        res.write(chunk({ tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: 'function', function: { name: next.tool, arguments: JSON.stringify(next.args) } }] }, null));
        res.write(chunk({}, 'tool_calls', usage));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Thư mục nhà tạm đã khai báo nhà cung cấp `local` (+ cài đặt tuỳ chọn) và một thư mục làm việc. */
function newHome(settings: Record<string, unknown> = {}): { home: string; work: string } {
  const home = mkdtempSync(path.join(dir, 'home-'));
  const work = path.join(home, 'work');
  mkdirSync(path.join(home, '.locaith'), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, 'a.txt'), 'một\n');
  writeFileSync(
    path.join(home, '.locaith', 'settings.json'),
    JSON.stringify({ language: 'vi', agent: { verify: 'off', ...(settings.agent as object | undefined) }, customProviders: [{ id: 'local', label: 'local', baseUrl: base, models: ['m1'], requiresKey: false }] }),
  );
  writeFileSync(path.join(home, '.locaith', 'trusted.json'), JSON.stringify({ version: 1, trusted: [work] }));
  return { home, work };
}

function run(home: string, cwd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|_TOKEN$|^LOCAITH_|^GOOGLE_|^XAI_/i.test(k)) env[k] = v;
  Object.assign(env, { LOCAITH_HOME: home, HOME: home, USERPROFILE: home, LOCAITH_LANG: 'vi', NO_COLOR: '1' });
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env, windowsHide: true, cwd });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill(), 90_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    p.stdin.end();
  });
}

const lastUser = (b: (typeof bodies)[number]): string => JSON.stringify([...b.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
const reset = (s: Reply[]) => {
  script = s;
  bodies = [];
};

describe('locaith -p — chống trượt sang tiếng Trung (tiến trình thật)', () => {
  it('«tiếp tục» → model trả lời tiếng Trung: bị bỏ, hỏi lại MỘT lần kèm dòng nhắc, màn hình chỉ có câu tiếng Việt', async () => {
    const { home, work } = newHome();
    reset([{ text: ZH }, { text: VI }]);
    const r = await run(home, work, ['-p', 'tiếp tục', '--model', 'local:m1', '--permission-mode', 'default']);
    expect(r.code, r.out + r.err).toBe(0);
    expect(bodies).toHaveLength(2);
    expect(r.out).toContain(VI);
    expect(r.out).not.toMatch(/[一-鿿]/);
    // chỉ dẫn «tiếp tục» đã nói rõ ngôn ngữ; lần hỏi lại mang dòng nhắc ở cuối tin cuối
    expect(lastUser(bodies[0])).toContain('Trả lời bằng tiếng Việt');
    expect(lastUser(bodies[1])).toContain('sai ngôn ngữ');
    expect(lastUser(bodies[0])).not.toContain('sai ngôn ngữ');
  }, 120_000);

  it('người dùng viết tiếng Trung → trả lời tiếng Trung được giữ nguyên (một lần gọi)', async () => {
    const { home, work } = newHome();
    reset([{ text: ZH }]);
    const r = await run(home, work, ['-p', '请用中文写一句欢迎词', '--model', 'local:m1', '--permission-mode', 'default']);
    expect(r.code, r.out + r.err).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(r.out).toContain('我继续完成这项工作');
  }, 120_000);
});

describe('locaith -p — không còn trần vòng (tiến trình thật)', () => {
  const dirCalls = (n: number): Reply[] => Array.from({ length: n }, () => ({ tool: 'list_dir', args: { path: '.' } }));

  it('`agent.maxTurns: 1` cũ trong settings.json bị BỎ QUA: việc 4 vòng công cụ chạy tới cùng, không có thông báo «đạt số vòng tối đa»', async () => {
    const { home, work } = newHome({ agent: { maxTurns: 1 } });
    reset([...dirCalls(4), { text: 'Đã duyệt thư mục bốn lần và không thấy gì bất thường; không còn việc nào dở dang cần làm tiếp cho yêu cầu này.' }]);
    const r = await run(home, work, ['-p', 'duyệt thư mục', '--model', 'local:m1', '--permission-mode', 'default']);
    expect(r.code, r.out + r.err).toBe(0);
    expect(bodies.length).toBeGreaterThanOrEqual(5);
    expect(r.out).toContain('Đã duyệt thư mục bốn lần');
    expect(r.out + r.err).not.toMatch(/số vòng|vòng lặp tối đa/i);
  }, 120_000);

  it('cờ `--max-turns 2` của chế độ in vẫn hoạt động: dừng ở vòng thứ hai bằng một lượt tổng kết và báo đã chạm trần', async () => {
    const { home, work } = newHome();
    reset([...dirCalls(6), { text: 'Tóm tắt tiến độ: mới duyệt thư mục vài lần, chưa xong việc.' }]);
    const r = await run(home, work, ['-p', 'duyệt thư mục mãi', '--model', 'local:m1', '--permission-mode', 'default', '--max-turns', '2']);
    expect(bodies.length).toBeLessThanOrEqual(4); // 2 vòng + lượt tổng kết (+ tối đa 1 lần dư), không chạy 7 lần
    expect(r.out + r.err).toMatch(/số vòng|vòng lặp tối đa/i);
  }, 120_000);
});
