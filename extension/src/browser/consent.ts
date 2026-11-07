/**
 * Cổng đồng ý về dữ liệu (chính sách dữ liệu người dùng của Chrome Web Store: thông báo NGAY TRONG tiện ích, trước khi nội dung trang / tin nhắn rời máy).
 *
 * Hai nửa dùng chung MỘT khoá trong chrome.storage.local:
 *  - giao diện: `static/store-consent.js` (nạp trong sidepanel.html trước panel.js) — lớp phủ toàn khung, bấm «Đồng ý và tiếp tục» thì ghi `{ v: 1, at }`;
 *  - dịch vụ nền: `static/store-consent-sw.js` (background.ts nạp bằng importScripts) — đặt `globalThis.__ndConsent.ok()` đọc lại khoá đó.
 * Bản `--test` (e2e) KHÔNG nạp cả hai (esbuild.browser.mjs gỡ tệp + thẻ script), nên mọi e2e không kẹt sau lớp phủ.
 */

/** Phải trùng KEY trong static/store-consent.js và store-consent-sw.js (test/browser/consent.test.ts kiểm). */
export const CONSENT_KEY = 'nd.consent.v1';

export interface ConsentGate {
  /** true khi người dùng đã bấm «Đồng ý và tiếp tục» (cờ `{ v: 1 }` trong chrome.storage.local). */
  ok(): Promise<boolean>;
}

/** Cổng do store-consent-sw.js đặt; undefined nếu tệp đó không được nạp (bản --test, hoặc nạp hỏng). */
export function consentGate(): ConsentGate | undefined {
  return (globalThis as { __ndConsent?: ConsentGate }).__ndConsent;
}
