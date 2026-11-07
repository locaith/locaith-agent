# Ngữ cảnh IDE: chẩn đoán lỗi, @tệp#dòng, vùng chọn (lane ide-context)

## Tiếng Việt

- **Công cụ `get_diagnostics`** (chỉ trong VS Code): trợ lý đọc được lỗi/cảnh báo mà language server (TypeScript, ESLint, Pylance…) đang báo, dạng `src/a.ts:12:5 error [ts 2304] …`, lỗi xếp trước, chỉ tệp trong workspace, có trần số mục. Ở bản Chrome/CLI công cụ không xuất hiện.
- **Tự báo lỗi mới sau khi sửa tệp**: sau `edit_file`/`write_file` thành công, trợ lý chờ language server ~1 giây rồi nhận ghi chú «Sau khi sửa, VS Code báo 2 lỗi mới ở …» (chỉ lỗi MỚI của đúng tệp vừa sửa, không báo lại lỗi có từ trước). Cài đặt `locaithAgent.agent.editDiagnostics`: `errors` (mặc định) | `all` (cả cảnh báo) | `off`. Hiến pháp của trợ lý nhắc phải sửa lỗi còn tồn trước khi báo xong.
- **`@tệp#L10-20`** trong ô nhập: gõ `@`, chọn tệp rồi gõ `#L10-20` (hoặc `#L10`). Chip đổi thành `a.ts:10–20`; trợ lý nhận đúng các dòng đó kèm số dòng. Dòng ngoài tệp thì báo rõ và không đính kèm; tối đa 2000 dòng một nhắc (phần dư kèm gợi ý `read_file offset=…`); tệp bí mật (`.env`, khoá) không tự đính kèm từ chữ; ngoài workspace bị từ chối. Tin gửi từ Remote hoặc Chrome chỉ có chữ `@tệp#L10-20` vẫn được giải mã.
- **`@problems`**: đính kèm lỗi/cảnh báo hiện tại của VS Code (hiện đầu menu `@`). Lệnh **`/problems`** xem ngay danh sách đó trong khung chat mà không tốn lượt model.
- **Thêm vùng chọn vào chat** (`Alt+Ctrl+K` khi đang chọn mã, hoặc menu chuột phải): thêm chip vùng chọn có khoảng dòng, không dán cả đoạn. Số dòng chọn nay đúng khi bôi trọn dòng (trước đây thừa một dòng khi vùng chọn kết thúc ở đầu dòng kế).
- **Chip «Đang xem …»** ở ô nhập là công tắc: bấm để ngừng gửi kèm tệp đang mở và vùng chọn (chip mờ, gạch ngang); bấm lại để bật. Cài đặt tương ứng: `locaithAgent.context.editor` (mặc định bật). Vùng chọn luôn lấy lúc gửi, không dùng vùng chọn cũ.
- Tham chiếu `đường/dẫn:dòng`, `:dòng:cột`, `:dòng-dòng`, `#L10-L20` trong câu trả lời bấm mở đúng dòng, kể cả đường dẫn có dấu cách.
- Lệnh mới `/problems`; công tắc mới `locaithAgent.agent.editDiagnostics`, `locaithAgent.context.editor`.

## English (short)

- New `get_diagnostics` tool (VS Code only) returning language-server errors/warnings; after `edit_file`/`write_file` the assistant is told about NEW errors in the edited file (`locaithAgent.agent.editDiagnostics`: errors | all | off).
- `@path#L10-20` mentions in the composer (chip `a.ts:10–20`, numbered lines, range-checked, capped at 2000 lines, workspace-only, secrets not auto-attached from text); `@problems` attaches current diagnostics; `/problems` shows them in the chat.
- "Add selection to chat" (Alt+Ctrl+K) adds a line-range chip; selected line numbers are now exact for whole-line selections.
- The "Viewing …" chip toggles sending the active file/selection (`locaithAgent.context.editor`).
- `path:line`, `path:line:col`, `path:10-20`, `path#L10-L20` references in replies open at the right line.
