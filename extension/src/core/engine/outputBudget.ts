/**
 * (lane:output-timeouts) Trần đầu ra THÍCH ỨNG cho từng lần gọi model.
 *
 * Vì sao có: một trần cố định 32k cho mọi lượt vừa lãng phí (câu trả lời thường chỉ vài trăm token nhưng model vẫn
 * được "phép" chạy tới 32k — có lượt chạm trần vì lan man), vừa làm lượt dài hơn (44 lượt >60 s trong log thật). Chọn trần
 * theo loại việc: trả lời / so sánh / sửa mã thông thường → 8.000; soạn tài liệu, báo cáo, bản đầy đủ, viết tiếp phần bị cắt,
 * hay đã thấy công cụ ghi nội dung dài (write_file, create_artifact…) → trần đầy đủ (cài đặt `agent.maxOutputTokens`, kẹp theo
 * giới hạn thật của model lấy từ danh mục). Hàm thuần, tất định — mỗi luật có test.
 */

/** Trần cho lượt thường (trả lời, so sánh, sửa mã nhỏ). */
export const SHORT_OUTPUT_TOKENS = 8_000;
/** Trần "dài" mặc định khi không biết trần model (bằng mặc định của cài đặt). */
export const LONG_OUTPUT_TOKENS = 32_000;

export interface OutputBudgetInput {
  /** Chữ người dùng gõ ở tin mở lượt (đã bỏ phần đính kèm). */
  userText: string;
  /** Cài đặt `agent.maxOutputTokens` — luôn là TỐI ĐA. */
  maxSetting: number;
  /** Trần đầu ra thật của model (từ danh mục), nếu biết. */
  modelCap?: number;
  /** Trong lần chạy này đã có công cụ stream nội dung dài (write_file, create_artifact…) được gọi. */
  longWriteSeen: boolean;
  /** Lần gọi ngay trước trong cùng lượt bị cắt vì chạm trần (đang viết tiếp). */
  continuation: boolean;
  /** Tắt chế độ thích ứng → luôn dùng trần tối đa (hành vi cũ). */
  adaptive: boolean;
}

export type OutputBudgetReason = 'fixed' | 'short' | 'long-request' | 'long-write' | 'continuation';

export interface OutputBudget {
  tokens: number;
  reason: OutputBudgetReason;
}

/**
 * Yêu cầu kiểu "viết dài": báo cáo, tài liệu, bản đầy đủ, viết tiếp, dịch cả tệp, bài viết/blog, kịch bản, hướng dẫn chi tiết…
 * Tiếng Việt có dấu lẫn không dấu, tiếng Anh. Tất định (regex), không gọi model.
 */
const LONG_FORM_RE = new RegExp(
  [
    // vi
    'báo cáo', 'bao cao', 'tài liệu', 'tai lieu', 'bản đầy đủ', 'ban day du', 'đầy đủ', 'day du', 'viết dài', 'viet dai', 'chi tiết nhất', 'toàn bộ nội dung',
    'viết tiếp', 'viet tiep', 'phần tiếp', 'phan tiep', 'bài viết', 'bai viet', 'bài blog', 'kịch bản', 'kich ban', 'hướng dẫn chi tiết', 'huong dan chi tiet',
    'biên bản', 'bien ban', 'đề án', 'de an', 'luận văn', 'luan van', 'giáo trình', 'giao trinh', 'sách', 'ebook', 'whitepaper', 'dịch toàn bộ', 'dich toan bo',
    'soạn thảo', 'soan thao', 'hợp đồng', 'hop dong', 'kế hoạch chi tiết', 'ke hoach chi tiet', 'changelog đầy đủ', 'tổng hợp đầy đủ', 'phân tích chi tiết', 'phan tich chi tiet',
    // en
    'report', 'full document', 'document', 'documentation', 'whole document', 'complete version', 'full version', 'in full', 'long[- ]form', 'write (?:it )?long',
    'continue (?:writing|the (?:report|document|article))', 'next part', 'blog post', 'article', 'essay', 'white ?paper', 'specification', 'spec sheet', 'detailed guide',
    'comprehensive', 'exhaustive', 'thesis', 'book chapter', 'translate the (?:whole|entire)', 'proposal', 'contract', 'detailed plan', 'full changelog',
  ].join('|'),
  'i',
);

/** Chuỗi đánh dấu mà chính harness gắn vào câu "viết tiếp" (nút «Chạy tiếp phần N» / tự nối tiếp): luôn là viết dài. */
const CONTINUATION_MARK_RE = /\[(?:tiếp phần|continue part|part) \d+\]|viết tiếp phần \d+|continue part \d+/i;

export function isLongFormRequest(text: string): boolean {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (CONTINUATION_MARK_RE.test(s)) return true;
  return LONG_FORM_RE.test(s);
}

/** Kẹp về số nguyên ≥ 1024 (API nào cũng từ chối trần quá nhỏ); không hợp lệ → `fallback`. */
function sane(n: number | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1024 ? Math.floor(n) : fallback;
}

export function pickOutputBudget(i: OutputBudgetInput): OutputBudget {
  const max = sane(i.maxSetting, LONG_OUTPUT_TOKENS);
  // Luôn kẹp theo giới hạn thật của model: adapter cũng tự hạ khi máy chủ báo, nhưng biết trước thì không mất một lượt gọi lỗi.
  const cap = i.modelCap !== undefined ? Math.min(max, sane(i.modelCap, max)) : max;
  if (!i.adaptive) return { tokens: cap, reason: 'fixed' };
  if (i.continuation) return { tokens: cap, reason: 'continuation' };
  if (i.longWriteSeen) return { tokens: cap, reason: 'long-write' };
  if (isLongFormRequest(i.userText)) return { tokens: cap, reason: 'long-request' };
  return { tokens: Math.min(SHORT_OUTPUT_TOKENS, cap), reason: 'short' };
}
