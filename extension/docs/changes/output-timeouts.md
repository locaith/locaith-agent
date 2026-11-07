# Trần đầu ra thích ứng · cắt đúng ranh giới · watchdog chống treo · dừng thì nói thật

Mảnh ghi chú của lane `output-timeouts` (H04, H05, B04, B08) để ghép vào CHANGELOG.

## Thay đổi nhìn thấy được

- **Câu trả lời dài bị chạm trần không còn đứt giữa câu.** Khi model chạm trần đầu ra, phần dở cuối cùng được lùi về hết câu/hết mục gần nhất (khối mã đang mở được đóng lại, hàng bảng dở bị bỏ), rồi hiện dòng `[tiếp phần 2]` ngay dưới. Trợ lý tự viết tiếp tối đa 2 lần với chỉ dẫn "viết tiếp phần N từ đúng chỗ dừng, không lặp phần trước"; nếu vẫn chưa hết thì hiện nút **«Chạy tiếp phần N»** dưới câu trả lời (một dòng gọn: chấm vàng · «Chưa xong» · nút) thay vì dừng im lặng. Bấm nút = gửi chỉ dẫn nối tiếp. Nút hiện ở VS Code, tab Remote trên locaith.ai và bản Chrome (đi qua `options` dùng chung).
- **Trần đầu ra theo loại việc** (cài đặt `locaithAgent.agent.adaptiveOutputTokens`, mặc định bật): lượt hỏi đáp / so sánh / sửa mã thường được 8.000 token; soạn báo cáo, tài liệu, bản đầy đủ, bài viết dài, hoặc đang viết tiếp phần bị cắt, hoặc lượt đã gọi công cụ ghi nội dung dài (write_file, create_artifact) → dùng trần tối đa. `locaithAgent.agent.maxOutputTokens` vẫn là **tối đa**, và mọi giá trị đều kẹp theo trần thật của model lấy từ danh mục (không còn một lượt gọi lỗi "max_tokens quá lớn" rồi mới hạ). Tắt cài đặt này = luôn dùng trần tối đa như trước.
- **Watchdog chống treo theo bậc** (`locaithAgent.agent.modelStallSeconds`, mặc định `auto`): nếu model im lặng quá ngưỡng — 20 s khi ngữ cảnh dưới 32k, 45 s tới 200k, 70 s tới 600k, 90 s hơn; nhân 1,5 ở mức suy luận medium, 2,5 ở high, 4 ở max/Swarm — thì chỉ lần gọi đó bị ngắt (khác với bấm Dừng), phần chữ đã viết được giữ, trợ lý tự thử lại đúng một lần với cùng lịch sử. Thời gian đứng hàng chờ của cổng Locaith (dải đếm ngược) và lúc nhà cung cấp chờ thử lại **không** tính. Lần thử lại cũng treo → chốt lượt bằng phần đã có, thông báo nói rõ "lỗi phía máy chủ/model, không phải lỗi của bạn" kèm ba phần Đã làm / Còn lại / Chạy tiếp, và nút **«Chạy tiếp»**. Đặt `0` để tắt, hoặc một số giây cố định (5–600). `locaithAgent.agent.modelCallMaxSeconds` (mặc định 600) là trần tổng thời gian hoạt động của một lần gọi.
- **Bị buộc dừng thì nói thật (ba phần).** Khi hết số vòng (`maxTurns`), lời nhắc tổng kết gửi model đòi đúng ba phần «Đã làm» / «Còn lại» / «Chạy tiếp bằng cách nào» và đính kèm vết thật do harness ghi (tệp đã sửa, lệnh đã chạy, việc chưa xong) — model không bịa "đã hoàn thành toàn bộ" được. Sau lượt tổng kết, khung chat hiện thêm một thông báo ba phần **tất định** dựng từ vết thật; nếu model vẫn nói "xong toàn bộ" khi danh sách còn việc, thông báo chỉ ra mâu thuẫn và bảo tin danh sách. Còn việc → có nút «Chạy tiếp». Lỗi nhà cung cấp sau khi đã làm việc cũng có thông báo này.

## Cài đặt liên quan

| Khoá | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `locaithAgent.agent.maxOutputTokens` | 32000 | Trần **tối đa** (giữ nguyên nghĩa) |
| `locaithAgent.agent.adaptiveOutputTokens` | `true` | Tự chọn 8k / trần đầy đủ theo loại việc mỗi lượt |
| `locaithAgent.agent.modelStallSeconds` | `"auto"` | Ngưỡng im lặng; `0` = tắt; số giây cố định 5–600 |
| `locaithAgent.agent.modelCallMaxSeconds` | 600 | Trần tổng thời gian hoạt động của một lần gọi model |

## Tương thích

- Phiên cũ mở bình thường: không có trường mới bắt buộc trong JSON đã lưu; nút «Chạy tiếp» dùng `session.options` sẵn có.
- Remote/Chrome: sự kiện `text` có thêm trường tuỳ chọn `trimTail` (bản cũ bỏ qua → chỉ không xoá mẩu câu dở); `SuggestionOption.kind = 'continue'` là trường tuỳ chọn (bản cũ vẽ như nút thường); snapshot/patch Remote mang thêm `options` (tuỳ chọn). Không có loại sự kiện / khối / mục mới.

## English (short)

- Replies that hit the output limit are cut at a sentence/list boundary (open code fences closed), marked `[continued in part N]`, auto-continued up to twice, then a compact **"Continue with part N"** button appears (VS Code, Remote on locaith.ai, Chrome).
- Per-turn adaptive output cap (`agent.adaptiveOutputTokens`, default on): 8,000 tokens for ordinary turns, the full `agent.maxOutputTokens` (clamped to the model's real limit from the catalog) for reports/long documents/continuations/after long-content tools.
- Tiered anti-hang watchdog (`agent.modelStallSeconds`, default `auto`: 20/45/70/90 s by context size × 1/1.5/2.5/4 by reasoning level; gateway queue time excluded): cancels only that model call, keeps the text, retries once with the same history; a second stall ends the turn with what was written, a clear "server/model problem, not you" notice with Done/Remaining/How-to-continue, and a **Continue** button. `agent.modelCallMaxSeconds` (600) caps one call's active time.
- Forced stops tell the truth: the wrap-up prompt demands exactly Done / Remaining / How to continue and includes the real trace; a deterministic three-part notice follows, flags "everything is done" claims that contradict the task list, and offers Continue when work remains.
