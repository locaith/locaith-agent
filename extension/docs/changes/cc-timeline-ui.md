# cc-timeline-ui — Dòng thời gian gọn kiểu Claude Code (VS Code · Chrome · hợp đồng cho Remote)

Nhánh `parity/cc-timeline-ui`. Mảnh ghi chú để người điều phối ghép CHANGELOG. Đặc tả cho trang Remote: `docs/TIMELINE-SPEC.md`.

## Thay đổi nhìn thấy được

- **Dòng nhóm một dòng, chấm trạng thái**: mỗi cụm lệnh gọi công cụ (lượt đã xong hoặc đang chạy) là `● 22 lệnh gọi công cụ ⌄`; chấm xanh = mọi lệnh ok, **đỏ** = có lệnh lỗi («54 lệnh gọi công cụ · 2 lỗi»), xám nhấp nháy = đang chạy. «sửa N tệp» màu xanh ngọc vẫn giữ. Không còn biểu tượng, khung, thanh màu bên trái hay nền tô. Thời lượng ngắn ở bên phải («23 phút»). Bấm dòng (hoặc «Thu gọn» ở cuối) để mở/đóng.
- **Đang chạy**: «Đang chạy Lệnh · 10 lệnh gọi công cụ» + dòng phụ «Chạy nền» khi model đặt `run_in_background`/`background: true` cho lệnh.
- **Nhóm mở ra** = thanh dọc mảnh bên trái, mỗi bước một dòng: `● **Lệnh** mô tả…  1,8 s`, `● **Đọc** src/a.ts  120 dòng`, `● **Ghi** đường/dẫn/đầy/đủ  58 dòng`, `● **Sửa** đường/dẫn  +9 −3`. Mô tả ưu tiên đối số `description` do model đặt (bất kỳ công cụ nào), không có thì lệnh / đường dẫn / mẫu tìm. Đường dẫn màu liên kết, bấm mở tệp (VS Code). Bên trong nhóm mở không còn dòng tóm tắt trung gian; các nhóm «Đã đọc 5 tệp» / «Đã sửa 3 tệp» tự mở; từng khối suy nghĩ đứng đúng chỗ.
- **Ô IN / OUT** cho lệnh shell: nhãn IN + lệnh, nhãn OUT + đầu ra trong hộp tối; mỗi ô ~4 dòng, phần cắt mờ dần, bấm bung đủ / thu lại; đầu ra lỗi chữ đỏ (không nền đỏ); nút Sao chép khi rê chuột.
- **Xem trước tệp vừa ghi**: dưới dòng «Ghi» hiện 4 dòng đầu tô màu nhẹ, mờ dần; bấm xem đủ (≤ 400 dòng), Thu gọn ở cuối. «Sửa» giữ DiffView + «Mở diff trong editor».
- **«Đã suy nghĩ 14 giây»** thay cho «Suy nghĩ · ~842 token · 3 s»; đang nghĩ: «Đang suy nghĩ» có shimmer nhẹ (tắt khi giảm chuyển động), không dấu «…». Phiên cũ không có số giây → «Đã suy nghĩ». Ước lượng token chỉ còn ở tooltip.
- **Dòng nén ngữ cảnh**: chữ nghiêng xám «Đã nén cuộc trò chuyện · tự động · giải phóng 968k token ⌄», mở ra số liệu + phần tóm tắt giữ lại + Thu gọn (dữ liệu do lane ctx-compaction phát; bản cũ chỉ thấy chữ).
- **Dòng agent con**: `● mô tả…  **654,9k token · 249 lệnh** · 39 phút 54 giây`, luôn hiện ngay dưới dòng nhóm kể cả khi nhóm gập (như Claude Code); chấm xanh/đỏ/xám theo kết quả; đang chạy thì thời gian đếm sống và dòng hai là việc đang làm. Số của dòng nhóm giờ chỉ đếm lệnh **của lượt** (agent = 1 lệnh), số lệnh bên trong agent hiện trên dòng agent.
- **Giờ & ngày**: giờ nhỏ xám căn phải trên mỗi tin của bạn (24h theo tiếng Việt, 12h AM/PM theo tiếng Anh) và trên câu trả lời mở đầu sau một nhóm; **đường ngăn ngày dạng sóng** «T7, 07/11» / «Sat, Nov 7» khi sang ngày mới. Thiếu dấu thời gian thì không vẽ (không bịa).
- **Thông báo** mức info = chấm nhỏ + chữ nghiêng xám («Nghỉ 1 ngày 16 giờ…»); cảnh báo/lỗi nổi hơn nhưng không tô nền kín.
- **Tin của bạn**: ô thao tác góc trên-phải (`MessageActionSlot`) chứa nút sửa; chỗ để lane checkpoints-rewind gắn biểu tượng quay lại.
- **Nhãn đang chạy** cuối lượt: logo «Lo» nhỏ xoay nhẹ + **Đang xử lý** in đậm (bỏ ba robot nhún nhảy), không dấu «…».
- **Ô nhập khi đang chạy**: chip đồng hồ «⏱ 59m» (thời gian chạy của lượt) cạnh chip agent; placeholder «Xếp hàng tin nhắn khác…» / «Queue another message…» (bản Chrome chưa có hàng chờ giữ chữ cũ).
- Chân lượt trả lời gọn hơn: nút chép chỉ hiện khi rê chuột; số token vẫn còn.
- Bản Chrome/Edge dùng chung các thành phần này (không có nút mở tệp vì không có editor).

