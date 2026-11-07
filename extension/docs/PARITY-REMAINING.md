# Phần còn lại của đợt «ngang Claude Code» — việc giao cho Locaith-v5-SI

Cập nhật 07/11/2026, sau khi gộp 14 lane vào bản **0.7.0** (xem `CHANGELOG.md`, `docs/changes/*.md`). Tệp này là bản giao việc **tự đứng được**: đọc xong là làm được, không cần lịch sử phiên của người giao.

## 0. Cách làm việc ở repo này (rút từ 14 lane vừa làm — vi phạm là hỏng đường gộp hoặc hỏng Remote)

1. **Logic mới đặt trong TỆP MỚI.** Các tệp trục (`engine.ts`, `dispatcher.ts`, `chatController.ts`, `protocol.ts`, `App.tsx`, `config.ts`, `package.json`, `strings.ts`, `i18n.ts`, `constitution.md`) chỉ sửa bằng đoạn nhỏ có chú thích `(lane:tên)`. Gắn vào engine qua `RunExtension` (`src/core/engine/seams.ts`, danh sách ở `src/core/engine/extensions/index.ts` và `src/host/hostExtensions.ts`), vào lệnh gạch chéo qua `SlashRegistry` (`src/host/slashRegistry.ts`).
2. `core/` và `shared/` KHÔNG import `vscode` hay `node:*` ở tệp bản Chrome/CLI dùng chung; `npm run build:browser` phải xanh.
3. **Hai ngôn ngữ** cho mọi chuỗi người dùng thấy (vi có dấu đầy đủ + en): `strings.ts`, `webview/src/i18n.ts`, `package.nls.json` + `package.nls.en.json`.
4. **Giao diện gọn kiểu Claude Code:** thứ mới trong dòng thời gian = MỘT dòng (chấm trạng thái + nhãn xám nhạt + mũi tên mở); không khung kín, không tô nền, không «…» thừa; mở ra thì thanh dọc mảnh bên trái + nút Thu gọn ở cuối; tôn trọng reduced-motion / high-contrast / khung hẹp 320px; trạng thái nằm TRONG khung chat. Tái dùng thành phần ở `webview/src/components/timeline/`. Xem `docs/TIMELINE-SPEC.md`.
5. **Remote (locaith.ai) có reducer ĐÓNG:** KHÔNG thêm loại `UiEvent`/`ABlock`/`TItem` mới; chỉ thêm TRƯỜNG TUỲ CHỌN vào loại đã có, và mọi trường phải đi qua `src/core/remote/sanitize.ts` (giới hạn độ dài/số phần tử).
6. **An toàn:** không đưa chuỗi do model đưa vào shell mà không kiểm tra; chặn path traversal; không ghi bí mật vào log; cài đặt có thể LÀM LỎNG bảo mật không được đọc từ workspace chưa tin cậy (xem `SECURE_KEYS` ở `src/host/config.ts`).
7. **Test thật** (vitest; `test/helpers/fakeProvider.ts` chạy ENGINE THẬT theo kịch bản): test phải CÓ THỂ ĐỎ. Trước khi xong: `npm run typecheck` (3 tsconfig), `npm run build:browser`, và `npx vitest run --no-file-parallelism` một lần cuối (`tools.test.ts`, `vietnamese-paths.test.ts` hay timeout khi máy bận — chạy riêng). Lưu ý quy tắc B05: sau ≥ 6 lệnh công cụ, câu trả lời cuối < 120 ký tự bị nhắc viết lại — kịch bản test cần câu cuối đủ dài.
8. **Chỉ commit bằng danh tính** `Locaith <locaithsolution@locaith.com>`, không dòng Co-Authored-By. Không đọc/ghi gì dưới `D:` (ổ sắp hỏng). Không in khoá/token/.env.

