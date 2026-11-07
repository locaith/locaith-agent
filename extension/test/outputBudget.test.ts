import { describe, expect, it } from 'vitest';
import { LONG_OUTPUT_TOKENS, SHORT_OUTPUT_TOKENS, isLongFormRequest, pickOutputBudget } from '../src/core/engine/outputBudget';

/**
 * (lane:output-timeouts · H04) Trần đầu ra thích ứng: 8k cho lượt thường, trần đầy đủ cho tài liệu dài / viết tiếp / đã ghi nội dung dài,
 * luôn kẹp theo cài đặt và trần thật của model. Heuristic tất định.
 */
const base = { maxSetting: 32_000, longWriteSeen: false, continuation: false, adaptive: true };

describe('outputBudget — trần đầu ra thích ứng', () => {
  it('lượt thường (hỏi, so sánh, sửa mã nhỏ) → 8.000', () => {
    for (const q of ['So sánh React và Vue cho tôi', 'sửa lỗi null ở hàm parse', 'Fix the failing test in utils.ts', 'giải thích đoạn này']) {
      expect(pickOutputBudget({ ...base, userText: q })).toEqual({ tokens: SHORT_OUTPUT_TOKENS, reason: 'short' });
    }
  });

  it('yêu cầu viết dài (báo cáo / tài liệu / bản đầy đủ / viết dài · vi có dấu, không dấu, en) → trần đầy đủ', () => {
    for (const q of ['Viết báo cáo tổng kết quý 3', 'soan tai lieu huong dan cho team', 'Cho mình bản đầy đủ nhé', 'viết dài hơn, chi tiết nhất', 'Write a full report on the migration', 'Draft the documentation for the API']) {
      expect(pickOutputBudget({ ...base, userText: q }), q).toEqual({ tokens: LONG_OUTPUT_TOKENS, reason: 'long-request' });
    }
    expect(isLongFormRequest('')).toBe(false);
    expect(isLongFormRequest('đọc file a.ts')).toBe(false);
  });

  it('đang viết tiếp phần bị cắt (continuation) → trần đầy đủ, bất kể câu hỏi ban đầu', () => {
    expect(pickOutputBudget({ ...base, userText: 'hỏi ngắn', continuation: true })).toEqual({ tokens: LONG_OUTPUT_TOKENS, reason: 'continuation' });
    // Nút «Chạy tiếp phần N» gửi câu có dấu phần → cũng là viết dài.
    expect(isLongFormRequest('Viết tiếp phần 3 từ đúng chỗ vừa dừng')).toBe(true);
    expect(isLongFormRequest('[continued in part 2]')).toBe(true);
  });

  it('đã thấy công cụ ghi nội dung dài trong lượt (write_file/create_artifact) → trần đầy đủ', () => {
    expect(pickOutputBudget({ ...base, userText: 'hỏi ngắn', longWriteSeen: true })).toEqual({ tokens: LONG_OUTPUT_TOKENS, reason: 'long-write' });
  });

  it('luôn kẹp theo cài đặt maxOutputTokens và trần thật của model (danh mục)', () => {
    expect(pickOutputBudget({ ...base, userText: 'viết báo cáo', modelCap: 16_000 })).toEqual({ tokens: 16_000, reason: 'long-request' });
    expect(pickOutputBudget({ ...base, userText: 'hỏi ngắn', modelCap: 4_096 })).toEqual({ tokens: 4_096, reason: 'short' });
    expect(pickOutputBudget({ ...base, userText: 'viết báo cáo', maxSetting: 12_000, modelCap: 128_000 })).toEqual({ tokens: 12_000, reason: 'long-request' });
    // cài đặt dưới 8k → lượt thường cũng không vượt cài đặt
    expect(pickOutputBudget({ ...base, userText: 'hỏi ngắn', maxSetting: 6_000 }).tokens).toBe(6_000);
  });

  it('tắt chế độ thích ứng → luôn dùng trần tối đa (hành vi cũ); giá trị hỏng → 32k', () => {
    expect(pickOutputBudget({ ...base, userText: 'hỏi ngắn', adaptive: false })).toEqual({ tokens: 32_000, reason: 'fixed' });
    expect(pickOutputBudget({ ...base, userText: 'hỏi ngắn', adaptive: false, maxSetting: NaN }).tokens).toBe(LONG_OUTPUT_TOKENS);
    expect(pickOutputBudget({ ...base, userText: 'hỏi ngắn', modelCap: 0 }).tokens).toBe(SHORT_OUTPUT_TOKENS); // modelCap vô nghĩa → bỏ qua
  });
});
