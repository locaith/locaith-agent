#!/usr/bin/env node
// Smoke test của Locaith CLI NHƯ NGƯỜI DÙNG CHẠY THẬT, trên mọi hệ điều hành (Windows · macOS · Linux).
// Dựng máy chủ OpenAI-compatible giả trên 127.0.0.1, dùng LOCAITH_HOME tạm (không đụng ~/.locaith thật), rồi chạy lần lượt:
//   --version · help providers · provider add/key/list/test/remove · `-p` qua nhà cung cấp tuỳ chỉnh (khoá đã lưu được gửi, gắn địa chỉ)
//   · khoá gõ ở dòng lệnh bị từ chối · quyền tệp 0600 (POSIX) · doctor --json.
//
//   node scripts/cli-smoke.mjs --bundle dist-cli/locaith.cjs      # node + bundle vừa dựng
//   node scripts/cli-smoke.mjs --bin <đường-dẫn-locaith>           # tệp chạy được, ví dụ lệnh `locaith` do pip cài
//   thêm --no-system-node (chỉ POSIX): đặt PATH của CLI KHÔNG có `node` → buộc launcher dùng Node đóng kèm gói pip (nodejs-wheel-binaries).
//
// Thoát 0 = mọi kiểm tra đạt. Không bao giờ in khoá.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const bundle = opt('--bundle');
const bin = opt('--bin');
const noSystemNode = argv.includes('--no-system-node');
if (!bundle && !bin) {
  console.error('Dùng: node scripts/cli-smoke.mjs --bundle <locaith.cjs> | --bin <locaith> [--no-system-node]');
  process.exit(2);
}
const isWin = process.platform === 'win32';

// ── máy chủ giả ─────────────────────────────────────────────────────────────
const reqs = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    reqs.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    if ((req.url ?? '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }, { id: 'm2', object: 'model' }] }));
    }
    let model = 'm1';
    try {
      model = JSON.parse(body || '{}').model ?? 'm1';
    } catch {
      /* bỏ qua */
    }
    const b = { id: 'c1', object: 'chat.completion.chunk', created: 0, model };
    const chunk = (delta, finish, extra = {}) => `data: ${JSON.stringify({ ...b, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(chunk({ role: 'assistant', content: '' }, null));
    res.write(chunk({ content: 'Chào từ máy chủ giả.' }, null));
    res.write(chunk({}, 'stop', { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/v1`;

// ── môi trường sạch ─────────────────────────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'locaith-smoke-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'locaith-smoke-cwd-'));
const childEnv = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|_TOKEN$|^LOCAITH_|^GOOGLE_|^XAI_/i.test(k)) childEnv[k] = v;
Object.assign(childEnv, { LOCAITH_HOME: home, HOME: home, USERPROFILE: home, LOCAITH_LANG: 'vi', NO_COLOR: '1', LOCAITH_NO_UPDATE_CHECK: '1' });
if (noSystemNode) {
  if (isWin) {
    console.error('--no-system-node chỉ dùng cho POSIX');
    process.exit(2);
  }
  const binDir = bin ? path.dirname(path.resolve(bin)) : '';
  childEnv.PATH = `${binDir}:/usr/bin:/bin`;
  try {
    execFileSync('/bin/sh', ['-c', 'command -v node'], { env: childEnv, stdio: 'pipe' });
    console.error('✘ vẫn còn `node` trong PATH của CLI — không thử được đường Node đóng kèm');
    process.exit(2);
  } catch {
    /* tốt: không có node trong PATH */
  }
}

function run(args, o = {}) {
  return new Promise((resolve) => {
    const cmd = bundle ? process.execPath : path.resolve(bin);
    const full = bundle ? [path.resolve(bundle), ...args] : args;
    const p = spawn(cmd, full, { env: { ...childEnv, ...(o.env ?? {}) }, cwd, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill(), o.timeoutMs ?? 90_000);
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err + String(e) });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (o.stdin !== undefined) p.stdin.end(o.stdin);
    else p.stdin.end();
  });
}

// ── kiểm tra ────────────────────────────────────────────────────────────────
let pass = 0;
const fails = [];
const check = (ok, name, extra = '') => {
  if (ok) {
    pass++;
    console.log(`✔ ${name}`);
  } else {
    fails.push(name);
    console.log(`✘ ${name}${extra ? `\n    ${String(extra).replace(/\n/g, '\n    ').slice(0, 900)}` : ''}`);
  }
};
const read = (rel) => JSON.parse(fs.readFileSync(path.join(home, '.locaith', rel), 'utf8'));
const mode = (rel) => fs.statSync(path.join(home, '.locaith', rel)).mode & 0o777;
const KEY = 'sk-smoke-SAVED-KEY-1234567890';

console.log(`Nền tảng: ${process.platform}/${process.arch} · Node ${process.versions.node} · ${bundle ? `bundle ${bundle}` : `bin ${bin}`}${noSystemNode ? ' · KHÔNG có Node hệ thống' : ''}`);

