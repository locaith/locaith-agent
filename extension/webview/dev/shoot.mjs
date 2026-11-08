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
      // (lane:cc-timeline-ui) dòng nhóm gập của lượt đang chạy (RunHead) — agent sống hiện ngay dưới nhóm gập
      sums: q('.turn-assistant > .run-group > .cc-head .cc-count').map((e) => e.textContent.trim()),
      overflowX: tl ? tl.scrollWidth - tl.clientWidth : -1,
      heights: rows.map((e) => Math.round(e.getBoundingClientRect().height)),
      counts: rows.map((e) => [shown(e.querySelector('.par-st-counts')), shown(e.querySelector('.par-act-counts'))]),
      times: rows.map((e) => (e.querySelector('.par-st-time') || {}).textContent || ''),
    };
  });
  if (r.agents !== 3) throw new Error(`cần 3 dòng agent sống, thấy ${r.agents}`);
  if (r.sums.length < 2 || !r.sums.every((s) => /(lệnh gọi công cụ|tool calls)/.test(s))) throw new Error(`dòng tóm tắt sai: ${JSON.stringify(r.sums)}`);
  if (!/^83 /.test(r.sums[0])) throw new Error(`tổng phải là 83 (80 lệnh + 3 agent; lệnh của agent con hiện trên dòng agent): ${r.sums[0]}`);
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

/**
 * (lane:cc-timeline-ui) Cảnh «cc-timeline» gập: đúng 4 dòng nhóm (22 · 54+2 lỗi · 36+2 lỗi · đang chạy), chấm xanh/đỏ/sống đúng màu,
 * dòng agent với bộ số nằm dưới nhóm gập, dòng nén, đường ngăn ngày + giờ, chip đồng hồ dưới ô nhập, placeholder xếp hàng, không tràn ngang.
 */
async function assertCcCollapsed(p) {
  const r = await p.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    const tl = document.querySelector('.timeline');
    // dòng nhóm cấp lượt: «quá trình» của lượt đã xong (work-sum), cụm gộp (run-group) hoặc một dòng tóm tắt lẻ (par-sum) của lượt đang chạy
    const heads = q('.turn-assistant > .act.work-sum .cc-head, .turn-assistant > .run-group > .cc-head, .turn-assistant > .act > .par-sum > .cc-head');
    return {
      heads: heads.map((h) => ({ text: h.querySelector('.cc-line').textContent.trim(), dot: [...h.querySelector('.cc-dot').classList].find((c) => c.startsWith('is-')), sub: (h.querySelector('.cc-sub') || {}).textContent || '' })),
      agents: q('.par-agent').map((e) => ({ title: e.querySelector('.par-agent-title').textContent, stats: e.querySelector('.par-agent-stats').textContent, h: Math.round(e.getBoundingClientRect().height) })),
      compact: q('.cc-compact-head').map((e) => e.textContent.trim()),
      days: q('.cc-day-label').map((e) => e.textContent),
      stamps: q('.cc-stamp').map((e) => e.textContent),
      clock: (document.querySelector('.cc-clock-text') || {}).textContent || '',
      placeholder: (document.querySelector('.composer-input') || {}).placeholder || '',
      browser: /platform=browser/.test(location.search),
      icons: q('.act-row .act-icon svg').length,
      overflowX: tl ? tl.scrollWidth - tl.clientWidth : -1,
      width: document.querySelector('.app').clientWidth,
    };
  });
  if (r.heads.length !== 4) throw new Error(`cần 4 dòng nhóm, thấy ${r.heads.length}: ${JSON.stringify(r.heads)}`);
  const [g22, g54, g36, gLive] = r.heads;
  if (!/^22 /.test(g22.text) || g22.dot !== 'is-ok') throw new Error(`nhóm 1 phải «22 …» chấm xanh: ${JSON.stringify(g22)}`);
  if (!/^54 .*2 (lỗi|failed)/.test(g54.text) || g54.dot !== 'is-fail') throw new Error(`nhóm 2 phải «54 … 2 lỗi» chấm đỏ: ${JSON.stringify(g54)}`);
  if (!/^36 .*2 (lỗi|failed)/.test(g36.text) || g36.dot !== 'is-fail') throw new Error(`nhóm 3 phải «36 … 2 lỗi» chấm đỏ: ${JSON.stringify(g36)}`);
  if (!/^(Đang chạy|Running) (Lệnh|Bash)/.test(gLive.text) || !/10 /.test(gLive.text) || gLive.dot !== 'is-live') throw new Error(`nhóm đang chạy sai: ${JSON.stringify(gLive)}`);
  if (!/(Chạy nền|Run in background)/.test(gLive.sub)) throw new Error(`thiếu dòng phụ «Chạy nền»: ${JSON.stringify(gLive)}`);
  if (r.agents.length !== 1 || !/654,9k|654\.9k/.test(r.agents[0].stats) || !/249/.test(r.agents[0].stats) || !/39( phút|m)/.test(r.agents[0].stats)) throw new Error(`dòng agent sai: ${JSON.stringify(r.agents)}`);
  if (r.agents[0].h > 60) throw new Error(`dòng agent cao hơn hai dòng chữ: ${r.agents[0].h}`);
  if (r.compact.length !== 1 || !/968k/.test(r.compact[0])) throw new Error(`dòng nén sai: ${JSON.stringify(r.compact)}`);
  if (r.days.length !== 1) throw new Error(`cần đúng 1 đường ngăn ngày: ${JSON.stringify(r.days)}`);
  if (r.stamps.length < 5) throw new Error(`thiếu dấu giờ: ${JSON.stringify(r.stamps)}`);
  if (!/^\d+[smh]/.test(r.clock)) throw new Error(`chip đồng hồ không hiện: ${JSON.stringify(r.clock)}`);
  // Bản Chrome chưa có hàng chờ tin nhắn → placeholder «đang làm việc» như cũ; VS Code → «Xếp hàng tin nhắn khác…».
  if (!r.browser && !/(Xếp hàng|Queue)/.test(r.placeholder)) throw new Error(`placeholder phải nói xếp hàng: ${r.placeholder}`);
  if (r.icons !== 0) throw new Error(`dòng thời gian gập không được có biểu tượng SVG ở cột chấm: ${r.icons}`);
  if (r.overflowX > 1) throw new Error(`tràn ngang ${r.overflowX}px ở bề ngang ${r.width}px`);
}

