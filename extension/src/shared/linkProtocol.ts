/**
 * Dấu phiên bản giao thức cầu nối VS Code ↔ tiện ích Chrome / Edge (dùng chung cho `src/core/chrome/bridge.ts` và `src/browser/link/linkSw.ts`).
 *
 * Tiện ích Chrome gắn `?v=<LINK_PROTO>` vào MỌI yêu cầu có token (/v1/ping, /v1/poll, /v1/result). Gắn trên URL chứ không thêm tiêu đề,
 * để không phải đổi preflight CORS: VS Code bản cũ (≤ 0.7.16) chỉ cho phép `authorization, content-type` nên tiêu đề lạ sẽ làm hỏng kết nối.
 *
 * Vì sao cần: tiện ích Chrome 0.7.12 (bản cửa hàng) bỏ quên thân câu trả lời lỗi. Mỗi 401 làm nó giữ lại một vùng nhớ dùng chung 2 MB
 * không bao giờ trả, và nó hỏi lại mỗi 7 giây mãi mãi (đo trên máy thật 25/11/2026: 1.371 vùng = 2,7 GB trong một tiến trình tiện ích,
 * tổng bộ nhớ cam kết của Windows tăng khoảng 4 GB/giờ). Vì vậy máy chủ cầu ≥ 0.7.17:
 *   • yêu cầu từ tiện ích CÓ dấu này → trả 401 bình thường (bản mới đọc hết thân, dừng hẳn và báo «mất ghép đôi»);
 *   • yêu cầu từ tiện ích KHÔNG có dấu (bản cũ) mà token sai → ĐÓNG kết nối, không trả lời: fetch của bản cũ báo lỗi mạng,
 *     không có thân câu trả lời nào để rò, và nó tự giãn nhịp hỏi.
 */
export const LINK_PROTO = '2';
