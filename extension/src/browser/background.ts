/**
 * Service worker (rất nhỏ): chỉ lo việc phải làm ngoài khung chat — mở khung khi bấm biểu tượng, menu chuột phải, và chuyển lệnh
 * từ menu vào khung chat qua chrome.storage.session. Engine KHÔNG chạy ở đây (service worker bị trình duyệt dừng sau ~30 giây rảnh);
 * nó chạy trong trang khung chat (panel.tsx), sống chừng nào khung còn mở.
 */

import { PENDING_KEY, type PendingAction } from './pending';

const MENU_ASK = 'nd-ask-selection';
const MENU_EXPLAIN = 'nd-explain-selection';
const MENU_SUMMARIZE = 'nd-summarize-page';
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
  const kind: PendingAction['kind'] | null = info.menuItemId === MENU_ASK ? 'ask' : info.menuItemId === MENU_EXPLAIN ? 'explain' : info.menuItemId === MENU_SUMMARIZE ? 'summarize' : null;
  if (!kind || !tab) return;
  const action: PendingAction = { kind, text: info.selectionText?.slice(0, 8000), url: tab.url, title: tab.title, tabId: tab.id, windowId: tab.windowId, ts: Date.now() };
  // sidePanel.open phải được gọi ĐỒNG BỘ trong cử chỉ người dùng (menu chuột phải) — không await trước nó.
  // (sidePanel.open có từ Chrome 116; bản cũ hơn không có hàm này → chỉ lưu hành động, người dùng tự mở khung.)
  const opening = tab.windowId !== undefined && typeof chrome.sidePanel.open === 'function' ? chrome.sidePanel.open({ windowId: tab.windowId }) : Promise.resolve();
  void chrome.storage.session.set({ [PENDING_KEY]: action });
  void opening.catch(() => undefined);
});
