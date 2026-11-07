// Chụp ảnh giao diện webview bằng Chrome không đầu (puppeteer-core) và kiểm tra hành vi bộ gõ tiếng Việt.
//   node webview/dev/build.mjs          # build trước
//   node webview/dev/shoot.mjs          # chụp tất cả
//   node webview/dev/shoot.mjs picker   # chỉ chụp các ảnh có tên chứa "picker"
//   node webview/dev/shoot.mjs --ime    # chạy kiểm tra IME (Telex) thay vì chụp ảnh
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(path.join(root, 'package.json'));
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(here, 'shots');
const args = process.argv.slice(2);
const imeMode = args.includes('--ime');
const filter = args.find((a) => !a.startsWith('--'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Kiểm tra DOM thật của cảnh «nhiều việc chạy cùng lúc» (parallel-agents / parallel-narrow): ném lỗi (→ ảnh bị đánh ✘) nếu sai.
 * Một dòng tóm tắt đếm đủ lệnh gọi (gồm cả lệnh của agent con), đúng 3 dòng agent sống, mỗi dòng đúng hai dòng chữ, không tràn ngang,
 * và bộ số «token · lệnh» hiện ở đúng một nơi theo bề ngang (rộng: dòng đầu; hẹp ≤ 520px: đầu dòng hai).
 */
async function assertParallel(p, tick = false) {
  const r = await p.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    const tl = document.querySelector('.timeline');
    const app = document.querySelector('.app');
    const rows = q('.par-agent');
    const shown = (el) => !!el && getComputedStyle(el).display !== 'none';
    return {
      width: app ? app.clientWidth : 0,
      agents: rows.length,
      sums: q('.par-sum-count').map((e) => e.textContent.trim()),
      overflowX: tl ? tl.scrollWidth - tl.clientWidth : -1,
      heights: rows.map((e) => Math.round(e.getBoundingClientRect().height)),
      counts: rows.map((e) => [shown(e.querySelector('.par-st-counts')), shown(e.querySelector('.par-act-counts'))]),
      times: rows.map((e) => (e.querySelector('.par-st-time') || {}).textContent || ''),
    };
  });
  if (r.agents !== 3) throw new Error(`cần 3 dòng agent sống, thấy ${r.agents}`);
  if (r.sums.length < 2 || !r.sums.every((s) => /(lệnh gọi công cụ|tool calls)/.test(s))) throw new Error(`dòng tóm tắt sai: ${JSON.stringify(r.sums)}`);
  if (!/^161 /.test(r.sums[0])) throw new Error(`tổng phải là 161 (80 lệnh + 3 agent + 78 lệnh của agent con): ${r.sums[0]}`);
  if (!/^4 /.test(r.sums[1])) throw new Error(`bước hiện tại phải là 4 lệnh: ${r.sums[1]}`);
  if (r.overflowX > 1) throw new Error(`tràn ngang ${r.overflowX}px`);
  if (r.heights.some((h) => h > 60)) throw new Error(`dòng agent cao hơn hai dòng chữ: ${r.heights.join(',')}`);
  const narrow = r.width <= 520;
  if (r.counts.some(([top, second]) => (narrow ? top || !second : !top || second))) throw new Error(`bộ số hiện sai chỗ ở bề ngang ${r.width}px: ${JSON.stringify(r.counts)}`);
  if (r.times.some((x) => !/(phút|giây|\ds|\dm)/.test(x))) throw new Error(`đồng hồ chạy không hiện: ${JSON.stringify(r.times)}`);
  if (tick) {
    // Đồng hồ giây dùng chung phải CHẠY THẬT: sau ~2,2 s mọi dòng agent đổi chữ thời gian (chỉ một setInterval cho cả ba dòng).
    await wait(2200);
    const after = await p.evaluate(() => [...document.querySelectorAll('.par-agent .par-st-time')].map((e) => e.textContent));
    if (after.length !== 3 || after.some((x, i) => x === r.times[i])) throw new Error(`đồng hồ không chạy: ${JSON.stringify(r.times)} → ${JSON.stringify(after)}`);
  }
}
const assertParallelTick = (p) => assertParallel(p, true);

