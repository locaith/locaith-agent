import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

/**
 * Đầu-cuối trên bản ĐÓNG GÓI của lõi chạy (không qua giao diện): máy chủ giả kiểu OpenAI (gọi read_file ở lần 1, trả lời ở lần 2) +
 * `baseUrl` + khoá Locaith giả. Chứng minh: fetch thật chạy, công cụ chạy, tiến trình thoát SẠCH sau dispose() (không treo, mã 0),
 * phiên được ghi, và bản đóng gói không kéo `vscode`.
 */
const root = path.resolve(__dirname, '../../..');
let dir = '';
let bundle = '';
let server: http.Server;
let base = '';
const calls: Array<{ auth?: string; client?: string; hasToolResult: boolean; model?: string }> = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lc-rt-e2e-'));
  mkdirSync(path.join(dir, 'home'), { recursive: true });
  mkdirSync(path.join(dir, 'work'), { recursive: true });
  writeFileSync(path.join(dir, 'work', 'sample.txt'), 'ALPHA\nBETA\n');
  bundle = path.join(dir, 'rt.cjs');
  await build({ entryPoints: [path.join(root, 'src/cli/runtime/index.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', loader: { '.md': 'text' }, outfile: bundle, logLevel: 'silent' });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'locaith-v5-flash', object: 'model' }] }));
      }
      if (url.endsWith('/account') || url.endsWith('/consent')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      const j = JSON.parse(body || '{}');
      const toolRound = !JSON.stringify(j.messages ?? []).includes('tool_call_id');
      calls.push({ auth: req.headers.authorization, client: String(req.headers['x-locaith-client'] ?? ''), hasToolResult: !toolRound, model: j.model });
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      const b = { id: 'c', object: 'chat.completion.chunk', created: 0, model: j.model };
      const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ ...b, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '' }, null));
      if (toolRound) {
        res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }, null));
        res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"sample.txt"}' } }] }, null));
        res.write(chunk({}, 'tool_calls', { usage }));
      } else {
        for (const p of ['Tệp có 2 dòng: ', 'ALPHA và BETA.']) res.write(chunk({ content: p }, null));
        res.write(chunk({}, 'stop', { usage }));
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

describe('lõi chạy đã đóng gói', () => {
  it('chạy một việc có công cụ qua HTTP thật, thoát sạch mã 0, ghi phiên, không treo', async () => {
    const script = path.join(dir, 'drive.cjs');
    writeFileSync(
      script,
      `
const { createRuntime } = require(${JSON.stringify(bundle)});
(async () => {
  const rt = await createRuntime({ cwd: ${JSON.stringify(path.join(dir, 'work'))}, home: ${JSON.stringify(path.join(dir, 'home'))}, version: '5.5.5', interactive: false, trusted: true, features: [], baseUrl: ${JSON.stringify(base)} });
  let text = '';
  rt.on((e) => { if (e.t === 'ui' && e.ev.t === 'text') text += e.ev.delta; });
  await rt.submit('đọc sample.txt');
  await rt.idle();
  const st = rt.status();
  await rt.dispose();
  console.log(JSON.stringify({ text, model: st.model, provider: st.provider, usage: st.usage }));
})().catch((e) => { console.error('LỖI', e); process.exit(1); });
`,
    );
    const env = { ...process.env, LOCAITH_API_KEY: 'lat_' + 'x'.repeat(43) };
    delete (env as Record<string, string | undefined>).ANTHROPIC_API_KEY;
    const t0 = Date.now();
    const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn(process.execPath, [script], { env, cwd: dir, windowsHide: true });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const timer = setTimeout(() => {
        p.kill();
        resolve({ code: null, out, err: err + '\n[TREO: quá 40 giây]' });
      }, 40_000);
      p.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(30_000);
    const j = JSON.parse(r.out.trim().split('\n').pop()!);
    expect(j.text).toContain('ALPHA và BETA.');
    expect(j).toMatchObject({ provider: 'locaith', model: 'locaith-v5-flash' });
    expect(j.usage.input).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toMatchObject({ auth: 'Bearer lat_' + 'x'.repeat(43), client: 'cli/5.5.5', model: 'locaith-v5-flash' });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(path.join(dir, 'home', '.locaith', 'sessions')).filter((f) => f !== 'index.json').length).toBe(1);
  }, 60_000);

  it('bản đóng gói không chứa require("vscode")', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(bundle, 'utf8')).not.toMatch(/require\(["']vscode["']\)/);
  });
});
