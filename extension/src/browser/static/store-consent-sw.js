// Locaith AI (bản Chrome / Edge) — phía dịch vụ nền của cổng đồng ý về dữ liệu (giao diện: store-consent.js).
// Chưa đồng ý thì KHÔNG có đường nào để nội dung trang / tin nhắn của người dùng rời máy từ dịch vụ nền:
//   • menu chuột phải («Hỏi / Giải thích đoạn đã chọn», «Tóm tắt trang này») → chỉ mở thanh bên để hiện thông báo (src/browser/background.ts đọc cổng này).
(() => {
  const KEY = 'nd.consent.v1';
  const ok = async () => {
    try { const o = await chrome.storage.local.get(KEY); return !!(o[KEY] && o[KEY].v === 1); } catch (e) { return false; }
  };
  const prompt = async (tab) => {
    try { if (tab && tab.id !== undefined) await chrome.sidePanel.open({ tabId: tab.id }); } catch (e) { /* cần thao tác người dùng; bấm biểu tượng tiện ích cũng mở được */ }
  };
  globalThis.__ndConsent = { ok, prompt, KEY };
})();