/** Nhãn đang chạy cuối lượt: từ khoá đậm + logo Lo, không dấu «…». */
async function assertCcWorking(p) {
  const r = await p.evaluate(() => {
    const w = document.querySelector('.cc-working');
    return { label: w ? w.querySelector('.cc-working-label').textContent : null, logo: !!(w && w.querySelector('.lo-spin')), weight: w ? getComputedStyle(w.querySelector('.cc-working-label')).fontWeight : '' };
  });
  if (!r.label || /…/.test(r.label) || !r.logo || Number(r.weight) < 600) throw new Error(`nhãn đang chạy sai: ${JSON.stringify(r)}`);
}

/**
 * (0.7.2) Nhân vật chờ ở dòng đang chạy. Kiểm DOM: ô nhân vật đúng 20×20 px, chiều cao dòng chờ KHÔNG phụ thuộc ô (bằng đúng dòng chữ),
 * không tràn ngang. `freezeFrame` (0–5) đóng băng hoạt hoạ ở khung đó (tham số truy vấn `actor=` khoá cảnh; xem LoActor.tsx).
 */
function assertActor(freezeFrame) {
  return async (p) => {
    const r = await p.evaluate(() => {
      const w = document.querySelector('.cc-working');
      const a = w && w.querySelector('.lo-actor');
      const tl = document.querySelector('.timeline');
      const box = a ? a.getBoundingClientRect() : null;
      return {
        has: !!a,
        wh: w ? w.getBoundingClientRect().height : 0,
        lh: w ? w.querySelector('.cc-working-label').getBoundingClientRect().height + parseFloat(getComputedStyle(w).paddingTop) + parseFloat(getComputedStyle(w).paddingBottom) : 0,
        w: box ? Math.round(box.width * 10) / 10 : 0,
        h: box ? Math.round(box.height * 10) / 10 : 0,
        overflowX: tl ? tl.scrollWidth - tl.clientWidth : -1,
        char: !!(a && a.querySelector('.lo-actor-char')),
        frames: a ? a.querySelectorAll('.lo-fr').length : 0,
      };
    });
    if (!r.has) throw new Error('thiếu .lo-actor ở dòng chờ');
    if (r.w !== 20 || r.h !== 20) throw new Error(`ô nhân vật phải 20×20: ${r.w}×${r.h}`);
    if (Math.abs(r.wh - r.lh) > 0.6) throw new Error(`chiều cao dòng chờ (${r.wh}) khác dòng chữ + đệm (${r.lh}) — ô nhân vật làm đổi chiều cao`);
    if (r.overflowX > 1) throw new Error(`tràn ngang ${r.overflowX}px`);
    if (r.char && r.frames !== 6) throw new Error(`nhân vật phải có 6 khung: ${r.frames}`);
    if (freezeFrame !== undefined) {
      await p.evaluate((k) => {
        for (const an of document.getAnimations()) {
          an.pause();
          an.currentTime = k * 150 + 75;
        }
      }, freezeFrame);
    }
  };
}

