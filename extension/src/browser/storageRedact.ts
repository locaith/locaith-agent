/**
 * Quyền riêng tư khi lưu hội thoại. Trợ lý đọc cả những trang người dùng đã đăng nhập (thư, ngân hàng, tài liệu nội bộ); nội dung đó
 * phục vụ lượt trả lời hiện tại chứ không nên nằm lại vĩnh viễn trong IndexedDB dạng văn bản thuần. Khi LƯU (không phải trong bộ nhớ):
 *  - kết quả của công cụ đọc trang chỉ giữ vài dòng đầu (URL, tiêu đề, vị trí cuộn), ảnh chụp màn hình bị bỏ;
 *  - nội dung tab đính kèm (`<attached_tab>`) và phần xem trước của khối công cụ trong giao diện bị lược.
 * Phiên khôi phục thấy ghi chú này và đọc lại trang nếu cần. Vì lịch sử đã bị sửa, phiên khôi phục phải đặt `historyEdited`
 * (engine sẽ bỏ khối suy luận cũ — chúng bị ràng buộc vào lịch sử gốc).
 */

import type { SessionState } from '../core/engine/types';
import type { TItem } from '../shared/protocol';

export const REDACTED_NOTE = '[nội dung trang đã được lược bỏ khi lưu để bảo vệ quyền riêng tư — hãy đọc lại bằng page_read nếu cần]';

/** Công cụ trả về nội dung/ảnh của trang người dùng đang đăng nhập. (web_search/fetch_url là web công khai, không cookie → giữ.) */
export const PRIVATE_PAGE_TOOLS = new Set(['page_read', 'page_snapshot', 'page_find', 'page_screenshot', 'tabs_list']);

const ATTACHED = /<attached_tab id="(\d+)">[\s\S]*?<\/attached_tab>/g;
/** Đoạn người dùng bôi đen trên trang (nằm trong `<browser_context>` của tin nhắn), kèm khung dữ liệu và lời nhắc đi sau nó. */
const SELECTED = /Text the user selected on the page:\n<trang_web id="([0-9a-f]+)"[\s\S]*?<\/trang_web id="\1">\n\(Nội dung từ[^\n]*\)/g;

const head = (s: string) => s.split('\n').slice(0, 3).join('\n').slice(0, 400);

export function redactForStorage(session: SessionState): SessionState {
  let changed = false;
  const messages = session.messages.map((m) => {
    let touched = false;
    const content = m.content.map((b) => {
      if (b.type === 'tool_result' && b.name && PRIVATE_PAGE_TOOLS.has(b.name)) {
        if (b.content.includes(REDACTED_NOTE) && !b.images?.length) return b;
        touched = true;
        return { ...b, content: `${head(b.content)}\n${REDACTED_NOTE}`, images: undefined };
      }
      if (b.type === 'text' && (b.text.includes('<attached_tab') || b.text.includes('Text the user selected on the page:'))) {
        const text = b.text.replace(ATTACHED, `<attached_tab id="$1">${REDACTED_NOTE}</attached_tab>`).replace(SELECTED, `Text the user selected on the page: ${REDACTED_NOTE}`);
        if (text !== b.text) {
          touched = true;
          return { ...b, text };
        }
      }
      return b;
    });
    if (!touched) return m;
    changed = true;
    return { ...m, content };
  });
  // Các quyền "cho phép cả phiên" (đọc/thao tác theo origin…) chỉ có hiệu lực trong lúc khung chat còn mở: khôi phục phiên ở lần mở sau không được
  // tự mang theo chúng — người dùng phải duyệt lại, nếu không một lần bấm "luôn cho phép" từ hôm qua vẫn còn hiệu lực với trang hôm nay.
  const base = session.approvals.length ? { ...session, approvals: [] } : session;
  return changed ? { ...base, messages } : base;
}

export function redactTranscript(items: TItem[]): TItem[] {
  return items.map((it) => {
    if (it.kind !== 'assistant') return it;
    let touched = false;
    const blocks = it.blocks.map((b) => {
      // Ảnh chụp màn hình (và mọi ảnh công cụ) chỉ sống trong bộ nhớ khung chat; không bao giờ ghi vào kho.
      if (b.type === 'tool' && b.images) {
        touched = true;
        b = { ...b, images: undefined };
      }
      if (b.type === 'tool' && PRIVATE_PAGE_TOOLS.has(b.name) && b.output) {
        touched = true;
        return { ...b, output: REDACTED_NOTE };
      }
      return b;
    });
    return touched ? { ...it, blocks } : it;
  });
}

/**
 * Chốt trạng thái các công cụ đang chạy / đang chờ duyệt thành "đã huỷ" trước khi lưu lúc đóng khung chat: sau khi khôi phục không còn tác vụ nào chạy,
 * nên thẻ xin phép "chết" hay biểu tượng xoay mãi là sai.
 */
export function settleForExit(items: TItem[]): TItem[] {
  return items.map((it) => {
    if (it.kind !== 'assistant') return it;
    let touched = false;
    const blocks = it.blocks.map((b) => {
      if (b.type === 'tool' && (b.state === 'running' || b.state === 'awaiting_permission')) {
        touched = true;
        return { ...b, state: 'cancelled' as const, permission: undefined };
      }
      return b;
    });
    return touched ? { ...it, blocks } : it;
  });
}

/** Phiên vừa nạp từ kho có bị lược nội dung không (→ lịch sử khác bản gốc, cần bỏ khối suy luận cũ)? */
export function hasRedactions(session: SessionState): boolean {
  return session.messages.some((m) => m.content.some((b) => (b.type === 'tool_result' ? b.content.includes(REDACTED_NOTE) : b.type === 'text' && b.text.includes(REDACTED_NOTE))));
}