/** @type {{name:string, q:Record<string,string>, w?:number, h?:number, full?:boolean, page?:string, act?:(p:any)=>Promise<void>}[]} */
const SHOTS = [
  { name: '01-welcome-dark-420', q: { scenario: 'welcome', theme: 'dark' }, w: 420, h: 780 },
  { name: 'acct-out-dark-420', q: { scenario: 'acct-out', theme: 'dark' }, w: 420, h: 780 },
  { name: 'acct-out-light-420', q: { scenario: 'acct-out', theme: 'light' }, w: 420, h: 780 },
  { name: 'acct-out-dark-300', q: { scenario: 'acct-out', theme: 'dark' }, w: 300, h: 780 },
  { name: 'acct-wait-dark-420', q: { scenario: 'acct-wait', theme: 'dark' }, w: 420, h: 780 },
  { name: 'acct-wait-manual-light-420', q: { scenario: 'acct-wait-manual', theme: 'light' }, w: 420, h: 780 },
  { name: 'acct-expired-dark-420', q: { scenario: 'acct-expired', theme: 'dark' }, w: 420, h: 780 },
  { name: 'acct-error-light-420', q: { scenario: 'acct-error', theme: 'light' }, w: 420, h: 780 },
  { name: 'acct-out-en-hc-420', q: { scenario: 'acct-out', theme: 'hc', lang: 'en' }, w: 420, h: 780 },
  { name: 'acct-settings-dark-420', q: { scenario: 'acct-settings', theme: 'dark' }, w: 420, h: 900 },
  { name: 'acct-settings-offline-light-420', q: { scenario: 'acct-settings-offline', theme: 'light' }, w: 420, h: 900 },
  { name: 'remote-queue-dark-420', q: { scenario: 'remote-queue', theme: 'dark' }, w: 420, h: 780 },
  { name: 'remote-queue-light-420', q: { scenario: 'remote-queue', theme: 'light' }, w: 420, h: 780 },
  { name: 'remote-queue-dark-300', q: { scenario: 'remote-queue', theme: 'dark' }, w: 300, h: 780 },
  { name: 'remote-queue-fresh-dark-420', q: { scenario: 'remote-queue-fresh', theme: 'dark' }, w: 420, h: 780 },
  { name: 'remote-queue-trying-light-420', q: { scenario: 'remote-queue-trying', theme: 'light' }, w: 420, h: 780 },
  { name: 'remote-queue-en-hc-420', q: { scenario: 'remote-queue', theme: 'hc', lang: 'en' }, w: 420, h: 780 },
  { name: 'remote-settings-dark-420', q: { scenario: 'remote-settings', theme: 'dark' }, w: 420, h: 1100 },
  { name: 'remote-settings-queued-light-420', q: { scenario: 'remote-settings-queued', theme: 'light' }, w: 420, h: 1100 },
  { name: 'remote-settings-off-dark-300', q: { scenario: 'remote-settings-off', theme: 'dark' }, w: 300, h: 1100 },
  { name: 'locaith-welcome-dark-420', q: { scenario: 'locaith-welcome', theme: 'dark' }, w: 420, h: 780 },
  { name: 'locaith-queue-dark-420', q: { scenario: 'locaith-queue', theme: 'dark' }, w: 420, h: 780 },
  { name: 'locaith-queue-light-420', q: { scenario: 'locaith-queue', theme: 'light' }, w: 420, h: 780 },
  { name: 'locaith-queue-dark-300', q: { scenario: 'locaith-queue', theme: 'dark' }, w: 300, h: 780 },
  { name: 'locaith-queue-fresh-dark-420', q: { scenario: 'locaith-queue-fresh', theme: 'dark' }, w: 420, h: 780 },
  { name: 'locaith-queue-trying-light-420', q: { scenario: 'locaith-queue-trying', theme: 'light' }, w: 420, h: 780 },
  { name: 'locaith-queue-en-hc-420', q: { scenario: 'locaith-queue', theme: 'hc', lang: 'en' }, w: 420, h: 780 },
  { name: 'locaith-consent-dark-420', q: { scenario: 'locaith-consent', theme: 'dark' }, w: 420, h: 900 },
  { name: 'locaith-consent-light-420', q: { scenario: 'locaith-consent', theme: 'light' }, w: 420, h: 900 },
  { name: 'locaith-consent-dark-300', q: { scenario: 'locaith-consent', theme: 'dark' }, w: 300, h: 1100 },
  { name: 'locaith-consent-conv-dark-420', q: { scenario: 'locaith-consent-conv', theme: 'dark' }, w: 420, h: 900 },
  { name: 'locaith-consent-saving-dark-420', q: { scenario: 'locaith-consent-saving', theme: 'dark' }, w: 420, h: 900 },
  { name: 'locaith-consent-error-light-420', q: { scenario: 'locaith-consent-error', theme: 'light' }, w: 420, h: 900 },
  { name: 'locaith-consent-outdated-dark-420', q: { scenario: 'locaith-consent-outdated', theme: 'dark', lang: 'en' }, w: 420, h: 900 },
  { name: 'locaith-settings-dark-420', q: { scenario: 'locaith-settings', theme: 'dark' }, w: 420, h: 1000 },
  { name: 'locaith-settings-pending-light-420', q: { scenario: 'locaith-settings-pending', theme: 'light' }, w: 420, h: 1000 },
  { name: '02-onboarding-dark-320', q: { scenario: 'onboarding', theme: 'dark' }, w: 320, h: 780 },
  // (lane:blind-verifier)
  { name: 'verify-fail-dark-420', q: { scenario: 'verify', theme: 'dark' }, w: 420, h: 820, act: async (p) => { await p.click('[data-testid="verify-row"] .tool-head'); await wait(200); } },
  { name: 'verify-fail-collapsed-dark-420', q: { scenario: 'verify', theme: 'dark' }, w: 420, h: 820 },
  { name: 'verify-pass-dark-420', q: { scenario: 'verify-pass', theme: 'dark' }, w: 420, h: 820 },
  { name: 'verify-outstanding-light-420', q: { scenario: 'verify-outstanding', theme: 'light' }, w: 420, h: 820, act: async (p) => { await p.click('[data-testid="verify-row"] .tool-head'); await wait(200); } },
  { name: 'verify-running-dark-320', q: { scenario: 'verify-running', theme: 'dark' }, w: 320, h: 820 },
  { name: 'verify-fail-en-hc-420', q: { scenario: 'verify', theme: 'hc', lang: 'en' }, w: 420, h: 820, act: async (p) => { await p.click('[data-testid="verify-row"] .tool-head'); await wait(200); } },
  { name: '03-research-done-dark-420-full', q: { scenario: 'research', theme: 'dark', speed: '0', expand: '1' }, w: 420, h: 900, full: true },
  { name: '04-research-searching-dark-420', q: { scenario: 'research', theme: 'dark', speed: '0', stop: 'searching' }, w: 420, h: 820 },
  { name: '05-research-pills-dark-420', q: { scenario: 'research', theme: 'dark', speed: '0', stop: 'pills' }, w: 420, h: 820 },
  { name: '06-research-writing-dark-420', q: { scenario: 'research', theme: 'dark', speed: '0', stop: 'writing' }, w: 420, h: 820 },
  { name: '07-research-streaming-dark-420', q: { scenario: 'research', theme: 'dark', speed: '0', stop: 'streaming' }, w: 420, h: 900 },
  { name: '08-research-done-light-420-full', q: { scenario: 'research', theme: 'light', speed: '0', expand: '1' }, w: 420, h: 900, full: true },
  { name: '09-research-done-hc-420', q: { scenario: 'research', theme: 'hc', speed: '0' }, w: 420, h: 900 },
  { name: '10-research-wide-dark-900', q: { scenario: 'research', theme: 'dark', speed: '0' }, w: 900, h: 900 },
  { name: '11-long-dark-420-full', q: { scenario: 'long', theme: 'dark', expand: '1' }, w: 420, h: 900, full: true },
  { name: '12-perm-edit-dark-420', q: { scenario: 'perm-edit', theme: 'dark' }, w: 420, h: 900 },
  { name: '13-perm-cmd-light-420', q: { scenario: 'perm-cmd', theme: 'light' }, w: 420, h: 760 },
  { name: '14-perm-plan-dark-420', q: { scenario: 'perm-plan', theme: 'dark' }, w: 420, h: 900 },
  { name: '15-error-dark-420', q: { scenario: 'error', theme: 'dark' }, w: 420, h: 640 },
  { name: '16-history-dark-420', q: { scenario: 'history', theme: 'dark' }, w: 420, h: 700 },
  { name: '17-settings-dark-420-full', q: { scenario: 'settings', theme: 'dark', expand: '1' }, w: 420, h: 900, full: true },
  { name: '18-settings-nokeys-light-420', q: { scenario: 'settings-nokeys', theme: 'light' }, w: 420, h: 900 },
  {
    name: '19-model-picker-dark-420',
    q: { scenario: 'long', theme: 'dark' },
    w: 420,
    h: 900,
    act: async (p) => {
      await p.click('.picker-btn');
      await wait(250);
    },
  },
  {
    name: '20-mode-picker-dark-420',
    q: { scenario: 'long', theme: 'dark', bypass: '1' },
    w: 420,
    h: 820,
    act: async (p) => {
      const btns = await p.$$('.picker-btn');
      await btns[1].click();
      await wait(250);
    },
  },
  {
    name: '21-think-picker-light-420',
    q: { scenario: 'long', theme: 'light' },
    w: 420,
    h: 820,
    act: async (p) => {
      const btns = await p.$$('.picker-btn');
      await btns[2].click();
      await wait(250);
    },
  },
  {
    name: '22-ctx-popover-dark-420',
    q: { scenario: 'high-context', theme: 'dark' },
    w: 420,
    h: 820,
    act: async (p) => {
      await p.click('.ctx-btn');
      await wait(250);
    },
  },
  {
    name: '23-mention-menu-dark-420',
    q: { scenario: 'long', theme: 'dark' },
    w: 420,
    h: 820,
    act: async (p) => {
      await p.click('.composer-input');
      await p.keyboard.type('Xem giúp mình @bao', { delay: 20 });
      await wait(700);
    },
  },
  {
    name: '24-slash-menu-dark-420',
    q: { scenario: 'welcome', theme: 'dark' },
    w: 420,
    h: 780,
    act: async (p) => {
      await p.click('.composer-input');
      await p.keyboard.type('/', { delay: 20 });
      await wait(300);
    },
  },
  { name: '25-research-done-dark-320', q: { scenario: 'research', theme: 'dark', speed: '0' }, w: 320, h: 900 },
  { name: '26-research-en-dark-420-full', q: { scenario: 'research', theme: 'dark', speed: '0', expand: '1', lang: 'en' }, w: 420, h: 900, full: true },
  { name: '27-research-manrope-dark-420', q: { scenario: 'research', theme: 'dark', speed: '0', font: 'manrope' }, w: 420, h: 900 },
  { name: '28-research-hclight-420', q: { scenario: 'research', theme: 'hclight', speed: '0' }, w: 420, h: 900 },
  { name: '29-icons', q: {}, w: 900, h: 700, page: 'icons.html' },
  // ── nhiều việc chạy cùng lúc (0.6.0): dòng tóm tắt «N lệnh gọi công cụ» + dòng agent con sống ──
  { name: 'parallel-agents-dark-420', q: { scenario: 'parallel-agents', theme: 'dark' }, w: 420, h: 900, act: assertParallelTick },
  { name: 'parallel-agents-light-420', q: { scenario: 'parallel-agents', theme: 'light' }, w: 420, h: 900, act: assertParallel },
  { name: 'parallel-agents-hc-420', q: { scenario: 'parallel-agents', theme: 'hc' }, w: 420, h: 900, act: assertParallel },
  { name: 'parallel-agents-hclight-420', q: { scenario: 'parallel-agents', theme: 'hclight' }, w: 420, h: 900, act: assertParallel },
  { name: 'parallel-agents-en-dark-420', q: { scenario: 'parallel-agents', theme: 'dark', lang: 'en' }, w: 420, h: 900, act: assertParallel },
  {
    name: 'parallel-agents-expanded-dark-420',
    q: { scenario: 'parallel-agents', theme: 'dark' },
    w: 420,
    h: 1200,
    act: async (p) => {
      await p.click('.par-sum .tool-head');
      await wait(250);
    },
  },
  { name: 'parallel-narrow-dark-260', q: { scenario: 'parallel-narrow', theme: 'dark' }, w: 260, h: 900, act: assertParallel },
  { name: 'parallel-narrow-light-300', q: { scenario: 'parallel-narrow', theme: 'light' }, w: 300, h: 900, act: assertParallel },
  { name: 'parallel-wide-dark-900', q: { scenario: 'parallel-narrow', theme: 'dark' }, w: 900, h: 900, act: assertParallel },
  {
    name: '35-scroll-pill-dark-420',
    q: { scenario: 'long', theme: 'dark' },
    w: 420,
    h: 820,
    act: async (p) => {
      await p.$eval('.timeline', (el) => {
        el.scrollTop = Math.max(0, el.scrollHeight / 3);
        el.dispatchEvent(new Event('scroll'));
      });
      await wait(300);
    },
  },
  {
    name: '36-toast-error-dark-420',
    q: { scenario: 'error', theme: 'dark' },
    w: 420,
    h: 640,
    act: async (p) => {
      await p.click('.notice .btn');
      await wait(400);
    },
  },
  {
    name: '37-settings-test-fail-dark-420',
    q: { scenario: 'settings', theme: 'dark' },
    w: 420,
    h: 900,
    act: async (p) => {
      await p.evaluate(() => document.querySelector('#key-deepseek')?.scrollIntoView({ block: 'start' }));
      const btns = await p.$$('.prov-card .field-actions .btn-secondary');
      // thẻ DeepSeek là thẻ thứ 4 (Claude, ChatGPT, Gemini, DeepSeek) → nút "Kiểm tra kết nối" thứ 3 có khóa
      const cards = await p.$$('.prov-card');
      const btn = await cards[3].$('.field-actions .btn-secondary');
      await btn.click();
      await wait(1300);
      await p.evaluate(() => document.querySelector('#key-deepseek')?.scrollIntoView({ block: 'start' }));
      await wait(200);
      void btns;
    },
  },
  {
    name: '34-long-expanded-dark-420-full',
    q: { scenario: 'long', theme: 'dark', expand: '1' },
    w: 420,
    h: 900,
    full: true,
    act: async (p) => {
      // mở các dòng tóm tắt «N lệnh gọi công cụ» (0.6.0) để lộ từng lệnh, rồi mở từng dòng công cụ / suy nghĩ để xem chi tiết (lệnh + kết quả, diff, khối suy nghĩ)
      for (const s of await p.$$('.par-sum > button.tool-head')) await s.click();
      await wait(150);
      const heads = await p.$$('.act-row:not(.tool-group) > .tool-line > button.tool-head, .act-thinking > button.tool-head');
      for (const h of heads) await h.click();
      await wait(250);
    },
  },
  {
    name: '30-composer-text-dark-320',
    q: { scenario: 'welcome', theme: 'dark' },
    w: 320,
    h: 700,
    act: async (p) => {
      await p.click('.composer-input');
      await p.keyboard.type('Tổng hợp giúp mình báo cáo quảng cáo Facebook tháng 10, nhớ ghi rõ chưa bao gồm thuế GTGT 10%.', { delay: 4 });
      await wait(200);
    },
  },
];

