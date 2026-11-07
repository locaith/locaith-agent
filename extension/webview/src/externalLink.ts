/**
 * Mở liên kết ngoài từ webview (lane:customer-bugs). Khách báo «bấm link mở 2 tab».
 * Nguyên nhân nghi nhất: webview của VS Code có bộ xử lý click RIÊNG cho mọi thẻ `<a href>` (mở bằng openerService),
 * chạy thêm sau handler của ta ⇒ hai lần mở. Ba lớp chặn, mỗi lớp đủ để không nảy đúp:
 *  1. liên kết KHÔNG mang thuộc tính `href` (chỉ `data-href`) nên bộ xử lý có sẵn của VS Code không thấy gì để mở;
 *  2. handler dừng nổi bọt (stopPropagation) cho trường hợp thẻ vẫn bị lớp ngoài bắt;
 *  3. khử trùng lặp cùng URL trong 1,5 s (xem core/host/openOnce.ts) — cả ở webview lẫn ở host.
 */
import { openExternalOnce } from '../../src/core/host/openOnce';
import { post } from './vscode';

interface EventLike {
  preventDefault?(): void;
  stopPropagation?(): void;
  key?: string;
  button?: number;
}

/** Gửi `open_external` về host đúng một lần cho mỗi cú bấm. Trả true nếu đã gửi. */
export function openExternalLink(url: string, e?: EventLike): boolean {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  if (!openExternalOnce.allow(url)) return false;
  post({ type: 'open_external', url });
  return true;
}

/** Thuộc tính cho một liên kết ngoài bấm được: KHÔNG `href`; vẫn focus được bằng bàn phím và đọc được là «link». */
export function externalLinkProps(url: string) {
  return {
    role: 'link' as const,
    tabIndex: 0,
    'data-href': url,
    onClick: (e: EventLike) => void openExternalLink(url, e),
    // Nhấp giữa (mở tab nền) cũng chỉ đi qua đúng một đường này.
    onAuxClick: (e: EventLike) => {
      if (e.button === 1) openExternalLink(url, e);
    },
    onKeyDown: (e: EventLike) => {
      if (e.key === 'Enter') openExternalLink(url, e);
    },
  };
}
