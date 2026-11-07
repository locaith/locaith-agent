/**
 * Cổng đồng ý về dữ liệu của bản Chrome / Edge (thông báo trong tiện ích — chính sách dữ liệu người dùng của Chrome Web Store).
 * Kiểm: (1) menu chuột phải không chuyển gì vào khung chat khi chưa đồng ý; (2) tệp store-consent-sw.js THẬT đọc đúng cờ; (3) sidepanel.html + background nối đúng;
 * (4) bản --test tự bỏ qua cổng (e2e không kẹt sau lớp phủ).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CONSENT_KEY, consentGate } from '../../src/browser/consent';
import { handleMenuClick, MENU_ASK, MENU_EXPLAIN, MENU_SUMMARIZE, type MenuDeps } from '../../src/browser/menuClick';
import type { PendingAction } from '../../src/browser/pending';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), 'utf8');

function rig(opts: { consented?: boolean; gate?: boolean; testBuild?: boolean; gateThrows?: boolean }) {
  const log = { opened: [] as number[], saved: [] as PendingAction[] };
  const deps: MenuDeps = {
    gate:
      opts.gate === false
        ? undefined
        : {
            ok: async () => {
              if (opts.gateThrows) throw new Error('storage');
              return !!opts.consented;
            },
          },
    testBuild: !!opts.testBuild,
    openPanel: async (w) => {
      log.opened.push(w);
    },
    save: async (a) => {
      log.saved.push(a);
    },
    now: () => 1234,
  };
  return { deps, log };
}
const tab = { id: 7, windowId: 3, url: 'https://bank.example/account/123', title: 'Số dư tài khoản' };

describe('menu chuột phải + cổng đồng ý (dịch vụ nền)', () => {
  it('CHƯA đồng ý: mở thanh bên để hiện thông báo nhưng KHÔNG lưu gì (đoạn chọn, URL, tiêu đề) cho khung chat', async () => {
    for (const id of [MENU_ASK, MENU_EXPLAIN, MENU_SUMMARIZE]) {
      const { deps, log } = rig({ consented: false });
      expect(await handleMenuClick({ menuItemId: id, selectionText: 'bí mật' }, tab, deps)).toBe('blocked');
      expect(log.saved).toEqual([]);
      expect(log.opened).toEqual([3]);
    }
  });

  it('ĐÃ đồng ý: lưu đúng hành động (kind, đoạn chọn cắt 8000 ký tự, tab, cửa sổ) và mở thanh bên', async () => {
    const { deps, log } = rig({ consented: true });
    expect(await handleMenuClick({ menuItemId: MENU_ASK, selectionText: 'x'.repeat(9000) }, tab, deps)).toBe('saved');
    expect(log.opened).toEqual([3]);
    expect(log.saved).toHaveLength(1);
    expect(log.saved[0]).toMatchObject({ kind: 'ask', url: tab.url, title: tab.title, tabId: 7, windowId: 3, ts: 1234 });
    expect(log.saved[0].text).toHaveLength(8000);
    const e = rig({ consented: true });
    await handleMenuClick({ menuItemId: MENU_EXPLAIN, selectionText: 'a' }, tab, e.deps);
    await handleMenuClick({ menuItemId: MENU_SUMMARIZE }, tab, e.deps);
    expect(e.log.saved.map((a) => a.kind)).toEqual(['explain', 'summarize']);
  });

  it('thanh bên được mở ĐỒNG BỘ (trước mọi await) để còn trong cử chỉ người dùng', async () => {
    const { deps, log } = rig({ consented: true });
    const p = handleMenuClick({ menuItemId: MENU_ASK, selectionText: 'a' }, tab, deps);
    expect(log.opened).toEqual([3]); // chưa await gì mà đã mở
    await p;
  });

  it('đóng-khi-lỗi: đọc cờ đồng ý bị lỗi, hoặc bản phát hành thiếu cổng → không gửi gì', async () => {
    const a = rig({ gateThrows: true });
    expect(await handleMenuClick({ menuItemId: MENU_ASK, selectionText: 'a' }, tab, a.deps)).toBe('blocked');
    expect(a.log.saved).toEqual([]);
    const b = rig({ gate: false, testBuild: false });
    expect(await handleMenuClick({ menuItemId: MENU_ASK, selectionText: 'a' }, tab, b.deps)).toBe('blocked');
    expect(b.log.saved).toEqual([]);
  });

  it('bản --test (không có cổng) coi như đã đồng ý, để e2e chạy được', async () => {
    const { deps, log } = rig({ gate: false, testBuild: true });
    expect(await handleMenuClick({ menuItemId: MENU_SUMMARIZE }, tab, deps)).toBe('saved');
    expect(log.saved).toHaveLength(1);
  });

  it('bỏ qua mục menu lạ và lần bấm không có tab', async () => {
    const { deps, log } = rig({ consented: true });
    expect(await handleMenuClick({ menuItemId: 'khac' }, tab, deps)).toBe('ignored');
    expect(await handleMenuClick({ menuItemId: MENU_ASK }, undefined, deps)).toBe('ignored');
    expect(log.opened).toEqual([]);
    expect(log.saved).toEqual([]);
  });
});

describe('tệp static/store-consent-sw.js thật', () => {
  type Gate = { ok(): Promise<boolean>; KEY: string };
  function load(stored: Record<string, unknown> | Error): Gate {
    const sandbox: Record<string, unknown> = {
      chrome: {
        storage: {
          local: {
            get: async (k: string) => {
              if (stored instanceof Error) throw stored;
              return { [k]: stored[k] };
            },
          },
        },
        sidePanel: { open: async () => undefined },
      },
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(read('src/browser/static/store-consent-sw.js'), sandbox);
    return sandbox.__ndConsent as Gate;
  }

  it('cùng khoá với phía TypeScript và giao diện', () => {
    expect(load({}).KEY).toBe(CONSENT_KEY);
    expect(CONSENT_KEY).toBe('nd.consent.v1');
    expect(read('src/browser/static/store-consent.js')).toContain(`const KEY = '${CONSENT_KEY}'`);
  });

  it('ok(): chỉ true khi cờ { v: 1 }; thiếu cờ, sai phiên bản hoặc lỗi bộ nhớ → false', async () => {
    expect(await load({ [CONSENT_KEY]: { v: 1, at: 1 } }).ok()).toBe(true);
    expect(await load({}).ok()).toBe(false);
    expect(await load({ [CONSENT_KEY]: { v: 2 } }).ok()).toBe(false);
    expect(await load({ [CONSENT_KEY]: true }).ok()).toBe(false);
    expect(await load(new Error('boom')).ok()).toBe(false);
  });

  it('consentGate() trả về cổng do tệp đó đặt trên globalThis (và undefined khi chưa nạp)', () => {
    const g = globalThis as { __ndConsent?: unknown };
    delete g.__ndConsent;
    expect(consentGate()).toBeUndefined();
    g.__ndConsent = { ok: async () => true };
    expect(consentGate()).toBe(g.__ndConsent);
    delete g.__ndConsent;
  });
});

describe('nối dây (kiểm tĩnh)', () => {
  it('sidepanel.html nạp store-consent.js TRƯỚC panel.js', () => {
    const html = read('src/browser/static/sidepanel.html');
    expect(html.indexOf('<script src="store-consent.js"></script>')).toBeGreaterThan(-1);
    expect(html.indexOf('store-consent.js')).toBeLessThan(html.indexOf('panel.js'));
  });

  it('background.ts nạp store-consent-sw.js (trừ bản --test) và đi qua handleMenuClick với cổng đồng ý', () => {
    const bg = read('src/browser/background.ts');
    expect(bg).toMatch(/if \(!__ND_TEST__\) \{\s*try \{\s*importScripts\('store-consent-sw\.js'\)/);
    expect(bg).toContain('gate: consentGate()');
    expect(bg).toContain('handleMenuClick(');
  });

  it('thông báo trong tiện ích: nút đồng ý/không đồng ý, khoá khung chính, KHÔNG hứa tính năng không có và KHÔNG nhắc mô hình Locaith', () => {
    const ui = read('src/browser/static/store-consent.js');
    expect(ui).toContain("const PRIVACY_URL = '__PRIVACY_URL__'");
    expect(ui).toContain("setAttribute('inert'");
    expect(ui).toContain('nd-consent-accept');
    expect(ui).toContain('nd-consent-decline');
    expect(ui).not.toMatch(/Theo dõi tin nhắn|Watch messages|Locaith’s service|dịch vụ của Locaith|mô hình Locaith|Locaith model/);
    expect(ui).toContain('nhà cung cấp AI do BẠN chọn');
    expect(ui).toContain('the AI provider YOU choose');
  });

  it('esbuild: bản --test bỏ cổng (tệp + thẻ nạp); bản thường có và điền URL chính sách thật', () => {
    const src = read('esbuild.browser.mjs');
    expect(src).toMatch(/if \(testBuild\) \{[\s\S]*store-consent\.js[\s\S]*store-consent-sw\.js[\s\S]*CONSENT_TAG, ''/);
    expect(src).toContain('https://www.locaith.ai/chinh-sach-quyen-rieng-tu-chrome/');
  });
});
