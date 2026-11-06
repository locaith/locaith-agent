// Vẽ media/icon.svg thành PNG 16/32/48/128 cho manifest của bản trình duyệt (Chrome/Edge không nhận SVG làm icon tiện ích).
//   node scripts/render-browser-icons.mjs
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const puppeteer = require('puppeteer-core');
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const { existsSync } = await import('node:fs');
const executablePath = process.env.BROWSER_PATH ?? CANDIDATES.find((p) => existsSync(p));
if (!executablePath) throw new Error('Không tìm thấy Edge/Chrome. Đặt BROWSER_PATH.');

const svg = await readFile(path.join(root, 'media/icon.svg'), 'utf8');
const out = path.join(root, 'src/browser/static/icons');
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath, headless: true });
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage();
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    const png = await page.screenshot({ omitBackground: true, type: 'png', clip: { x: 0, y: 0, width: size, height: size } });
    await writeFile(path.join(out, `${size}.png`), png);
    await page.close();
  }
  console.log('Đã tạo icon trong', path.relative(root, out));
} finally {
  await browser.close();
}
