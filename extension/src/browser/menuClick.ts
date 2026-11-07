/**
 * Xử lý menu chuột phải của dịch vụ nền. Tách khỏi background.ts (nơi gắn thẳng vào `chrome.*` lúc nạp) để kiểm thử được bằng đối tượng giả.
 *
 * Cổng đồng ý: chưa đồng ý thì KHÔNG ghi hành động (đoạn đã chọn, URL, tiêu đề trang) vào chrome.storage.session — khung chat sẽ không nhận được gì để gửi đi;
 * chỉ mở thanh bên để người dùng thấy thông báo về dữ liệu và bấm «Đồng ý».
 */

import type { ConsentGate } from './consent';
import { PENDING_KEY, type PendingAction } from './pending';

export const MENU_ASK = 'nd-ask-selection';
export const MENU_EXPLAIN = 'nd-explain-selection';
export const MENU_SUMMARIZE = 'nd-summarize-page';
export { PENDING_KEY };

export interface MenuInfo {
  menuItemId: string | number;
  selectionText?: string;
}
export interface MenuTab {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
}
export interface MenuDeps {
  /** undefined = tệp cổng đồng ý chưa được nạp. */
  gate: ConsentGate | undefined;
  /** Bản --test (e2e): không có cổng đồng ý và coi như đã đồng ý. Bản phát hành: thiếu cổng = KHÔNG gửi (đóng-khi-lỗi). */
  testBuild: boolean;
  /** Mở thanh bên của cửa sổ. PHẢI được gọi đồng bộ trong cử chỉ người dùng. */
  openPanel(windowId: number): Promise<unknown>;
  /** Lưu hành động cho khung chat đọc (chrome.storage.session). */
  save(action: PendingAction): Promise<unknown>;
  now(): number;
}
export type MenuResult = 'ignored' | 'saved' | 'blocked';

export async function handleMenuClick(info: MenuInfo, tab: MenuTab | undefined, deps: MenuDeps): Promise<MenuResult> {
  const kind: PendingAction['kind'] | null = info.menuItemId === MENU_ASK ? 'ask' : info.menuItemId === MENU_EXPLAIN ? 'explain' : info.menuItemId === MENU_SUMMARIZE ? 'summarize' : null;
  if (!kind || !tab) return 'ignored';
  // sidePanel.open phải được gọi ĐỒNG BỘ trong cử chỉ người dùng (menu chuột phải) — không await trước nó, kể cả việc đọc cờ đồng ý bên dưới.
  const opening = tab.windowId !== undefined ? deps.openPanel(tab.windowId) : Promise.resolve();
  const allowed = deps.gate ? await deps.gate.ok().catch(() => false) : deps.testBuild;
  void Promise.resolve(opening).catch(() => undefined);
  if (!allowed) return 'blocked';
  const action: PendingAction = { kind, text: info.selectionText?.slice(0, 8000), url: tab.url, title: tab.title, tabId: tab.id, windowId: tab.windowId, ts: deps.now() };
  await deps.save(action);
  return 'saved';
}
