/**
 * Kiểm thử đầu-cuối mô hình Locaith (Locaith-v5-flash / SI) trên Edge VÀ Chrome thật (headless), từ 0.7.10: nạp tiện ích MV3 bản --test, dựng "máy chủ locaith.ai" giả
 * (tài khoản PostgREST + cổng mô hình, một cổng HTTP — test/helpers/testBackend.ts) rồi đi ĐÚNG đường của người dùng bằng giao diện thật: Cài đặt → dán «mã kết nối» →
 * chọn model → gõ tin → thẻ thông báo dữ liệu → «Đồng ý» → câu trả lời qua SSE → đăng xuất.
 *
 * Chạy: npm run test:browser-e2e   (cần Edge hoặc Chrome đã cài; tự bỏ qua trình duyệt không có). Không có yêu cầu nào ra mạng thật: tài khoản và cổng đều là máy chủ cục bộ.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountClient } from '../../src/core/account/client';
import { challengeOf, newVerifier } from '../../src/core/account/pkce';
import { TestBackend } from '../helpers/testBackend';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist-browser-test');
const SHOTS = process.env.ND_E2E_SHOTS;

const CANDIDATES: [string, string[]][] = [
  ['edge', [process.env.EDGE_PATH ?? '', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']],
  ['chrome', [process.env.CHROME_PATH ?? '', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']],
];
const BROWSERS = CANDIDATES.map(([name, paths]) => [name, paths.find((p) => p && fs.existsSync(p))] as const).filter((b): b is readonly [string, string] => !!b[1]);

const USER = { id: 'u-e2e', email: 'e2e@example.com', name: 'Người Thử E2E' };

/* eslint-disable @typescript-eslint/no-explicit-any */
const waitFor = (page: Page, fn: () => boolean, timeout = 20_000) => page.waitForFunction(fn, { timeout });
const view = (page: Page) => page.evaluate(() => (window as any).__nd.controller.snapshot().view);

