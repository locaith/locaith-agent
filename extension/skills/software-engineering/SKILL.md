---
name: software-engineering
description: Quy trình làm việc trên mã nguồn trong workspace — đọc trước khi sửa, sửa nhỏ có kiểm chứng, chạy test/build, an toàn khi dùng terminal trên Windows/macOS/Linux. Nạp khi nhiệm vụ là viết, sửa, gỡ lỗi hoặc tái cấu trúc mã.
tags: [code, lập trình, sửa lỗi, refactor, test, build, git, terminal, debug]
---

# Làm việc trên mã nguồn

## Trước khi sửa

- Tìm hiểu cấu trúc: `list_dir`, `glob`, `grep`. Đọc tệp liên quan bằng `read_file` TRƯỚC khi sửa; công cụ sửa sẽ từ chối tệp chưa đọc hoặc đã bị thay đổi từ lúc đọc.
- Bắt chước phong cách sẵn có: đặt tên, thụt lề, cách xử lý lỗi, mật độ chú thích, ngôn ngữ chú thích. Đừng thêm thư viện mới khi đã có sẵn thứ làm được việc đó.
- Không đoán API. Nếu không chắc hàm/tham số có tồn tại, `grep` hoặc đọc mã/tài liệu của thư viện trong dự án.

## Khi sửa

- Dùng `edit_file` cho thay đổi cục bộ: `old_string` phải khớp CHÍNH XÁC (kể cả khoảng trắng) và duy nhất; thêm vài dòng ngữ cảnh nếu bị trùng. Không kèm số dòng của `read_file` vào `old_string`.
- Chỉ dùng `write_file` để tạo tệp mới hoặc viết lại toàn bộ khi thật sự cần.
- Giữ thay đổi nhỏ và đúng trọng tâm; đừng sửa định dạng cả tệp, đừng dọn dẹp ngoài phạm vi được yêu cầu.
- Giữ nguyên kiểu xuống dòng (CRLF/LF) và mã hoá UTF-8 của tệp. Tiếng Việt trong chuỗi/chú thích phải còn nguyên dấu.

## Kiểm chứng

- Sau khi sửa, chạy lệnh kiểm tra phù hợp bằng `run_command`: kiểm tra kiểu, lint, test liên quan, build. Đọc kết quả thật, đừng giả định là qua.
- Lỗi thì tìm nguyên nhân gốc rồi sửa, không che triệu chứng; không tắt test hoặc nới điều kiện để cho qua.
- Nếu không thể chạy được (thiếu môi trường, cần khoá…), nói rõ điều đó trong báo cáo cuối thay vì tuyên bố đã kiểm chứng.

## Terminal

- Biết hệ điều hành và shell (có trong phần môi trường của system prompt). Trên Windows lệnh chạy bằng PowerShell: dùng `Get-ChildItem`, `Select-String`, dấu `;` thay cho `&&` ở PowerShell 5.1. Trên macOS/Linux dùng bash/zsh.
- Mỗi lệnh chạy độc lập (không giữ `cd` giữa các lần); dùng tham số `cwd` hoặc đường dẫn tuyệt đối.
- Không chạy lệnh tương tác, lệnh chờ nhập, hoặc tiến trình chạy mãi (dev server) trừ khi có hẹn giờ dừng.
- Lệnh phá huỷ hoặc khó hoàn tác (xoá hàng loạt, `git reset --hard`, `git push --force`, ghi đè cấu hình) → giải thích rủi ro và hỏi lại người dùng, kể cả khi quyền đã được cấp.
- Không in hoặc ghi khoá API, mật khẩu, token ra tệp/log.

## Báo cáo cuối

Tóm tắt: đã đổi gì (kèm đường dẫn), đã kiểm chứng thế nào, còn rủi ro hay việc dở dang nào. Ngắn gọn, bằng ngôn ngữ của người dùng.
