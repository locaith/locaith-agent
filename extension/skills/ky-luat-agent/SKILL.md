---
name: ky-luat-agent
description: Kỷ luật làm việc khi chạy dài trong VS Code — biết mình còn bao nhiêu vòng, chốt việc trước khi cạn ngân sách, đồng bộ danh sách tác vụ với thực tế, không cắt giữa câu khi chạm trần đầu ra, viết lệnh đúng shell, phá vòng lặp công cụ. Dùng khi phiên đã dài trên 10 vòng, khi nhận thông điệp nhắc còn việc chưa xong, khi thấy mình sắp hết ngân sách hoặc sắp chạm trần đầu ra, khi một lệnh shell trả lỗi, hoặc khi cùng một công cụ đã gọi 3 lần mà kết quả không đổi. KHÔNG dùng cho câu hỏi ngắn một lượt.
tags: [kỷ luật, vòng lặp, ngân sách, todo, todo_write, shell, PowerShell, bash, chốt việc, bàn giao, hết vòng, lặp, run_command, JSON]
---

# Kỷ luật làm việc khi phiên đã dài

Sáu luật dưới đây không phải lời khuyên. Mỗi luật ứng với một lỗi đã đo được trên dữ liệu vận hành thật.

## 0. Trước khi làm bất cứ việc gì, đọc dòng ngân sách

Nếu trong ngữ cảnh có dòng dạng `[vòng 12/40 · còn 28 vòng]`, đó là **sự thật duy nhất** về việc bạn còn bao xa. Không có dòng đó thì bạn không biết — và không được đoán.

| Còn lại | Được làm | Không được làm |
|---|---|---|
| > 10 vòng | Mọi thứ | — |
| 4–10 vòng | Việc đã bắt đầu, sửa nhỏ, chạy test | Mở hạng mục mới |
| ≤ 3 vòng | Ghi/sửa tệp, chạy kiểm tra, chốt và bàn giao | `read_file` `grep` `glob` `list_dir` `fetch_url` `web_search` |

Khi còn ≤ 3 vòng, câu trả lời phải có đủ ba phần: **đã xong gì · còn lại gì · chạy tiếp bằng lệnh nào**.

## 1. Bị nhắc "còn việc chưa xong" thì phải gọi `todo_write`

Không được trả lời bằng cách thuật lại trạng thái. Thuật lại không làm danh sách đúng, nên lượt sau lại bị nhắc — dữ liệu có 59 lần nhắc liên tiếp trong một phiên.

Nếu bị nhắc **lần thứ hai trở đi**, cấm lặp lại câu cũ. Chọn một trong ba:
- gọi `todo_write` đưa danh sách về đúng thực tế — việc không làm được thì đặt `status: "blocked"` kèm `note` một dòng nói thiếu gì;
- nêu rõ vì sao không đóng được việc đó (thiếu quyết định của người dùng, thiếu quyền, thiếu dữ liệu);
- hỏi người dùng đúng một câu cụ thể để gỡ.

Đến lần nhắc thứ ba, harness tự đóng danh sách thay bạn (việc có vết ghi tệp/chạy lệnh → `completed`, còn lại → `blocked`) rồi dừng và báo người dùng. Đừng để tới đó.

## 2. Chạm trần đầu ra thì dừng ở ranh giới câu

Không bao giờ để câu cụt. Khi thấy mình sắp hết chỗ: kết thúc ở cuối câu hoặc cuối mục, thêm dòng `[tiếp phần 2/3]`, và nói rõ phần còn lại sẽ viết tiếp.

## 3. Câu trả lời cuối phải tự đứng được

Lượt kết thúc phải chứa kết quả thật: bảng, danh sách, kết luận, lệnh chạy tiếp. Cấm các câu `chi tiết ở trên`, `xem phần Worked for`, `như đã nói` thay cho nội dung.

## 4. Viết lệnh theo đúng shell

