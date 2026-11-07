# Ngữ cảnh gọn mà không quên (lane ctx-compaction)

Mảnh ghi chú để điều phối ghép vào CHANGELOG. Mỗi gạch đầu dòng là một thay đổi người dùng NHÌN THẤY được.

- **Kết quả công cụ cũ được lược trước, tóm tắt sau.** Khi ngữ cảnh vượt 40% cửa sổ của model, các kết quả `read_file` / `run_command` / `grep`… cũ được thay bằng MỘT dòng giữ đủ thông tin để quyết định — tên công cụ, đường dẫn/lệnh, ok hay lỗi (kèm mã thoát), kích thước gốc và gợi ý gọi lại, ví dụ `[đã lược — read_file src/auth.ts · ok · 12,3k ký tự — gọi lại read_file src/auth.ts nếu cần]`. Lỗi và mã thoát luôn được giữ; 8 kết quả gần nhất và bước đang chờ trả lời không bao giờ bị lược; tin nhắn của bạn không bị đụng. Lược theo đợt (xuống còn ~30%) để không lắt nhắt mỗi vòng và giữ tiền tố ổn định cho prompt-cache. Trong khung chat hiện một dòng «Đã lược N kết quả công cụ cũ để giữ ngữ cảnh gọn — đọc lại được khi cần». Cài đặt: `locaithAgent.agent.clearToolResultsAtPercent` (mặc định 40; 0 = tắt).
- **Bản tóm tắt khi nén toàn bộ có cấu trúc cố định và không thể "quên" yêu cầu gốc.** Bảy mục: *Yêu cầu của người dùng (nguyên văn)* · *Đã đọc* · *Đã sửa/tạo* · *Đã chạy* · *Quyết định & lý do* · *Việc còn lại* · *Trạng thái todo*. Bốn mục đầu được dựng tất định từ vết các lệnh gọi công cụ (không nhờ model), nên dù model tóm tắt kém, yêu cầu gốc, tệp đã sửa và lệnh đã chạy (kèm mã thoát) vẫn còn nguyên. Lần nén sau mang nguyên văn yêu cầu từ lần nén trước đi tiếp. Danh sách việc và tệp đã tải lên vẫn được gắn lại nguyên vẹn như trước.
- **Giữ nguyên 20 tin nhắn gần nhất khi tóm tắt** (cài đặt `locaithAgent.agent.keepRecentMessages`, 4–200). Mốc cắt tự lùi về ranh giới hợp lệ nên không bao giờ tách đôi cặp gọi công cụ / kết quả; lần chạy dài chỉ có một tin người dùng rồi hàng chục vòng công cụ cũng nén được giữa chừng.
- **Trần tuyệt đối cho model cửa sổ rất lớn.** Với model có cửa sổ > 400k token và khi bạn KHÔNG tự đặt `compactAtPercent`, nén tự động diễn ra ở 300.000 token thay vì 80% cửa sổ (800k token làm mỗi lượt chậm gấp nhiều lần). Cửa sổ ≤ 400k giữ hành vi cũ. Tự đặt trần bằng `locaithAgent.agent.compactAtTokens` (0 = tự động); ngưỡng hiệu dụng = min(compactAtPercent × cửa sổ, trần).
- **`/compact <hướng dẫn>`**: gõ `/compact giữ lại chi tiết về auth` để bộ tóm tắt ưu tiên giữ những chi tiết đó. Không có hướng dẫn thì như cũ. Gọi `/compact` lần nữa khi chỉ còn bản tóm tắt sẽ báo «Không có gì để nén» thay vì tóm tắt lại bản tóm tắt.
- **Dòng thông báo nén có số liệu thật**: «Đã nén cuộc trò chuyện · tự động / thủ công / tràn ngữ cảnh · giải phóng 968k token». Số token giải phóng = ước lượng trước − sau (cùng một thước đo), không bịa. Thông báo mang thêm số tin đã tóm tắt, số kết quả đã lược và bản tóm tắt (cắt 1500 ký tự) để giao diện mở ra xem; đi qua Remote (locaith.ai) và bản Chrome bằng trường tuỳ chọn của thông báo sẵn có — bản cũ chỉ thấy dòng chữ, không hỏng.
- **Thanh đo ngữ cảnh có thêm số liệu**: phần trăm đã dùng, số kết quả đã lược và số lần nén trong phiên (`ViewState.context.percent / clearedResults / compactions`), được lọc kích thước trước khi ra Remote. Phần vẽ do lane sessions-ux làm.

Cài đặt mới (mặc định an toàn, chèn ngay sau `compactAtPercent`): `agent.compactAtTokens` (0), `agent.clearToolResultsAtPercent` (40), `agent.keepRecentMessages` (20). Phiên cũ mở bình thường: mọi trường mới là tuỳ chọn.

## English (short)

- Old tool results are **cleared before** the chat is summarized: past 40% of the window, old `read_file`/`run_command` results become one line (tool, path/command, ok or error with exit code, original size, "call again" hint). Errors are kept, the 8 most recent results and the pending step are never touched, clearing runs in batches down to ~30%. Setting `locaithAgent.agent.clearToolResultsAtPercent` (default 40, 0 = off). Timeline line: "Trimmed N old tool results to keep the context lean — re-readable when needed".
- Full compaction uses a **fixed structured summary**: user requests (verbatim) · read · edited/created · ran · decisions & reasons · remaining work · todo state. The first four are built deterministically from the tool trace, so a weak summarizer cannot lose them; later compactions carry the verbatim requests forward.
- **`keepRecentMessages`** (default 20) are kept verbatim; the cut never splits a tool call from its result.
- **Absolute cap** for huge windows: models above 400k compact at 300k tokens unless you set `compactAtPercent` yourself; `agent.compactAtTokens` sets your own cap (0 = auto).
- **`/compact <instructions>`** feeds your focus into the summarizer prompt.
- The compaction notice carries real numbers: "Compacted chat · auto · 968k tokens freed" (+ summarized messages, cleared results, summary excerpt) and reaches Remote/Chrome through an optional field of the existing notice. `ViewState.context` gains `percent`, `clearedResults`, `compactions` for the context meter.

## Sửa sau kiểm chứng
- Nén lần 2 trở đi vẫn giữ danh sách «Đã đọc / Đã sửa/tạo / Đã chạy» của các đoạn đã nén trước đó (không chỉ yêu cầu nguyên văn).
- Phần «Yêu cầu nguyên văn» có trần theo cửa sổ ngữ cảnh (10%): yêu cầu đầu tiên và các yêu cầu mới nhất giữ nguyên văn, đoạn giữa rút còn 200 ký tự.
- `clearToolResultsAtPercent = 0` thật sự tắt việc lược, kể cả khi `/compact` hoặc nén tự động.
- Số «giải phóng N token» dùng một thước đo ước lượng cho cả trước lẫn sau.
- Giữa vòng công cụ: giữ khối suy luận của bước đang chờ kết quả; nhà cung cấp Anthropic hoãn việc lược tới ranh giới lượt.
- Bản Chrome/Edge: thanh đo ngữ cảnh có đủ số liệu lược/nén, `/compact <giữ lại gì>`, cập nhật sau khi nén. Bộ đếm lược/nén sống sót qua lưu/mở lại phiên.

Fixes after verification (EN): carry-forward of read/edited/ran lists across compactions, window-relative cap on verbatim requests, `clearToolResultsAtPercent=0` truly disables clearing, single-measure `tokensFreed`, pending thinking preserved mid tool loop, browser parity, persisted context counters.
