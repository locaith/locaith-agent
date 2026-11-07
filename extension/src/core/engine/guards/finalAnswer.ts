/**
 * Câu trả lời cuối phải tự đứng được (B05, lane:loop-guards).
 *
 * Model yếu hay kết lượt dài bằng "chi tiết ở trên" / "xem phần Worked for" / "như đã nói" — trỏ vào nội dung đã gập trong dòng thời gian,
 * hoặc một câu quá ngắn sau hàng chục lệnh công cụ. Người dùng (nhất là trên Remote/điện thoại) không thấy gì. Bộ phát hiện này chỉ
 * là HÀM THUẦN; cổng hoàn thành dùng nó để nhắc ĐÚNG MỘT lần (tính chung vào ngân sách nhắc).
 */

/** Số lệnh gọi công cụ từ đó một câu trả lời ngắn bị coi là "quá ngắn sau lượt dài". */
export const LONG_RUN_CALLS = 6;
/** Pointer phrases chỉ xét khi lượt đã có ít nhất chừng này lệnh công cụ (tránh bắt nhầm câu chuyện đời thường). */
export const POINTER_MIN_CALLS = 2;
const SHORT_CHARS = 120;

const POINTERS: RegExp[] = [
  /chi\s*tiết\s*(ở|như)\s*(trên|phía trên|bên trên)/i,
  /(xem|tham khảo)\s+(lại\s+)?(phần|mục|kết quả|nội dung|bảng|log|nhật ký)\s+(ở\s+)?(trên|phía trên|bên trên|worked for|đã làm|trước)/i,
  /như\s+(đã|tôi đã|mình đã|em đã)\s+(nói|trình bày|nêu|liệt kê|báo|mô tả)\s*(ở\s*)?(trên|phía trên|bên trên)?/i,
  /(kết quả|chi tiết|nội dung)\s+(đã|như)\s+(nêu|hiện|có)\s+(ở\s+)?(trên|phía trên|bên trên)/i,
  /\b(see|refer to|as (shown|listed|mentioned|described|noted|stated))\s+(above|earlier|previously|in the (log|output|work log|worked for section))\b/i,
  /\bdetails?\s+(are\s+)?(above|in the (log|output|work log))\b/i,
  /\bworked\s+for\b/i,
];

const HAS_SUBSTANCE = /(^|\n)\s*([-*•]|\d+[.)]|\|)/; // danh sách, bảng
const CODE_BLOCK = /```/;

export type FinalAnswerProblem = 'pointer' | 'short';

/**
 * `toolCalls` = số lệnh công cụ đã chạy trong lượt. Trả về loại vấn đề, hoặc null nếu câu trả lời ổn.
 *  - 'pointer': câu trả lời trỏ vào chỗ khác thay vì nêu kết quả (chỉ xét khi lượt đã dùng công cụ);
 *  - 'short':   lượt dài (≥ LONG_RUN_CALLS lệnh) mà câu trả lời < 120 ký tự, không bảng/danh sách/mã.
 */
export function finalAnswerProblem(text: string, toolCalls: number): FinalAnswerProblem | null {
  const s = text.trim();
  if (!s) return null;
  if (toolCalls >= POINTER_MIN_CALLS && POINTERS.some((re) => re.test(s))) {
    // Trỏ lên trên nhưng ngay dưới vẫn có bảng/danh sách/mã dài → vẫn tự đứng được.
    if (s.length >= 600 && (HAS_SUBSTANCE.test(s) || CODE_BLOCK.test(s))) return null;
    return 'pointer';
  }
  if (toolCalls >= LONG_RUN_CALLS && s.length < SHORT_CHARS && !HAS_SUBSTANCE.test(s) && !CODE_BLOCK.test(s)) return 'short';
  return null;
}
