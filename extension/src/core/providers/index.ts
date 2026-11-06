/**
 * Lớp nhà cung cấp LLM — điểm vào duy nhất cho engine/host.
 *
 * Quy ước chung của mọi adapter:
 *  - `stream()` trả `AsyncGenerator<ProviderEvent>` kết thúc bằng ĐÚNG MỘT sự kiện `done` (hoặc ném ProviderError).
 *  - Sự kiện `usage` là ảnh chụp cộng dồn của lượt gọi hiện tại (không phải số gia tăng); `done.usage` là số cuối.
 *  - `usage.inputTokens` = TỔNG token đầu vào (đã gồm phần đọc/ghi cache) → dùng trực tiếp làm cỡ ngữ cảnh.
 *  - Lỗi được chuẩn hoá thành `ProviderError` (kind/status/retryable) với thông điệp tiếng Việt, đã che khoá.
 *  - Thử lại tự động CHỈ khi chưa có nội dung nào đến tay người dùng; mỗi lần thử lại phát sự kiện `retry`.
 */

export * from './anthropic';
export * from './catalog';
export * from './common';
export * from './demo';
export * from './gemini';
export * from './history';
export * from './http';
export * from './modelFilters';
export * from './openaiChat';
export * from './openaiResponses';
export * from './presets';
export * from './registry';
export * from './service';
export * from './sse';
