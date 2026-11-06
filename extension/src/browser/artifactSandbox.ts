/**
 * Chạy TRONG trang sandbox (origin riêng, không API extension). Nhận tài liệu đã dựng từ vỏ tin cậy rồi ghi vào chính trang này.
 * Chỉ nhận tin từ cửa sổ cha; chỉ nhận MỘT lần (sau document.write, trang này không còn bộ lắng nghe nào).
 */

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window.parent || !e.data || e.data.type !== 'nd-render' || typeof e.data.html !== 'string') return;
  document.open();
  document.write(e.data.html);
  document.close();
});
