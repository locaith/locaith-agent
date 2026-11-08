# Vòng góp ý thứ hai của bạn Huân (0.7.2) / Round-two feedback (0.7.2)

Nhánh `feat/v072-fixes`. Bốn việc, theo thứ tự ưu tiên. Không sửa `CHANGELOG.md` (điều phối viên ghi khi phát hành).
Branch `feat/v072-fixes`. Four items, in priority order. `CHANGELOG.md` is untouched (the release coordinator writes it).

## 1. Mở tệp ngoài workspace / Open files outside the workspace

**vi.** Bấm liên kết tệp trong chat giờ mở được tệp thật kể cả ngoài workspace (trước đây: «Chỉ mở được tệp trong workspace.», nên «không mở được file .md dù trong VS Code»).
- Logic phân loại là hàm THUẦN `src/core/fsutil/openTarget.ts` (`openCandidates`, `classifyOpenTarget`), có test `test/openFileTarget.test.ts`.
- Hỗ trợ `~`, `file://` (kể cả `%20`), đường dẫn tương đối tính theo MỌI gốc workspace rồi tới thư mục nhà, dạng Git Bash `/c/Users/...`.
- Tệp nhạy cảm NGOÀI workspace (`.env`, khoá riêng `.pem/.key`, `id_rsa`, `credentials`, thư mục `.ssh/.aws/.gnupg/.kube`) → hộp xác nhận modal «Mở tệp nhạy cảm ngoài workspace?». Tính theo đường dẫn THẬT (symlink trong workspace trỏ ra tệp nhạy cảm cũng bị hỏi).
- Tài liệu/media (pdf, docx, xlsx, mp4…) mở bằng ứng dụng hệ thống; tệp nhị phân chạy được/nén (exe, dll, zip…) chỉ hiện trong thư mục chứa nó (không bao giờ tự mở); đuôi lạ → nhìn 4 KB đầu, có byte NUL = nhị phân.
- Thư mục → «… là thư mục, không phải tệp.»; không thấy → «Không thấy tệp …» (hết câu «Chỉ mở được tệp trong workspace»).
- An toàn: đường dẫn mạng UNC (`\\máy\...`, `//máy/...`), thiết bị (`\\?\`), luồng dữ liệu thay thế NTFS bị từ chối trước khi chạm đĩa (stat UNC làm Windows gửi thông tin NTLM). Remote không gọi được `open_file` (không nằm trong danh sách lệnh từ xa).
- `parseFileRef` đã kiểm: nhận `C:\Users\Anh Tuấn\bản giao.md:12`, `C:/…/x.md#L5`, `~/x.md`, `~/tài liệu/bản giao.md:3`.

**en.** Clicking a file link in chat now opens the real file even outside the workspace. Pure classifier in `src/core/fsutil/openTarget.ts`; sensitive files outside the workspace ask for a modal confirmation; documents/media open in the OS app; runnable binaries/archives are only revealed in their folder; UNC/device/NTFS-stream paths are rejected before touching the disk. Clear errors: "File not found: …" / "… is a folder, not a file."

## 2. HTML mặc định mở bằng trình duyệt / HTML opens in the browser by default

**vi.** Cài đặt mới `locaithAgent.artifacts.htmlOpenIn` (`browser` | `vscode`, MẶC ĐỊNH `browser`, scope machine, chỉ đọc từ cài đặt người dùng như `autoOpen`).
- Thẻ artifact HTML: nút chính «Mở trong trình duyệt», nút phụ «Xem trước trong VS Code». Đặt `vscode` thì về như cũ («Mở xem trước» + «Mở trong trình duyệt»). SVG/Markdown/dashboard giữ xem trước trong VS Code. Bản Chrome/Edge không đổi (chỉ «Mở xem trước»).
- `artifacts.autoOpen` vẫn quyết định CÓ tự mở không (`static` chỉ SVG/Markdown, `always` cả HTML, `browser` kiểu cũ: mọi loại bằng trình duyệt); HTML tự mở theo `htmlOpenIn`. Nhà cung cấp demo luôn xem trước trong VS Code.
- Hàm thuần `src/shared/artifactOpen.ts` (`primaryArtifactTarget`, `autoOpenTarget`); cờ đi theo `UiSettings.htmlOpenIn` xuống webview. Test: `test/artifactOpen.test.ts`.

**en.** New setting `locaithAgent.artifacts.htmlOpenIn` (default `browser`). HTML cards get «Open in browser» as the primary button and «Preview in VS Code» as secondary; auto-open of HTML follows the setting; SVG/Markdown unchanged.

## 3. Bảng lựa chọn cuối hội thoại + «Tất cả» / End-of-conversation options + "All"

**vi.** `OptionsBar` vẽ NGAY SAU lượt trả lời cuối ở cuối dòng hội thoại (trong `ChatView`, cuộn cùng nội dung), không còn ở chân khung trên ô nhập. Có ≥ 2 lựa chọn «hướng đi» (không áp cho kiểu `continue`) thì tự thêm chip «Tất cả»/«All»: bấm → gửi MỘT tin «Làm tất cả các hướng sau, theo thứ tự hợp lý, rồi báo kết quả từng hướng: 1) <nhãn> — <prompt> 2) …» (mỗi prompt cắt ≤ 420 ký tự, tổng ≤ ~3 200). Chip do giao diện tự sinh, không đổi giao thức nên Remote/Chrome tự có. Vẫn ẩn được bằng «×». Biến thể trong hội thoại PHẲNG (không khung kín/nền, không vạch dọc). Mô hình thuần: `webview/src/optionsModel.ts`.
Trung thực: `offer_options` chỉ dùng khi yêu cầu mơ hồ nên bảng này ít khi xuất hiện.
Harness: cảnh `options-directions`; ảnh `options-all-{dark-420,light-420,dark-300,en-light-320}`, `options-continue-inline-dark-420`, kiểm DOM trong `shoot.mjs` (`assertOptions`). Test: `test/webview/optionsInline.test.ts`.

