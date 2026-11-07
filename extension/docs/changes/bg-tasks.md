# Tác vụ nền (lane bg-tasks)

- **Chạy lệnh dài ở nền.** `run_command` nhận `background: true`: trợ lý khởi chạy server dev, watcher hay bộ test dài rồi làm tiếp việc khác, không còn treo cả lượt tới hết giờ. Lệnh trả ngay mã tác vụ (`bg1`, `bg2`…) kèm vài dòng đầu ra (chờ tối đa ~1,5 giây để bắt lỗi khởi động như sai lệnh, cổng bận). Mỗi lần khởi chạy vẫn xin quyền như `run_command` thường, theo chế độ quyền và luật hiện hành.
- **Ba công cụ mới cho trợ lý.** `command_output {id, since?, wait_ms?, filter?}` đọc đầu ra MỚI theo con trỏ (kèm trạng thái đang chạy / mã thoát, lọc theo regex, chờ tối đa 120 giây); `command_stop {id}` dừng cả cây tiến trình theo PID (Windows `taskkill /T /F`, Linux/macOS cả nhóm tiến trình, không bao giờ giết theo tên); `command_list` liệt kê tác vụ của cuộc trò chuyện.
- **Báo "đã sẵn sàng".** Server dev in ra URL cục bộ (`http://localhost:5173`) hoặc câu "ready in / listening on…" thì tác vụ được đánh dấu sẵn sàng, trợ lý và người dùng đều thấy.
- **Trợ lý được báo khi tác vụ kết thúc.** Tác vụ tự thoát, bị lỗi hoặc bị bạn bấm Dừng → ở lần gọi mô hình kế tiếp, một tin gọn `[Tác vụ nền bg2 (npm test) đã kết thúc: exit 1 sau 42s. 20 dòng cuối: …]` được thêm vào lịch sử (một lần cho mỗi tác vụ, nhiều tác vụ gộp một tin). Tác vụ do chính trợ lý dừng hoặc đã đọc thấy kết thúc thì không báo lại.
- **Chip «N tác vụ nền» phía trên ô nhập.** Một dòng gọn (chấm xanh khi đang chạy, đỏ khi lỗi, xám khi đã xong). Bấm để mở: mỗi tác vụ có lệnh rút gọn, thời gian chạy, trạng thái, 5 dòng cuối đầu ra cập nhật sống, nút **Dừng**, **Sao chép đầu ra**, **Xem đầy đủ** (mở tab log trong editor); nút **Thu gọn** ở cuối. Cũng hiện qua Remote (locaith.ai chỉ được bấm Dừng).
- **Lệnh `/tasks`.** Liệt kê tác vụ nền của cuộc trò chuyện hiện tại: trạng thái, thời gian, địa chỉ sẵn sàng, lệnh.
- **Lệnh đồng bộ hết giờ chỉ đường sang chạy nền.** Khi `run_command` thường chạy quá giờ, kết quả gợi ý rõ "hãy chạy lại với `background:true`" (giữ nguyên cài đặt `locaithAgent.terminal.timeoutSeconds`).
- **Giới hạn và dọn dẹp.** Tối đa 8 tác vụ ĐANG CHẠY mỗi cuộc trò chuyện (giữ 20 tác vụ gần nhất để xem lại); bộ đệm mỗi tác vụ ≤ ~1 MB (giữ phần đầu và phần đuôi, phần giữa bị lược có đánh dấu). Tác vụ sống tiếp khi bạn chuyển sang cuộc trò chuyện khác; xoá cuộc trò chuyện, đóng khung chat hoặc tắt extension thì toàn bộ cây tiến trình bị dừng (có thêm lưới an toàn khi tiến trình extension thoát) — không để tiến trình mồ côi.
- **Windows.** Dùng cùng shell với lệnh thường (PowerShell 5.1, pwsh, cmd, Git Bash): đầu ra UTF-8 đọc đúng tiếng Việt, thư mục có dấu cách/tiếng Việt chạy được.
- Không có cài đặt mới. Bản Chrome không có tác vụ nền (không có tiến trình cục bộ), nên không hiện công cụ hay chip.

## English (short)

- `run_command` accepts `background: true` (dev servers, watchers, long builds): returns a task id (`bg1`…) at once with the first output; permission gate unchanged.
- New tools: `command_output` (incremental read by cursor, status/exit code, regex filter, optional wait), `command_stop` (kills the whole process tree by PID, never by name), `command_list`.
- The agent is told once, before the next model call, when a task ends or dies (last 20 lines, merged into one message). Server readiness (local URL / "ready") is detected.
- UI: a one-line "N background tasks" chip above the composer opens a compact panel (command, runtime, status, live last 5 lines, Stop / Copy output / View full output, Collapse). Mirrored to Remote (Stop only). `/tasks` slash command.
- Sync timeouts now suggest re-running with `background:true`. Limits: 8 running tasks per conversation, ~1 MB buffer each (head + tail), everything is killed on conversation delete / window close / deactivate. No new settings; the Chrome build has no background tasks.