| Việc | PowerShell 5.1 (Windows) | bash/zsh (macOS, Linux) |
|---|---|---|
| Nối lệnh | `;` | `&&` |
| Tìm trong đầu ra | `Select-String 'mẫu'` | `grep 'mẫu'` |
| Liệt kê tệp | `Get-ChildItem -Recurse` | `find . -type f` |
| Biến môi trường | `$env:NAME` | `export NAME=` |
| Xoá | `Remove-Item -Recurse -Force` | `rm -rf` |
| Đổi thư mục | `Set-Location <đường dẫn>` | `cd <đường dẫn>` |

Trên Windows: **không** dùng `&&`, `||`, `grep`, `findstr` kiểu Unix, `export`, `/dev/null`. Đây là nguồn lỗi lớn nhất — 455/3.095 lần chạy lệnh trả lỗi (14,7%), gấp ~30 lần các công cụ khác.

Harness kiểm tra lệnh trước khi chạy: `a && b` đơn giản được tự đổi thành `a; if ($?) { b }` (ghi chú `[kiểm tra shell]` ở đầu kết quả cho biết lệnh thực sự đã chạy); dạng phức tạp bị chặn kèm hướng dẫn; các thói quen bash khác được gợi ý ngay cạnh lỗi. Đọc ghi chú đó và sửa đúng một lần, không thử biến thể.

## 5. Ba vòng cùng công cụ, kết quả không đổi thì đổi chiến lược

Dấu hiệu: cùng một lệnh, cùng mã thoát, cùng đầu ra — lần thứ ba. Thử lần thứ tư không thêm thông tin.

Đổi sang một trong ba:
- đọc mã nguồn trước khi thử tiếp;
- thu hẹp phạm vi (chạy một tệp test thay vì cả bộ);
- hỏi người dùng đúng một câu về điều đang giả định.

## 6. Không tuyên bố xong khi chưa xong

Bị dừng vì hết vòng, hết thời gian hay hết quota thì nói thật: **đã làm gì · còn lại gì · chạy tiếp thế nào**. Cấm `đã hoàn thành toàn bộ`, `tất cả đã xong` khi còn việc.

---

## Checklist trước khi kết thúc một lượt

Chạy trong đầu, đủ 6 câu mới kết thúc:

1. Danh sách tác vụ có khớp việc thật đã làm chưa? (nếu chưa → `todo_write`)
2. Câu trả lời có tự đứng được không, hay đang trỏ vào nội dung đã gập?
3. Có câu nào bị cắt giữa chừng không?
4. Nếu bị dừng giữa việc: đã nêu phần còn lại và cách chạy tiếp chưa?
5. Có con số nào mình chưa kiểm mà vẫn khẳng định không?
6. Lệnh vừa chạy có đúng shell không?

## Bảng tra nhanh: dấu hiệu → hành động

| Dấu hiệu | Hành động ngay |
|---|---|
| Ngữ cảnh có `[vòng N/M]`, còn ≤ 3 | Dừng khám phá, chốt và bàn giao |
| Nhận thông điệp nhắc todo | Gọi `todo_write`, không thuật lại trạng thái |
| Nhắc todo lần 2 trở đi | Không lặp câu cũ — hành động, giải thích, hoặc hỏi một câu |
| Sắp hết chỗ sinh | Dừng cuối câu + `[tiếp phần 2/3]` |
| Lệnh trả `Mã thoát: 1` vì cú pháp | Đổi sang cú pháp PowerShell, không thử biến thể nữa |
| Ba lần cùng công cụ, cùng kết quả | Đổi chiến lược: đọc mã, thu hẹp, hoặc hỏi |
| Được yêu cầu dừng giữa việc | Ba phần: đã xong · còn lại · chạy tiếp |
| Định tự ghép JSON có dấu nháy và xuống dòng | Dùng công cụ ghi tệp với nội dung thô |

## Điều không được làm

- Không bịa số vòng, số token, số tệp. Không biết thì nói không biết.
- Không đánh dấu việc xong cho đẹp danh sách.
- Không nhồi lại toàn bộ lịch sử vào câu trả lời để "đầy đủ" — người dùng cần kết quả, không cần bản ghi.
