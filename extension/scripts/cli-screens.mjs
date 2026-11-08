// Ảnh màn hình để NGƯỜI DUYỆT xem giao diện CLI: chạy kịch bản demo qua pty THẬT + xterm headless, rồi render buffer (màu thật) thành HTML → PNG
// bằng Chrome (puppeteer-core) vào docs/cli-screens/.   Chạy:  node scripts/cli-screens.mjs [tên-lọc …]
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtySession, buildDemo, root, sleep } from './cli-lib.mjs';

const require_ = createRequire(path.join(root, 'package.json'));
const OUT = path.join(root, 'docs', 'cli-screens');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CW = 9; // px mỗi ô
const CH = 20;
const FONT = 15;

// ───────────── màu ─────────────
const ANSI = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
const ANSI_LIGHT = ['#000000', '#cd3131', '#00bc00', '#949800', '#0451a5', '#bc05bc', '#0598bc', '#555555', '#666666', '#cd3131', '#14ce14', '#b5ba00', '#0451a5', '#bc05bc', '#0598bc', '#a5a5a5'];
function paletteColor(n, light) {
  if (n < 16) return (light ? ANSI_LIGHT : ANSI)[n];
  if (n < 232) {
    const i = n - 16;
    const v = [0, 95, 135, 175, 215, 255];
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor((i % 36) / 6)]},${v[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

function colorOf(cell, fg, light, def) {
  const isDef = fg ? cell.isFgDefault() : cell.isBgDefault();
  if (isDef) return def;
  const isRgb = fg ? cell.isFgRGB() : cell.isBgRGB();
  const v = fg ? cell.getFgColor() : cell.getBgColor();
  return isRgb ? hex(v) : paletteColor(v, light);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Buffer khung nhìn → HTML. */
function renderHtml(term, { light, title }) {
  const bg = light ? '#fbfbfd' : '#0d0f17';
  const fgDef = light ? '#1f2330' : '#d6d9e6';
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  const cell0 = buf.getNullCell();
  let html = '';
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.baseY + y);
    let row = '';
    if (line) {
      for (let x = 0; x < cols; x++) {
        const c = line.getCell(x, cell0);
        const w = c.getWidth();
        if (w === 0) continue;
        let ch = c.getChars() || ' ';
        let fg = colorOf(c, true, light, fgDef);
        let bgc = colorOf(c, false, light, null);
        if (c.isInverse()) {
          const t = fg;
          fg = bgc ?? bg;
          bgc = t;
        }
        let style = '';
        let extra = '';
        if (ch === '▀' || ch === '▄' || ch === '█') {
          const top = ch !== '▄';
          const bottom = ch !== '▀';
          const b = bgc ?? 'transparent';
          style = ch === '█' ? `background:${fg}` : `background:linear-gradient(to bottom,${top ? fg : b} 50%,${bottom ? fg : b} 50%)`;
          ch = ' ';
        } else if (bgc) style = `background:${bgc};color:${fg}`;
        else style = `color:${fg}`;
        if (c.isBold()) extra += 'font-weight:700;';
        if (c.isDim()) extra += 'opacity:.62;';
        if (c.isItalic()) extra += 'font-style:italic;';
        const deco = [c.isUnderline() ? 'underline' : '', c.isStrikethrough() ? 'line-through' : ''].filter(Boolean).join(' ');
        if (deco) extra += `text-decoration:${deco};`;
        if (c.isInvisible()) ch = ' ';
        const wpx = w * CW;
        row += `<b style="width:${wpx}px;${style};${extra}">${esc(ch)}</b>`;
      }
    }
    html += `<div class="r">${row}</div>`;
  }
  const dots = light ? '#c9ccd6' : '#2a2e3d';
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:${light ? '#e9ebf2' : '#05060a'}}
  .win{display:inline-block;margin:18px;border-radius:10px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.45);background:${bg};border:1px solid ${dots}}
  .bar{height:28px;background:${light ? '#dfe2ec' : '#171a26'};display:flex;align-items:center;padding:0 12px;gap:7px;font:12px 'Segoe UI',sans-serif;color:${light ? '#4a4f63' : '#8a90a6'}}
  .bar i{width:11px;height:11px;border-radius:50%;background:${light ? '#bfc3d1' : '#33384c'}}
  .term{padding:10px 14px;font-family:'Cascadia Mono','Consolas','MS Gothic','Malgun Gothic','Segoe UI Symbol',monospace;font-size:${FONT}px;line-height:${CH}px;color:${fgDef};background:${bg}}
  .r{height:${CH}px;white-space:nowrap;display:flex}
  .r b{font-weight:400;display:inline-block;height:${CH}px;overflow:visible;flex:none;text-align:left;white-space:pre}
  </style><div class="win"><div class="bar"><i></i><i></i><i></i><span style="margin-left:8px">${esc(title)}</span></div><div class="term">${html}</div></div>`;
}

// ───────────── kịch bản ─────────────
const ENTER = '\r';
const wait = (s, text, ms = 40000) => s.waitFor((x) => x.text().includes(text), ms);
const idle = (s) => s.waitFor((x) => !x.text().includes('esc để dừng') && !x.text().includes('esc to interrupt'), 60000);

const SCENES = [
  { name: '01-khoi-dong', cols: 100, rows: 24, async run(s) { await wait(s, 'Nhập việc cần làm'); } },
  {
    name: '02-hoi-thoai-markdown-cong-cu',
    cols: 100,
    rows: 58,
    args: ['--speed', '0.08'],
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('Chào bạn, hãy xem giúp mình dự án này' + ENTER);
      await wait(s, 'Bạn muốn mình làm luôn không?');
      await idle(s);
    },
  },
  {
    name: '03-xin-quyen-sua-tep-diff',
    cols: 100,
    rows: 34,
    args: ['--speed', '0.08'],
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('hãy sửa parseArgs để nhận --no-color' + ENTER);
      await wait(s, 'Cho phép sửa src/cli.ts?');
      await s.settle(300);
    },
  },
  {
    name: '04-sua-tep-xong-diff',
    cols: 100,
    rows: 34,
    args: ['--speed', '0.08'],
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('hãy sửa parseArgs để nhận --no-color' + ENTER);
      await wait(s, 'Cho phép sửa src/cli.ts?');
      s.write(ENTER);
      await wait(s, 'Đã cập nhật.');
      await idle(s);
    },
  },
  {
    name: '05-xin-quyen-chay-lenh',
    cols: 100,
    rows: 26,
    args: ['--speed', '0.08'],
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('chạy test giúp mình' + ENTER);
      await wait(s, 'Cho phép chạy lệnh?');
      await s.settle(300);
    },
  },
  {
    name: '06-lenh-bash-loi',
    cols: 100,
    rows: 30,
    args: ['--speed', '0.08'],
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('chạy test giúp mình' + ENTER);
      await wait(s, 'Cho phép chạy lệnh?');
      s.write('a');
      await wait(s, 'Có 1 test lỗi');
      await idle(s);
    },
  },
  {
    name: '07-chon-phien-resume',
    cols: 100,
    rows: 24,
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('/resume' + ENTER);
      await wait(s, 'Mở lại phiên');
      await s.settle(300);
    },
  },
  {
    name: '08-dang-chay-spinner-hang-doi-todos',
    cols: 100,
    rows: 28,
    args: ['--speed', '1.4'],
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('lập kế hoạch với todo' + ENTER);
      await wait(s, 'Đọc cấu hình TypeScript');
      s.write('sau đó chạy lại toàn bộ test' + ENTER);
      await wait(s, 'đang chờ');
      await wait(s, '◐');
      await s.settle(100);
    },
  },
  {
    name: '08b-cho-lau-nhan-vat-cho',
    cols: 100,
    rows: 30,
    args: ['--speed', '6'],
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('viết một câu trả lời dài giúp mình' + ENTER);
      await wait(s, 'esc để dừng');
      await sleep(10000);
      await s.settle(200);
    },
  },
  {
    name: '09-menu-lenh-gach-cheo',
    cols: 100,
    rows: 24,
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('/co');
      await wait(s, '/compact');
      await s.settle(200);
    },
  },
  {
    name: '10-hep-60-cot',
    cols: 60,
    rows: 60,
    args: ['--speed', '0.08'],
    async run(s) {
      await wait(s, 'Nhập việc cần');
      s.write('Chào bạn, hãy xem giúp mình dự án này' + ENTER);
      await wait(s, 'không?');
      await idle(s);
    },
  },
  {
    name: '11-nen-sang',
    cols: 100,
    rows: 44,
    args: ['--speed', '0.08', '--light'],
    light: true,
    env: { COLORFGBG: '0;15' },
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('hãy sửa parseArgs để nhận --no-color' + ENTER);
      await wait(s, 'Cho phép sửa src/cli.ts?');
      s.write(ENTER);
      await wait(s, 'Đã cập nhật.');
      await idle(s);
    },
  },
  {
    name: '12-ascii',
    cols: 100,
    rows: 40,
    args: ['--speed', '0.08', '--ascii'],
    env: { LOCAITH_ASCII: '1' },
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('hãy sửa parseArgs để nhận --no-color' + ENTER);
      await wait(s, 'Cho phép sửa src/cli.ts?');
      s.write(ENTER);
      await wait(s, 'Đã cập nhật.');
      await idle(s);
    },
  },
  {
    name: '13-tieng-anh-khoi-dong-va-phim-tat',
    cols: 100,
    rows: 28,
    args: ['--lang', 'en'],
    async run(s) {
      await wait(s, 'Type a task');
      s.write('?');
      await wait(s, 'Shortcuts');
      await s.settle(200);
    },
  },
  {
    name: '14-agent-nen-kiem-chung-loi',
    cols: 100,
    rows: 50,
    args: ['--speed', '0.08'],
    async run(s) {
      await wait(s, 'Nhập việc cần làm');
      s.write('nén ngữ cảnh đi' + ENTER);
      await wait(s, 'Tiếp tục công việc');
      await idle(s);
      s.write('có lỗi' + ENTER);
      await wait(s, 'ECONNRESET');
      await idle(s);
      s.write('agent song song' + ENTER);
      await wait(s, 'Xong (12 lệnh');
      await idle(s);
    },
  },
];

async function main() {
  const filters = process.argv.slice(2);
  const scenes = SCENES.filter((s) => !filters.length || filters.some((f) => s.name.includes(f)));
  mkdirSync(OUT, { recursive: true });
  const tmp = path.join(os.tmpdir(), 'locaith-screens-' + process.pid);
  const bundle = await buildDemo(tmp);
  const puppeteer = require_('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--font-render-hinting=none'] });
  let failed = 0;
  try {
    for (const sc of scenes) {
      const s = new PtySession({ cols: sc.cols, rows: sc.rows, args: sc.args ?? [], env: sc.env ?? {}, bundle });
      await s.start();
      try {
        await sc.run(s);
        await s.settle(250);
        const html = renderHtml(s.term, { light: !!sc.light, title: `locaith — ${sc.name}` });
        const page = await browser.newPage();
        await page.setViewport({ width: sc.cols * CW + 28 + 36 + 4, height: sc.rows * CH + 28 + 20 + 36 + 8, deviceScaleFactor: 2 });
        await page.setContent(html, { waitUntil: 'load' });
        await sleep(150);
        const el = await page.$('.win');
        await el.screenshot({ path: path.join(OUT, sc.name + '.png') });
        await page.close();
        writeFileSync(path.join(OUT, sc.name + '.txt'), s.all().join('\n') + '\n');
        console.log('ok  ', sc.name);
      } catch (e) {
        failed++;
        console.error('LỖI ', sc.name, String(e?.message ?? e).slice(0, 600));
      } finally {
        try {
          s.write('\x04');
          await s.exit(3000);
        } catch {
          /* bỏ qua */
        }
        s.kill();
      }
    }
  } finally {
    await browser.close();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* bỏ qua */
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
