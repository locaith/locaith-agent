/** Mã lỗi khi đọc/điều khiển một trang, kèm thông điệp tiếng Việt đủ rõ để model (và người dùng) biết phải làm gì. */

export type PageErrorCode =
  | 'no_access' // chưa có quyền truy cập trang (host permission / activeTab)
  | 'restricted' // trang hệ thống/cửa hàng tiện ích/PDF… trình duyệt không cho tiện ích đọc
  | 'no_tab' // tab không còn
  | 'no_runtime' // không nạp được bộ đọc trang
  | 'navigated' // trang đã chuyển đi giữa chừng
  | 'stale_ref' // phần tử trong ref không còn (trang đã đổi)
  | 'not_found' // không tìm thấy phần tử/chuỗi
  | 'blocked' // hành động bị chặn (che khuất, bị vô hiệu hoá, trường nhạy cảm)
  | 'timeout'
  | 'page_error';

export const PAGE_ERROR_HINT: Record<PageErrorCode, string> = {
  no_access:
    'Chưa có quyền truy cập trang này. Người dùng cần mở Cài đặt → Truy cập trang web và bấm «Cho phép đọc mọi trang», hoặc bấm biểu tượng tiện ích trên đúng tab này rồi thử lại.',
  restricted: 'Trình duyệt không cho tiện ích đọc loại trang này (trang hệ thống như edge://, chrome://, cửa hàng tiện ích, trình xem PDF, trang lỗi). Hãy dùng fetch_url nếu chỉ cần nội dung.',
  no_tab: 'Tab này không còn nữa (đã bị đóng). Dùng tabs_list để xem các tab hiện có.',
  no_runtime: 'Không nạp được bộ đọc trang vào tab này.',
  navigated: 'Trang đã chuyển sang địa chỉ khác trong lúc thao tác. Hãy chụp lại page_snapshot rồi tiếp tục.',
  stale_ref: 'Phần tử này không còn trên trang (trang đã đổi sau lần page_snapshot gần nhất). Hãy gọi page_snapshot lại để lấy ref mới.',
  not_found: 'Không tìm thấy mục yêu cầu trên trang.',
  blocked: 'Không thao tác được phần tử này.',
  timeout: 'Hết thời gian chờ trang phản hồi.',
  page_error: 'Lỗi khi chạy trên trang.',
};

export type MappedError = { ok: false; code: PageErrorCode; message: string };

export function pageError(code: PageErrorCode, detail?: string): MappedError {
  return { ok: false, code, message: detail ? `${PAGE_ERROR_HINT[code]} (${detail})` : PAGE_ERROR_HINT[code] };
}

/** Đổi lỗi của chrome.scripting / chrome.tabs thành mã lỗi của extension. */
export function mapScriptError(err: unknown): MappedError {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.toLowerCase();
  if (m.includes('cannot access contents of the page') || m.includes('must request permission to access') || m.includes('host permission')) return pageError('no_access');
  if (
    m.includes('cannot access a chrome') ||
    m.includes('cannot access an edge') ||
    m.includes('extensions gallery cannot be scripted') ||
    m.includes('cannot be scripted') ||
    m.includes('cannot access contents of url') ||
    m.includes('showing error page') ||
    m.includes('chrome-extension://') ||
    m.includes('blocked by') ||
    m.includes('cannot access "')
  )
    return pageError('restricted');
  if (m.includes('no tab with id') || m.includes('tab was closed') || m.includes('the tab was closed') || m.includes('no frame with id')) return pageError('no_tab');
  if (m.includes('frame with id') && m.includes('was removed')) return pageError('navigated');
  return pageError('page_error', raw.slice(0, 300));
}
