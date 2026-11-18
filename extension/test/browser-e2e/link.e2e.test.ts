/**
 * Kiểm thử đầu-cuối CẦU NỐI VS CODE của bản trình duyệt (0.7.12) trên Edge VÀ Chrome thật (headless): nạp tiện ích MV3 dựng bản --test --production (đã NÉN: mã `inPage`
 * chạy trong trang là một hàm bị nén được chuyển nguyên mã nguồn qua executeScript — phải thử trên chính bản nén), dựng máy chủ cầu THẬT của VS Code (BrowserBridge, cổng ngẫu nhiên),
 * rồi đi đúng đường người dùng: công tắc trong Cài đặt → thẻ «Cho phép» ở phía VS Code → nối → VS Code gọi tabs.list / page.snapshot / page.type / page.click / page.read
 * trên một trang thật. Bản --test trỏ cầu nối sang cổng giả (storage `nd.test.linkPorts`) nên KHÔNG chạm tới VS Code thật của người chạy test.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserBridge, type BridgeCreds, type BridgeStore } from '../../src/core/chrome/bridge';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'browser', 'fixtures');

const CANDIDATES: [string, string[]][] = [
  ['edge', [process.env.EDGE_PATH ?? '', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']],
  ['chrome', [process.env.CHROME_PATH ?? '', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']],
];
const BROWSERS = CANDIDATES.map(([name, paths]) => [name, paths.find((p) => p && fs.existsSync(p))] as const).filter((b): b is readonly [string, string] => !!b[1]);

/* eslint-disable @typescript-eslint/no-explicit-any */
const memStore = (): BridgeStore => {
  let v: BridgeCreds = {};
  return { load: async () => ({ ...v }), save: async (c) => void (v = { ...c }) };
};
const until = async (f: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('quá hạn chờ điều kiện');
};

function startServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(FIXTURES, 'shop.html')));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) })));
}

