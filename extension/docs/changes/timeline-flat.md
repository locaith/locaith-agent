# Dòng thời gian bung ra: phẳng và sạch như Claude Code

Anh chê (07/11/2026, kèm ảnh so sánh): «Claude khi bung ra vẫn sạch sẽ hơn; của mình nhiều vạch quá, nhiều viền dọc quá».

- **Bỏ mọi thanh dọc và đường nối.** Trước đây bung một khối ra là có thanh dọc bên trái của khối quá trình, thêm một thanh nữa cho mỗi nhóm lồng («Việc: …», «Đã sửa N tệp»), thêm đường nối giữa các chấm và thanh 2 px của khối suy nghĩ. Nay không còn thanh nào: các chấm thẳng MỘT cột; nhóm lồng chỉ thụt nhẹ 14 px để thấy cấp. Cùng kiểu cho khối nén ngữ cảnh, «Kiểm tra độc lập», thanh «N tệp đã đổi», thẻ «Quay lại» và bảng tác vụ nền.
- **Lệnh và kết quả chung MỘT hộp** (nhãn IN/OUT nằm trong hộp; ô OUT đậm hơn một chút thay cho đường kẻ ngăn) thay cho hai hộp viền riêng; khung xem trước tệp viền mờ hơn.
- **«Thu gọn» chỉ còn là chữ nhỏ xám căn trái** (không khung, không đường kẻ ngang). Nhiều «Thu gọn» liền nhau ở cuối các khối lồng nhau thì chỉ hiện cái ngoài cùng (trước đây xếp ba cái chồng lên nhau).
- **Đường dẫn dài xuống dòng ở ranh giới thư mục** (`src/core/engine/` rồi `extensions/gate.ts`), không còn bẻ giữa từ («ex|tensions»).
- **Remote (locaith.ai) và bản Chrome/Edge** dùng đúng kiểu phẳng này (Remote: cùng quy tắc trong `timeline.css`, vùng bấm vẫn ≥ 40 px). Không thêm sự kiện hay trường dữ liệu nào.
- **Vòng hai sau khi hai người rà độc lập:** cột phải thẳng MỘT hàng (nút «mở tệp» ẩn từng chiếm 28 px nên chevron các hàng Đọc/Ghi/Sửa lệch với hàng Tìm/Lệnh — đã bỏ), chữ phụ bên phải xám chứ không đậm, thẻ diff không lặp tên tệp và «+a −b», «Thu gọn» đọc được và có vòng focus, tương phản cao/forced-colors vẫn thấy viền hộp IN/OUT và thẻ diff.
- **Chốt chặn:** `webview/dev/shoot.mjs` (121 cảnh) thất bại nếu bất kỳ phần tử nào trong dòng thời gian có viền trái MỘT BÊN; `test/webview/ccStyles.test.ts` kiểm CSS không còn `border-left` kiểu thanh dọc. Đặc tả cập nhật ở `docs/TIMELINE-SPEC.md`.

## English (short)

- Expanded blocks are now flat like Claude Code: no vertical rail on opened blocks or nested groups, no connector line between dots, no 2 px rail on thinking blocks; dots sit in one column, nested groups indent a little (14 px). Same for the compact-chat summary, the independent-check row, the change bar, the rewind card and the background-task panel; Remote on locaith.ai and the Chrome/Edge build share it.
- A command and its output share ONE box (OUT a shade darker); "Collapse" is a small grey text link, and only the outermost shows when several blocks end together; long paths wrap at folder boundaries.
- Second pass after two independent reviews: the right-hand column lines up on one edge (the hidden "open file" button no longer takes room), secondary text is grey not bold, the diff card no longer repeats the file name and +/− counts, "Collapse" is readable with a visible focus ring, and high-contrast / forced-colors themes keep an outline around the command box and diff card.
- Guard: the screenshot harness fails if any element in the timeline has a one-sided left border.
