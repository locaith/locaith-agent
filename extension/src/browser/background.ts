/**
 * Service worker (rất nhỏ): chỉ lo việc phải làm ngoài khung chat — mở khung khi bấm biểu tượng, menu chuột phải, và chuyển lệnh
 * từ menu vào khung chat qua chrome.storage.session. Engine KHÔNG chạy ở đây (service worker bị trình duyệt dừng sau ~30 giây rảnh);
 * nó chạy trong trang khung chat (panel.tsx), sống chừng nào khung còn mở.
 *
 * Cổng đồng ý về dữ liệu: store-consent-sw.js đặt `globalThis.__ndConsent`; menu chuột phải chỉ chuyển hành động vào khung chat sau khi người dùng đã đồng ý (xem consent.ts).
 */

import { consentGate } from './consent';
import { handleMenuClick, MENU_ASK, MENU_EXPLAIN, MENU_SUMMARIZE, PENDING_KEY } from './menuClick';

declare const __ND_TEST__: boolean;
declare function importScripts(...urls: string[]): void;

// Bản --test (e2e) không có cổng đồng ý (esbuild.browser.mjs không chép tệp này); bản phát hành BẮT BUỘC có — thiếu thì menu không gửi gì (xem handleMenuClick).
if (!__ND_TEST__) {
  try {
    importScripts('store-consent-sw.js');
  } catch (e) {
    console.error('[Locaith AI] không nạp được cổng đồng ý về dữ liệu', e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  chrome.contextMenus.removeAll(() => {
    const msg = (k: string) => chrome.i18n.getMessage(k);
    chrome.contextMenus.create({ id: MENU_ASK, title: msg('menuAskSelection'), contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_EXPLAIN, title: msg('menuExplainSelection'), contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_SUMMARIZE, title: msg('menuSummarizePage'), contexts: ['page', 'frame'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleMenuClick(info, tab, {
    gate: consentGate(),
    testBuild: __ND_TEST__,
    // sidePanel.open có từ Chrome 116; bản cũ hơn không có hàm này → chỉ lưu hành động, người dùng tự mở khung.
    openPanel: (windowId) => (typeof chrome.sidePanel.open === 'function' ? chrome.sidePanel.open({ windowId }) : Promise.resolve()),
    save: (action) => chrome.storage.session.set({ [PENDING_KEY]: action }),
    now: () => Date.now(),
  });
});
