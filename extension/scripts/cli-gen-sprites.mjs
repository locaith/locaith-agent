// Sinh `src/cli/tui/spriteArt.ts`: khung hình nhân vật nhỏ (chó robot, robot người) bằng khối nửa ô, từ scripts/brand/sprites.mjs.
// Quy trình: dựng SVG từng pha → Chrome (puppeteer-core) chụp nền trong suốt → lấy mẫu độ phủ alpha theo lưới → ▀ ▄ █ → hằng nhúng.
// Chạy:  node scripts/cli-gen-sprites.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFS, bot, dog } from './brand/sprites.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(path.join(root, 'package.json'));
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PHASES = 8;
const PX = 256; // kích thước chụp

const puppeteer = require_('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: PX, height: PX, deviceScaleFactor: 1 });

async function frames(fn) {
  const out = [];
  for (let i = 0; i < PHASES; i++) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${PX}" height="${PX}" style="position:absolute;left:0;top:0">${fn(i / PHASES)}</svg>`;
    await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${DEFS}${svg}</body>`);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: PX, height: PX }, encoding: 'base64' });
    // giải mã trong trang: trả về mảng alpha PX×PX
    const alpha = await page.evaluate(async (b64, n) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = n;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, n, n).data;
      const a = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) a[i] = d[i * 4 + 3];
      return Array.from(a);
    }, png, PX);
    out.push(alpha);
  }
  return out;
}

function bbox(all) {
  let x0 = PX, y0 = PX, x1 = 0, y1 = 0;
  for (const a of all)
    for (let y = 0; y < PX; y++)
      for (let x = 0; x < PX; x++)
        if (a[y * PX + x] > 40) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

function toBlocks(alpha, box, cols, pxRows) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const grid = [];
  for (let gy = 0; gy < pxRows; gy++) {
    const row = [];
    for (let gx = 0; gx < cols; gx++) {
      let sum = 0;
      let n = 0;
      const xs = box.x0 + Math.floor((gx * w) / cols);
      const xe = box.x0 + Math.max(xs - box.x0 + 1, Math.floor(((gx + 1) * w) / cols));
      const ys = box.y0 + Math.floor((gy * h) / pxRows);
      const ye = box.y0 + Math.max(ys - box.y0 + 1, Math.floor(((gy + 1) * h) / pxRows));
      for (let y = ys; y < ye; y++) for (let x = xs; x < xe; x++) (sum += alpha[y * PX + x]), n++;
      row.push(sum / n / 255 >= 0.3);
    }
    grid.push(row);
  }
  const rows = [];
  for (let r = 0; r < pxRows; r += 2) {
    let s = '';
    for (let x = 0; x < cols; x++) {
      const t = grid[r][x];
      const b = grid[r + 1]?.[x] ?? false;
      s += t && b ? '█' : t ? '▀' : b ? '▄' : ' ';
    }
    rows.push(s.replace(/\s+$/, ''));
  }
  return rows;
}

const result = {};
for (const [name, fn] of [['DOG', dog], ['BOT', bot]]) {
  const all = await frames(fn);
  const box = bbox(all);
  // cao tối đa 7 hàng chữ (14 pixel); rộng theo tỉ lệ nhưng không quá 22 cột
  const aspect = (box.x1 - box.x0) / (box.y1 - box.y0);
  const pxRows = Math.min(14, Math.max(2, Math.round((22 / aspect) / 2) * 2));
  const cols = Math.min(22, Math.max(4, Math.round(pxRows * aspect)));
  result[name] = all.map((a) => toBlocks(a, box, cols, pxRows));
  console.log(name, `${cols} cột × ${pxRows / 2} hàng`);
  console.log(result[name][0].join('\n'));
  console.log(result[name][3].join('\n'));
}
await browser.close();

const out = `/* TỆP SINH TỰ ĐỘNG bởi scripts/cli-gen-sprites.mjs từ scripts/brand/sprites.mjs — đừng sửa tay. */

/** Khung hình (${PHASES} pha) của nhân vật nhỏ bằng khối nửa ô; mỗi khung là các hàng chữ, cùng chiều rộng/cao. */
export const DOG_FRAMES: readonly (readonly string[])[] = ${JSON.stringify(result.DOG, null, 1)};
export const BOT_FRAMES: readonly (readonly string[])[] = ${JSON.stringify(result.BOT, null, 1)};
`;
writeFileSync(path.join(root, 'src/cli/tui/spriteArt.ts'), out);
