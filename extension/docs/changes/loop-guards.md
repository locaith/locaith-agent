# Chốt chặn vòng lặp bằng máy (lane: loop-guards)

Những gì người dùng NHÌN THẤY khác so với bản trước. Mọi thứ đều đi qua các sự kiện/khối sẵn có (dòng công cụ lỗi, thông báo trong khung chat, danh sách việc) nên hiện giống nhau ở VS Code, Remote (locaith.ai) và bản Chrome — không có kênh riêng, không có kiểu khối mới.

- **Cạn vòng thì không tìm hiểu thêm.** Khi còn ≤ 3 vòng (dòng `[vòng N/M · còn K vòng — CHỐT VIỆC]`), các công cụ khám phá (`read_file`, `grep`, `glob`, `list_dir`, `fetch_url`, `web_search`, công cụ MCP chỉ đọc) không chạy nữa — dòng công cụ hiện lỗi `[hết ngân sách vòng]` kèm lời dặn chốt ba phần (đã xong · còn lại · chạy tiếp bằng gì). Ghi/sửa tệp, chạy lệnh kiểm tra, `todo_write`, `remember` vẫn được. Lượt chưa ghi/chạy gì thì vẫn được **một** lần đọc ân hạn (kết quả mở đầu bằng `[sắp hết ngân sách]`). Cài đặt: `locaithAgent.agent.budgetGuard` (mặc định bật).

- **Nhắc việc dở tối đa 3 lần, rồi tự chốt.** Lần 1: lời nhắc kèm trạng thái THẬT từng việc (`[~] đang làm; [ ] chưa làm; [!] bị chặn (lý do)`). Lần 2: `[nhắc lần 2]` yêu cầu làm KHÁC — gọi `todo_write`, hoặc nói rõ việc nào không đóng được, hoặc hỏi đúng một câu. Lần 3: không nhắc nữa — engine tự đóng danh sách theo vết chạy (việc có tệp ghi / lệnh chạy khớp tên → hoàn thành; việc còn lại → **bị chặn** kèm lý do), rồi dừng và báo một dòng cảnh báo trong khung chat: *«Đã nhắc 2 lần nhưng vẫn còn việc chưa xong: … — đã đánh dấu «bị chặn»…»*. Nhắn «tiếp tục» để làm nốt.
  - Danh sách việc có thêm trạng thái `blocked` + `note` (lý do). Model cũng tự đặt được qua `todo_write` khi thật sự bị kẹt. Phiên cũ mở bình thường (trường tuỳ chọn). Trên Remote, trạng thái này hiện là «chưa làm» với lý do nối vào tên việc (để trang web bản cũ không hỏng).

- **Câu trả lời cuối phải tự đứng được.** Sau một lượt dùng công cụ mà câu kết lại là «chi tiết ở trên», «như đã nói», «xem phần Worked for», «see above»… hoặc quá ngắn sau ≥ 6 lệnh công cụ, trợ lý bị nhắc một lần viết lại đầy đủ (bảng/danh sách/kết luận, bằng chứng, việc còn lại). Lần nhắc này tính chung vào ngân sách 3 lần của cổng hoàn thành — không bao giờ làm tăng số lần nhắc.

- **Lệnh shell được kiểm tra trước khi chạy, theo shell thật của máy.** Trên Windows PowerShell 5.1: `a && b` / `a || b` đơn giản được tự đổi thành `a; if ($?) { b }` (thẻ xin quyền và dòng công cụ hiện lệnh đã đổi; đầu kết quả có `[kiểm tra shell] Đã tự đổi…`); dạng phức tạp (trộn `&&`/`||`, nhiều dòng, trong ngoặc) bị chặn kèm hướng dẫn, không chạy. Các thói quen bash khác (`grep`, `head/tail`, `export`, `rm -rf`, `ls -la`, `mkdir -p`, `curl -s`, `/dev/null`, heredoc, `2>&1`…) chỉ được **gợi ý** ở đầu kết quả — lệnh vẫn chạy, không cản nhầm. Trên bash/zsh và cmd.exe thì ngược lại (cmdlet PowerShell, `$env:`, `%VAR%`…). Chuỗi nháy, here-string, chú thích, regex không bị đụng. Cài đặt: `locaithAgent.agent.shellCheck` = `rewrite` (mặc định) · `hint` (chỉ gợi ý, không đổi lệnh) · `off`.