**en.** The options bar is now rendered inside the timeline right after the last answer (no longer in the footer); ≥ 2 "direction" options add an auto-generated "All" chip that sends one combined message. Flat look, closable, no protocol change.

## 4. Dọn dẹp bộ nhớ / Storage cleanup

**vi.** Bằng chứng: thư mục phiên 113 MB, một cuộc 69 MB trong đó ~68 MB là ảnh base64, mỗi ảnh nằm hai nơi (`session.messages` cho model + transcript hiển thị).

- **a. Thu nhỏ ảnh khi đính kèm.** `src/shared/imageShrink.ts` (kế hoạch thuần, có test) + `webview/src/imageShrink.ts` (canvas). Cạnh dài ≤ 1568 px; ảnh lớn không trong suốt nén JPEG q0,85 (>400 KB); giữ PNG nếu nhỏ hoặc có alpha; GIF giữ nguyên; lỗi giải mã → ảnh gốc. Ảnh đầu vào tối đa 25 MB, sau thu nhỏ vẫn ≤ 5 MB (host từ chối ảnh lớn hơn).
- **b. Transcript chỉ giữ bản xem trước nhỏ.** Ảnh đính kèm: `thumb` ≤ 480 px, ~≤ 60 KB (chế độ nhẹ: 320 px, ~30 KB); `trimTranscriptForStorage` bỏ mọi `data` đầy đủ lọt vào transcript và `thumb` quá nặng. Ảnh do công cụ trả về (kể cả `show_before_after`, tối đa 3 triệu ký tự mỗi ảnh) vượt ~300 KB (`toolImageMaxChars` = 400 000 ký tự base64) thì không ghi vào transcript; thẻ «Trước | Sau» tra lại ảnh theo đường dẫn trong đối số khi mở phiên (đã có sẵn). `session.messages` giữ ảnh đầy đủ cho model. Trường mới đều tuỳ chọn; phiên cũ mở bình thường, không tự ghi đè khi mở.
- **c. Thẻ «Dọn dẹp bộ nhớ»** trong Cài đặt (chỉ VS Code): dung lượng phiên / Thùng rác / điểm quay lại / số ảnh; bốn nút: «Xoá ảnh khỏi cuộc trò chuyện cũ hơn N ngày (giữ chữ)», «Chuyển cuộc trò chuyện cũ hơn N ngày vào Thùng rác», «Dọn Thùng rác», «Dọn điểm quay lại cũ hơn N ngày». Webview chỉ gửi `cleanup_run`; HOST hỏi xác nhận modal có ghi số lượng + dung lượng sẽ giải phóng (`src/host/cleanup.ts`). Cuộc đang mở ở BẤT KỲ khung chat nào, cuộc đã ghim (khi chuyển Thùng rác) không bị đụng. Lệnh `locaithAgent.cleanup` mở thẻ này. Cài đặt `locaithAgent.history.autoCleanImagesDays` (0 = tắt, mặc định) tự xoá ảnh cũ ở nền 30 giây sau khi khởi động (chỉ ảnh, luôn giữ chữ, bỏ qua cuộc đang mở).
- **d. Chế độ nhẹ** `locaithAgent.ui.liteMode` (mặc định false; có công tắc trong Cài đặt): lớp `lite` trên `<html>` tắt hoạt cảnh/shimmer/quầng sáng/filter (vòng xoay «đang chạy» vẫn quay chậm); không tự xem trước media (nút «Xem trước» thay thế); transcript chỉ lưu xem trước nhỏ và không lưu ảnh công cụ. Cờ đi theo `UiSettings.liteMode` (lane actor đọc `settings.liteMode`).
- **e. `agent.maxImagesInContext`** (mặc định 8, 0 = không giới hạn): ảnh cũ ngoài N ảnh gần nhất thành «[ảnh đã lược để giữ ngữ cảnh gọn]» TRONG BẢN GỬI (`src/core/engine/imageContext.ts`); lịch sử lưu giữ nguyên; kết quả công cụ chỉ mất `images`, cặp tool_use/tool_result nguyên vẹn. Đánh đổi: mỗi ảnh mới vượt ngưỡng làm đoạn đầu lịch sử đổi một lần (hỏng bộ nhớ đệm prompt một lần).

