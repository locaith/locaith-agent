/**
 * (lane:sessions-ux) Kiểu dữ liệu hiển thị của: đồng hồ ngữ cảnh/chi phí, tìm kiếm toàn văn lịch sử. Dùng chung host + webview + Remote.
 * Không import gì ngoài kiểu — protocol.ts import tệp này.
 */

/** Số liệu cho chip «ngữ cảnh 38%» ở thanh tiêu đề. Mọi trường là số thật hoặc ước lượng có ghi rõ; thiếu = không biết (ẩn). */
export interface SessionMeterView {
  /** Tổng token vào / ra cả phiên (session.usageTotals). */
  inputTokens: number;
  outputTokens: number;
  /** Số lần đã nén cuộc trò chuyện (đếm từ thông báo nén trong transcript). */
  compactions: number;
  /** Tổng số kết quả công cụ cũ đã được lược bớt khi nén. */
  clearedResults: number;
  /** ƯỚC TÍNH chi phí phiên (USD) theo bảng giá model trong danh mục. Thiếu = danh mục không có giá → giao diện ẩn chi phí. */
  costUsd?: number;
}

/** Một cuộc trò chuyện khớp truy vấn tìm kiếm lịch sử. */
export interface SessionSearchHit {
  id: string;
  /** Khớp ở tiêu đề. */
  inTitle: boolean;
  /** Trích đoạn quanh chỗ khớp đầu tiên trong nội dung (đã cắt ~160 ký tự); thiếu nếu chỉ khớp tiêu đề. */
  snippet?: string;
  /** Các khoảng [bắt đầu, kết thúc) cần làm nổi trong `snippet`. */
  marks?: Array<[number, number]>;
  /** Số chỗ khớp trong nội dung (tối đa 99). */
  count: number;
}
