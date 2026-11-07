# Đặc tả dòng thời gian gọn kiểu Claude Code (VS Code · Chrome · Remote locaith.ai)

Tài liệu này đủ để một kỹ sư dựng lại dòng thời gian trên trang Remote (React + lucide-react) **mà không cần đọc mã webview**. Mã tham chiếu
(Preact) nằm ở `webview/src/components/timeline/*`, `webview/src/timelineCc.ts`, `webview/src/timeline.ts`, `webview/src/styles/timeline-cc.css`.
Ảnh mẫu gốc: `_work/claude-code-ui/cc-1…3.png`; ảnh của bản này: `webview/dev/shots/cc-*.png` (chạy `node webview/dev/build.mjs && node webview/dev/shoot.mjs cc-`).

Nguyên tắc chung (áp cho mọi dòng):

* **Một thứ = MỘT dòng**: `[chấm trạng thái 7 px] nhãn xám nhạt cỡ nhỏ … (meta nhỏ bên phải) [⌄]`. Không khung kín, không tô nền cả khối, không biểu tượng, không dấu «…» ở nhãn.
* Mở ra: **PHẲNG** như Claude Code (anh chê «nhiều viền dọc quá», 07/11/2026): thân xếp dọc, **KHÔNG thanh dọc, KHÔNG đường nối giữa các chấm, KHÔNG đường kẻ ngang**; mọi chấm thẳng MỘT cột với chấm của dòng nhóm. Nhóm lồng trong nhóm («Việc: …», «Đã sửa N tệp») chỉ thụt nhẹ 14 px để thấy cấp, vẫn không vạch.
  Ô IN/OUT là MỘT hộp (nhãn nằm trong hộp, ô OUT đậm hơn một chút thay đường kẻ ngăn). Nút **Thu gọn** ở cuối thân là chữ nhỏ xám căn trái (không khung, không đường kẻ; vùng bấm vẫn ≥ 40 px trên điện thoại); nhiều Thu gọn liền nhau ở cuối các khối lồng nhau thì chỉ hiện cái ngoài cùng (`:has(+ .collapse-foot) .collapse-foot { display: none }`).
  Đường dẫn dài xuống dòng ở ranh giới thư mục (chèn `<wbr>` / ký tự rộng-không sau mỗi `/` hoặc `\`), không bẻ giữa từ. Bộ dò tự động: `webview/dev/shoot.mjs` thất bại nếu có phần tử nào trong `.timeline` có viền trái MỘT BÊN.
* Chấm: `ok` xanh lá · `fail` đỏ · `live` xám nhấp nháy nhẹ (opacity 0,45 → 1, 1,6 s; tắt khi `prefers-reduced-motion`) · `muted` xám · `warn` cam.
  Cột phải thẳng MỘT hàng: nút «mở tệp» ẩn (opacity 0) từng chiếm 28 px bên phải các hàng Đọc/Ghi/Sửa làm chevron lệch so với hàng Tìm/Lệnh → bỏ hẳn (đường dẫn ở dòng đã là liên kết bấm mở tệp). Chữ phụ bên phải (số dòng, kết quả, thời lượng) màu xám, KHÔNG đậm. Thẻ diff trong dòng công cụ không lặp tên tệp và «+a −b» (đã ở dòng ngay trên), chỉ còn «Mở diff trong editor» và nhãn «Tệp mới»; «Thu gọn» là chữ xám đọc được (không biểu tượng) và có vòng focus bàn phím rõ.
* Tương phản cao: chữ phụ dùng màu chữ chính, chấm có viền 1 px, shimmer tắt; hộp IN/OUT, khung xem trước và thẻ diff giữ viền `--vscode-contrastBorder` (forced-colors: `CanvasText`) vì viền thường đã mờ đi, ô OUT chỉ ngăn bằng một đường kẻ trên. Khung hẹp (≤ 320 px): ô IN/OUT xếp dọc, ẩn thời lượng.
* Mọi chữ hai ngôn ngữ (vi/en). Chuỗi ở bảng cuối.

---

## 1. Hợp đồng dữ liệu (những gì đi qua relay)

Tất cả là trường **tuỳ chọn** của các loại đã có trong `src/shared/protocol.ts`; thiếu → hiển thị theo cột «Mặc định khi thiếu».

| Loại | Trường | Ý nghĩa | Mặc định khi thiếu |
|---|---|---|---|
| `UserItem` | `ts` | lúc gửi (ms) | không vẽ giờ |
| `UserItem.attachments[]` | `kind='image'`, `label`, `thumb?` | chip «image.png» (kích thước ảnh **không có** trong dữ liệu — không bịa) | chip tên tệp |
| `AssistantItem` | `ts`, `endedAt?`, `done` | giờ của câu trả lời sau một nhóm = `endedAt` | không vẽ giờ |
| `AssistantItem.blocks[]` `thinking` | `text`, `startedAt?`, `durationMs?` | «Đã suy nghĩ 14 giây» | «Đã suy nghĩ» (không số) |
| `tool` | `name`, `args`, `state`, `summary?`, `output?`, `diff?`, `durationMs?`, `startedAt`, `agent?` | một dòng công cụ | — |
| `tool.args` | `description?: string` | mô tả một dòng do model đặt — **ưu tiên** cho mọi công cụ | lấy từ lệnh / đường dẫn / mẫu tìm / URL |
| `tool.args` | `run_in_background?`/`background?: true` | dòng phụ «Chạy nền» | không có dòng phụ |
| `tool.summary` | «58 dòng» / «58 lines» | số dòng của Write (nguồn duy nhất ở Remote: `args.content` bị cắt 600 ký tự) | đếm `args.content` nếu chưa bị cắt (không có đuôi `… [+N]`), không thì ẩn |
| `tool.agent` | `tokens`, `tools`, `failed?`, `activity?` | dòng agent «654,9k token · 249 lệnh» | dòng công cụ thường |
| `notice` (khối hoặc mục) | `level`, `text`, `compact?: {mode, tokensFreed?, summarizedMessages?, clearedResults?, summary?}` | info = chữ nghiêng xám; có `compact` = dòng nén mở ra được | chữ nghiêng xám |
| sự kiện `thinking` | `ts?` | reducer tính `startedAt`/`durationMs` (xem §6) | không có số |

Kích thước ở Remote (`src/core/remote/sanitize.ts`): `output` ≤ 2000 (giữ đuôi), `args` mỗi chuỗi ≤ 600, `thinking.text` ≤ 4000 (giữ đuôi), diff ≤ 160 dòng, `compact.summary` ≤ 1500, số nguyên không âm (giá trị lạ bị bỏ). `REMOTE_API_VERSION` không đổi (1).

---

## 2. Dòng nhóm (A) — `RunHead`

Đầu vào: `calls`, `failed`, `edits`, `steps`, `live`, `runningTool?` (tên hành động), `background?`, `durationMs?`, `open`.

```
[●] 22 lệnh gọi công cụ                                   23 phút ⌄
[●] 54 lệnh gọi công cụ · 2 lỗi                            12 phút ⌄      ← chấm ĐỎ khi failed > 0
[●] 36 lệnh gọi công cụ · 2 lỗi · sửa 3 tệp                11 phút ⌄      ← «sửa N tệp» xanh ngọc (giữ của Locaith)
[●] Đang chạy Lệnh · 10 lệnh gọi công cụ                          ⌄      ← live: chấm xám nhấp nháy, «Đang chạy …» màu chữ chính
    Chạy nền                                                              ← dòng phụ khi lệnh đang chạy nền
```

* `calls` = số lệnh **của lượt** (mỗi agent con = 1). Số lệnh bên trong agent KHÔNG cộng vào (khớp ảnh «54 tool calls · 2 failed» + agent «249 tools»).
* Màu chấm: `runTone(stats, live)` → `fail` nếu `failed > 0` (kể cả đang chạy), `live` nếu đang chạy, `ok` còn lại.
* Thời lượng bên phải: `formatDurationShort` (dưới 1 phút: «48 giây»/«48s»; từ 1 phút: «23 phút»/«23m»; từ 1 giờ: «1 giờ 12 phút»/«1h 12m»). Ẩn ở khung ≤ 320 px.
* Chevron: `chevron-down` khi gập, `chevron-up` khi mở (lucide `ChevronDown`/`ChevronUp`, 14 px, opacity 0,7).
* Dòng agent con (§5) luôn hiện NGAY DƯỚI dòng nhóm khi nhóm **gập** (mở ra thì nằm trong thân đúng vị trí).
* Khi nào có dòng nhóm: lượt ĐÃ XONG → mọi thứ trước dãy chữ cuối (= câu trả lời) gập thành một dòng (`splitWork`; câu trả lời dài ≥ 280 ký tự không bao giờ bị gập; artifact, thẻ xin phép, thông báo lỗi/cảnh báo luôn nằm ngoài); lượt ĐANG CHẠY → các đoạn hoạt động liền nhau gộp một dòng (`groupActivityRuns`, từ 2 dòng trở lên).

## 3. Nhóm mở ra (B) — từng bước là một dòng

```
│ [●] Đã suy nghĩ 14 giây                                   ⌄   ← bấm xem nội dung suy nghĩ
│ [●] **Lệnh**  Xem phiên bản hiện tại của extension, C…  1,8 s ⌃
│      IN   cd /c/locaith/… && grep -m1 '"version"' package.json
│      OUT  "version": "0.6.30",
│           # Changelog
│           ## 0.6.30 — 2026-11-06                 (mờ dần, bấm bung đủ)
│ [●] Đã suy nghĩ 3 giây                                    ⌄
│ [●] **Đọc**  src/core/engine/engine.ts             120 dòng ⌄   ← đường dẫn màu liên kết, bấm mở tệp (chỉ VS Code)
│ [●] **Tìm**  RunExtension · src                    4 kết quả ⌄
│ [●] **Ghi**  src/core/engine/extensions/gate.ts     58 dòng ⌃
│      ┌ /**                                                     ┐
│      │  * Cổng hoàn thành như một RunExtension …               │  (4 dòng đầu, tô màu nhẹ, mờ dần; bấm xem đủ ≤ 400 dòng)
│ [●] **Sửa**  src/utils/formatMoney.ts                 +9 −3 ⌃
│      (DiffView: đường dẫn, +9 −3, «Mở diff trong editor», 10 dòng đầu, «Hiện thêm N dòng»)
│                      ⌃ Thu gọn
```

* **Tên hành động** in đậm (`actionName`): run_command→Lệnh/Bash · read_file→Đọc/Read · write_file→Ghi/Write · edit_file→Sửa/Edit · grep→Tìm/Grep · glob→Tìm tệp/Glob · list_dir→Liệt kê/List · web_search→Web · fetch_url→Đọc web/Fetch · agent→Agent/Task · workflow_run→Workflow · create/update/list_artifact_types→Artifact · load_skill/search_skills→Kỹ năng/Skill · scratchpad→Ghi chú/Notes · todo_write→Tác vụ/Tasks · exit_plan_mode→Kế hoạch/Plan · tabs_*/tab_*→Tab/Tabs · page_*→Trang/Page · khác→chính tên công cụ.
* **Mô tả** (`toolDescription`): `args.description` (dòng đầu) → nếu không: run_command: lệnh (dòng đầu, ≤ 240 ký tự); read/edit/write/list_dir: đường dẫn; grep: `mẫu · nơi`; glob: mẫu; web_search: truy vấn; fetch_url/page_navigate/tab_open: URL; agent/workflow: description/agent_type; page_type: `[ref] ⟨độ dài⟩` (không lộ chữ đã gõ). Đường dẫn: màu liên kết, **xuống dòng** (không cắt); các loại khác: một dòng cắt bằng `text-overflow: ellipsis`.
* Trạng thái: `error` → chấm đỏ, tên hành động đỏ, chữ «Lỗi»; `denied` → chấm cam «Đã từ chối»; `cancelled` → xám «Đã hủy»; `running` → chấm sống; `awaiting_permission` → cam (thẻ xin phép là đoạn riêng, không nằm trong nhóm).
* Meta bên phải: `+a −b` (diff) · «N dòng» (Write; khi diff.isNew thì «N dòng» + xem trước thay cho diff, tránh lặp nội dung — Edit/ghi đè giữ `+a −b` và diff) · `summary` khác · thời lượng (`formatDuration`, chỉ khi ≥ 400 ms) · «token · lệnh» của agent đã xong.
* Bên trong nhóm mở: **mỗi khối suy nghĩ đứng đúng chỗ** (không gom); dòng tóm tắt «N lệnh gọi công cụ» trung gian **bị bỏ**, các lệnh bày phẳng cùng cấp; các nhóm cùng tên («Đã đọc 5 tệp», «Đã sửa 3 tệp») tự mở; dòng Lệnh/Ghi/Sửa tự bày IN-OUT / xem trước / diff — chevron vẫn thu lại được.
* Ngoài nhóm (lượt ngắn < 3 bước, hoặc «tệp đã sửa» bày dưới dòng nhóm gập): dòng công cụ gập, bấm mới mở.

## 4. Ô IN / OUT (C) — `CmdInOut`

* Hai ô xếp dọc, lưới `30px | 1fr`: nhãn «IN»/«OUT» nhỏ (12 px, đậm, xám nhạt) + `<pre>` chữ đơn cách, `white-space: pre-wrap`, viền 1 px mềm, nền `code-bg`, bo 8 px.
* Cắt: hơn 4 dòng hoặc > 600 ký tự → `max-height = 1.55em × 4 + 12px`, `mask-image: linear-gradient(#000 52%, transparent)`; cả ô là nút (`role=button`, Enter/Space) bấm bung đủ/thu lại.
* Lỗi: lớp `is-error` → chữ `color-mix(danger 78%, fg)`, nhãn OUT đỏ, **không** nền đỏ. Đang chạy chưa có đầu ra → không có ô OUT.
* Nút Sao chép (`copy`, 12 px) góc trên-phải, chỉ hiện khi rê chuột/focus; bấm xong hiện «Đã chép» 1,4 s.

## 5. Dòng agent con (F) — `AgentRow`

```
rộng:  [●] Hoàn thiện 0.6.31 dở dang của Locaith: Monitoring: Wait…   **654,9k token · 249 lệnh** · 39 phút 54 giây
       (đang chạy) Đang đọc C:\locaith\…                                  ← dòng hai = việc đang làm
hẹp (≤ 520 px):
       [●] Hoàn thiện 0.6.31 dở dang của Locaith: M…           39 phút 54 giây
           654,9k token · 249 lệnh [· Đang đọc …]
```

* Chấm: `error` hoặc `agent.failed > 0` → đỏ; `running` → sống; `denied/cancelled` → xám; `done` → xanh.
* Thời gian: đang chạy → đếm sống từ `startedAt` (một `setInterval` dùng chung, mỗi giây); xong → `durationMs`. Định dạng `formatSeconds` («39 phút 54 giây» / «39m 54s»).
* Bộ số in đậm (600) màu chữ phụ; thời gian thường. Luôn tối đa 2 dòng, không tràn ngang. `aria-live="off"`, aria-label không chứa số giây.

## 6. Suy nghĩ

* Đang nghĩ: «Đang suy nghĩ» (+ « · 12 giây» sau 1 giây) với **shimmer** (gradient `fg-muted → fg → fg-muted` chạy ngang 2,2 s qua `background-clip: text`; tắt khi reduced-motion / tương phản cao). KHÔNG dấu «…».
* Xong: «Đã suy nghĩ 14 giây» từ `durationMs` (nhiều khối gom → cộng); không có số → «Đã suy nghĩ».
* Reducer (`applyEvent` trường hợp `thinking`): delta đầu của một khối → `startedAt = ev.ts`; delta sau → `durationMs = max(0, ev.ts − startedAt)`; `ts` thiếu/lạ → không thêm trường. Engine đóng dấu `ts = Date.now()` ở mỗi delta (`interceptor.ts`); host gộp delta ~60 ms giữ `ts` của delta đầu trong gói → sai số ≤ một gói.
* Bấm dòng → nội dung suy nghĩ (chữ xám, `pre-wrap`, tối đa 320 px cuộn) + Thu gọn. Ước lượng token chỉ còn ở tooltip.

## 7. Dòng nén ngữ cảnh (E) — `CompactRow`

`Đã nén cuộc trò chuyện · tự động · giải phóng 968k token ⌄` — chữ nghiêng xám nhạt (`notice.level='info'` + `compact`). `mode`: auto→«tự động»/«auto», manual→«thủ công»/«manual», overflow→«tràn ngữ cảnh»/«overflow»; `tokensFreed` qua `formatCompact` («968k»). Mở ra: dòng meta «tóm tắt 41 tin nhắn · lược 12 kết quả công cụ», tiêu đề «Phần tóm tắt giữ lại», `summary` (pre-wrap, cuộn ≤ 320 px) hoặc «Không có bản tóm tắt để xem.», Thu gọn. Dùng cho cả notice độc lập lẫn notice trong lượt. Thiếu `compact` → §8.

## 8. Thông báo (K)

* `info`: `[● xám] chữ nghiêng xám nhạt` (ví dụ «Nghỉ 1 ngày 16 giờ. Bộ nhớ đệm prompt có thể đã hết hạn…»). Không viền, không nền.
* `warn`: chấm cam, chữ `color-mix(warn 70%, fg)`; `error`: chấm đỏ, chữ `color-mix(danger 78%, fg)`, `role=alert`, có nút «Thử lại» khi là mục cuối. Không tô nền kín.

## 9. Giờ & ngày (G) — `timelineMarks`

* Giờ: `formatClock` — vi 24 giờ «17:52» (số 0 đầu), en «5:52 PM». Vẽ nhỏ xám căn phải (12 px) **trên** mỗi tin người dùng (`ts`) và trên câu trả lời mở đầu sau một nhóm của lượt đã xong (`endedAt`, chỉ khi lượt có công cụ/suy nghĩ). Thiếu → không vẽ.
* Ngày: `formatDayLabel` — vi «T7, 07/11» (CN, T2…T7; thêm «/2025» khi khác năm), en «Sat, Nov 7» («, 2025» khi khác năm). Vẽ **đường ngăn dạng sóng** (`mask-image` SVG `M0 3 Q4 0 8 3 T16 3`, lặp ngang, màu `line`) với nhãn ở giữa, giữa hai mục liên tiếp có `ts` mà ngày địa phương khác nhau; mục đầu tiên không có đường ngăn. Mục `notice` cũng có `ts` nên tham gia so sánh ngày.
* `timelineMarks(items) → Map<id, {day?, time?}>` O(n) theo số mục; tính lại mỗi khi transcript đổi.

## 10. Tin người dùng (H)

Khung viền mảnh 1 px bo 14 px, nền `surface-2`; chip đính kèm ở đầu (ảnh: thumbnail nếu có `thumb`, không thì biểu tượng ảnh + tên); chữ bên dưới (clamp 900 ký tự/14 dòng + «Mở rộng»). Góc trên-phải: `MessageActionSlot` (`data-slot="message-actions"`, mờ khi không rê chuột) hiện chứa nút «Sửa tin nhắn này» ở tin cuối; **lane checkpoints-rewind** gắn thêm biểu tượng quay lại vào đây.

## 11. Nhãn đang chạy (I) và ô nhập (J)

* Cuối lượt đang chạy khi không có dòng nào đang sống: `[logo Lo xoay nhẹ 15 px] **Đang xử lý**` (hoặc **Đang chuẩn bị** khi chưa có gì) + «~N token · 12 giây» nhỏ. Không dấu «…». Reduced-motion: logo tĩnh.
* Hàng chip dưới ô nhập: [@] [đính kèm] [model] [chế độ quyền] [mức suy luận] [Swarm] [● N agent] **[⏱ 59m — chỉ khi đang chạy]** [đồng hồ ngữ cảnh] [Dừng (khi chạy)] [Gửi/Xếp hàng]. Đồng hồ: `formatElapsedShort` («48s» · «59m» · «1h 12m»), mốc = `runningSince(view)` (ts của lượt đang chạy, hoặc của tin người dùng cuối khi lượt chưa mở). Placeholder khi đang chạy: «Xếp hàng tin nhắn khác…» / «Queue another message…» (bản không có hàng chờ: «Trợ lý đang làm việc — bạn vẫn có thể soạn sẵn tin tiếp theo»).

---

## 12. Hàm thuần cần chép (`webview/src/timelineCc.ts` + `timeline.ts`)

| Hàm | Chữ ký | Việc |
|---|---|---|
| `formatClock(ts, lang)` | `(number\|undefined, 'vi'\|'en') → string` | giờ 24h/12h, rỗng khi không hợp lệ |
| `formatDayLabel(ts, lang, now?)` | → string | nhãn ngày, thêm năm khi khác năm |
| `sameLocalDay(a, b)` | → boolean | so ngày địa phương |
| `timelineMarks(items)` | → `Map<id, {day?, time?}>` | mốc giờ/ngày |
| `hasProcess(blocks)` | → boolean | có tool/thinking |
| `actionName(lang, toolName)` | → string | tên hành động |
| `toolDescription(lang, block)` | → `{text, kind}` | mô tả một dòng (ưu tiên `args.description`) |
| `writeLineCount(block)` | → number\|undefined | số dòng Write từ `summary` rồi `args.content` |
| `countLines(text)`, `firstLines(text, n)` | | đếm / N dòng đầu + còn lại |
| `langOfPath(path)` | → string\|undefined | ngôn ngữ tô màu từ đuôi tệp |
| `thinkingDuration(blocks)` | → number\|undefined | cộng `durationMs` |
| `formatSeconds(ms, lang)` | → string | «14 giây»/«14s», «1 phút 20 giây»/«1m 20s», «<1 giây» |
| `formatDurationShort(ms, lang)` | → string | meta nhóm: «23 phút»/«23m» |
| `formatElapsedShort(ms)` | → string | chip đồng hồ: «59m», «1h 12m» |
| `runTone(stats, live)` | → `'ok'\|'fail'\|'live'` | màu chấm nhóm |
| `backgroundOf(block)` | → boolean | `args.run_in_background`/`background === true` |
| `agentRowsOf(rows)` | → ToolBlock[] | mọi agent trong cụm (đi xuyên nhóm), không trùng |
| `runningSince(view)` | → number\|undefined | mốc đồng hồ ô nhập |
| `formatCompact(n, lang)` (format.ts) | | «654,9k» / «654.9k», «1,3M» |
| `formatInt(n, lang)` | | «1.284» / «1,284» |
| `formatDuration(ms, lang)` | | meta từng lệnh: «1,8 s», «2 phút 13 giây» |
| `buildSegments(blocks, turnDone, showThinking, turnLive)` (timeline.ts) | → Segment[] | tách khối thành đoạn activity/text/artifact/permission/notice; ≥ 3 lệnh liền nhau → `toolsum`; cùng tên đã xong → `toolgroup`; ≥ 2 sửa tệp liền nhau đã xong → `editgroup`; agent đang chạy → dòng `agent` |
| `splitWork(segments, blocks, startedAt, endedAt)` | → `{work, kept, tail, stats, changes}\|null` | lượt đã xong: phần gập / giữ ngoài / câu trả lời / số liệu / tệp đã sửa bày dưới dòng |
| `groupActivityRuns(segments, minRows=2)` | → `({kind:'run', items}\|{kind:'one', seg})[]` | lượt đang chạy: gộp đoạn hoạt động liền nhau |
| `activityStats(rows)` | → `{calls, failed, edits, steps}` | số liệu dòng nhóm (agent = 1 lệnh; `toolsum.liveCalls` không đếm hai lần) |
| `latestRunningTool(rows)` | → ToolBlock\|null | lệnh đang chạy mới nhất (cho «Đang chạy Lệnh») |
| `nestedRows(blocks)` | → ActivityRow[] | các dòng khi mở dòng tóm tắt |
| `agentStats(block)` | → `{tokens, tools, failed, activity}` | số liệu agent đã làm sạch |

Quy tắc đếm (`rowStats`): `tool` +1 (lỗi +1, sửa tệp +1 edits) · `toolgroup`/`editgroup` + số khối · `toolsum` + `total − liveCalls` · `agent` +1 · `pill`/`thinking`/`skill` → `steps`.

## 13. Chuỗi (vi / en)

| Khoá | vi | en |
|---|---|---|
| `par.calls` | {n} lệnh gọi công cụ | {n} tool calls |
| `par.failed` | {n} lỗi | {n} failed |
| `work.edits` | sửa {n} tệp | {n} files changed |
| `cc.running` | Đang chạy {tool} | Running {tool} |
| `cc.background` | Chạy nền | Run in background |
| `cc.thought` / `cc.thoughtPlain` / `cc.thinking` | Đã suy nghĩ {d} / Đã suy nghĩ / Đang suy nghĩ | Thought for {d} / Thought / Thinking |
| `cc.parts` | {n} đoạn | {n} parts |
| `cc.in` / `cc.out` | IN / OUT | IN / OUT |
| `cc.lines` | {n} dòng | {n} lines |
| `cc.copy` / `cc.copied` | Sao chép / Đã chép | Copy / Copied |
| `cc.showAll` / `cc.showAllLines` | Xem đủ / Xem đủ {n} dòng | Show all / Show all {n} lines |
| `cc.openFile` | Mở tệp | Open file |
| `cc.compact.head` | Đã nén cuộc trò chuyện | Compacted chat |
| `cc.compact.auto` / `manual` / `overflow` | tự động / thủ công / tràn ngữ cảnh | auto / manual / overflow |
| `cc.compact.freed` | giải phóng {n} token | {n} tokens freed |
| `cc.compact.summarized` / `cleared` | tóm tắt {n} tin nhắn / lược {n} kết quả công cụ | {n} messages summarized / {n} tool results cleared |
| `cc.compact.summaryTitle` / `noSummary` | Phần tóm tắt giữ lại / Không có bản tóm tắt để xem. | Summary kept in context / No summary to show. |
| `cc.runClock` | Thời gian chạy của lượt này | Elapsed time for this turn |
| `cc.action.*` | Lệnh · Đọc · Ghi · Sửa · Tìm · Tìm tệp · Liệt kê · Web · Đọc web · Agent · Workflow · Artifact · Kỹ năng · Ghi chú · Tác vụ · Kế hoạch · Tab · Trang | Bash · Read · Write · Edit · Grep · Glob · List · Web · Fetch · Task · Workflow · Artifact · Skill · Notes · Tasks · Plan · Tabs · Page |
| `tool.showLess` / `collapse.foot` | Thu gọn | Show less / Collapse |
| `tool.openDiff` | Mở diff trong editor | Open diff in editor |
| `act.working` / `turn.preparing` | Đang xử lý / Đang chuẩn bị | Working / Getting ready |
| `composer.placeholderQueue` | Xếp hàng tin nhắn khác… | Queue another message… |

## 14. Bảng kiểm thử (chép sang web)

| # | Đầu vào | Kết quả mong đợi | Test gốc |
|---|---|---|---|
| 1 | 22 tool `done` + text cuối, lượt xong | 1 dòng nhóm chấm xanh «22 lệnh gọi công cụ», câu trả lời ngoài, giờ `endedAt` trên câu trả lời | `webview/dev/shoot.mjs` `assertCcCollapsed` |
| 2 | 53 tool (2 `error`) + 1 agent done {tokens 654900, tools 249, durationMs 2394000} | «54 lệnh gọi công cụ · 2 lỗi» chấm đỏ; dưới nó dòng agent «654,9k token · 249 lệnh · 39 phút 54 giây» chấm xanh | cùng trên |
| 3 | 31 read (1 error) + 2 write (summary «58 dòng», «23 dòng») + 1 edit (+9 −3) + 2 cmd (1 error) | «36 … · 2 lỗi · sửa 3 tệp»; gập vẫn bày 3 dòng Ghi/Ghi/Sửa với «58 dòng», «23 dòng», «+9 −3» | cùng trên |
| 4 | lượt đang chạy, 9 done + 1 run_command `running` với `run_in_background: true` | «Đang chạy Lệnh · 10 lệnh gọi công cụ», dòng phụ «Chạy nền», chấm sống; chip đồng hồ «1m»; placeholder «Xếp hàng tin nhắn khác…» | cùng trên |
| 5 | mở nhóm 1 | thân PHẲNG (không thanh dọc, không thụt lề); «Đã suy nghĩ 14 giây», «Lệnh …», IN/OUT ×2, «Đã suy nghĩ 3 giây», từng Đọc/Tìm; Thu gọn ở cuối | `expandCcGroup(0)` |
| 6 | mở nhóm 3 | 2 khung xem trước (4 dòng, mờ dần), «58 dòng», ≥ 3 đường dẫn màu liên kết, đúng 1 ô OUT lỗi (chữ đỏ) | `expandCcGroup(2)` |
| 7 | notice info `compact` {auto, 968000, 41, 12, summary} | «Đã nén cuộc trò chuyện · tự động · giải phóng 968k token ⌄»; mở: «tóm tắt 41 tin nhắn · lược 12 kết quả công cụ», tóm tắt, Thu gọn | `cc-compact-open` |
| 8 | 2 mục khác ngày | 1 đường ngăn «T7, 07/11» / «Sat, Nov 7»; mục đầu không có | `ccTimeline.test.ts` timelineMarks |
| 9 | `thinking` ts 10000, 15500, 24000 | khối `startedAt 10000, durationMs 14000`; không ts → không trường | `thinkingDuration.test.ts` |
| 10 | sanitize: `startedAt NaN`, `durationMs −5`, `ts −1` | trường bị bỏ; `ts 12.9 → 12` | `thinkingDuration.test.ts` |
| 11 | formatClock 17:52 vi/en, 00:05 en, 12:00 en | «17:52», «5:52 PM», «12:05 AM», «12:00 PM» | `ccTimeline.test.ts` |
| 12 | writeLineCount: summary «1,284 lines»; content «a\nb\nc»; content cắt «… [+900]» | 1284; 3; undefined | `ccTimeline.test.ts` |
| 13 | toolDescription: `description` 2 dòng | dòng đầu, kind `description`; không có → lệnh/đường dẫn | `ccTimeline.test.ts` |
| 14 | 3 tool + 3 agent (2 running, tools 5/7/10) | `activityStats.calls = 6`, `agentRowsOf` = 3 agent không trùng | `ccTimeline.test.ts` |
| 15 | 80 tool + 3 agent sống, lượt đang chạy, 420/300/260/900 px | dòng nhóm «83 lệnh gọi công cụ», 3 dòng agent ≤ 60 px, bộ số ở đúng chỗ theo bề ngang, đồng hồ chạy | `shoot.mjs` `assertParallel` |
| 16 | CSS | nạp cuối; reduced-motion tắt nhấp nháy/shimmer; HC chấm viền; không font < 12 px; không nền kín | `ccStyles.test.ts` |
