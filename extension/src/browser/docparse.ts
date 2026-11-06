/**
 * Bộ đọc tệp tải lên của bản trình duyệt (PDF, Word, Excel, HTML, CSV, TXT). Được đóng gói RIÊNG thành docparse.js (ESM) và chỉ nạp lười ở lần tải tệp đầu tiên
 * (xem panel.tsx): pdf.js khá nặng nên không nằm trong panel.js — và panel.js phải sạch `new Function`/`eval` (test/browser/platform.test.ts).
 */
export { extractDocument } from '../shared/docExtract';