Hạn chế đã biết: (1) host (Node) không có canvas nên KHÔNG thu nhỏ được ảnh vào qua đường khác ngoài ô nhập của webview (ảnh từ Remote/điện thoại, ảnh công cụ như chụp màn hình trong `session.messages`) — chúng vẫn được lược khỏi bản gửi (e), bỏ khỏi transcript (b) và xoá theo yêu cầu (c). (2) Bộ lọc «cũ hơn N ngày» dựa vào `updatedAt` của cuộc. (3) «Chuyển vào Thùng rác» và «Dọn Thùng rác» chỉ tính cuộc của thư mục làm việc hiện tại (Thùng rác vốn theo thư mục); số «cuộc trò chuyện» và «ảnh» trong thẻ tính cả kho.
Test: `test/imageCleanup.test.ts` (kho giả trong bộ nhớ + thư mục tạm, không đụng dữ liệu thật), `test/imageShrink.test.ts`, `test/imageContext.test.ts`. Harness: `cleanup-{click-dark-420,dark-420,light-320,en-hc-420}`, `lite-media-dark-420`.

**en.** Images are now shrunk when attached (long edge ≤ 1568 px, JPEG q0.85 for large opaque images), the transcript stores only a small preview (≤ 480 px / ~60 KB), a new "Clean up storage" card in Settings (command `locaithAgent.cleanup`) shows usage and offers four cleanups, each confirmed by a host modal that states the space to be freed (open conversations never touched; deleting conversations goes through the Trash). `history.autoCleanImagesDays` (0 = off) removes old images in the background (text always kept). `ui.liteMode` turns effects and auto media preview off and stores only small previews. `agent.maxImagesInContext` (default 8) replaces older images with a text note in the outgoing request only (history unchanged). Known limit: the Node host has no canvas, so images that do not enter via the webview composer (Remote/phone uploads, tool screenshots) are not shrunk — they are trimmed from the request, dropped from the transcript above the size cap, and removable via the cleanup card.