/**
 * (0.7.2) Tờ liên hoàn phóng 4,5×: `mode` = 'frames' → 6 khung của vòng lặp; 'wipe' → chuyển cảnh vào ở 0/20/40/60/80/100%; 'wipe-out' → ra.
 * Mỗi ô là một bản sao của ô thật (cùng CSS) bị đóng băng ở thời điểm cần xem.
 */
function actorSheet(mode) {
  return async (p) => {
    await assertActor()(p);
    await p.evaluate((mode) => {
      const src = document.querySelector('.cc-working .lo-actor');
      const row = document.createElement('div');
      row.id = 'actor-sheet';
      row.style.cssText = 'position:fixed;left:0;right:0;top:80px;z-index:9999;display:flex;gap:4px;flex-wrap:wrap;padding:14px 8px;background:var(--vscode-editor-background);';
      document.querySelector('.cc-working').after(row);
      const times = mode === 'frames' ? [0, 1, 2, 3, 4, 5].map((k) => k * 150 + 75) : [0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => q * 500);
      for (const t of times) {
        const cell = document.createElement('div');
        cell.style.cssText = 'width:60px;height:60px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:color-mix(in srgb, var(--fg) 7%, transparent);';
        const c = src.cloneNode(true);
        c.style.transform = 'scale(2.7)';
        cell.appendChild(c);
        row.appendChild(cell);
        for (const an of c.getAnimations({ subtree: true })) {
          an.pause();
          an.currentTime = t;
        }
      }
      src.style.visibility = 'hidden';
    }, mode);
    await wait(150);
  };
}

