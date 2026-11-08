/**
 * Lịch sử các tin đã gõ ở ô nhập — bấm ↑ / ↓ để xem lại như terminal và Claude Code (anh yêu cầu 08/11/2026).
 * Toàn bộ là hàm THUẦN (không DOM, không timer): dùng chung cho host (lưu bền qua lần khởi động lại) và webview (điều hướng), kiểm thử bằng số.
 *
 * Quy ước:
 *  - Mỗi tin đã gửi (kể cả lệnh gạch chéo) vào lịch sử, mới nhất ở CUỐI; gửi lại đúng chữ cũ thì chuyển nó xuống cuối (không lặp).
 *  - Tin rỗng hoặc quá dài (dán cả tài liệu) không lưu. Tối đa PROMPT_HISTORY_MAX tin.
 *  - ↑ ở DÒNG ĐẦU của ô nhập: lùi một tin (lần đầu giữ lại bản nháp đang gõ); ↓ ở DÒNG CUỐI: tiến một tin, qua tin mới nhất thì trả bản nháp.
 *    Ở dòng giữa của tin nhiều dòng thì phím ↑/↓ vẫn di con trỏ như thường. Có chọn vùng chữ, hoặc có Shift/Alt/Ctrl/Cmd → không đụng.
 *  - Người dùng sửa chữ vừa gọi lại → thoát khỏi chế độ duyệt (↑ kế tiếp lại bắt đầu từ tin mới nhất, bản sửa là bản nháp mới).
 */

export const PROMPT_HISTORY_MAX = 500;
/** Số ký tự tối đa của một tin được lưu; dài hơn (dán cả tài liệu/nhật ký) thì không đưa vào lịch sử. */
export const PROMPT_ENTRY_MAX = 8000;

/** Đọc lịch sử đã lưu (dữ liệu không đáng tin): chỉ giữ chuỗi hợp lệ, bỏ trùng (giữ bản MỚI NHẤT), cắt còn PROMPT_HISTORY_MAX. */
export function sanitizeHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  let out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const t = x.trim();
    if (!t || t.length > PROMPT_ENTRY_MAX) continue;
    out = out.filter((y) => y !== t);
    out.push(t);
  }
  return out.slice(-PROMPT_HISTORY_MAX);
}

/** Thêm một tin vừa gửi. Không đổi gì (trả đúng `list`) nếu tin rỗng/quá dài hoặc đã là tin mới nhất. */
export function addPrompt(list: readonly string[], text: string): readonly string[] {
  const t = String(text ?? '').trim();
  if (!t || t.length > PROMPT_ENTRY_MAX) return list;
  if (list[list.length - 1] === t) return list;
  const next = list.filter((y) => y !== t);
  next.push(t);
  return next.slice(-PROMPT_HISTORY_MAX);
}

export interface HistoryNav {
  /** Chỉ số tin đang hiện trong lịch sử; -1 = không đang duyệt (ô nhập là bản nháp của người dùng). */
  index: number;
  /** Bản nháp người dùng đang gõ lúc bắt đầu duyệt (trả lại khi ↓ qua tin mới nhất). */
  draft: string;
}

export const NO_NAV: HistoryNav = { index: -1, draft: '' };

export interface HistoryStep {
  text: string;
  nav: HistoryNav;
}

/** Một bước ↑ (`up`) hoặc ↓ (`down`). `null` = không có gì để làm (lịch sử rỗng, đã ở tin cũ nhất, hay đang không duyệt mà bấm ↓). */
export function historyStep(list: readonly string[], nav: HistoryNav, dir: 'up' | 'down', current: string): HistoryStep | null {
  if (dir === 'up') {
    if (list.length === 0) return null;
    if (nav.index < 0) return { text: list[list.length - 1]!, nav: { index: list.length - 1, draft: current } };
    if (nav.index === 0) return null;
    const index = Math.min(nav.index, list.length) - 1;
    return { text: list[index]!, nav: { index, draft: nav.draft } };
  }
  if (nav.index < 0) return null;
  if (nav.index >= list.length - 1) return { text: nav.draft, nav: NO_NAV };
  return { text: list[nav.index + 1]!, nav: { index: nav.index + 1, draft: nav.draft } };
}

export interface HistoryKey {
  key: string;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  /** Bộ gõ (Telex/VNI/IME) đang ghép chữ. */
  composing?: boolean;
  value: string;
  selStart: number;
  selEnd: number;
}

/**
 * Phím ↑/↓ trong ô nhập có phải là «duyệt lịch sử» không, và nếu có thì kết quả. `null` = để phím làm việc mặc định (di con trỏ).
 * Chỉ nhận khi con trỏ đứng yên (không chọn vùng) và ở dòng đầu (↑) / dòng cuối (↓) của chữ đang soạn.
 */
export function historyKey(k: HistoryKey, list: readonly string[], nav: HistoryNav): HistoryStep | null {
  if (k.composing) return null;
  if (k.key !== 'ArrowUp' && k.key !== 'ArrowDown') return null;
  if (k.shift || k.alt || k.ctrl || k.meta) return null;
  if (k.selStart !== k.selEnd) return null;
  if (k.key === 'ArrowUp' && k.value.slice(0, k.selStart).includes('\n')) return null; // còn dòng phía trên → di con trỏ lên
  if (k.key === 'ArrowDown' && k.value.slice(k.selEnd).includes('\n')) return null; // còn dòng phía dưới → di con trỏ xuống
  return historyStep(list, nav, k.key === 'ArrowUp' ? 'up' : 'down', k.value);
}

/** Chữ trong ô nhập đã bị người dùng sửa so với tin đang gọi lại? Có → phải thoát chế độ duyệt. */
export function navDetached(list: readonly string[], nav: HistoryNav, value: string): boolean {
  return nav.index >= 0 && list[nav.index] !== value;
}