try {
  let r = await run(['--version']);
  check(r.code === 0 && /^\d+\.\d+\.\d+/.test(r.out.trim()), '--version', r.out + r.err);

  r = await run(['help', 'providers']);
  check(r.code === 0 && r.out.includes('locaith provider add') && r.out.includes('--key-stdin'), 'help providers', r.out + r.err);

  r = await run(['provider', 'add', 'local-llm', '--url', base, '--models', 'm1,m2']);
  check(r.code === 0 && /kết nối được/.test(r.out), 'provider add (API cục bộ, không cần khoá) + thử kết nối', r.out + r.err);
  check(reqs.some((q) => q.url.includes('/models')), 'thử kết nối gọi đúng máy chủ');

  r = await run(['provider', 'add', 'secured', '--url', base, '--key-stdin', '--models', 'm1'], { stdin: `${KEY}\n` });
  check(r.code === 0 && !(r.out + r.err).includes(KEY), 'provider add + khoá qua stdin (khoá không in ra)', r.out + r.err);
  check(reqs.some((q) => q.url.includes('/models') && q.auth === `Bearer ${KEY}`), 'thử kết nối dùng đúng khoá vừa lưu');
  const st = read('settings.json');
  check(Array.isArray(st.customProviders) && st.customProviders.length === 2, 'settings.json có hai API tuỳ chỉnh', JSON.stringify(st));
  const ks = read('provider-keys.json');
  check(ks.keys?.secured?.key === KEY && ks.keys.secured.baseUrl === base, 'provider-keys.json: khoá gắn địa chỉ lúc lưu');
  if (!isWin) {
    check(mode('provider-keys.json') === 0o600, `quyền provider-keys.json = 600 (thấy ${mode('provider-keys.json').toString(8)})`);
    check(mode('settings.json') === 0o600, `quyền settings.json = 600 (thấy ${mode('settings.json').toString(8)})`);
  }

  r = await run(['provider', 'list', '--json']);
  let j = null;
  try {
    j = JSON.parse(r.out);
  } catch {
    /* kiểm bên dưới */
  }
  check(!!j && j.providers.some((p) => p.id === 'secured' && p.usable) && j.providers.some((p) => p.id === 'local-llm' && p.usable), 'provider list --json: cả hai dùng được', r.out + r.err);
  check(!r.out.includes(KEY), 'provider list không lộ khoá');

  reqs.length = 0;
  r = await run(['-p', 'xin chào', '--model', 'secured:m1']);
  check(r.code === 0 && r.out.includes('Chào từ máy chủ giả.'), '-p qua nhà cung cấp tuỳ chỉnh (có khoá)', r.out + r.err);
  const chat = reqs.filter((q) => q.url.includes('/chat/completions'));
  check(chat.length > 0 && chat.every((q) => q.auth === `Bearer ${KEY}`), 'lượt hỏi gửi đúng khoá đã lưu', JSON.stringify(chat));
  check(!(r.out + r.err).includes(KEY), '-p không lộ khoá');

  reqs.length = 0;
  r = await run(['-p', 'xin chào', '--model', 'local-llm:m1']);
  check(r.code === 0 && reqs.filter((q) => q.url.includes('/chat/completions')).every((q) => q.auth === undefined), '-p qua API không cần khoá: KHÔNG gửi Authorization', r.out + r.err);

  // Khoá gắn địa chỉ: sửa baseUrl → khoá không được gửi
  const s2 = read('settings.json');
  s2.customProviders.find((c) => c.id === 'secured').baseUrl = `http://127.0.0.1:${port}/other/v1`;
  fs.writeFileSync(path.join(home, '.locaith', 'settings.json'), JSON.stringify(s2));
  reqs.length = 0;
  r = await run(['-p', 'xin chào', '--model', 'secured:m1']);
  check(r.code !== 0 && (r.out + r.err).includes('locaith provider key secured') && !reqs.some((q) => q.auth?.includes(KEY)), 'đổi địa chỉ → khoá KHÔNG được gửi, báo cách lưu lại', r.out + r.err);
  s2.customProviders.find((c) => c.id === 'secured').baseUrl = base;
  fs.writeFileSync(path.join(home, '.locaith', 'settings.json'), JSON.stringify(s2));

  r = await run(['provider', 'key', 'openai', '--key', 'sk-cmdline-AAAA1111']);
  check(r.code === 2 && !(r.out + r.err).includes('sk-cmdline-AAAA1111'), 'khoá gõ ở dòng lệnh bị từ chối, không in lại', r.out + r.err);

  r = await run(['doctor', '--json'], { timeoutMs: 120_000 });
  let d = null;
  try {
    d = JSON.parse(r.out);
  } catch {
    /* kiểm bên dưới */
  }
  const node = d?.checks?.find((c) => c.name === 'Node.js');
  check(!!d && !!node, 'doctor --json chạy được', r.out.slice(0, 400) + r.err);
  if (noSystemNode) check(/đi kèm gói pip/.test(node?.detail ?? ''), 'launcher dùng Node ĐÓNG KÈM gói pip khi máy không có Node', node?.detail);
  check(!!d?.checks?.find((c) => c.name === 'Nhà cung cấp khác' && /secured/.test(c.detail)), 'doctor nêu nhà cung cấp khác đang dùng được');
  check(!r.out.includes(KEY), 'doctor không lộ khoá');

  r = await run(['provider', 'remove', 'secured']);
  check(r.code === 0 && !('secured' in (read('provider-keys.json').keys ?? {})), 'provider remove gỡ cả khoá đã lưu', r.out + r.err);
} catch (e) {
  fails.push('LỖI NGOÀI Ý MUỐN: ' + (e instanceof Error ? e.stack : String(e)));
  console.log('✘ lỗi ngoài ý muốn:', e);
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r()));
  for (const d of [home, cwd]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows có thể còn giữ tệp */
    }
  }
}

console.log(`\n${fails.length === 0 ? 'ĐẠT' : 'KHÔNG ĐẠT'}: ${pass} kiểm tra đạt, ${fails.length} hỏng.`);
process.exit(fails.length === 0 ? 0 : 1);
