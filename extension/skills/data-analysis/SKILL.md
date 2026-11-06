---
name: data-analysis
description: Phân tích dữ liệu bảng (CSV, JSON, số liệu dán vào) — làm sạch, tổng hợp, so sánh, kiểm tra tính nhất quán, trình bày kết quả có thể kiểm chứng. Nạp khi cần tính toán số liệu, thống kê, đối chiếu hoặc dựng báo cáo từ dữ liệu.
tags: [dữ liệu, thống kê, csv, excel, báo cáo, tính toán, phân tích, python, pandas]
---

# Phân tích dữ liệu

## Nguyên tắc

- **Không tính nhẩm số liệu quan trọng.** Dùng `run_command` chạy Python (`python`/`python3`) hoặc Node để tính, rồi dựa trên kết quả thật. Kiểm tra bằng `python --version` hoặc `node --version` trước.
- Nhìn dữ liệu trước khi kết luận: số dòng, các cột, kiểu dữ liệu, giá trị thiếu, trùng lặp, ngoại lai, đơn vị, múi giờ, định dạng số (dấu `.` và `,` kiểu Việt khác kiểu Mỹ).
- Ghi lại giả định (đã loại dòng nào, quy đổi gì) và nói rõ trong kết quả.
- Số liệu từ nhiều nguồn: đối chiếu định nghĩa, thời điểm và phiên bản trước khi gộp; không cộng/so sánh những thứ khác đơn vị.

## Cách làm

1. Xác nhận câu hỏi cần trả lời và chỉ số cần tính; chia nhỏ bằng `todo_write` nếu nhiều bước.
2. Đọc dữ liệu (CSV bằng `csv`/`pandas`, Excel cần `openpyxl`; nếu thiếu thư viện, báo người dùng thay vì tự cài khi chưa được phép).
3. Làm sạch → tính → kiểm tra chéo (tổng thành phần = tổng, phần trăm cộng đúng 100, so với một phép tính độc lập).
4. Trình bày: bảng Markdown gọn (≤ 15 dòng, phần còn lại ghi vào tệp), làm tròn hợp lý, đơn vị rõ ràng, định dạng số kiểu Việt khi trả lời bằng tiếng Việt.
5. Nếu cần biểu đồ hoặc bảng tương tác, nạp thêm kỹ năng `artifacts`.

## Cảnh báo thường gặp

- Chia cho 0, NaN, cột số bị đọc thành chuỗi vì có dấu phẩy ngăn cách.
- Trung bình bị lệch bởi ngoại lai — cân nhắc trung vị.
- So sánh phần trăm: phân biệt "điểm phần trăm" với "phần trăm thay đổi".
- Mẫu nhỏ: đừng kết luận mạnh từ vài chục dòng.