describe.skipIf(BROWSERS.length === 0)('mô hình Locaith trong bản trình duyệt (tiện ích MV3) trên trình duyệt thật', () => {
  let backend: TestBackend;
  let client: AccountClient;

  beforeAll(async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'esbuild.browser.mjs'), '--test'], { cwd: ROOT, stdio: 'pipe' });
    backend = new TestBackend();
    await backend.start();
    backend.account.addUser(USER);
    client = new AccountClient({ supabaseUrl: backend.url, anonKey: backend.anonKey, webUrl: 'http://127.0.0.1:1' }, { timeoutMs: 4000 });
  }, 120_000);
  afterAll(async () => {
    await backend?.stop();
  });

  /** Cấp «mã kết nối» đúng cách trang locaith.ai/#ext-browser làm. */
  async function mint(): Promise<string> {
    const v = newVerifier();
    const code = backend.account.approve(USER.id, challengeOf(v), 'http://127.0.0.1/ext-browser', 'Chrome / Edge');
    const r = await client.exchange(code, v, { client: 'chrome' });
    if (!r.ok) throw new Error('không cấp được mã kết nối thử');
    return r.token;
  }

  describe.each(BROWSERS)('%s', (name, exe) => {
    let browser: Browser;
    let panel: Page;
    let profile: string;
    let extId: string;
    const errors: string[] = [];

    beforeAll(async () => {
      backend.gateway.reset();
      profile = fs.mkdtempSync(path.join(os.tmpdir(), `nd-e2e-locaith-${name}-`));
      browser = await puppeteer.launch({
        executablePath: exe,
        headless: true,
        pipe: true,
        enableExtensions: true,
        userDataDir: profile,
        args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
      });
      extId = await browser.installExtension(DIST);
      panel = await browser.newPage();
      await panel.setViewport({ width: 430, height: 900 });
      panel.on('pageerror', (e: unknown) => errors.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`));
      panel.on('console', (m) => m.type() === 'error' && errors.push(`console.error: ${m.text()}`));
      // Trỏ tài khoản + cổng mô hình sang máy chủ giả: nd.test.account chỉ được đọc ở bản --test (nhánh __ND_TEST__ bị loại khỏi bản phát hành); cổng đổi bằng baseUrls như người dùng.
      await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
      await panel.evaluate(
        async (url, anon, gateway) => {
          await chrome.storage.local.set({
            'nd.test.account': { supabaseUrl: url, anonKey: anon, webUrl: 'http://127.0.0.1:1' },
            'nd.config': { baseUrls: { locaith: gateway } },
          });
        },
        backend.url,
        backend.anonKey,
        `${backend.url}/api/llm/v1`,
      );
      await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
      // `.app` đã có ở màn «đang nạp» — đợi tới khi ô nhập (giao diện đầy đủ) xuất hiện
      await panel.waitForFunction(() => (window as any).__nd && (window as any).__ndTest && document.querySelector('.composer-input'), { timeout: 30_000 });
    }, 120_000);

    afterAll(async () => {
      await browser?.close().catch(() => undefined);
      fs.rmSync(profile, { recursive: true, force: true });
    });

    it('chưa kết nối: giao diện KHÔNG bị chặn bởi màn đăng nhập; Cài đặt có thẻ «Tài khoản Locaith (tuỳ chọn)»; nhóm Locaith có «Đăng nhập…»', async () => {
      const v = await view(panel);
      expect(v.account).toMatchObject({ status: 'signedOut', optional: true });
      expect(await panel.$('.acct-gate')).toBeNull();
      expect(await panel.$('.composer-input')).not.toBeNull(); // dùng được ngay (khoá API riêng không cần tài khoản)
      // Bộ chọn model: nhóm Locaith mời đăng nhập
      await panel.click('.picker-model');
      const group = await panel.evaluate(() => {
        const g = [...document.querySelectorAll('.model-group')].find((x) => /Locaith/.test(x.querySelector('.model-group-name')?.textContent ?? ''));
        return g ? { link: g.querySelector('.link-btn')?.textContent ?? '', note: g.querySelector('.model-nokey')?.textContent ?? '' } : null;
      });
      expect(group?.link).toMatch(/Đăng nhập/);
      expect(group?.note).toMatch(/Locaith-v5-flash/);
      await panel.keyboard.press('Escape');
      await panel.click('button[aria-label="Cài đặt"]');
      await panel.waitForSelector('[data-testid="account-connect"]');
      expect(await panel.$eval('#acct-b-code', (e) => (e as HTMLInputElement).type)).toBe('password');
      expect(await panel.$eval('[data-testid="account-connect"] .field-row .btn', (e) => (e as HTMLButtonElement).disabled)).toBe(true);
      if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await panel.screenshot({ path: path.join(SHOTS, `${name}-locaith-settings-out.png`) });
      }
    });

    it('dán mã SAI: lý do hiện ngay dưới ô nhập, không kết nối, không có yêu cầu nào tới cổng mô hình', async () => {
      await panel.type('#acct-b-code', 'đây không phải mã');
      await panel.click('[data-testid="account-connect"] .field-row .btn');
      await panel.waitForSelector('[data-testid="account-connect"] [role="alert"]');
      expect(await panel.$eval('[data-testid="account-connect"] [role="alert"]', (e) => e.textContent)).toMatch(/Đây chưa phải mã kết nối/);
      await panel.click('#acct-b-code', { count: 3 });
      await panel.keyboard.press('Backspace');
      await panel.type('#acct-b-code', 'lat_' + 'z'.repeat(43)); // đúng hình dạng nhưng máy chủ không biết mã này
      await panel.click('[data-testid="account-connect"] .field-row .btn');
      await panel.waitForFunction(() => /sai, đã bị thu hồi hoặc đã hết hạn/.test(document.querySelector('[data-testid="account-connect"] [role="alert"]')?.textContent ?? ''), { timeout: 15_000 });
      expect((await view(panel)).account.status).not.toBe('signedIn');
      expect(backend.gateway.chat.length + backend.gateway.others.length).toBe(0);
    });

    let token = '';
    it('dán mã ĐÚNG: kết nối; thẻ đổi sang tài khoản đã đăng nhập; Locaith-v5-flash được chọn sẵn; mã nằm trong chrome.storage (không mã hoá) nhưng không trong giao diện', async () => {
      token = await mint();
      await panel.click('#acct-b-code', { count: 3 });
      await panel.keyboard.press('Backspace');
      await panel.type('#acct-b-code', token);
      await panel.click('[data-testid="account-connect"] .field-row .btn');
      await panel.waitForSelector('.acct-set .acct-user', { timeout: 20_000 });
      expect(await panel.$eval('.acct-set .acct-name', (e) => e.textContent)).toBe(USER.name);
      expect(await panel.$('[data-testid="account-connect"]')).toBeNull();
      const v = await view(panel);
      expect(v.account).toMatchObject({ status: 'signedIn', user: { email: USER.email } });
      expect(v.provider).toBe('locaith');
      expect(v.model).toBe('locaith-v5-flash');
      const stored = (await panel.evaluate(async () => (await chrome.storage.local.get('nd.account'))['nd.account'])) as { token: string };
      expect(stored.token).toBe(token);
      expect(await panel.evaluate(() => document.body.innerText)).not.toContain(token);
      // chưa gọi cổng mô hình để GỬI gì: chỉ đọc danh sách model / bản ghi đồng ý / hạn mức
      expect(backend.gateway.chat).toHaveLength(0);
      if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, `${name}-locaith-settings-in.png`) });
    });

    it('mã dán nhầm vào ô chat bị chặn TRƯỚC khi rời máy', async () => {
      await panel.click('button[aria-label="Quay lại cuộc trò chuyện"]');
      await panel.waitForSelector('.composer-input');
      await panel.type('.composer-input', `mã của tôi: ${token}`);
      await panel.keyboard.press('Enter');
      await panel.waitForFunction(() => /mã kết nối Locaith/i.test(document.body.innerText), { timeout: 10_000 });
      expect(backend.gateway.chat).toHaveLength(0);
      expect(JSON.stringify((await view(panel)).transcript)).not.toContain(token);
      // dọn ô nhập
      await panel.click('.composer-input', { count: 3 });
      await panel.keyboard.press('Backspace');
    });

    it('LẦN ĐẦU gửi: thẻ thông báo dữ liệu (bản trình duyệt nói về TRANG WEB) mở, chưa gửi gì; «Đồng ý và dùng» → gửi lại → câu trả lời qua SSE; tiêu đề tới cổng đúng', async () => {
      await panel.type('.composer-input', 'Xin chào Locaith');
      await panel.keyboard.press('Enter');
      await panel.waitForSelector('[data-testid="locaith-consent"]', { timeout: 20_000 });
      expect(await panel.$eval('.lcn-list li', (e) => e.textContent)).toMatch(/trang web/);
      expect(backend.gateway.chat).toHaveLength(0);
      if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, `${name}-locaith-consent.png`) });
      await panel.click('.lcn-actions .btn');
      await panel.waitForFunction(() => !document.querySelector('[data-testid="locaith-consent"]'), { timeout: 15_000 });
      expect(backend.gateway.consents.at(-1)).toMatchObject({ userId: USER.id, version: 1 });
      expect(backend.gateway.consents.at(-1)!.client).toMatch(/^browser\//);
      // nội dung vừa gõ được trả lại ô nhập: gửi lại
      await waitFor(panel, () => (document.querySelector('.composer-input') as HTMLTextAreaElement)?.value.includes('Xin chào Locaith'));
      backend.gateway.mode = { reply: 'Chào bạn, mình là Locaith-v5 trong trình duyệt!' };
      await panel.focus('.composer-input'); // tiêu điểm đang ở nút «Đồng ý» vừa biến mất
      await panel.keyboard.press('Enter');
      await panel.waitForFunction(() => /Chào bạn, mình là Locaith-v5 trong trình duyệt!/.test(document.body.innerText), { timeout: 25_000 });
      expect(backend.gateway.chat).toHaveLength(1);
      const h = backend.gateway.chat[0]!.headers;
      expect(h.authorization).toBe(`Bearer ${token}`);
      expect(h['x-locaith-client']).toMatch(/^browser\/\d+\.\d+\.\d+/);
      expect(h['x-locaith-queue']).toBe('ticket');
      expect(h['x-locaith-device']).toMatch(/^[0-9a-f]{16}$/);
      expect(backend.gateway.chat[0]!.body.model).toBe('locaith-v5-flash');
      if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, `${name}-locaith-chat.png`) });
    });

    it('hết hạn mức 5 giờ: thông báo của cổng + nút «Nâng cấp» trong khung chat (không thử lại)', async () => {
      backend.gateway.mode = {
        limit: { state: 'limit_session', plan: 'plus', resetsInS: 7800, message: 'Bạn đã dùng hết hạn mức 5 giờ của gói Plus. Hạn mức làm mới sau 2 giờ 10 phút.' },
        account: { plan: 'plus', entitlement: { state: 'limit_session', plan: 'plus', usage: { session: { percent: 100, resets_in_s: 7800 }, week: { percent: 35, resets_in_s: 400000 } }, can_upgrade: true, upgrade_url: 'https://locaith.ai/#upgrade' } },
      };
      const before = backend.gateway.chat.length;
      await panel.type('.composer-input', 'Thêm một câu hỏi nữa');
      await panel.keyboard.press('Enter');
      await panel.waitForSelector('.notice-has-link', { timeout: 20_000 });
      expect(await panel.$eval('.notice-has-link', (e) => e.textContent)).toMatch(/hết hạn mức 5 giờ của gói Plus/);
      expect(await panel.$eval('.notice-has-link .notice-actions button', (e) => e.textContent)).toBe('Nâng cấp');
      expect(backend.gateway.chat.length).toBe(before + 1); // đúng một lần gọi, không thử lại
      if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, `${name}-locaith-limit.png`) });
      backend.gateway.mode = {};
    });

    it('đăng xuất: máy chủ thu hồi mã; thẻ «Tài khoản Locaith (tuỳ chọn)» quay lại; Locaith hết khoá; mã cũ không dùng lại được', async () => {
      await panel.click('button[aria-label="Cài đặt"]');
      await panel.waitForSelector('.acct-set .acct-actions');
      // Các thông báo nổi (toast) của bước trước tự tắt sau ~4,5 s; đang phủ lên thẻ thì chuột thật bấm trúng chúng chứ không phải nút.
      await panel.waitForFunction(() => !document.querySelector('.toast'), { timeout: 15_000 });
      const buttons = await panel.$$('.acct-set .acct-actions .btn');
      const labels = await Promise.all(buttons.map((b) => b.evaluate((e) => e.textContent?.trim())));
      await buttons[labels.indexOf('Đăng xuất')]!.click();
      await panel.waitForSelector('[data-testid="account-connect"]', { timeout: 15_000 });
      expect((await view(panel)).account.status).toBe('signedOut');
      expect([...backend.account.devices.values()].every((d) => d.revoked)).toBe(true);
      expect(await panel.evaluate(async () => (await chrome.storage.local.get('nd.account'))['nd.account'])).toBeUndefined();
      expect((await client.whoami(token)).ok).toBe(false);
      // Locaith hết khoá. Cuộc trò chuyện đang dở vẫn ở Locaith (không tự đổi model giữa chừng); gửi tiếp thì được nhắc kết nối lại và KHÔNG có byte nào tới cổng.
      expect((await view(panel)).providers.find((p: any) => p.id === 'locaith')?.hasKey).toBe(false);
      if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, `${name}-locaith-signed-out.png`) });
      const before = backend.gateway.chat.length + backend.gateway.others.length;
      await panel.click('button[aria-label="Quay lại cuộc trò chuyện"]');
      await panel.waitForSelector('.composer-input');
      await panel.type('.composer-input', 'Tiếp tục nhé');
      await panel.keyboard.press('Enter');
      // Cài đặt (thẻ kết nối ở đầu trang) mở sẵn; lời nhắc nằm trong cuộc trò chuyện (khung chat đang ẩn nên đọc từ trạng thái, không từ chữ trên màn hình)
      await panel.waitForSelector('[data-testid="account-connect"]', { timeout: 10_000 });
      expect(JSON.stringify((await view(panel)).transcript)).toMatch(/Mô hình Locaith cần tài khoản Locaith/);
      expect(backend.gateway.chat.length + backend.gateway.others.length).toBe(before);
    });

    it('không có lỗi console / pageerror trong cả luồng', () => {
      expect(errors.filter((e) => !/favicon|Failed to load resource|net::ERR/i.test(e))).toEqual([]);
    });
  });
});
