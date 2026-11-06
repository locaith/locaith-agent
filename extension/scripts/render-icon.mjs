// Kết xuất media/icon.svg thành media/icon.png (256×256, nền trong suốt) bằng Chrome/Edge không đầu.
//   node scripts/render-icon.mjs
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) throw new Error('Không tìm thấy Chrome/Edge. Đặt biến CHROME_PATH.');

const svg = await readFile(new URL('../media/icon.svg', import.meta.url), 'utf8');
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 256, height: 256, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.screenshot({ path: fileURLToPath(new URL('../media/icon.png', import.meta.url)), omitBackground: true, clip: { x: 0, y: 0, width: 256, height: 256 } });
await browser.close();
console.log('Đã tạo media/icon.png');
