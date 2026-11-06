---
name: vietnamese-writing
description: Quy tắc viết tiếng Việt tự nhiên, đúng chuẩn — dấu thanh, giọng văn, định dạng số/ngày/tiền tệ, thuật ngữ, cách xưng hô. Nạp khi soạn nội dung tiếng Việt dài, văn bản gửi khách hàng, báo cáo, email, bài đăng.
tags: [tiếng việt, viết, nội dung, văn bản, email, báo cáo, marketing, dịch]
---

# Viết tiếng Việt

## Chuẩn chữ

- Luôn có đủ dấu, Unicode dựng sẵn (NFC). Không viết không dấu, không dùng kiểu gõ Telex còn sót ("tieng Viet", "ddoi").
- Quy tắc dấu thanh: nhất quán một kiểu trong cả văn bản (ví dụ "hoà"/"hòa", "thuỷ"/"thủy") — mặc định dùng kiểu hiện đại "hòa", "thủy", "quý".
- Chữ hoa đầu câu và tên riêng; tiêu đề viết hoa chữ đầu câu (sentence case), không viết HOA TOÀN BỘ.

## Giọng văn

- Tự nhiên như người Việt viết, không dịch từng chữ từ tiếng Anh. Câu ngắn, chủ ngữ rõ; hạn chế bị động và danh từ hoá ("tiến hành thực hiện việc…").
- Chọn mức trang trọng theo ngữ cảnh: văn bản gửi khách hàng/doanh nghiệp dùng "Quý công ty/Quý khách", xưng tên đơn vị ("Locaith AI chúng tôi"); trao đổi nội bộ thân thiện hơn.
- Thiên về kết quả kinh doanh cụ thể thay vì thuật ngữ công nghệ khi người đọc là chủ doanh nghiệp.
- Giữ nguyên thuật ngữ tiếng Anh đã quen dùng (SEO, landing page, API, ROAS, CPC) — lần đầu có thể chú giải ngắn. Tên riêng sản phẩm/thương hiệu giữ nguyên.

## Định dạng số, ngày, tiền

- Số: dấu chấm phân tách hàng nghìn, dấu phẩy thập phân → `1.234.567,89`. Phần trăm `12,5%`.
- Tiền: `15.000.000 ₫` hoặc `15 triệu đồng`; ghi rõ "chưa/đã bao gồm VAT". Đã chốt giá thì ghi một con số cố định, không ghi khoảng.
- Ngày: `29/10/2026` (dd/MM/yyyy); khi cần đọc thành lời: "ngày 29 tháng 10 năm 2026". Giờ 24h: `14:30`.
- Đơn vị đo theo hệ mét; ngôn ngữ so sánh "gấp 2 lần", "giảm 23% so với tháng trước".

## Cấu trúc

- Mở đầu bằng kết luận hoặc điều người đọc cần biết nhất, sau đó mới đến chi tiết.
- Dùng tiêu đề, danh sách và bảng khi nội dung có cấu trúc; đoạn văn thường 2–4 câu.
- Email/tin nhắn: lời chào → mục đích → nội dung chính → việc cần người nhận làm và hạn → lời kết.

## Sắp xếp và tìm kiếm

- Sắp xếp theo bảng chữ cái tiếng Việt bằng `localeCompare(b, 'vi')` (không so sánh mã Unicode thô).
- Khi so khớp/tìm kiếm, cân nhắc bỏ dấu hai phía (NFD, bỏ ký tự kết hợp U+0300–U+036F, đ→d) để "nguyen" khớp "Nguyễn".
- Tên người Việt: Họ + tên đệm + Tên; khi viết tắt hoặc gọi, thường gọi theo Tên.