describe.skipIf(BROWSERS.length === 0)('cầu nối VS Code (bản trình duyệt) trên trình duyệt thật', () => {
  let dist: string;
  let site: { port: number; close(): Promise<void> };

  beforeAll(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-e2e-link-dist-'));
    execFileSync(process.execPath, [path.join(ROOT, 'esbuild.browser.mjs'), '--test', '--production', `--out=${dist}`], { cwd: ROOT, stdio: 'pipe' });
    site = await startServer();
  }, 120_000);
  afterAll(async () => {
    await site?.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  describe.each(BROWSERS)('%s', (name, exe) => {
    let browser: Browser;
    let panel: Page;
    let fixture: Page;
    let profile: string;
    let extId: string;
    let bridge: BrowserBridge;
    let port: number;
    const errors: string[] = [];
    const origin = () => `http://127.0.0.1:${site.port}`;

    beforeAll(async () => {
      bridge = new BrowserBridge(memStore(), () => undefined, { ports: [0], credTtlMs: 0, connectWaitMs: 15_000 });
      port = await bridge.start();
      profile = fs.mkdtempSync(path.join(os.tmpdir(), `nd-e2e-link-${name}-`));
      browser = await puppeteer.launch({ executablePath: exe, headless: true, pipe: true, enableExtensions: true, userDataDir: profile, args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'] });
      extId = await browser.installExtension(dist);
      fixture = await browser.newPage();
      await fixture.goto(`${origin()}/shop.html`, { waitUntil: 'load' });
      panel = await browser.newPage();
      await panel.setViewport({ width: 430, height: 900 });
      panel.on('pageerror', (e: unknown) => errors.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`));
      panel.on('console', (m) => m.type() === 'error' && errors.push(`console.error: ${m.text()}`));
      await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
      await panel.waitForFunction(() => (window as any).__nd && document.querySelector('.app'), { timeout: 30_000 });
      // Trỏ cầu nối sang máy chủ cầu giả này (chỉ bản --test có đường này).
      await panel.evaluate(async (p) => chrome.storage.local.set({ 'nd.test.linkPorts': [p] }), port);
    }, 120_000);
    afterAll(async () => {
      bridge?.stop();
      await browser?.close().catch(() => undefined);
      fs.rmSync(profile, { recursive: true, force: true });
    });

    it('Cài đặt có mục «Kết nối với VS Code», đang TẮT, chưa có trang nào được cho phép', async () => {
      await panel.evaluate(async () => (window as any).__nd.controller.showScreen('settings'));
      await panel.waitForSelector('[data-testid="vscode-link"]', { timeout: 20_000 });
      const t = await panel.$eval('[data-testid="vscode-link"]', (el) => (el as HTMLElement).innerText);
      expect(t).toMatch(/Kết nối với VS Code/);
      expect(t).toMatch(/TẮT mặc định/);
      expect(await panel.$eval('[data-testid="vscode-link-state"]', (el) => (el as HTMLElement).innerText)).toMatch(/Đang tắt/);
      expect(t).toMatch(/Chưa có trang nào/);
      expect(bridge.pairRequest()).toBeUndefined();
    });

    it('bật công tắc → VS Code thấy yêu cầu → Cho phép → giao diện báo «Đã kết nối với VS Code»', async () => {
      await panel.evaluate(() => {
        const sw = document.querySelector('[data-testid="vscode-link"] [role="switch"], [data-testid="vscode-link"] input[type="checkbox"], [data-testid="vscode-link"] button[aria-checked]') as HTMLElement | null;
        if (!sw) throw new Error('không thấy công tắc');
        sw.click();
      });
      await until(() => !!bridge.pairRequest());
      expect(bridge.pairRequest()!.extensionId).toBe(extId);
      expect(await bridge.approvePair(bridge.pairRequest()!.id)).toBe(true);
      await until(() => bridge.connected());
      await panel.waitForFunction(() => /Đã kết nối với VS Code/.test(document.querySelector('[data-testid="vscode-link-state"]')?.textContent ?? ''), { timeout: 20_000 });
    });

    it('VS Code điều khiển một trang đã cho phép: tabs.list → snapshot → gõ → bấm → đọc (mã trang chạy trên bản NÉN)', async () => {
      // Cho phép trang mẫu như người dùng đã bấm «Luôn cho phép» (cửa sổ hỏi duyệt không bấm tay được ở headless).
      await panel.evaluate(async (o) => chrome.storage.local.set({ 'nd.bridge.allow': [o] }), origin());
      const list = (await bridge.call('tabs.list', {})) as any[];
      const tab = list.find((t) => t.allowed && /Hoa Sen/.test(t.title));
      expect(tab, 'thấy tab trang mẫu với tên đầy đủ').toBeTruthy();
      // tab của khung chat (chrome-extension://) KHÔNG nằm trong danh sách (chỉ http/https)
      expect(list.every((t) => !String(t.url ?? '').startsWith('chrome-extension://'))).toBe(true);

      const snap = (await bridge.call('page.snapshot', { tabId: tab.id })) as any;
      expect(snap.elements.length).toBeGreaterThan(5);
      const input = snap.elements.find((e: any) => e.tag === 'input' && /search/.test(e.type ?? ''));
      expect(input, 'thấy ô tìm kiếm').toBeTruthy();
      expect(await bridge.call('page.type', { tabId: tab.id, ref: input.ref, text: 'nón lá', submit: true })).toMatchObject({ ok: true });
      await until(async () => /Đã tìm: nón lá/.test(await fixture.$eval('#result', (e) => e.textContent ?? '')));

      const add = snap.elements.find((e: any) => /Thêm vào giỏ/.test(e.text));
      expect(await bridge.call('page.click', { tabId: tab.id, ref: add.ref })).toMatchObject({ ok: true, clicked: expect.stringMatching(/Thêm vào giỏ/) });
      await until(async () => (await fixture.$eval('#cart', (e) => e.textContent ?? '')) !== '0');

      const read = (await bridge.call('page.read', { tabId: tab.id })) as any;
      expect(read.text).toMatch(/Cửa hàng Hoa Sen/);
      expect(read.links.length).toBeGreaterThan(2);
      expect(await bridge.call('page.scroll', { tabId: tab.id, dy: 300 })).toMatchObject({ ok: true });
      await expect(bridge.call('page.click', { tabId: tab.id, text: 'không có nút này đâu' })).rejects.toThrow(/Không thấy phần tử/);
    });

    // Cửa sổ hỏi duyệt thật (bridge-approve.html, bản NÉN): tìm cửa sổ vừa mở và bấm nút như người dùng.
    async function approvePopup(button: 'once' | 'always' | 'deny'): Promise<string> {
      const target = await browser.waitForTarget((t) => t.url().includes('bridge-approve.html'), { timeout: 15_000 });
      const page = (await target.page())!;
      await page.waitForSelector('#origin');
      const shown = await page.$eval('#origin', (e) => e.textContent ?? '');
      await page.evaluate((b) => (document.getElementById(b) as HTMLElement).click(), button);
      await target.page().then((p) => p?.waitForNavigation?.({ timeout: 100 }).catch(() => undefined)).catch(() => undefined);
      return shown;
    }

    it('trang CHƯA duyệt: tabs.list chỉ lộ tên miền; page.read mở cửa sổ hỏi duyệt thật — «Từ chối» chặn, «Cho phép lần này» cho đọc và nhớ trong phiên', async () => {
      const other = await browser.newPage();
      const otherUrl = `http://localhost:${site.port}/shop.html`; // origin khác (tên miền khác) — chưa duyệt
      await other.goto(otherUrl, { waitUntil: 'load' });
      const list = (await bridge.call('tabs.list', {})) as any[];
      const t = list.find((x) => x.host === `localhost:${site.port}`);
      expect(t).toEqual(expect.objectContaining({ allowed: false }));
      expect(JSON.stringify(t)).not.toMatch(/Hoa Sen|shop\.html/);

      // 1) Từ chối → lệnh lỗi rõ ràng, trang KHÔNG bị đọc
      const denied = bridge.call('page.read', { tabId: t.id });
      const deniedRej = expect(denied).rejects.toThrow(/từ chối cho trợ lý điều khiển/);
      expect(await approvePopup('deny')).toBe(`http://localhost:${site.port}`);
      await deniedRej;

      // 2) Cho phép lần này → đọc được; lần sau không hỏi lại (không có cửa sổ mới)
      const ok = bridge.call('page.read', { tabId: t.id });
      await approvePopup('once');
      expect(((await ok) as any).text).toMatch(/Cửa hàng Hoa Sen/);
      const before = browser.targets().filter((x) => x.url().includes('bridge-approve.html')).length;
      await bridge.call('page.snapshot', { tabId: t.id });
      expect(browser.targets().filter((x) => x.url().includes('bridge-approve.html')).length).toBe(before);
      const status = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'nd-link-status' }))) as any;
      expect(status.session).toContain(`http://localhost:${site.port}`);
      expect(status.allowed).not.toContain(`http://localhost:${site.port}`);

      // 3) Thu hồi trong Cài đặt (giao diện thật) → lại phải hỏi
      await panel.evaluate(() => (window as any).__nd.controller.showScreen('settings'));
      await panel.waitForFunction((o) => document.querySelector('[data-testid="vscode-link"]')?.textContent?.includes(o) ?? false, { timeout: 15_000 }, `http://localhost:${site.port}`);
      await panel.evaluate((o) => {
        const row = [...document.querySelectorAll('[data-testid="vscode-link"] li')].find((li) => li.textContent?.includes(o));
        (row!.querySelector('button') as HTMLElement).click();
      }, `http://localhost:${site.port}`);
      await until(async () => !((await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'nd-link-status' }))) as any).session.includes(`http://localhost:${site.port}`));
      const again = bridge.call('page.read', { tabId: t.id });
      const againRej = expect(again).rejects.toThrow(/từ chối cho trợ lý điều khiển/);
      await approvePopup('deny');
      await againRej;
      await other.close().catch(() => undefined);
    }, 90_000);

    it('tắt công tắc → ngừng nối; không có lỗi console', async () => {
      await panel.evaluate(() => {
        const sw = document.querySelector('[data-testid="vscode-link"] [role="switch"], [data-testid="vscode-link"] input[type="checkbox"], [data-testid="vscode-link"] button[aria-checked]') as HTMLElement;
        sw.click();
      });
      await panel.waitForFunction(() => /Đang tắt/.test(document.querySelector('[data-testid="vscode-link-state"]')?.textContent ?? ''), { timeout: 20_000 });
      expect(errors.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
    });
  });
});