### Định nghĩa «xong» (bài học từ sự cố biểu tượng «N» trên Chrome Web Store, 07/11/2026)
Một bản phát hành chưa xong nếu CHỈ code chạy. Phải kiểm cả thứ **người dùng và chủ dự án nhìn thấy ở ngoài code**:
- Bản **Chrome/Edge**: `npm run package:browser` chạy `scripts/verify-browser-package.mjs` (biểu tượng đúng logo Lo theo băm, mô tả không thương hiệu, CSP không CDN, thông báo dữ liệu có nối, chuỗi không nói sai nơi lưu khoá). Gói PHẢI qua bộ kiểm; giải nén gói ra và nhìn biểu tượng bằng mắt. Xem `docs/CHROME-STORE.md`.
- Mô tả/ảnh trên trang cửa hàng KHÔNG nằm trong gói: nếu tính năng đổi thì nói rõ cho chủ dự án phải cập nhật tay.
- Mọi thứ có logo thương hiệu (model Locaith, tiện ích, gói) phải mang logo «Lo» thật.
- Sau mỗi bản phát hành VS Code: cài VSIX vào VS Code của chủ dự án (`code --install-extension <vsix> --force`) và dặn họ Reload Window.

## 1. Ba lane chưa làm (đặc tả đầy đủ bên dưới)

Làm theo thứ tự ưu tiên của chủ dự án: **tools-parity → instructions-memory → mcp-parity** (công cụ sửa mã chính xác ảnh hưởng chất lượng A–Z nhiều nhất; chỉ dẫn+ký ức giữ độ chính xác qua nhiều lần nén; MCP là mở rộng). Mỗi lane: khảo sát cái đã có trước, lấp chỗ thiếu, test, ghi `docs/changes/<lane>.md` (vi + en ngắn), không bump version/CHANGELOG (người phát hành làm).

### Lane `mcp-parity` — MCP đầy đủ: OAuth, resources, prompts, tìm công cụ

BỐI CẢNH: src/core/mcp/client.ts đã có stdio + HTTP "streamable", tools/list có phân trang, thông báo tools/list_changed, và móc cấp tiêu đề OAuth + làm mới khi 401; src/core/mcp/oauth.ts có phần OAuth; manager.ts quản lý; webview McpPanel.tsx. Hãy KHẢO SÁT trước rồi lấp chỗ thiếu theo ưu tiên (đừng viết lại cái đã tốt).