/** Mở nhóm thứ i (0 = «22», 2 = «36 · 2 lỗi» có Write/Edit/Bash) và kiểm cấu trúc bên trong: thanh dọc, IN/OUT, xem trước tệp, nút Thu gọn ở cuối. */
function expandCcGroup(i) {
  return async (p) => {
    const heads = await p.$$('.turn-assistant > .act.work-sum .cc-head, .turn-assistant > .run-group > .cc-head, .turn-assistant > .act > .par-sum > .cc-head');
    await heads[i].click();
    await wait(300);
    const r = await p.evaluate(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const body = document.querySelector('.work-body');
      const tl = document.querySelector('.timeline');
      return {
        body: !!body,
        border: body ? getComputedStyle(body).borderLeftWidth : '',
        // «Phẳng»: KHÔNG phần tử nào trong lượt trả lời có viền trái MỘT BÊN (thanh dọc) — hộp IN/OUT, khung mã, trích dẫn có viền đủ 4 cạnh/ngoại lệ riêng.
        rails: q('.turn-assistant *')
          .filter((e) => {
            const c = getComputedStyle(e);
            return parseFloat(c.borderLeftWidth) > 0 && c.borderLeftStyle !== 'none' && parseFloat(c.borderTopWidth) === 0 && parseFloat(c.borderBottomWidth) === 0 && !e.closest('blockquote');
          })
          .map((e) => e.className || e.tagName),
        indent: body ? parseFloat(getComputedStyle(body).marginLeft) + parseFloat(getComputedStyle(body).paddingLeft) : -1,
        thought: q('.cc-think').map((e) => e.textContent),
        actions: q('.work-body .cc-action').map((e) => e.textContent),
        io: q('.cc-io-label').map((e) => e.textContent),
        previews: q('.cc-preview').length,
        lines: q('.cc-lines').map((e) => e.textContent),
        paths: q('.cc-path').length,
        errOut: q('.cc-io.is-error').length,
        foot: q('.work-body > .collapse-foot').length,
        overflowX: tl ? tl.scrollWidth - tl.clientWidth : -1,
      };
    });
    if (!r.body) throw new Error(`thiếu thân nhóm sau khi mở: ${JSON.stringify(r)}`);
    if (r.border !== '0px' || r.rails.length) throw new Error(`thân nhóm phải PHẲNG (không thanh dọc): ${JSON.stringify({ border: r.border, rails: r.rails })}`);
    if (r.indent !== 0) throw new Error(`thân nhóm không được thụt lề (chấm thẳng một cột): ${r.indent}`);
    if (r.foot !== 1) throw new Error('thiếu nút Thu gọn ở cuối thân nhóm');
    if (r.overflowX > 1) throw new Error(`tràn ngang ${r.overflowX}px`);
    if (i === 0) {
      if (!r.thought.some((x) => /(Đã suy nghĩ 14 giây|Thought for 14s)/.test(x))) throw new Error(`thiếu «Đã suy nghĩ 14 giây»: ${JSON.stringify(r.thought)}`);
      if (!r.actions.some((a) => /^(Lệnh|Bash)$/.test(a))) throw new Error(`thiếu dòng Lệnh/Bash: ${JSON.stringify(r.actions)}`);
      if (r.io.filter((x) => x === 'IN').length < 2 || r.io.filter((x) => x === 'OUT').length < 2) throw new Error(`thiếu ô IN/OUT: ${JSON.stringify(r.io)}`);
    }
    if (i === 2) {
      if (!r.actions.some((a) => /^(Ghi|Write)$/.test(a)) || r.previews < 2) throw new Error(`thiếu dòng Ghi + xem trước tệp: ${JSON.stringify(r)}`);
      if (!r.lines.some((x) => /58/.test(x))) throw new Error(`thiếu «58 dòng»: ${JSON.stringify(r.lines)}`);
      if (r.paths < 3) throw new Error(`đường dẫn màu liên kết phải có ở Ghi/Sửa: ${r.paths}`);
      if (r.errOut !== 1) throw new Error(`đầu ra lỗi (chữ đỏ) phải có đúng 1: ${r.errOut}`);
    }
  };
}

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
  // (lane:checkpoints-rewind)
  { name: 'rewind-bar-dark-420', q: { scenario: 'rewind-bar', theme: 'dark' }, w: 420, h: 900 },
  { name: 'rewind-menu-dark-420', q: { scenario: 'rewind-menu', theme: 'dark' }, w: 420, h: 900 },
  { name: 'rewind-plan-dark-420', q: { scenario: 'rewind-plan', theme: 'dark' }, w: 420, h: 900 },
  { name: 'rewind-plan-light-320', q: { scenario: 'rewind-plan', theme: 'light' }, w: 320, h: 900 },
  { name: 'rewind-done-dark-420', q: { scenario: 'rewind-done', theme: 'dark' }, w: 420, h: 900 },
  { name: 'rewind-recent-hc-420', q: { scenario: 'rewind-recent', theme: 'hc' }, w: 420, h: 900 },
  { name: '12-perm-edit-dark-420', q: { scenario: 'perm-edit', theme: 'dark' }, w: 420, h: 900 },
  { name: '13-perm-cmd-light-420', q: { scenario: 'perm-cmd', theme: 'light' }, w: 420, h: 760 },
  { name: '14-perm-plan-dark-420', q: { scenario: 'perm-plan', theme: 'dark' }, w: 420, h: 900 },
  { name: '15-error-dark-420', q: { scenario: 'error', theme: 'dark' }, w: 420, h: 640 },
  // (lane:output-timeouts)
  // (0.7.2) bảng lựa chọn cuối hội thoại: nằm TRONG dòng hội thoại (không ở chân khung), có chip «Tất cả», phẳng
  // (0.7.2) Dọn bộ nhớ trong Cài đặt + chế độ nhẹ
  { name: 'cleanup-click-dark-420', q: { scenario: 'settings', theme: 'dark' }, w: 420, h: 900, act: assertCleanup({ click: true }) },
  { name: 'cleanup-dark-420', q: { scenario: 'settings', theme: 'dark' }, w: 420, h: 900, act: assertCleanup() },
  { name: 'cleanup-light-320', q: { scenario: 'settings', theme: 'light' }, w: 320, h: 900, act: assertCleanup() },
  { name: 'cleanup-en-hc-420', q: { scenario: 'settings', theme: 'hc', lang: 'en' }, w: 420, h: 900, act: assertCleanup() },
  { name: 'lite-media-dark-420', q: { scenario: 'media', theme: 'dark', lite: '1' }, w: 420, h: 900, act: assertLiteMedia },
  { name: 'options-all-dark-420', q: { scenario: 'options-directions', theme: 'dark' }, w: 420, h: 900, act: assertOptions({ all: true }) },
  { name: 'options-all-click-dark-420', q: { scenario: 'options-directions', theme: 'dark' }, w: 420, h: 900, act: assertOptions({ all: true, click: true }) },
  { name: 'options-all-light-420', q: { scenario: 'options-directions', theme: 'light' }, w: 420, h: 900, act: assertOptions({ all: true }) },
  { name: 'options-all-dark-300', q: { scenario: 'options-directions', theme: 'dark' }, w: 300, h: 900, act: assertOptions({ all: true }) },
  { name: 'options-all-en-light-320', q: { scenario: 'options-directions', theme: 'light', lang: 'en' }, w: 320, h: 900, act: assertOptions({ all: true, en: true }) },
  { name: 'options-continue-inline-dark-420', q: { scenario: 'cut-continue', theme: 'dark' }, w: 420, h: 900, act: assertOptions({ all: false }) },
  { name: 'cut-continue-dark-420', q: { scenario: 'cut-continue', theme: 'dark' }, w: 420, h: 900 },
  { name: 'cut-continue-light-320', q: { scenario: 'cut-continue', theme: 'light' }, w: 320, h: 900 },
  { name: 'cut-forced-dark-420', q: { scenario: 'cut-forced', theme: 'dark' }, w: 420, h: 900 },
  { name: 'cut-continue-en-hc-420', q: { scenario: 'cut-continue', theme: 'hc', lang: 'en' }, w: 420, h: 900 },
  { name: '16-history-dark-420', q: { scenario: 'history', theme: 'dark' }, w: 420, h: 700 },
  // (lane:sessions-ux)
  { name: '16b-sessions-history-dark-420', q: { scenario: 'sessions-ux-history', theme: 'dark' }, w: 420, h: 760 },
  {
    name: '16c-sessions-meter-dark-420',
    q: { scenario: 'sessions-ux', theme: 'dark' },
    w: 420,
    h: 520,
    act: async (p) => {
      await p.click('.meter-chip');
      await wait(250);
    },
  },
  {
    name: '16d-sessions-msgmenu-dark-320',
    q: { scenario: 'sessions-ux', theme: 'dark' },
    w: 320,
    h: 520,
    act: async (p) => {
      await p.click('.msg-menu-btn');
      await wait(250);
    },
  },
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
    name: '23-bg-tasks-dark-420', // (lane:bg-tasks)
    q: { scenario: 'bg-tasks', theme: 'dark' },
    w: 420,
    h: 820,
    act: async (p) => {
      await p.click('.bgt-chip');
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
  // ── (lane:cc-timeline-ui) dòng thời gian gọn kiểu Claude Code: tái hiện ba ảnh mẫu ──
  { name: 'cc-1-collapsed-dark-420', q: { scenario: 'cc-timeline', theme: 'dark', expand: '1' }, w: 420, h: 900, full: true, act: assertCcCollapsed },
  { name: 'cc-1-collapsed-light-420', q: { scenario: 'cc-timeline', theme: 'light', expand: '1' }, w: 420, h: 900, full: true },
  { name: 'cc-1-collapsed-hc-420', q: { scenario: 'cc-timeline', theme: 'hc', expand: '1' }, w: 420, h: 900, full: true },
  { name: 'cc-1-collapsed-en-dark-420', q: { scenario: 'cc-timeline', theme: 'dark', expand: '1', lang: 'en' }, w: 420, h: 900, full: true, act: assertCcCollapsed },
  { name: 'cc-1-collapsed-dark-300', q: { scenario: 'cc-timeline', theme: 'dark', expand: '1' }, w: 300, h: 900, full: true, act: assertCcCollapsed },
  { name: 'cc-1-collapsed-browser-dark-420', q: { scenario: 'cc-timeline', theme: 'dark', expand: '1', platform: 'browser' }, w: 420, h: 900, full: true, act: assertCcCollapsed },
  // ── (0.7.2) nhân vật chờ ──
  { name: 'actor-dog-frames-dark-420', q: { scenario: 'cc-working', theme: 'dark', actor: 'dog:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-dog-frames-light-420', q: { scenario: 'cc-working', theme: 'light', actor: 'dog:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-dog-frames-hc-420', q: { scenario: 'cc-working', theme: 'hc', actor: 'dog:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-dog-real-dark-300', q: { scenario: 'cc-working', theme: 'dark', actor: 'dog:char' }, w: 300, h: 420, act: assertActor(1) },
  { name: 'actor-dog-real-light-420', q: { scenario: 'cc-working', theme: 'light', actor: 'dog:char' }, w: 420, h: 420, act: assertActor(2) },
  { name: 'actor-dog-real-hc-800', q: { scenario: 'cc-working', theme: 'hc', actor: 'dog:char' }, w: 800, h: 420, act: assertActor(4) },
  { name: 'actor-bot-frames-dark-420', q: { scenario: 'cc-working', theme: 'dark', actor: 'bot:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-bot-frames-light-420', q: { scenario: 'cc-working', theme: 'light', actor: 'bot:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-bot-frames-hc-420', q: { scenario: 'cc-working', theme: 'hc', actor: 'bot:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-bot-real-dark-300', q: { scenario: 'cc-working', theme: 'dark', actor: 'bot:char' }, w: 300, h: 420, act: assertActor(1) },
  { name: 'actor-bot-real-light-420', q: { scenario: 'cc-working', theme: 'light', actor: 'bot:char' }, w: 420, h: 420, act: assertActor(2) },
  { name: 'actor-bot-real-hc-800', q: { scenario: 'cc-working', theme: 'hc', actor: 'bot:char' }, w: 800, h: 420, act: assertActor(4) },
  { name: 'actor-drone-frames-dark-420', q: { scenario: 'cc-working', theme: 'dark', actor: 'drone:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-drone-frames-light-420', q: { scenario: 'cc-working', theme: 'light', actor: 'drone:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-drone-frames-hc-420', q: { scenario: 'cc-working', theme: 'hc', actor: 'drone:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-drone-real-dark-300', q: { scenario: 'cc-working', theme: 'dark', actor: 'drone:char' }, w: 300, h: 420, act: assertActor(1) },
  { name: 'actor-drone-real-light-420', q: { scenario: 'cc-working', theme: 'light', actor: 'drone:char' }, w: 420, h: 420, act: assertActor(2) },
  { name: 'actor-drone-real-hc-800', q: { scenario: 'cc-working', theme: 'hc', actor: 'drone:char' }, w: 800, h: 420, act: assertActor(4) },
  { name: 'actor-rocket-frames-dark-420', q: { scenario: 'cc-working', theme: 'dark', actor: 'rocket:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-rocket-frames-light-420', q: { scenario: 'cc-working', theme: 'light', actor: 'rocket:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-rocket-frames-hc-420', q: { scenario: 'cc-working', theme: 'hc', actor: 'rocket:char' }, w: 420, h: 360, act: actorSheet('frames') },
  { name: 'actor-rocket-real-dark-300', q: { scenario: 'cc-working', theme: 'dark', actor: 'rocket:char' }, w: 300, h: 420, act: assertActor(1) },
  { name: 'actor-rocket-real-light-420', q: { scenario: 'cc-working', theme: 'light', actor: 'rocket:char' }, w: 420, h: 420, act: assertActor(2) },
  { name: 'actor-rocket-real-hc-800', q: { scenario: 'cc-working', theme: 'hc', actor: 'rocket:char' }, w: 800, h: 420, act: assertActor(4) },
  { name: 'actor-dog-wipein-dark-420', q: { scenario: 'cc-working', theme: 'dark', actor: 'dog:in' }, w: 420, h: 360, act: actorSheet('wipe') },
  { name: 'actor-bot-wipein-dark-420', q: { scenario: 'cc-working', theme: 'dark', actor: 'bot:in' }, w: 420, h: 360, act: actorSheet('wipe') },
  { name: 'actor-rocket-wipeout-light-420', q: { scenario: 'cc-working', theme: 'light', actor: 'rocket:out' }, w: 420, h: 360, act: actorSheet('wipe') },
  { name: 'actor-logo-dark-420', q: { scenario: 'cc-working', theme: 'dark' }, w: 420, h: 420, act: assertActor() },
  { name: 'cc-working-dark-420', q: { scenario: 'cc-working', theme: 'dark' }, w: 420, h: 820, act: assertCcWorking },
  { name: 'cc-2-expanded-bash-dark-420', q: { scenario: 'cc-timeline', theme: 'dark', expand: '1' }, w: 420, h: 900, full: true, act: expandCcGroup(0) },
  { name: 'cc-3-expanded-write-dark-420', q: { scenario: 'cc-timeline', theme: 'dark', expand: '1' }, w: 420, h: 900, full: true, act: expandCcGroup(2) },
  { name: 'cc-3-expanded-write-light-300', q: { scenario: 'cc-timeline', theme: 'light', expand: '1' }, w: 300, h: 900, full: true, act: expandCcGroup(2) },
  { name: 'cc-compact-open-dark-420', q: { scenario: 'cc-timeline', theme: 'dark', expand: '1' }, w: 420, h: 900, full: true, act: async (p) => { await p.click('.cc-compact-head'); await wait(200); } },
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
      await p.click('.turn-assistant > .run-group > .cc-head');
      await wait(250);
    },
  },
  { name: 'before-after-dark-420', q: { scenario: 'before-after', theme: 'dark', expand: '1' }, w: 420, h: 700 },
  // Ảnh nguồn cho ảnh chụp màn hình trang cửa hàng Chrome (nền sáng, nền tảng browser): _work/chrome-store-shots-07.mjs ghép lại.
  { name: 'store-timeline-light-420', q: { scenario: 'cc-timeline', theme: 'light', platform: 'browser' }, w: 420, h: 760 },
  { name: 'store-research-light-420', q: { scenario: 'research', theme: 'light', speed: '0', platform: 'browser' }, w: 420, h: 760 },
  // Kiểm «phẳng» (không thanh dọc) cho nhóm «Việc: …» và khối suy nghĩ bung ra
  { name: 'flat-taskflow-expanded-dark-420', q: { scenario: 'taskflow', theme: 'dark', expand: '1' }, w: 420, h: 900, full: true },
  { name: 'flat-taskflow-expanded-light-300', q: { scenario: 'taskflow', theme: 'light', expand: '1' }, w: 300, h: 900, full: true },
  { name: 'flat-thinking-dark-420', q: { scenario: 'thinking', theme: 'dark', expand: '1' }, w: 420, h: 700 },
  { name: 'rating-ask-dark-420', q: { scenario: 'rating', theme: 'dark', platform: 'browser' }, w: 420, h: 520 },
  { name: 'rating-thanks-dark-420', q: { scenario: 'rating-thanks', theme: 'dark', platform: 'browser' }, w: 420, h: 520 },
  { name: 'rating-queued-light-420', q: { scenario: 'rating-queued', theme: 'light', platform: 'browser' }, w: 420, h: 520 },
  { name: 'rating-thanks-low-dark-300', q: { scenario: 'rating-thanks-low', theme: 'dark', platform: 'browser' }, w: 300, h: 560 },
  { name: 'before-after-narrow-dark-300', q: { scenario: 'before-after', theme: 'dark', expand: '1' }, w: 300, h: 900 },
  { name: 'before-after-light-720', q: { scenario: 'before-after', theme: 'light', expand: '1' }, w: 720, h: 600 },
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
      // mở dòng «quá trình» của lượt đã xong (lane:cc-timeline-ui: RunHead) rồi các dòng tóm tắt bên trong, rồi từng dòng công cụ / suy nghĩ
      for (const s of await p.$$('.work-sum .cc-head')) await s.click();
      await wait(150);
      for (const s of await p.$$('.par-sum > button.tool-head[aria-expanded="false"]')) await s.click();
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

/**
 * (0.7.2) Bảng lựa chọn cuối hội thoại: nằm TRONG `.timeline-inner` (sau lượt trả lời cuối, cuộn cùng nội dung), KHÔNG còn ở chân khung;
 * chip «Tất cả» chỉ có với kiểu «hướng đi»; bấm «Tất cả» gửi MỘT tin liệt kê đủ các hướng; «×» ẩn được; không tràn ngang.
 */
function assertOptions({ all, en = false, click = false }) {
  return async (p) => {
    const r = await p.evaluate(() => {
      const bar = document.querySelector('.timeline-inner .options');
      const inFooter = !!document.querySelector('.app-foot .options');
      const tl = document.querySelector('.timeline');
      const chip = document.querySelector('.timeline-inner .option-all');
      const lastTurn = [...document.querySelectorAll('.timeline-inner > *')].filter((e) => !e.classList.contains('options'));
      const before = bar && lastTurn.length ? lastTurn[lastTurn.length - 1].compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
      const cs = bar ? getComputedStyle(bar) : null;
      return {
        inTimeline: !!bar,
        inFooter,
        hasAll: !!chip,
        allText: chip ? chip.textContent.trim() : '',
        chips: document.querySelectorAll('.timeline-inner .option-chip').length,
        after: !!before,
        boxed: cs ? parseFloat(cs.borderTopWidth) > 0 || cs.backgroundColor !== 'rgba(0, 0, 0, 0)' : false,
        overflowX: tl ? tl.scrollWidth - tl.clientWidth : -1,
      };
    });
    if (!r.inTimeline) throw new Error('bảng lựa chọn phải nằm trong dòng hội thoại (.timeline-inner)');
    if (r.inFooter) throw new Error('bảng lựa chọn không được lặp ở chân khung (.app-foot)');
    if (!r.after) throw new Error('bảng lựa chọn phải đứng SAU lượt trả lời cuối');
    if (r.boxed) throw new Error('bảng lựa chọn trong hội thoại phải phẳng (không khung/nền)');
    if (r.overflowX > 1) throw new Error(`tràn ngang ${r.overflowX}px`);
    if (all) {
      if (!r.hasAll) throw new Error('thiếu chip «Tất cả»');
      if (r.allText !== (en ? 'All' : 'Tất cả')) throw new Error(`nhãn chip sai: ${r.allText}`);
      if (r.chips !== 4) throw new Error(`cần 3 hướng + chip Tất cả, thấy ${r.chips}`);
      if (!click) return;
      await p.evaluate(() => { window.__ND_LOG__ = []; });
      await p.click('.timeline-inner .option-all');
      await wait(150);
      const sent = await p.evaluate(() => (window.__ND_LOG__ ?? []).filter((m) => m.type === 'send').map((m) => m.text));
      if (sent.length !== 1) throw new Error(`bấm «Tất cả» phải gửi đúng 1 tin, gửi ${sent.length}`);
      if (!/1\) .*2\) .*3\) /.test(sent[0])) throw new Error(`tin «Tất cả» thiếu hướng: ${sent[0]}`);
      if (!sent[0].startsWith(en ? 'Do all of the following' : 'Làm tất cả các hướng sau')) throw new Error(`mở đầu sai: ${sent[0].slice(0, 60)}`);
    } else if (r.hasAll) throw new Error('kiểu «Chạy tiếp» không được có chip «Tất cả»');
  };
}

/** (0.7.2) Thẻ «Dọn dẹp bộ nhớ»: đủ 4 việc, có số liệu (MB), không tràn ngang; bấm nút gửi đúng `cleanup_run`. */
function assertCleanup({ click = false } = {}) {
  return async (p) => {
    await p.waitForSelector('#cleanup .cleanup-figure', { timeout: 4000 });
    await wait(400);
    await p.evaluate(() => document.querySelector('#cleanup')?.scrollIntoView({ block: 'start' }));
    await wait(200);
    const r = await p.evaluate(() => {
      const card = document.querySelector('#cleanup');
      const sc = document.querySelector('.pane-scroll') || document.scrollingElement;
      return {
        rows: card ? card.querySelectorAll('.cleanup-row').length : 0,
        figs: card ? [...card.querySelectorAll('.cleanup-figure')].map((e) => e.textContent.trim()) : [],
        total: card?.querySelector('.cleanup-total strong')?.textContent.trim() ?? '',
        overflowX: sc ? sc.scrollWidth - sc.clientWidth : -1,
      };
    });
    if (r.rows !== 4) throw new Error(`cần 4 việc dọn, thấy ${r.rows}`);
    if (r.figs.some((f) => !/(MB|KB)/.test(f))) throw new Error(`thiếu số liệu: ${JSON.stringify(r.figs)}`);
    if (!/MB/.test(r.total)) throw new Error(`tổng sai: ${r.total}`);
    if (r.overflowX > 1) throw new Error(`tràn ngang ${r.overflowX}px`);
    if (!click) return;
    await p.evaluate(() => { window.__ND_LOG__ = []; });
    await p.click('#cleanup .cleanup-row .btn');
    await wait(150);
    const sent = await p.evaluate(() => (window.__ND_LOG__ ?? []).filter((m) => m.type === 'cleanup_run'));
    if (sent.length !== 1 || sent[0].action !== 'images' || sent[0].days !== 30) throw new Error(`bấm «Xoá ảnh» phải gửi cleanup_run images 30, gửi ${JSON.stringify(sent)}`);
  };
}

/** (0.7.2) Chế độ nhẹ: không tự nạp xem trước media; có nút «Xem trước»; <html> có lớp lite. */
async function assertLiteMedia(p) {
  await wait(500);
  const r = await p.evaluate(() => ({
    lite: document.documentElement.classList.contains('lite'),
    tiles: document.querySelectorAll('.media-tile, .media-card').length,
    buttons: document.querySelectorAll('.media-lite').length,
  }));
  if (!r.lite) throw new Error('thiếu lớp lite trên <html>');
  if (r.tiles !== 0) throw new Error(`chế độ nhẹ vẫn tự xem trước ${r.tiles} tệp`);
  if (r.buttons < 1) throw new Error('thiếu nút «Xem trước» trong chế độ nhẹ');
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
      // «Phẳng» TOÀN CỤC (anh chê «nhiều viền dọc quá» 07/11/2026): không phần tử nào trong dòng thời gian có viền trái MỘT BÊN (thanh dọc).
      // Ngoại lệ có chủ đích: trích dẫn markdown (blockquote), dải trạng thái hàng chờ (queue), chế độ tương phản cao.
      if ((s.page ?? 'harness.html') === 'harness.html') {
        const rails = await page.evaluate(() =>
          [...document.querySelectorAll('.timeline *')]
            .filter((e) => {
              const c = getComputedStyle(e);
              return parseFloat(c.borderLeftWidth) > 0 && c.borderLeftStyle !== 'none' && parseFloat(c.borderTopWidth) === 0 && parseFloat(c.borderBottomWidth) === 0;
            })
            .filter((e) => !e.closest('blockquote, .queue, .queue-strip, .rmt'))
            .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ').join('.')}`),
        );
        if (rails.length) throw new Error(`còn thanh dọc (viền trái một bên): ${JSON.stringify([...new Set(rails)].slice(0, 8))}`);
      }
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
