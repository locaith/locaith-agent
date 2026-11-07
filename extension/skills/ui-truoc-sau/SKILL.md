---
name: ui-truoc-sau
description: Khi người dùng nhờ sửa, làm đẹp hoặc thiết kế lại giao diện web/app, chụp ảnh «trước» rồi «sau» và đặt cạnh nhau trong khung chat để họ thấy ngay thay đổi. Nạp khi yêu cầu liên quan đến bố cục, màu sắc, CSS, responsive, redesign, "làm đẹp", "sửa giao diện".
tags: [giao diện, ui, css, làm đẹp, redesign, responsive, bố cục, trước sau, before after, ảnh chụp, so sánh, screenshot]
unlocks: [show_before_after]
---

# Ảnh «Trước → Sau» khi làm giao diện

Người dùng muốn THẤY thay đổi, không chỉ đọc mô tả. Quy trình gọn gồm bốn bước; bỏ qua bước nào không làm được và nói thẳng, không bịa ảnh.

## 1. Xác định có chụp được không
Chụp được khi có một trong ba nguồn: trang đang chạy (dev server, ví dụ `http://localhost:5173`), tệp HTML trong workspace, hoặc một URL công khai. Không có gì để chụp (thiếu cả trang lẫn tệp HTML dựng được) thì KHÔNG gọi `show_before_after`: tóm tắt thay đổi bằng lời và nói rõ chưa chụp được vì sao.

## 2. Chụp ảnh «trước» — TRƯỚC khi sửa bất cứ thứ gì
Lưu vào `.locaith/shots/` trong workspace (tạo thư mục nếu chưa có; đừng commit nó). Đặt tên `<trang>-truoc.png`. Dùng cách nào CÓ SẴN, theo thứ tự:

- **MCP Playwright / trình duyệt đã kết nối** (nếu danh sách công cụ có `browser_navigate` + `browser_take_screenshot`): mở trang, đặt cỡ cửa sổ, chụp với tham số `filename` để ra tệp.
- **Trình duyệt headless có sẵn trên máy** qua `run_command` (không cài thêm gì): Chrome hoặc Edge đều có cờ chụp.
  - Windows (PowerShell): `& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,800 --screenshot="$PWD\.locaith\shots\trang-truoc.png" http://localhost:5173/`
  - macOS: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --window-size=1280,800 --screenshot=.locaith/shots/trang-truoc.png http://localhost:5173/`
  - Linux: `google-chrome --headless=new --window-size=1280,800 --screenshot=.locaith/shots/trang-truoc.png http://localhost:5173/` (hoặc `chromium`)
  - Tệp HTML tĩnh: dùng địa chỉ `file:///đường/dẫn/index.html`.
- Công cụ `chrome` (cầu nối Chrome thật) và `page_screenshot` chỉ cho model NHÌN ảnh, không lưu ra tệp ⇒ không dùng được cho `show_before_after`. Có thể dùng để tự kiểm tra bằng mắt, nhưng ảnh trình bày cho người dùng vẫn phải là tệp.

Giữ ảnh nhỏ: cỡ 1280×800, tối đa khoảng 2 MB mỗi ảnh (trần của thẻ). Quá nặng thì chụp vùng nhỏ hơn hoặc lưu `.jpg`.

## 3. Sửa giao diện
Làm đúng yêu cầu. Nếu dev server cần khởi động lại hoặc build, làm trước khi chụp «sau».

## 4. Chụp ảnh «sau» đúng cùng góc nhìn, rồi trình bày
Cùng URL, cùng cỡ cửa sổ, cùng tình trạng cuộn như ảnh «trước» (khác góc nhìn thì so sánh vô nghĩa). Lưu `<trang>-sau.png`, rồi gọi:

`show_before_after` với `before`, `after`, `caption` (một câu nói đã đổi gì, bằng ngôn ngữ của người dùng) và nhãn nếu cần (`label_before`, `label_after`).

## Sau khi gọi
- Công cụ KHÔNG gửi ảnh lại cho bạn: đừng mô tả chi tiết ảnh như thể đã nhìn thấy. Tóm tắt bằng những điều bạn đã sửa trong mã.
- Nếu có nhiều màn hình/breakpoint, gọi tối đa vài cặp (ví dụ desktop và điện thoại), không tràn ngập khung chat.
- Công cụ báo lỗi (ảnh không có, quá nặng, không phải ảnh)? Sửa đúng lỗi đó rồi gọi lại, đừng bỏ qua im lặng.
