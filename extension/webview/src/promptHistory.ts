/**
 * (0.7.4) Kho lịch sử các tin đã gõ phía giao diện — phím ↑/↓ ở ô nhập duyệt lại chúng (logic thuần ở src/shared/promptHistory.ts).
 * Host là nguồn đúng: gửi cả danh sách sau `init` (lưu bền theo thư mục làm việc). Ở đây chỉ giữ bản sao + thêm NGAY tin vừa gửi,
 * để ↑ dùng được tức thì mà không chờ host.
 */
import { addPrompt, sanitizeHistory } from '../../src/shared/promptHistory';

let list: readonly string[] = [];

export const getPromptHistory = (): readonly string[] => list;

/** Host gửi danh sách đã lưu: giữ thêm các tin gõ ở phiên giao diện này mà host chưa kịp ghi (hiếm: webview vừa được dựng lại giữa lúc gửi). */
export function setPromptHistory(raw: unknown): void {
  const fromHost = sanitizeHistory(raw);
  const extra = list.filter((x) => !fromHost.includes(x));
  list = extra.length ? sanitizeHistory([...fromHost, ...extra]) : fromHost;
}

/** Người dùng vừa gửi một tin. */
export function recordPrompt(text: string): void {
  list = addPrompt(list, text);
}
