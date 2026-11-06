---
name: artifacts
description: Dựng giao diện, bảng biểu, biểu đồ, dashboard hoặc tài liệu tương tác (HTML một tệp, SVG, Markdown) và hiển thị trong khung xem trước. Nạp khi cần trình bày dữ liệu bằng bảng thang điểm, bộ lọc, biểu đồ, trang giới thiệu, công cụ tính toán nhỏ.
unlocks: [list_artifact_types, create_artifact, update_artifact]
tags: [html, bảng, biểu đồ, dashboard, giao diện, báo cáo, svg, trực quan, bộ lọc]
---

# Artifacts — hướng dẫn thiết kế

Artifact là một sản phẩm độc lập (trang HTML, hình SVG, tài liệu Markdown) hiển thị trong khung xem trước bên cạnh cuộc trò chuyện. Công cụ vừa được mở khoá: `list_artifact_types`, `create_artifact`, `update_artifact`.

## Quy trình

1. Gọi `list_artifact_types` để đọc đặc tả và giới hạn hiện hành của từng loại.
2. Suy nghĩ kỹ rồi chọn loại phù hợp NHẤT với dữ liệu thực tế (xem bảng dưới), đừng chọn theo thói quen.
3. Gọi `create_artifact` MỘT lần với nội dung HOÀN CHỈNH. Không để lại "// … phần còn lại", không viết dở.
4. Sửa nhỏ bằng `update_artifact` (old_string → new_string) thay vì viết lại cả tệp.
5. Cuối lượt, mô tả ngắn artifact vừa dựng và những gì người dùng có thể thao tác. Không dán lại mã nguồn vào câu trả lời.

## Chọn loại

| Loại | Dùng khi | Lưu ý |
|---|---|---|
| `html` | Bảng tương tác, thanh điểm, bộ lọc, biểu đồ tự vẽ, trang giới thiệu, công cụ tính | Một tệp duy nhất: HTML + CSS + JS thuần. Linh hoạt nhất. |
| `svg` | Sơ đồ, biểu tượng, infographic tĩnh | Chỉ vector, không script. |
| `markdown` | Báo cáo, tài liệu, hướng dẫn có tiêu đề/bảng/danh sách | Nhẹ, dễ sao chép; không có tương tác. |

## Giới hạn của khung xem trước (rất quan trọng)

- Chạy trong iframe cô lập: KHÔNG có `fetch`/`XMLHttpRequest`/WebSocket, KHÔNG dùng `localStorage`/`sessionStorage`/cookie.
- Chỉ được tải script/style từ: `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`. Tải từ nơi khác sẽ bị chặn.
- KHÔNG dùng ảnh từ internet. Dùng SVG nội tuyến, CSS, emoji hoặc data URI.
- Dữ liệu nhúng sẵn dưới dạng hằng số JSON ở đầu `<script>`; vẽ giao diện bằng JS thuần từ đó.
- Kích thước tối đa khoảng 400 KB.

## Thiết kế

- Khung xem trước đã nạp sẵn font **Be Vietnam Pro** và **JetBrains Mono**: dùng `font-family: 'Be Vietnam Pro', system-ui, sans-serif` cho chữ và `'JetBrains Mono', monospace` cho số/mã. Đừng nhúng font khác.
- Thêm `<html lang="vi">` và `<meta charset="utf-8">`. Tiếng Việt nhiều dấu chồng: `line-height` từ 1.5 trở lên, không dùng chữ dưới 12px, không đặt `letter-spacing` âm cho chữ thường.
- Hỗ trợ cả giao diện sáng và tối bằng `@media (prefers-color-scheme: dark)`; dùng biến CSS cho màu. Độ tương phản chữ tối thiểu 4.5:1.
- Bố cục co giãn (flex/grid), không rộng cố định; bảng rộng cho cuộn ngang trong khung riêng.
- Số liệu: định dạng kiểu Việt Nam bằng `Intl.NumberFormat('vi-VN')` (1.234.567,89); tiền tệ ghi `₫` hoặc `VNĐ`.
- Bảng xếp hạng/thang điểm: thanh điểm (score bar) có nhãn số, màu theo nhóm, đường/ô đánh dấu ranh giới (ví dụ ngưỡng "mua được"), chip lọc theo nhóm, sắp xếp theo cột.
- Luôn ghi nguồn dữ liệu và thời điểm lấy ở chân artifact khi số liệu đến từ nghiên cứu.
- Trạng thái rỗng, hover, focus bàn phím rõ ràng; không dựa riêng vào màu để truyền đạt ý nghĩa.
