/**
 * (lane:checkpoints-rewind) Kiểu dữ liệu DÙNG CHUNG host ↔ webview ↔ Remote cho Checkpoint & Quay lại (rewind).
 *
 * Không import `vscode`/`node:*` — tệp này đi vào cả bản trình duyệt và trang Remote (qua protocol.ts).
 * Mọi thứ ở đây là TRƯỜNG TUỲ CHỌN trên ViewState (`checkpoints`, `rewind`): bản Remote cũ không biết thì bỏ qua,
 * không có loại UiEvent/ABlock/TItem mới (reducer của trang Remote có switch kín).
 */

/** Vì sao một tệp không được chụp / không khôi phục được. */
export type CheckpointSkip = 'too_large' | 'binary' | 'outside' | 'missing_blob' | 'unreadable';

/** Một tệp trợ lý đã ghi trong một lượt (đã chụp bản gốc trước lần ghi đầu). */
export interface CheckpointFile {
  /** Đường dẫn tương đối theo workspace (dấu '/'). */
  rel: string;
  /** 'create' = trước lượt này tệp chưa tồn tại. */
  kind: 'edit' | 'create';
  /** Số dòng thêm/bớt từ bản gốc tới bản cuối trợ lý ghi trong lượt. */
  added: number;
  removed: number;
  /** Có giá trị = KHÔNG chụp được (quá 2 MB, nhị phân…): hiện ra nhưng không hoàn tác được. */
  skipped?: CheckpointSkip;
}

/** Tóm tắt checkpoint của MỘT lượt (gắn với id tin nhắn người dùng khởi động lượt). */
export interface CheckpointTurn {
  promptId: string;
  files: CheckpointFile[];
  /** Đã hoàn tác (khôi phục mã) lượt này. */
  undone?: boolean;
}

export type RewindWhat = 'code' | 'conversation' | 'both';
/** 'from' = từ điểm này về sau (quay lại thật sự) · 'turn' = chỉ các tệp của riêng lượt này (hoàn tác ở thanh thay đổi). */
export type RewindScope = 'from' | 'turn';

/** Một tệp trong kế hoạch khôi phục đã được host kiểm tra trên đĩa. */
export interface RewindPlanFile {
  rel: string;
  /** restore = ghi lại bản gốc · recreate = tạo lại tệp đã bị xoá · delete = xoá tệp trợ lý tạo mới · skip = không làm được (xem `reason`). */
  action: 'restore' | 'recreate' | 'delete' | 'skip';
  /** Số dòng sẽ thêm/bớt so với nội dung HIỆN TẠI trên đĩa. */
  added: number;
  removed: number;
  /** Nội dung hiện tại ≠ bản trợ lý đã ghi: bạn (hoặc lệnh shell) đã sửa tiếp sau đó — khôi phục sẽ đè lên phần sửa đó. */
  conflict?: boolean;
  reason?: CheckpointSkip;
}

export interface RewindRecent {
  promptId: string;
  /** Chữ đầu của tin (đã cắt). */
  text: string;
  /** Số tệp trợ lý đã sửa trong lượt đó. */
  files: number;
}

/** Thẻ «Quay lại» đang mở dưới một tin nhắn người dùng. */
export interface RewindView {
  promptId: string;
  /** menu = chọn khôi phục gì · plan = xem trước và xác nhận · applying = đang khôi phục · done = kết quả (có thể Làm lại). */
  stage: 'menu' | 'plan' | 'applying' | 'done';
  what?: RewindWhat;
  scope?: RewindScope;
  files?: RewindPlanFile[];
  /** Số tệp có xung đột trong `files`. */
  conflicts?: number;
  /** Số tin nhắn (mục transcript) sẽ bị cắt khi khôi phục hội thoại. */
  messages?: number;
  /** Số tệp đã khôi phục (stage 'done'). */
  restored?: number;
  /** Kết quả là «Làm lại» (đảo ngược lần khôi phục trước). */
  redone?: boolean;
  /** Số tệp KHÔNG khôi phục được (xung đột, ngoài workspace, lỗi ghi) trong lần vừa rồi. */
  skipped?: number;
  /** Có thể «Làm lại» (đảo ngược lần khôi phục vừa rồi). */
  canRedo?: boolean;
  /** `/rewind`: các tin gần đây để chọn điểm quay lại (mới nhất trước). Có mặt = thẻ hiện ở cuối khung chat thay vì dưới một tin. */
  recent?: RewindRecent[];
  /** Lỗi ngắn hiện trong thẻ (không đóng thẻ). */
  error?: string;
}

export const CHECKPOINT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const CHECKPOINT_KEEP_TURNS = 30;
export const CHECKPOINT_KEEP_DAYS = 14;