## Cách dùng

- Bấm vào dòng nhóm để xem từng bước; «Thu gọn» ở cuối thân để đóng tại chỗ. Trong nhóm mở, bấm ô IN/OUT hay khung xem trước để bung đủ.
- Model nên đặt `description` ngắn cho lệnh (`run_command`) để dòng đọc như «Lệnh  Chạy bộ kiểm thử» thay vì cả câu lệnh — bất kỳ công cụ nào có đối số chuỗi `description` đều được ưu tiên hiển thị.
- Cài đặt liên quan: không thêm cài đặt mới. `locaithAgent.ui.showThinking` (có sẵn) vẫn ẩn/hiện dòng suy nghĩ.

## Dữ liệu / Remote

- Sự kiện `thinking` có `ts` (engine đóng dấu, chung cho VS Code · Chrome · CLI); khối `thinking` có `startedAt`/`durationMs` tuỳ chọn; `sanitize.ts` giữ số hợp lệ, bỏ số lạ. Không thêm loại sự kiện/khối mới, `REMOTE_API_VERSION` giữ 1 — trang Remote cũ vẫn chạy, chỉ không vẽ thứ mới. Chi tiết: `docs/REMOTE-RELAY.md` (mục «Trường hiển thị tuỳ chọn») và `docs/TIMELINE-SPEC.md`.

## Kiểm thử / ảnh

- `npx vitest run test/thinkingDuration.test.ts test/webview/ccTimeline.test.ts test/webview/ccStyles.test.ts test/webview/parallelTimeline.test.ts test/compactNotice.test.ts test/remoteSanitize.test.ts`
- `node webview/dev/build.mjs && node webview/dev/shoot.mjs cc-` → `webview/dev/shots/cc-*.png` (có kiểm DOM: `assertCcCollapsed`, `expandCcGroup`, `assertCcWorking`); `node webview/dev/shoot.mjs parallel` (kiểm `assertParallel` đã cập nhật theo cách đếm mới). Cảnh harness: `cc-timeline`, `cc-working`; tham số mới `platform=browser`.

---

## English (short)

Timeline redesigned to match Claude Code's compact look: one line per group with a status dot (green ok / red failed / grey pulsing running), «N tool calls · M failed · K files changed», «Running Bash · N tool calls» + «Run in background»; expanded groups show one row per step (bold action name + description, path as a link) with IN/OUT boxes for shell commands (4-line clamp with fade, red text on error, hover copy), a 4-line syntax-highlighted preview for Write, DiffView for Edit; «Thought for 14s» (new optional `ts` on thinking events → `startedAt`/`durationMs` on the block, old sessions show «Thought»); italic compact-chat row with expandable summary; sub-agent rows always visible under a collapsed group with bold «654.9k tokens · 249 tools · 39m 54s»; small right-aligned timestamps and a wavy day divider; info notices as italic grey text; `MessageActionSlot` on user messages (for the rewind lane); bold «Working» label with the Lo logo; a run clock chip and «Queue another message…» placeholder while running. Shared by the Chrome build; Remote contract documented in `docs/TIMELINE-SPEC.md` (no new event/block types, API version unchanged).