async function newPage(browser, w, h) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url().slice(-80)}`));
  return { page, problems };
}

async function openPage(page, file, q) {
  const url = new URL(pathToFileURL(path.join(here, file)).href);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  await page.goto(url.href, { waitUntil: 'load' });
  await page.waitForFunction('window.__ND_READY__ === true', { timeout: 40000 });
  await page.evaluate(() => document.fonts.ready);
  await wait(250);
}

async function runShots(browser) {
  await mkdir(OUT, { recursive: true });
  let failures = 0;
  for (const s of SHOTS) {
    if (filter && !s.name.includes(filter)) continue;
    const { page, problems } = await newPage(browser, s.w ?? 420, s.h ?? 800);
    try {
      await openPage(page, s.page ?? 'harness.html', s.q);
      if (s.act) await s.act(page);
      const file = path.join(OUT, `${s.name}.png`);
      await page.screenshot({ path: file, fullPage: Boolean(s.full) });
      // Ảnh toàn trang rất dài → cắt thành các lát dễ đọc (mỗi lát `slice` px CSS).
      if (s.full) {
        const sliceH = s.slice ?? 760;
        const total = await page.evaluate(() => document.documentElement.scrollHeight);
        for (let y = 0, i = 1; y < total; y += sliceH, i++) {
          await page.screenshot({
            path: path.join(OUT, `${s.name}-part${i}.png`),
            captureBeyondViewport: true,
            clip: { x: 0, y, width: s.w ?? 420, height: Math.min(sliceH, total - y) },
          });
        }
      }
      console.log(`✔ ${s.name}${problems.length ? `  (${problems.length} cảnh báo)` : ''}`);
      problems.forEach((p) => console.log(`    ${p}`));
    } catch (e) {
      failures++;
      console.log(`✘ ${s.name}: ${e.message}`);
      problems.forEach((p) => console.log(`    ${p}`));
    } finally {
      await page.close();
    }
  }
  return failures;
}

// ── kiểm tra bộ gõ tiếng Việt (IME / Telex) ─────────────────────────────────

async function runImeTests(browser) {
  const { page, problems } = await newPage(browser, 420, 760);
  // speed=0: host giả lập trả lời tức thì → không bị khoá gửi vì "đang chạy".
  await openPage(page, 'harness.html', { scenario: 'welcome', theme: 'dark', speed: '0' });
  const sends = () => page.evaluate(() => (window.__ND_LOG__ ?? []).filter((m) => m.type === 'send').length);
  const client = await page.createCDPSession();
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push(ok);
    console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
  };

  await page.click('.composer-input');

  // 1) Bộ gõ thật (CDP): đang ghép chữ "tiê" rồi nhấn Enter → KHÔNG được gửi.
  await client.send('Input.imeSetComposition', { text: 'tiê', selectionStart: 3, selectionEnd: 3 });
  await page.keyboard.press('Enter');
  await wait(80);
  check('Enter khi đang ghép chữ (CDP IME) không gửi tin', (await sends()) === 0);

  // 2) Chốt chữ rồi Enter → gửi.
  await client.send('Input.insertText', { text: 'tiếng Việt' });
  await wait(60);
  const value = await page.$eval('.composer-input', (el) => el.value);
  check('Chữ đã chốt nằm đúng trong ô nhập', value.includes('tiếng Việt'), JSON.stringify(value));
  await page.keyboard.press('Enter');
  await wait(300);
  check('Enter sau khi chốt chữ sẽ gửi tin', (await sends()) === 1);

  // 3) Sự kiện tổng hợp: compositionstart + keydown Enter (isComposing/keyCode 229).
  await page.click('.composer-input');
  await page.$eval('.composer-input', (el) => {
    el.value = 'xin chào';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true }));
  });
  await wait(80);
  check('keydown Enter (isComposing) trong lúc compositionstart không gửi', (await sends()) === 1);
  await page.$eval('.composer-input', (el) => {
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await wait(80); // vượt qua cửa sổ chặn 40 ms ngay sau compositionend
  await page.keyboard.press('Enter');
  await wait(300);
  check('Sau compositionend + chờ, Enter gửi tin', (await sends()) === 2);

  // 3b) Safari/WebKit bắn keydown Enter NGAY sau compositionend → không được gửi (cửa sổ chặn 40 ms).
  await page.click('.composer-input');
  await page.$eval('.composer-input', (el) => {
    el.value = 'chữ vừa chốt';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await wait(300);
  check('keydown Enter ngay sau compositionend không gửi', (await sends()) === 2);
  await page.$eval('.composer-input', (el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // 4) Giữ nguyên chữ đang soạn khi giao diện cập nhật (ô nhập không kiểm soát).
  await page.click('.composer-input');
  await client.send('Input.imeSetComposition', { text: 'Việ', selectionStart: 3, selectionEnd: 3 });
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'patch', patch: { title: 'Cập nhật giữa lúc gõ' } } }));
  });
  await wait(150);
  const composing = await page.$eval('.composer-input', (el) => el.value);
  check('Bản vá trạng thái từ host không xoá chữ đang ghép', composing.includes('Việ'), JSON.stringify(composing));

  // 5) Shift+Enter xuống dòng, không gửi.
  await client.send('Input.insertText', { text: 't' });
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await wait(80);
  check('Shift+Enter không gửi tin', (await sends()) === 2);

  // 6) Dán ảnh từ clipboard → hiện chip ảnh (không chèn chữ vào ô nhập).
  await page.$eval('.composer-input', (el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'anh.png', { type: 'image/png' }));
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await wait(300);
  check('Dán ảnh tạo chip ảnh', (await page.$$('.composer .chip-image')).length === 1);
  await page.click('.composer .chip-x');
  await wait(100);
  check('Bấm × gỡ được chip', (await page.$$('.composer .chip-image')).length === 0);

  // 7) @mention bằng bàn phím: gõ "@bao" (không dấu) → tìm ra "báo-…", Enter chọn → chèn @đường-dẫn + chip tệp.
  await page.click('.composer-input');
  await page.keyboard.type('xem @bao', { delay: 15 });
  await page.waitForSelector('.popover-menu .menu-row', { timeout: 3000 });
  const firstHit = await page.$eval('.popover-menu .menu-row .menu-name', (n) => n.textContent);
  check('Gõ không dấu "bao" vẫn tìm ra tệp có dấu', /báo/.test(firstHit ?? ''), firstHit ?? '');
  await page.keyboard.press('Enter');
  await wait(150);
  const afterMention = await page.$eval('.composer-input', (el) => el.value);
  check('Enter chọn tệp: chèn @đường-dẫn vào văn bản', /@\S*báo\S*/.test(afterMention), JSON.stringify(afterMention));
  check('Enter chọn tệp: thêm chip tệp', (await page.$$('.composer .chip-file')).length === 1);
  check('Chọn @mention không làm gửi tin', (await sends()) === 2);
  await page.$eval('.composer-input', (el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('.composer .chip-x');

  // 8) Lệnh /: gõ "/new" + Enter → gửi thông điệp slash (không gửi như tin nhắn thường).
  await page.click('.composer-input');
  await page.keyboard.type('/new', { delay: 15 });
  await page.keyboard.press('Enter');
  await wait(200);
  const slashMsgs = await page.evaluate(() => (window.__ND_LOG__ ?? []).filter((m) => m.type === 'slash'));
  check('"/new" + Enter gửi lệnh slash', slashMsgs.length >= 1 && slashMsgs.at(-1).command === 'new', JSON.stringify(slashMsgs.at(-1)));
  check('Lệnh slash không bị gửi như tin nhắn thường', (await sends()) === 2);

  // 9) Điều hướng bàn phím trong bộ chọn model: ↓ rồi Enter → đổi sang model kế tiếp.
  await page.click('.picker-model');
  await wait(250);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await wait(200);
  const setModel = await page.evaluate(() => (window.__ND_LOG__ ?? []).filter((m) => m.type === 'set_model').at(-1));
  check('Bộ chọn model: ↓ + Enter chọn model kế tiếp', setModel?.model === 'claude-sonnet-5-5', JSON.stringify(setModel));

  // 10) Esc đóng menu mà không dừng/không gửi gì.
  await page.click('.picker-model');
  await wait(200);
  await page.keyboard.press('Escape');
  await wait(150);
  check('Esc đóng bộ chọn model', (await page.$$('.popover-model')).length === 0);

  problems.forEach((p) => console.log(`    ${p}`));
  await page.close();
  return results.filter((ok) => !ok).length;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--allow-file-access-from-files', '--no-sandbox', '--force-color-profile=srgb'],
});
let failures = 0;
try {
  failures = imeMode ? await runImeTests(browser) : await runShots(browser);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} mục lỗi` : '\nXong, không có lỗi.');
process.exit(failures ? 1 : 0);