- **Phá vòng lặp theo kết quả.** Cùng một công cụ trả cùng một kết quả 3 lần liên tiếp (dù đối số hơi khác: thêm `./`, đổi khoảng trắng) → cuối kết quả có `[phá vòng lặp] … đổi chiến lược`; lần thứ 4 gần y hệt bị chặn (dòng công cụ lỗi). Ghi tệp hay thao tác lên trang web xoá chuỗi đếm (đọc lại sau khi sửa là chính đáng). `todo_write`, `scratchpad`, công cụ trang web đang cuộn… không bị tính. Cài đặt: `locaithAgent.agent.loopBreaker` (mặc định bật).

- **Đối số JSON hỏng được sửa nhẹ khi chắc chắn.** Dấu phẩy thừa, xuống dòng/tab thật trong chuỗi → tự sửa và chạy (không thấy gì khác). Thiếu ngoặc đóng chỉ sửa khi đầu ra KHÔNG bị cắt; nội dung cụt vì chạm trần đầu ra không bao giờ được chạy. Khi vẫn hỏng, lỗi hướng dẫn rõ «dùng write_file với nội dung thô»; lần hỏng thứ 2 liên tiếp nói mạnh hơn.

- **Kỹ năng `ky-luat-agent`** (kỷ luật khi chạy dài) có sẵn trong kho kỹ năng, nạp khi cần (`load_skill ky-luat-agent`), không tự nạp mỗi lượt. Điều 8 của hiến pháp đã rà khớp 8 quy tắc ngắn (gọi `todo_write` khi bị nhắc, `[tiếp phần 2/3]`, không grep/findstr kiểu Unix trên Windows, chiều ngược lại cho macOS/Linux).

Cài đặt mới (đều có mô tả vi/en trong Settings): `locaithAgent.agent.budgetGuard`, `locaithAgent.agent.shellCheck`, `locaithAgent.agent.loopBreaker`.

---

## English (short)

- **Budget guard:** with ≤ 3 turns left, exploratory tools (read/grep/glob/list/fetch/search/read-only MCP) are refused with a wrap-up instruction; writes, commands, `todo_write`, `remember` still run; one grace read if nothing was written/run yet. Setting `agent.budgetGuard`.
- **Todo reminders capped at 3:** 1st shows real statuses, 2nd demands a different action, 3rd auto-closes the list from the run trace (evidence → completed, rest → `blocked` + note) and stops with one warning. New optional todo status `blocked`/`note`; downgraded to `pending` for Remote.
- **Self-standing final answer:** "see above"/too-short endings after tool-heavy runs get one rewrite reminder, counted in the same 3-nudge budget.
- **Shell check** before `run_command` against the real shell: simple `&&`/`||` on Windows PowerShell 5.1 rewritten to `a; if ($?) { b }`, complex forms blocked with guidance, other bash habits only hinted; reverse checks for bash/zsh/cmd. Setting `agent.shellCheck` = `rewrite` | `hint` | `off`.
- **Result-based loop breaker:** same tool, same result 3× (even with slightly different args) → strategy note; 4th near-identical call blocked. Setting `agent.loopBreaker`.
- **JSON argument repair** for unambiguous cases (trailing commas, raw newlines; missing closers only when output was not truncated); clearer, escalating guidance otherwise.
- Bundled skill `ky-luat-agent` (not auto-loaded); constitution rule 8 aligned with the eight short rules.
