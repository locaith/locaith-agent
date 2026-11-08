// Thư viện dùng chung cho các script kiểm thử/ảnh của giao diện CLI:
//  - buildDemo(): esbuild gói src/cli/tui + MockRuntime thành một tệp .cjs chạy được (không kéo `vscode`)
//  - PtySession: chạy bundle trong pty THẬT (@lydell/node-pty, useConptyDll:false + đường dẫn node tuyệt đối — bắt buộc trên Windows,
//    nếu không bị treo), đọc màn hình qua @xterm/headless.
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(path.join(root, 'package.json'));

const ENTRY_PATH = path.join(root, 'src/cli/tui/index.ts').split(path.sep).join('/');
const DEMO_ENTRY = `
import { runTui, MockRuntime } from ${JSON.stringify(ENTRY_PATH)};
const a = process.argv.slice(2);
const has = (f) => a.includes(f);
const val = (f, d) => { const i = a.indexOf(f); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
const lang = val('--lang', 'vi');
const rt = new MockRuntime({ speed: Number(val('--speed', '1')), lang, loggedIn: !has('--logged-out'), cwd: val('--cwd', 'C:\\\\Dev\\\\demo-app') });
runTui(rt, {
  version: '0.4.0', lang, theme: has('--light') ? 'light' : has('--dark') ? 'dark' : 'auto',
  noColor: has('--no-color'), ascii: has('--ascii'), historyFile: val('--history', null) || null,
  initialInput: val('--prompt', undefined),
}).then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
`;

/** Gói bundle demo; trả về đường dẫn tệp .cjs. */
export async function buildDemo(outDir) {
  const { build } = require_('esbuild');
  const dir = outDir ?? mkdtempSync(path.join(os.tmpdir(), 'locaith-tui-'));
  mkdirSync(dir, { recursive: true });
  const outfile = path.join(dir, 'demo.cjs');
  await build({
    stdin: { contents: DEMO_ENTRY, resolveDir: root, sourcefile: 'demo-entry.ts', loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    loader: { '.md': 'text' },
    outfile,
    logLevel: 'warning',
  });
  return outfile;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Phiên pty + xterm headless. */
export class PtySession {
  constructor({ cols = 100, rows = 32, args = [], env = {}, cwd = root, bundle }) {
    this.cols = cols;
    this.rows = rows;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.bundle = bundle;
    this.exited = false;
    this.exitCode = null;
    this.raw = '';
  }

  async start() {
    const pty = require_('@lydell/node-pty');
    const { Terminal } = require_('@xterm/headless');
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 5000, allowProposedApi: true });
    this.chain = Promise.resolve();
    const env = { ...process.env, COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', FORCE_HYPERLINK: '0', ...this.env };
    delete env.NO_COLOR;
    for (const [k, v] of Object.entries(this.env)) if (v === undefined) delete env[k];
    this.proc = pty.spawn(process.execPath, [this.bundle, ...this.args], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
      useConptyDll: false,
    });
    this.proc.onData((d) => {
      this.raw += d;
      this.chain = this.chain.then(() => new Promise((r) => this.term.write(d, r)));
    });
    this.exitPromise = new Promise((resolve) => {
      this.proc.onExit((e) => {
        this.exited = true;
        this.exitCode = e.exitCode;
        resolve(e.exitCode);
      });
    });
    return this;
  }

  write(s) {
    this.proc.write(s);
  }

  async settle(ms = 120) {
    await sleep(ms);
    await this.chain;
  }

  resize(cols, rows = this.rows) {
    this.cols = cols;
    this.rows = rows;
    this.proc.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  lineAt(i) {
    return this.term.buffer.active.getLine(i)?.translateToString(true) ?? '';
  }

  /** Cả scrollback + khung nhìn, bỏ dòng trống cuối. */
  all() {
    const b = this.term.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i++) out.push(this.lineAt(i));
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }

  text() {
    return this.all().join('\n');
  }

  async waitFor(pred, ms = 15000) {
    const t0 = Date.now();
    for (;;) {
      await this.settle(60);
      try {
        if (pred(this)) return;
      } catch {
        /* thử lại */
      }
      if (Date.now() - t0 > ms) throw new Error('waitFor: hết giờ\n' + this.text());
    }
  }

  async exit(ms = 8000) {
    const r = await Promise.race([this.exitPromise, sleep(ms).then(() => 'timeout')]);
    // Thoát xong còn phải đợi phần dữ liệu cuối (lời chào + lệnh khôi phục terminal) đi hết qua hàng đợi xterm: trên macOS sự kiện thoát tới
    // TRƯỚC khi chữ cuối kịp vào bộ đệm màn hình, nên đọc text() ngay sau exit() thấy thiếu «Hẹn gặp lại» (Linux/Windows chỉ may mắn nhanh hơn).
    if (r !== 'timeout') await this.settle(250);
    return r;
  }

  kill() {
    try {
      this.proc.kill();
    } catch {
      /* đã thoát */
    }
  }
}
