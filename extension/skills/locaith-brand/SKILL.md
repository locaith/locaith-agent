---
name: locaith-brand
description: Nhận diện thương hiệu Locaith AI để dựng tài liệu gửi khách (báo giá, hồ sơ năng lực, proposal) bằng HTML một tệp — bảng màu, font, quy tắc thị giác, bẫy khi xuất PDF, quy tắc nội dung thương mại. Nạp khi soạn tài liệu mang thương hiệu Locaith AI.
tags: [locaith ai, thương hiệu, báo giá, proposal, hồ sơ, pdf, brand, tài liệu khách hàng]
---

# Locaith AI — nhận diện và tài liệu gửi khách

Người đọc là chủ doanh nghiệp SME Việt Nam, phần lớn không rành kỹ thuật. Giọng điệu tự tin, rõ ràng, thiên về kết quả kinh doanh. Xưng "Locaith AI", gọi khách là "Quý công ty".

## Bảng màu chính thức

| Token | Hex | Dùng ở đâu |
|---|---|---|
| `--nd-primary` | `#5138ee` | Tím indigo — nút hành động, liên kết, giá tiền, số liệu, biểu tượng |
| `--nd-secondary` | `#02ebad` | Mint — dấu tick, điểm nhấn phụ, đuôi gradient |
| `--nd-heading` | `#04000b` | Gần đen — tiêu đề, tiêu đề cột bảng, nền chân trang |
| `--nd-paragraph` | `#666666` | Xám — chữ thân bài |

Gradient thương hiệu: `linear-gradient(115deg,#5138ee,#02ebad)` — dùng cho nút CTA, gói dịch vụ nổi bật, vạch nhấn, vài từ khoá (gradient-text).

## Nguyên tắc thị giác

1. Nền trắng `#FFFFFF`; section xen kẽ dùng `#F7F5FF`. Chỉ chân trang được dùng nền `--nd-heading`. Tài liệu gửi khách không làm nền tối.
2. Tím là màu hành động, mint chỉ là gia vị (dấu tick, đuôi gradient, nhãn nhỏ), không làm nền lớn một mình.
3. Tiêu đề: `--nd-heading`, weight 800, `letter-spacing:-0.03em`, `line-height:1.12` (cỡ lớn). Với cỡ chữ nhỏ và chữ thân bài KHÔNG dùng letter-spacing âm (làm dấu tiếng Việt khó đọc).
4. Font Manrope toàn bộ (Google Fonts), không pha serif. Thân bài 400–500 màu `#666666`; nhãn nhỏ weight 800, tím.
5. Bo góc rộng (card 16px, gói dịch vụ 24px), viền mảnh, bóng mềm.
6. Số liệu là điểm nhấn: giá, phần trăm cỡ 32–44px, weight 800, màu tím hoặc gradient-text.
7. Không dùng emoji làm biểu tượng trong tài liệu gửi khách; dùng số thứ tự trong chip tím nhạt hoặc SVG nội tuyến.
8. Tài liệu là **một tệp HTML duy nhất**; chỉ được link Google Fonts. Logo bên thứ ba phải là bản chính thức, nhúng bằng SVG nội tuyến.

## Quy tắc nội dung thương mại

- Giá luôn là MỘT con số cố định, không ghi khoảng ("15–25 triệu").
- Ghi rõ "chưa bao gồm thuế GTGT 10%" ở chân trang. Ngân sách quảng cáo trả cho Meta/Google không xuất hoá đơn mang tên Locaith AI, chỉ phí quản trị mới xuất VAT — luôn ghi chú.
- Phí bảo trì tính theo năm. Bảo hành 12 tháng kể từ nghiệm thu. Báo giá có hiệu lực 30 ngày.
- Cấu trúc báo giá: Hero (tên khách, dự án, ngày lập, hiệu lực) → Thấu hiểu doanh nghiệp (3 vấn đề cụ thể) → Phân tích tham chiếu → Phương án và giá (3 gói, gói giữa "Locaith AI đề xuất") → Nền tảng công nghệ → Chi phí duy trì hằng năm → Dịch vụ mở rộng → Tiến độ → Thanh toán và điều khoản → Thông tin cần khách cung cấp → Chân trang ký kết.

## Xuất PDF — các bẫy phải tránh

- Luôn viết `@media screen and (max-width:900px)` (có `screen and`), nếu không layout di động sẽ ăn vào bản in khổ A4 (~794px) và bảng bị cắt cột.
- Trong `@media print` khôi phục tường minh layout nhiều cột (`grid-template-columns:repeat(3,1fr) !important`, `table{display:table !important}`), thêm `-webkit-print-color-adjust:exact;print-color-adjust:exact` cho nền màu.
- Tắt `backdrop-filter`, `mask-image`, `box-shadow`, hiệu ứng `hover`/`transform` và nút CTA khi in.
- `@page{size:A4 portrait;margin:12mm 10mm}`; `.card,.pkg,tr{break-inside:avoid}`; `h2,h3{break-after:avoid}`; `thead{display:table-header-group}`.
- Gradient-text (`background-clip:text` + `-webkit-text-fill-color:transparent`) biến mất khi in: trong `@media print` đổ lại màu đặc `var(--nd-primary)`. Cỡ chữ in dùng đơn vị `pt`, không dùng `clamp()`.
- Gửi khách cả HTML lẫn PDF đã xuất sẵn (Chrome → In → bật "Background graphics" → A4).
