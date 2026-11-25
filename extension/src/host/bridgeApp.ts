/**
 * (0.7.20) Danh tính ứng dụng của cầu nối Chrome + sự kiện ra ngoài — KHÔNG phụ thuộc `vscode`, để host khác (bản desktop Locaith Work)
 * gọi được TRƯỚC activate():
 *
 *   setBridgeApp({ kind: 'work', name: 'Locaith Work' });
 *   bridgeEvents.on('change', () => …); // ghép đôi / vé / kết nối với trình duyệt vừa đổi — đọc lại bằng lệnh locaithAgent.chrome.linkState
 *
 * Tiện ích Chrome / Edge giữ MỖI ỨNG DỤNG MỘT token theo `kind` (mọi cửa sổ VS Code dùng chung `vscode`), và gọi tên `name` trong cửa sổ xin.
 */
import { EventEmitter } from 'node:events';
import type { BridgeApp } from '../core/chrome/bridge';

let current: BridgeApp | undefined;

export function setBridgeApp(app: BridgeApp): void {
  current = { kind: app.kind, name: app.name };
}

export function getBridgeApp(): BridgeApp | undefined {
  return current ? { ...current } : undefined;
}

/** Phát `'change'` khi ghép đôi, vé ghép đôi hoặc trạng thái kết nối với trình duyệt đổi. */
export const bridgeEvents = new EventEmitter();
bridgeEvents.setMaxListeners(20);
