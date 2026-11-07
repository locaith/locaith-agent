# Bản Chrome / Edge: chạm một ngôi sao là gửi ngay

- **Đánh giá một chạm, như nút 👍/👎 của Claude.** Trước đây chạm sao (hay «Đánh giá ngay») chỉ mở trang Chrome Web Store để người dùng tự viết đánh giá. Nay chạm một ngôi sao là **gửi ngay về Locaith** (đến nhóm góp ý của đội), dải chuyển sang «Cảm ơn bạn! Đã gửi 5★ cho Locaith.» — không mở trang nào, không bắt viết gì. Mất mạng thì báo «Đã ghi nhận 4★ — sẽ gửi khi có mạng» và tự gửi bù ở lần mở khung chat sau (giữ tối đa 30 ngày).
- **Nhận xét bằng chữ là tuỳ chọn** và chỉ hiện SAU khi đã gửi sao («Muốn nói thêm?», với 1–3 sao: «Điều gì chưa tốt?»). Với 4–5 sao có thêm nút riêng «Đánh giá cả trên Chrome Web Store ↗» (không bắt buộc). Lời cảm ơn tự đóng sau vài giây; X ở dải mời = «Không hiện lại».
- **Sửa lỗi nút «Đánh giá» mở trang không có thật:** bản 0.6.27 mang mã mục cửa hàng gõ nhầm (29 ký tự), và test cũ chép đúng mã sai đó. Mã đúng `amngiccgboohakecgdiadjkdfcablkjc`; test nay kiểm định dạng (32 chữ a–p) và đúng mục.
- **Dữ liệu gửi đi:** chỉ số sao, nhận xét nếu bạn tự gõ, và dòng «tiện ích Chrome/Edge · phiên bản · ngôn ngữ · số lượt dùng». Không email, không địa chỉ trang đang xem, không khoá, không mã máy; yêu cầu ẩn danh (không cookie, không Referer). Manifest khai báo thêm máy chủ `https://studio-api.locaith.com/*` (gói 0.4.4 đã duyệt cũng có), chỉ dùng cho việc này. Cập nhật lên bản này Chrome sẽ hỏi chấp nhận quyền mới.
- Không có cài đặt mới.

## English (short)

- One-tap rating, like Claude's thumbs: tapping a star now SENDS it to Locaith immediately (anonymous POST to the existing feedback endpoint) and the strip turns into "Thank you! Sent 5★" — no page opens, nothing to write. Offline → "Saved 4★ — will be sent when you are online" and delivered the next time the panel opens (kept up to 30 days). An optional comment box appears after the star is sent; 4–5★ also gets an optional "Also rate on the Chrome Web Store" button.
- Fixed: the store link used a mistyped extension id (29 chars) and pointed at a page that does not exist; the id is now correct and tested (32 letters a–p).
- Data sent: star count, the comment if you type one, and "extension · version · language · usage count". No email, page URL, keys or device id. The manifest now declares `https://studio-api.locaith.com/*` (used only for this), so Chrome asks to accept the new permission on update.