YÊU CẦU (sắp theo ưu tiên; làm lần lượt, mục sau chỉ khi mục trước xong và có test)
1. OAuth HTTP MCP đầy đủ: khám phá 'oauth-protected-resource' / 'oauth-authorization-server', đăng ký client động (RFC 7591), Authorization Code + PKCE (S256), mở trình duyệt hệ thống, nhận callback (redirect loopback hoặc vscode:// URI — theo cách an toàn nhất có sẵn trong repo), lưu token mã hoá trong SecretStorage, tự làm mới refresh_token, thu hồi khi gỡ server; luồng «Xác thực» trong McpPanel (nút, trạng thái «cần xác thực»). Kiểm thử bằng máy chủ OAuth+MCP giả cục bộ trong test.
2. Transport SSE cũ (legacy) nếu máy chủ không hỗ trợ streamable (tự phát hiện/fallback), tiêu đề tuỳ chỉnh, mở rộng biến môi trường ${VAR} / ${VAR:-mặc định} trong cấu hình (command/args/env/url/headers) — KHÔNG in giá trị bí mật ra log.
3. Phạm vi cấu hình: '.mcp.json' của dự án + '~/.locaith/mcp.json'/cài đặt người dùng; máy chủ của DỰ ÁN cần xác nhận một lần (hiện lệnh đầy đủ, ghi nhớ theo băm) trước khi chạy; workspace chưa tin cậy ⇒ không chạy máy chủ dự án.
4. Resources & prompts: resources/list+read (đưa vào @-mention như '@server:resource' hoặc công cụ 'mcp_read_resource'), prompts/list+get → lệnh gạch chéo '/mcp__server__prompt' (đăng ký qua slashRegistry, đối số hỏi gọn).
5. Quy mô công cụ: khi tổng công cụ MCP > 40 (cài đặt 'mcp.toolSearchThreshold'), ẩn bớt và cấp công cụ 'mcp_search_tools' {query} (tìm theo tên/mô tả, mở khoá công cụ khớp cho các vòng sau — dùng cơ chế unlock/hidden sẵn có), để ngữ cảnh không phình; giới hạn kích thước kết quả công cụ MCP + timeout theo máy chủ ('MCP_TOOL_TIMEOUT'), kết nối lại tự động có backoff, trạng thái rõ ràng trong McpPanel (kết nối/lỗi/cần xác thực/đang kết nối lại + nút Kết nối lại).
6. Test: máy chủ MCP giả (stdio và HTTP) đầy đủ tools/resources/prompts, OAuth giả, fallback SSE, mở rộng biến, xác nhận dự án, tìm công cụ, kết nối lại; không rò token vào log/UI/phiên lưu.

### Lane `instructions-memory` — Chỉ dẫn & ký ức kiểu CLAUDE.md đầy đủ

BỐI CẢNH: extension nạp LOCAITH.md/AGENTS.md/CLAUDE.md ở GỐC workspace (src/core/engine/instructions.ts, cài đặt instructionFiles) và có ký ức bền tự nạp (memory.ts: .locaith/memory/MEMORY.md + ~/.locaith/memory/MEMORY.md, công cụ remember). Claude Code còn: chỉ dẫn cấp người dùng, tệp lồng nhau theo thư mục con, nhập @tệp trong chỉ dẫn, luật theo đường dẫn, '#' ghi nhanh vào ký ức, '/memory' mở/sửa. Độ chính xác của Claude Code "dù compact bao nhiêu lần" đến từ đây.

YÊU CẦU
1. CHỈ DẪN NHIỀU TẦNG: người dùng '~/.locaith/LOCAITH.md' (và tương thích '~/.claude/CLAUDE.md' theo cài đặt), dự án (gốc), dự án cục bộ không commit 'LOCAITH.local.md', và THƯ MỤC CON: khi agent đọc/sửa tệp trong thư mục con có LOCAITH.md/AGENTS.md/CLAUDE.md thì nạp chỉ dẫn đó (một lần mỗi phiên, gắn vào kết quả công cụ đọc/sửa đầu tiên hoặc vào system prompt lượt kế — chọn cách không phá prompt-cache và test được), có trần kích thước tổng + ghi rõ nguồn. Thứ tự ưu tiên rõ ràng (cụ thể thắng chung).
2. NHẬP: dòng '@đường/dẫn' trong tệp chỉ dẫn nhúng nội dung tệp đó (tối đa 4 cấp, chống vòng lặp, chỉ trong workspace hoặc ~/.locaith, chặn tệp bí mật .env/khoá, có trần).
3. LUẬT THEO ĐƯỜNG DẪN: '.locaith/rules/*.md' có frontmatter 'paths: ["src/api/**"]' — chỉ nạp khi agent làm việc với tệp khớp; không có 'paths' thì nạp luôn.
4. GHI NHANH: gõ '# nội dung' ở đầu tin nhắn (hoặc lệnh '/remember') ⇒ ghi vào ký ức qua cùng đường với công cụ remember (hỏi phạm vi dự án/cá nhân bằng lựa chọn gọn nếu không rõ; vi+en), không gửi tin đó cho model như một yêu cầu. Lệnh '/memory': hiện các tệp chỉ dẫn + ký ức đang nạp (nguồn, kích thước, dòng đầu), nút mở/sửa trong editor, tạo mẫu nếu chưa có; thay cho việc phải đoán.
5. ĐỘ BỀN SAU NÉN: chứng minh bằng test chạy engine thật qua nhiều lần nén rằng chỉ dẫn+ký ức vẫn có trong mọi lượt (system prompt), todo vẫn còn, và yêu cầu gốc không mất; thêm vào ký ức TỰ ĐỘNG tóm tắt sau mỗi lần nén (đã có saveCompactionToMemory — kiểm tra nó thật sự ghi đúng, không ghi trùng/phình vô hạn: trần + dọn).
6. An toàn: nội dung từ tệp dự án là DỮ LIỆU không tin cậy (có thể chứa prompt-injection): đánh dấu nguồn rõ trong prompt, không cho tệp chỉ dẫn của thư mục con LÀM LỎNG quy tắc an toàn của hiến pháp (thứ tự: hiến pháp > người dùng > dự án).
7. Test: thứ tự/ưu tiên, thư mục con nạp đúng lúc, nhập @ (vòng lặp, traversal, bí mật), luật theo đường dẫn, '#' ghi nhanh, /memory, trần, bền qua nén.

### Lane `tools-parity` — Bộ công cụ ngang Claude Code: sửa nhiều chỗ, notebook, grep, đọc tệp

VẤN ĐỀ: tỉ lệ lỗi công cụ ghi/đọc thấp (<0,6%) nhưng chất lượng A–Z phụ thuộc việc sửa mã chính xác ít vòng. Công cụ hiện có: read_file, write_file, edit_file, list_dir, glob, grep, run_command, fetch_url/web_search (src/core/tools/web), memory/remember, artifact, load_skill, todo_write, agent, workflow_run, scratchpad, exit_plan_mode, offer_options. Hãy so với bộ công cụ của Claude Code (Read, Write, Edit, MultiEdit, NotebookEdit, Glob, Grep, Bash, WebFetch, WebSearch, TodoWrite, Task, ExitPlanMode, SlashCommand) và KHẢO SÁT từng cái trước khi làm (đừng trùng).

YÊU CẦU (ưu tiên theo giá trị)
1. SỬA NHIỀU CHỖ NGUYÊN TỬ: công cụ 'multi_edit' {path, edits:[{old_string,new_string,replace_all?}]} áp tuần tự trên cùng tệp, TẤT CẢ hoặc KHÔNG (một chỗ lỗi ⇒ không ghi gì, báo chỗ nào + gợi ý), tôn trọng chống-sửa-mù (readFiles/băm), CRLF/LF giữ nguyên, BOM, mã hoá không-UTF-8 (NotUtf8Error), một diff chung. Cổng quyền như edit_file.
2. edit_file THÔNG MINH HƠN KHI LỆCH: khi old_string không khớp: thử so khớp bỏ qua khác biệt khoảng trắng đầu/cuối dòng và CRLF↔LF (chỉ khi cho ra ĐÚNG MỘT vị trí), nếu vẫn không khớp thì trả lỗi có ích (đoạn gần giống nhất kèm số dòng, "tệp đã đổi từ lần đọc cuối — hãy đọc lại"), khi khớp nhiều nơi nêu số lần và yêu cầu thêm ngữ cảnh/ replace_all. Không bao giờ ghi bừa.
3. NOTEBOOK: 'notebook_edit' cho .ipynb (thay/chèn/xoá ô theo chỉ số hoặc id, giữ metadata/outputs hợp lệ, JSON ổn định) và read_file hiển thị ô notebook dễ đọc (ô, loại, nguồn, tóm tắt đầu ra). Tối thiểu nhưng đúng.
4. GREP/GLOB: chế độ đầu ra (content | files_with_matches | count), -A/-B/-C, multiline, lọc theo loại tệp, head_limit/offset, tôn trọng .gitignore và bỏ qua node_modules/dist mặc định (có cờ tắt), trả số kết quả bị cắt — kiểm tra phần nào đã có và chỉ thêm cái thiếu. list_dir/glob không làm ngập ngữ cảnh (trần + tóm tắt).
5. read_file: offset/limit theo dòng với số dòng, tệp lớn có gợi ý đọc từng phần, ảnh/PDF đưa qua đường docExtract sẵn có; cảnh báo tệp nhị phân; phát hiện tệp vừa bị đổi bởi người dùng trong editor chưa lưu (đã ưu tiên bản chưa lưu — giữ).
6. web_fetch có tham số 'prompt' để rút trích (qua mô hình nhanh nếu host có Summarizer, ngược lại trả văn bản đã làm sạch có trần) và bộ đệm 15 phút; ghi rõ nguồn; chống SSRF hiện có giữ nguyên.
7. Mọi công cụ mới có mô tả CHÍNH XÁC, ngắn, ví dụ đúng; nằm trong registry; hiển thị tên/nhãn tiếng Việt trong webview (toolLabels.ts) kèm icon; remote/điện thoại hiển thị được; bản trình duyệt không bị phá (công cụ ghi tệp không xuất hiện ở đó).
8. Test: multi_edit (nguyên tử, CRLF, BOM, sửa chồng nhau), khớp mờ an toàn, lỗi gợi ý, notebook (round-trip), grep modes, read_file offset, web_fetch prompt (giả), nhãn UI, schema hợp lệ cho mọi adapter nhà cung cấp (không dùng cú pháp schema mà một hãng từ chối).

## 2. Phần giao diện web Remote (repo `locaith-ai-v2`, `src/screens/remote/`) chưa vẽ dữ liệu mới của extension

Đã làm xong ở web (đã triển khai): dòng thời gian gọn kiểu Claude Code, dòng «Đã nén cuộc trò chuyện …», «Kiểm tra độc lập», liên kết rẽ nhánh (trường tuỳ chọn `notice.compact/verify/fork`, `thinking.ts/durationMs`). **Chưa có** (extension đã gửi qua relay, web đang bỏ qua; mỗi mục chỉ cần vẽ + gửi lệnh tương ứng, KHÔNG sửa reducer đóng — dữ liệu nằm trong `ViewState`/trường tuỳ chọn, xem `src/core/remote/protocol.ts` + `sanitize.ts` của extension):
1. Chip «ngữ cảnh 38%» + chi phí ước tính (`meter`/`context`).
2. Thanh «N tệp đã đổi +68 −9 · Xem» sau mỗi lượt (`checkpoints`) — chỉ đọc; lệnh `rewind_*` từ Remote chỉ chạy khi chế độ acceptEdits/bypass (host chặn).
3. Chip «N tác vụ nền» + nút Dừng (`bgTasks`, lệnh `bg_task`).
4. Thẻ «Trước → Sau» (`show_before_after`: `imageCount` + `imageKeys`, lấy ảnh bằng `get_image` sẵn có).
5. Dòng hook (`Hook PreToolUse · tên ✓ 120 ms`, đi qua `pill`) và luật quyền (`permissions`).

## 3. Việc nhỏ còn treo
- **Chrome/Edge:** mô tả chi tiết + ảnh chụp ở trang cửa hàng mô tả bản cũ 0.4.x (Theo dõi tin nhắn, cầu nối VS Code) — bản dùng chung giao diện không có hai tính năng đó. Chủ dự án quyết định: cập nhật mô tả theo `docs/chrome-store/` hay giữ hai dòng sản phẩm.
- **gateway-client (mức thấp):** (a) 401 đúng lúc không xác minh được tài khoản (mất mạng thoáng qua) → 30 s liền báo «hết hạn đăng nhập» dù token còn hiệu lực (`src/core/account/gatewayToken.ts`: tách «không xác minh được» khỏi «bị thu hồi»); (b) 401 giữa chừng stream không đánh dấu token hỏng; (c) lần 401 thứ hai xoá token khỏi kho thay vì chỉ khoá phiên.
- **CLI (`locaith-cli`):** MCP kết nối thật, lỗi lưu lịch sử, `/compact` bằng tóm tắt model — xem `locaith.md` mục 3. Không phát hành PyPI khi chưa được chủ dự án cho phép.
- **Nghi ngờ do rà soát chéo giữa các lane (chưa chứng minh, mức thấp — kiểm tra rồi sửa nếu đúng):** (a) hook `PreToolUse` trả `updatedInput` thì lệnh đó không còn đi qua shell check / loop-breaker (hook đứng SAU loopGuards trong danh sách extension); (b) `retry` sau lần chạy đã ghi tệp: checkpoint của lượt cũ thành mồ côi, lượt mới lấy trạng thái đã sửa làm bản gốc nên không quay lại được bản gốc thật; (c) `forkSession` sao chép nguyên `contextStats` nên phiên nhánh có thể hiện số lần nén lớn hơn thực tế; (d) `replaceSource` của lệnh tuỳ chỉnh làm mất lệnh bị che (lệnh `user` bị lệnh `project` cùng tên che) và không khôi phục khi lệnh che bị xoá cho tới khi nạp lại nguồn.
- **Bản Chrome/Edge — tính năng của bản 0.4.4 cũ mà bản dùng chung giao diện (0.6.x/0.7.0) KHÔNG có:** mô hình Locaith (đăng nhập tài khoản + `ACCOUNT_PRESETS`; cổng `https://studio-api.locaith.com/api/llm/v1`), «Theo dõi tin nhắn», cầu nối VS Code. Muốn có lại phải làm có chủ đích (kèm cập nhật thông báo dữ liệu + chính sách quyền riêng tư + mô tả cửa hàng).
