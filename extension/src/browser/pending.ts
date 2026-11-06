/** Hành động từ menu chuột phải: service worker ghi vào chrome.storage.session, khung chat đọc và thực hiện. */
export const PENDING_KEY = 'nd.pending';

export interface PendingAction {
  kind: 'ask' | 'explain' | 'summarize';
  text?: string;
  url?: string;
  title?: string;
  /** Tab nơi người dùng bấm menu: hành động áp lên ĐÚNG tab này nên trợ lý gắn lại vào nó. */
  tabId?: number;
  /** Cửa sổ nơi người dùng bấm menu: chỉ khung chat của cửa sổ đó được thực hiện (nhiều cửa sổ = nhiều khung chat). */
  windowId?: number;
  ts: number;
}
