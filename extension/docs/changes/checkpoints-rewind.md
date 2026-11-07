# Checkpoint, Quay lại và duyệt thay đổi (lane: checkpoints-rewind)

Mảnh để ghép vào CHANGELOG. Mỗi gạch đầu dòng là một thay đổi nhìn thấy được.

## Tiếng Việt

- **Checkpoint tự động.** Trước khi trợ lý ghi lần đầu vào một tệp trong một lượt, extension chụp bản gốc (hoặc ghi nhận «chưa tồn tại»). Mỗi lượt gắn với tin nhắn của bạn khởi động nó. Lưu trong thư mục dữ liệu của extension (`globalStorage/checkpoints`), giữ 30 lượt gần nhất mỗi cuộc trò chuyện và tối đa 14 ngày, tự dọn khi khởi động và khi xoá vĩnh viễn một cuộc trò chuyện. Tệp lớn hơn 2 MB hoặc không phải văn bản vẫn hiện trong danh sách nhưng ghi rõ «không hoàn tác được».
- **Thanh «N tệp đã đổi».** Sau mỗi lượt có sửa tệp, dưới câu trả lời có một dòng: `● 3 tệp đã đổi +68 −9 · Xem · Hoàn tác`. «Xem» mở danh sách (bấm tên tệp để mở diff của VS Code: bản gốc của lượt ↔ tệp hiện tại; có nút Thu gọn ở cuối). «Hoàn tác» (cả lượt hoặc từng tệp) hiện bản xem trước rồi mới ghi.
- **Quay lại điểm này.** Rê chuột vào một tin nhắn của bạn (trên màn cảm ứng luôn hiện) → «Quay lại điểm này» → chọn **Khôi phục mã**, **Khôi phục hội thoại** hoặc **Cả hai**. Bước xem trước liệt kê từng tệp sẽ đổi (+/− dòng, khôi phục / tạo lại / xoá) rồi bạn xác nhận.
  - *Khôi phục mã* đưa mọi tệp trợ lý đã sửa từ tin đó trở về sau về như trước tin đó; tệp trợ lý tạo mới bị xoá, tệp đã bị xoá được tạo lại.
  - *Khôi phục hội thoại* cắt cuộc trò chuyện về trước tin đó (lịch sử gửi cho model, transcript, danh sách việc đều quay về đúng lúc đó), đưa chữ của tin vào ô nhập để sửa/gửi lại. Phần đã bị nén ngữ cảnh thì không quay lại được và sẽ báo rõ.
  - *Cả hai* làm cả hai việc.
- **Không ghi đè mù.** Nếu bạn (hoặc một lệnh shell) đã sửa tệp sau khi trợ lý ghi, tệp đó được đánh dấu «đã sửa tiếp» ở bước xem trước, kèm cảnh báo; nút xác nhận đổi thành «Ghi đè và khôi phục». Chỉ những tệp bạn đã thấy cảnh báo mới bị ghi đè. Đường dẫn ngoài workspace (kể cả đi qua symlink) luôn bị từ chối.
- **Làm lại.** Sau khi khôi phục mã, thẻ kết quả có «Làm lại» để đưa các tệp về trạng thái trước khi khôi phục (một lần; bỏ qua tệp bạn đã sửa sau đó).
- **`/rewind`.** Mở thẻ ở cuối khung chat với danh sách tin gần đây (mới nhất chọn sẵn) để chọn điểm quay lại.
- **Remote (locaith.ai / điện thoại).** Thanh thay đổi và thẻ Quay lại đi qua giao thức Remote (`checkpoints`, `rewind` trong trạng thái; lệnh `rewind_open/plan/apply/cancel/redo`). Khôi phục mã từ xa chỉ chạy khi chế độ quyền là «Tự nhận sửa»/«Bỏ qua»; còn lại cần bạn xác nhận bằng hộp thoại tại VS Code. Mở diff chỉ làm được trong VS Code. Trang web Remote cần cập nhật bên repo web để hiển thị phần này; bản cũ bỏ qua các trường mới.
- **Cài đặt:** `locaithAgent.checkpoints.enabled` (mặc định bật). Tắt thì không chụp gì và ẩn mọi nút.
- **Giới hạn đã biết (giống Claude Code):** tệp do lệnh shell (`run_command`) sửa không được theo dõi; «Làm lại» chỉ nhớ trong phiên làm việc hiện tại của cửa sổ (tải lại cửa sổ thì mất khả năng làm lại, các checkpoint vẫn còn); cuộc trò chuyện cũ chưa có checkpoint thì ẩn nút; với «Khôi phục hội thoại» ảnh dán trong tin không được đưa lại vào ô nhập (giống «Sửa tin cuối»).

## English

- **Automatic checkpoints.** Before the assistant first writes a file in a turn, the original content (or “did not exist”) is snapshotted, keyed to the user message that started the turn. Stored under the extension's globalStorage, last 30 turns per conversation / 14 days; files over 2 MB or binary are listed but marked as not undoable. Files changed by shell commands are not tracked.
- **“N files changed” bar** after each turn that edited files: `3 files changed +68 −9 · View · Undo`. View lists files (click opens a VS Code diff, original ↔ current; Collapse at the bottom); Undo (whole turn or per file) previews before writing.
- **Rewind to this point** on every user message: Restore code / Restore conversation / Both, with a file-by-file preview and confirmation. Conversation restore cuts the model history, transcript and todos back to that moment and puts the text back in the input.
- **No blind overwrite:** files edited after the assistant wrote them are flagged and need an explicit “Overwrite and restore”; paths outside the workspace (including via symlinks) are refused.
- **Redo** once after a code restore; **`/rewind`** opens a picker of recent messages.
- **Remote:** change bar and rewind card travel through the Remote protocol; remote code restore needs “accept edits”/bypass mode, otherwise a modal confirmation at the VS Code window. Diff opening is VS Code only.
- **Setting:** `locaithAgent.checkpoints.enabled` (default on).
