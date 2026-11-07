# Kiến trúc Locaith AI Agent

Tài liệu này ánh xạ **từng thành phần** trong *Tài liệu đặc tả kiến trúc hệ thống Agent tự chủ (Anthropic Claude Architecture)* sang mã nguồn, và ghi lại những chỗ triển khai khác hoặc bổ sung so với đặc tả.

## 1. Nguyên tắc cốt lõi

**LLM là máy trạng thái và bộ lập lịch.** Không có đồ thị DAG hay `if (user_asks_benchmark) …` nào: lập kế hoạch, tìm kiếm, phát hiện mâu thuẫn dữ liệu, đổi hướng kiến trúc giao diện và viết mã đều diễn ra bên trong **một vòng lặp `while` duy nhất** (`src/core/engine/engine.ts`). Mọi nhà cung cấp (Claude, ChatGPT, Gemini, DeepSeek, Grok, API tương thích OpenAI…) được chuẩn hoá về cùng một dạng tin nhắn và luồng sự kiện (`src/core/types.ts`), nên **vòng lặp không biết gì về từng hãng**.

```
┌──────────────────────────── Webview (Preact) ─────────────────────────────┐
│ Todo tracker · Live thought timeline (chấm cam/xám) · Tool rows · Artifact │   Tầng 1
└───────────────▲──────────────────────────────────────────┬────────────────┘
                │ UiEvent (host gộp ~33 ms)                │ WebviewMessage
┌───────────────┴──────────────────────────────────────────▼────────────────┐
│ Extension host · ChatController (nguồn sự thật: ViewState + SessionState)  │
└───────────────▲────────────────────────────────────────────────────────────┘
                │ emit(UiEvent)
┌───────────────┴────────────────────────────────────────────────────────────┐
│ StreamInterceptor ── thinking ──► khối "Suy nghĩ" + bộ đệm trượt ─► Summarizer│   Tầng 2
│        │              (150–300 token / 1,5 s, không chặn)   (model nhỏ)      │
│        ├─ code trong đối số tool ─► "Đang viết <tệp>…"                        │
│        └─ chữ thường ─► giao diện (đã tách thẻ <think>)                       │
└───────────────▲────────────────────────────────────────────────────────────┘
                │ ProviderEvent (đã chuẩn hoá)
┌───────────────┴────────────────────────────────────────────────────────────┐
│ AgentEngine: while (turn < maxTurns)                                         │   Tầng 3
│   Context Builder → Provider.stream() → Dispatcher (song song) → nối kết quả │
└───┬───────────────────────┬──────────────────────────┬─────────────────────┘
    ▼                       ▼                          ▼
 4A trạng thái &       4B Skill Registry          4C Thực thi & IO
 kế hoạch              (nạp kỹ năng lũy tiến)     web_search · fetch_url · tệp
 todo_write            load_skill / search_skills  terminal · artifact
 scratchpad            SKILL.md (Markdown)
```

## 2. Bản đồ đặc tả → mã nguồn

| Thành phần trong đặc tả | Cài đặt |
| --- | --- |
| **Trụ cột 1** — vòng lặp đơn ReAct + Interleaved Thinking | `src/core/engine/engine.ts` |
| Context Builder (hiến pháp + môi trường + hướng dẫn dự án) | `src/core/engine/context.ts`, `src/core/prompts/constitution.md` |
| Tool Dispatcher (gọi song song, kiểm tra schema, xin phép) | `src/core/engine/dispatcher.ts`, `permissions.ts`, `toolRegistry.ts` |
| **Trụ cột 2** — Documentation-as-Tool-Output, Skill Registry | `src/core/skills/registry.ts`, `builtin.ts`, `skills/*/SKILL.md`, `src/core/tools/meta.ts` (`load_skill`, `search_skills`) |
| Công cụ con mở khoá theo kỹ năng (`list_artifact_types`, `create_artifact`) | `src/core/tools/artifact.ts` (đánh dấu `hidden`, mở bởi `unlocks` trong SKILL.md) |
| **Trụ cột 3** — Stream Summarization | `src/core/engine/interceptor.ts`, `summarizer.ts`, `thinkTags.ts` |
| **Trụ cột 4** — Hiến pháp điều phối (4 nguyên tắc) | `src/core/prompts/constitution.md` |
| 4A `todo_write`, scratchpad | `src/core/tools/meta.ts` |
| 4C Web Search song song, Headless Scraper | `src/core/tools/web/` (`search.ts`, `html.ts`, `ssrf.ts`, `safeFetch.ts`, `web.ts`) |
| 4C Code/Artifact Writer (sandbox) | `src/core/tools/artifact.ts`, `src/host/artifactPanel.ts` |
| Tầng 1 UI: Task tracker, Thought timeline, Artifact sandbox | `webview/src/**`, `src/shared/transcript.ts` (reducer dùng chung) |
| Giao thức SSE đa kênh | `postMessage` có gộp sự kiện: `src/shared/protocol.ts`, `src/host/chatController.ts` |

## 3. Những điểm khác hoặc bổ sung so với đặc tả

1. **`todo_write` thay cả danh sách** (giống Claude Code) thay vì thêm từng tác vụ: LLM ít sinh trùng lặp hơn; engine tự so sánh với danh sách cũ để phát ra đúng các dòng "Đã thêm tác vụ…".
2. **Lập lịch song song có phân loại.** Đặc tả dùng `asyncio.gather` cho mọi lệnh. Ở đây các lệnh *chỉ đọc* liên tiếp chạy song song, còn lệnh *ghi / chạy lệnh* chạy tuần tự đúng thứ tự model phát ra, vì hai lệnh sửa cùng một tệp chạy song song sẽ hỏng dữ liệu.
3. **Hệ thống quyền** (bốn chế độ: hỏi trước / tự nhận chỉnh sửa / lập kế hoạch / bỏ qua) với thẻ xin phép có diff, "cho phép trong phiên này", và các vùng luôn hỏi (ngoài workspace, `.git`, workflow CI, tệp chứa khoá, tệp cấu hình chạy mã như `package.json`). Quyền xét trên **đường dẫn thật** (`src/core/fsutil/paths.ts`: realpath, liên kết treo, tên 8.3, luồng NTFS); "cho phép trong phiên" chỉ áp cho đúng nguyên văn lệnh; lệnh chỉ-đọc theo danh sách cho phép dương (`tools/terminal.ts`).
4. **Mọi đối số công cụ đều được kiểm tra schema** trước khi chạy; đối số bị cụt do `max_tokens` không bao giờ được thực thi.
5. **Tách thẻ `<think>` trong dòng chữ** cho model không có kênh suy luận riêng (Ollama/DeepSeek-R1…), tương ứng "XML Stream Parser" của Tầng 2; chịu được việc thẻ bị chẻ đôi giữa hai gói dữ liệu.
6. **Bộ tóm tắt có cầu dao** (ngừng sau 3 lần lỗi liên tiếp), giới hạn số dòng trạng thái mỗi lượt, và bỏ các bản tóm tắt đến muộn để không lạc ra sau câu trả lời.
7. **Quản lý ngữ cảnh dài:** cắt tỉa kết quả công cụ cũ → tóm tắt hội thoại cũ bằng model nhỏ; chỉ làm giữa các lượt gọi và luôn bỏ khối suy luận cũ (Anthropic "preserved thinking" từ chối khối suy luận khi lịch sử đã bị sửa).
8. **Phòng vệ prompt injection:** nội dung web/tệp/lệnh được coi là dữ liệu; `fetch_url` chặn địa chỉ nội bộ (SSRF), phân giải DNS một lần rồi ghim IP vào kết nối (`safeFetch.ts`) và kiểm tra lại từng bước chuyển hướng; tiến trình con không thừa hưởng khoá API; cài đặt nhạy cảm chỉ đọc từ cài đặt người dùng (`src/host/config.ts`); chuỗi gửi đi được làm sạch UTF-16 (`src/core/textSafe.ts`).

## 4. Lớp nhà cung cấp (`src/core/providers/`)

Mỗi adapter dịch giữa dạng chuẩn (`ChatMessage`, `ProviderEvent`) và API của hãng; **dữ liệu riêng của hãng** (chữ ký suy luận Anthropic, item mã hoá của OpenAI, `thoughtSignature` của Gemini, `reasoning_content` của DeepSeek) được gắn vào từng khối (`block.raw` + `block.provider`) và chỉ được phát lại đúng hãng đã sinh ra nó — nên đổi nhà cung cấp giữa chừng hội thoại vẫn an toàn.

| Adapter | Dùng cho | API | Suy luận |
| --- | --- | --- | --- |
| `anthropic.ts` | Claude | Messages API qua SDK chính thức | `thinking: adaptive` + `output_config.effort`, `display: summarized`; không gửi `temperature`; `eager_input_streaming` để stream mã dài |
| `openaiResponses.ts` | ChatGPT, Grok | Responses API, `store:false` | tóm tắt suy luận + item mã hoá phát lại nguyên trạng giữa các lần gọi công cụ |
| `openaiChat.ts` | DeepSeek, OpenRouter, Ollama, LM Studio, Groq, Together, Mistral… | Chat Completions | `reasoning_content` (DeepSeek), `<think>` (model cục bộ) |
| `gemini.ts` | Gemini | `streamGenerateContent` (SSE) | `thinkingConfig` + `thoughtSignature` |
| `demo.ts` | Chế độ demo | không có | kịch bản có sẵn, offline |

Danh sách model **lấy trực tiếp từ hãng** (`catalog.ts`): bộ đệm 1 giờ khi thành công / 2 phút khi lỗi, dùng lại danh sách cũ nếu hỏi lại lỗi, rơi về danh sách dự phòng chỉ cần *đúng* chứ không cần *đủ*, và model đã lưu mà hãng không còn cung cấp sẽ được thay bằng mặc định. Nhờ vậy dropdown không bao giờ lỗi thời.

## 5. Cách mở rộng

- **Thêm một API tương thích OpenAI** (OpenRouter, vLLM, Ollama, proxy nội bộ…): lệnh *Thêm API tương thích OpenAI…* hoặc `locaithAgent.customProviders` trong settings. Cần kiểu API khác (Anthropic/Gemini/Responses): đặt `kind`.
- **Thêm công cụ:** tạo `ToolDef` trong `src/core/tools/`, đăng ký ở `tools/index.ts`. Đặt `risk`, `concurrencySafe`, và hàm `permission()` nếu cần xin phép.
- **Thêm kỹ năng:** tạo `.locaith/skills/<tên>/SKILL.md` trong workspace (hoặc `~/.locaith/skills`). Định dạng tương thích skill của Claude:

  ```markdown
  ---
  name: bao-gia
  description: Soạn báo giá theo mẫu của công ty — dùng khi khách yêu cầu báo giá.
  tags: [báo giá, khách hàng]
  ---
  # Quy trình
  …
  ```

  Kỹ năng được liệt kê ngắn gọn trong mô tả của công cụ `load_skill`; toàn bộ nội dung chỉ vào ngữ cảnh khi model gọi nó.
- **Thêm adapter cho một API mới** (ví dụ Gemini Interactions): cài `LLMProvider` (`stream`, `complete`, `fetchModels`, `ping`) và thêm vào `createProvider()` ở `registry.ts`.

## 6. Kiểm thử

- `npm test` — kiểm thử đơn vị: engine với provider giả, công cụ trên hệ tệp thật, reducer, bộ tách thẻ, SSE (mọi điểm chẻ chuỗi tiếng Việt), từng adapter với máy chủ SSE giả.
- `node test/vscode/runTest.mjs` — chạy extension trong **VS Code thật** (thư mục dữ liệu riêng): kích hoạt, nạp webview thật (kiểm tra CSP/font/script qua bắt tay `ready`), chạy trọn kịch bản agent ở chế độ demo, mở tab artifact, lưu hội thoại, và luồng **sửa tệp** (thẻ xin phép → `WorkspaceEdit` lên editor đang mở có thay đổi chưa lưu → lưu; nhánh từ chối giữ nguyên tệp). Đặt `ND_TEST_SHOTS=<thư mục>` để chụp ảnh cửa sổ VS Code qua CDP.
- `node webview/dev/shoot.mjs --ime` — kiểm tra hành vi ô nhập với bộ gõ tiếng Việt (Enter khi đang ghép chữ không gửi tin, không xoá chữ đang gõ dở khi host cập nhật trạng thái).
- Các adapter cũng đã được thăm dò với API thật bằng khoá giả (đều trả 401/400 đúng như mong đợi, thông báo tiếng Việt, không lộ khoá) để xác nhận URL gốc, đường dẫn endpoint và header; chưa gọi model thật vì cần khoá thật.

## 7. Bản trình duyệt (Chrome / Edge, `src/browser/`)

Cùng đặc tả, cùng lõi: vòng lặp một `while`, suy luận đan xen công cụ, `todo_write`, nạp kỹ năng lười, công cụ song song, bộ tóm tắt luồng suy nghĩ, hiến pháp điều phối. Khác ở bề mặt:

| Khái niệm | Bản VS Code | Bản trình duyệt |
| --- | --- | --- |
| Nơi engine chạy | extension host (Node) | **trang side panel** (không phải service worker — SW bị dừng sau ~30 giây rảnh; đóng khung = dừng tác vụ) |
| Cầu nối UI ↔ controller | `postMessage` qua webview | cùng một trang: `installBridge` + `MessageEvent` tổng hợp (`isTrusted=false`); mọi message thật bị chặn nên iframe không giả mạo được host |
| Công cụ "thế giới thật" | tệp, grep, terminal | **trang web**: `page_read` / `page_snapshot` / … chạy qua `page/runtime.ts` nạp bằng `chrome.scripting` vào thế giới ISOLATED |
| Quyền | vùng workspace, lệnh | theo **origin**: tab neo/tab của trợ lý chỉ tin cậy ở origin đã duyệt (`TabScope`); khoá phiên `browser:read|act|nav:<origin>`; yêu cầu "nâng cao" không ghi nhớ được |
| Hiến pháp | `constitution.md` | `constitutionFor('browser')` = cùng bốn điều lệ + phần mở đầu và "Working with tools" của `constitution.browser.md` |
| Kỹ năng | 6 kỹ năng, nạp `artifacts` mở công cụ artifact | bỏ `software-engineering`, thêm `browser-control` mở 11 công cụ thao tác |
| Ngữ cảnh động | `<ide_context>` (tệp, vùng chọn) | `<browser_context>` (tab đang xem, đoạn bôi đen) — vẫn nằm ở tin nhắn người dùng, không vào system prompt |
| Khoá API | SecretStorage (OS) | `chrome.storage.local` (không mã hoá — nêu rõ trong README) |
| Phiên | tệp JSON | IndexedDB, nội dung trang đã đọc bị lược khi lưu (`storageRedact.ts`) |

Ràng buộc nền tảng đã xử lý: MV3 cấm `unsafe-eval` (Ajv → `shims/ajv.ts` thông dịch, đối chiếu Ajv thật trong test); băm đồng bộ (`shims/crypto.ts`); `chrome.scripting.executeScript` không trả về khi trang điều hướng giữa chừng (`api.ts` đua với `tabs.onUpdated`); `captureVisibleTab` chỉ nhận `<all_urls>`/activeTab; artifact HTML chạy trong trang `sandbox` khai báo ở manifest (origin riêng, CSP không mạng).

Kiểm thử: `test/browser` (đơn vị: chính sách, công cụ qua dispatcher thật với trình duyệt giả, controller, cấu hình, manifest sản phẩm) và `test/browser-e2e` (Edge + Chrome thật, headless, `puppeteer-core` `enableExtensions` + `installExtension`).

**Mô hình đe doạ & các chốt chặn (sau đợt rà soát 0.2.1).** Kẻ tấn công là TRANG WEB (nội dung, tiêu đề, thuộc tính, cấu trúc DOM) cố điều khiển mô hình rồi dùng quyền của người dùng. Chốt chặn, từ ngoài vào trong:
1. *Dữ liệu ≠ lệnh*: mọi chuỗi bên thứ ba qua `wrapPage` (khung có mã ngẫu nhiên mỗi lần gọi) / `safeInline` / `safeUrl` (lọc ký tự vô hình, bidi, "ký tự thẻ"; vô hiệu thẻ giả). Bộ đọc trang chỉ lấy chữ NHÌN THẤY (`boxHidden` + `textHidden` trong `page/runtime.ts`; không có phương án dự phòng `innerText`).
2. *Quyền theo origin* (`TabScope`): tab neo/tab của trợ lý chỉ tin cậy ở origin đã duyệt; tab khác luôn hỏi (không có `autoInAcceptEdits`); **cờ "nhiễm"** (`tainted`) bật khi nội dung tab khác đã vào ngữ cảnh → hết tự duyệt thao tác trang. `elevated` (ngân hàng/thanh toán, gửi biểu mẫu nhạy cảm, đích biểu mẫu sang origin khác hoặc bị che, văn bản dài sau khi nhiễm) không ghi nhớ được cả phiên.
3. *Đọc đúng cái sẽ xảy ra*: đích biểu mẫu đọc qua getter của nguyên mẫu gốc (`formOf/formActionOf/formControls/submitForm` — chống DOM clobbering), tính `formaction`; `describe` trả chữ nhìn thấy + nhãn trợ năng lệch; `changedSinceApproval` so lại ngay trước khi thực hiện.
4. *Không để model nhập bí mật*: ô mật khẩu/thẻ/OTP bị công cụ từ chối (`classifySensitive`, nhận diện theo TỪ).
5. *Lưu trữ*: `storageRedact.ts` lược nội dung trang khi lưu và KHÔNG lưu `approvals`; `settleForExit` chốt công cụ đang chạy thành "đã huỷ" khi đóng khung.
6. *Nén ngữ cảnh*: kết quả công cụ bên thứ ba bị cắt ngắn và đánh dấu cho bộ tóm tắt (`compaction.ts`) để lời dụ không "rửa" qua bản tóm tắt thành tin nhắn tin cậy.
7. *Artifact*: markdown thoát HTML thô; SVG cấm `foreignObject`/script; ở vỏ `artifactSanitize.ts` bỏ `<link rel=prerender|preconnect…>`; `INNER_PRELUDE` chặn mã tạo `<link>` lúc chạy. Đo thực nghiệm (31 kênh, Chrome/Edge 156): CSP + sandbox chặn hết trừ `prerender`/`preconnect` — hai kênh đó là lý do của hai lớp trên; test canary trong e2e theo dõi hành vi trình duyệt.

**Hiện diện, con trỏ ảo & không giành tab.** `presence.ts` (`Presence`) quyết định KHI NÀO hiện/gỡ lớp phủ; phần vẽ nằm trong `page/overlay.ts` (chạy trong runtime của trang): host `[data-nd-overlay]` với shadow DOM ĐÓNG (stylesheet dựng bằng `adoptedStyleSheets` nên CSP `style-src` của trang không chặn), `pointer-events:none` trừ nút Dừng (chỉ nhận `isTrusted`), TTL 15 s gia hạn bằng nhịp 4 s; `deepElementFromPoint` bỏ qua host nên thanh nằm đè lên nút của trang không bị tính là "che". `Presence.begin/end` gắn vào `setRunning` của controller; công cụ trang gọi `touch(tab, 'read'|'act')` ngay trước `execute` (bọc ở `tools/index.ts`; chụp màn hình báo SAU khi chụp thành công để khỏi chạy đua với lệnh ẩn lớp phủ). Mọi thao tác trên cùng một tab được xếp hàng để lệnh gỡ không bị lệnh bật đến trước chạy đè. Gọi vào runtime cho việc này đi đường riêng (`ChromeBrowserApi.pageCall`), không qua `callRuntime`, để không giẫm lên theo dõi lời gọi đang chạy (`__inflight` là TẬP các id). Nút Dừng gửi `{type:'nd-presence-stop'}` về khung chat (`chrome.runtime.onMessage` trong `panel.tsx`, chỉ nhận `sender.id` của chính tiện ích + có `sender.tab`, và chỉ khi tab đó đang có lớp phủ của lượt này).
**Con trỏ ảo + số bước.** Thao tác lên MỘT phần tử (`runAction` với `opts.act`) xin `Presence.action(tab, kind, what)` → `ActionFx { n, kind, verb, what, show? }`: `n` là số bước tăng suốt cuộc trò chuyện (`resetSteps` khi đổi/xoá cuộc; mở lại cuộc cũ thì nối tiếp từ số lớn nhất trong bản ghi), `show` (có khi hiệu ứng đang bật và lượt còn chạy) cho runtime đủ dữ liệu để TỰ dựng lớp phủ nếu chưa có — khỏi phụ thuộc thứ tự với lệnh "bật" chạy ngầm. `fx` đi kèm tham số của `click/type/selectOption/hover`; runtime gọi `aim()` (khung đánh dấu + con trỏ bay tới, chờ bay xong nếu tab đang hiện và không bật giảm chuyển động) → kiểm tra "bị che" → `strike()` (vòng sóng + dấu số, CHỈ khi thao tác thật sự diễn ra). Dấu số giữ `WeakRef` tới phần tử và đặt lại vị trí theo `getBoundingClientRect` khi cuộn/đổi cỡ/nhịp gia hạn. `ToolResult.step` → `tool_end.step` → `ToolBlock.step` (huy hiệu ở `ToolRow`); dòng đầu kết quả cho mô hình: "Bước N · … — tại <địa chỉ trước khi thao tác>".
**Không giành tab.** `runAction`/`tab_open`/`tab_activate` không còn `tabs.update({active:true})` (trừ khi `focusTabs` hoặc `show:true`); tab neo là trạng thái của `TabScope` chứ không phải "tab đang hiện" nên người dùng chuyển tab không đổi đích của trợ lý. **Chụp màn hình** là việc duy nhất cần tab đang hiện: `capture()` chụp thẳng tab đang hiện; tab nền → `BackgroundTabError` (công cụ trả lời có hướng dẫn) trừ khi `allowFlip` (= `focusTabs`): khi đó nhớ tab đang hiện của cửa sổ, đưa tab đích lên, đợi 2 khung hình, ẩn lớp phủ (và đợi vẽ xong), chụp, rồi trả về tab cũ — trừ khi người dùng đã tự chuyển sang tab khác. ĐÃ ĐO (Chrome 156, Edge 156, bỏ các cờ `--disable-backgrounding…` của puppeteer để giống trình duyệt thật): `chrome.debugger` + `Page.captureScreenshot` trên tab ĐANG ẨN treo quá 8 s, nên không có đường chụp tab nền mà không chuyển tab. `guardForeground` canh `tabs.onCreated`/`onActivated` trong lúc thao tác: tab mới do tab nguồn hoặc tab đang xem mở ra mà bị trình duyệt đưa lên trước thì trả người dùng về ngay (Chrome ghi tab ĐANG HIỆN làm `openerTabId` khi tab nguồn nằm nền, nên `runAction` nhận tab theo `opener ∈ {nguồn, đang xem}` + cùng site với liên kết). `markAssistantTab` gom tab trợ lý mở vào nhóm `tabGroups` tên "Locaith AI" màu `cyan` (bỏ qua tab ghim/cửa sổ popup; lỗi chỉ nuốt vì đây là dấu hiệu nhận biết). Runtime trong trang mang `RUNTIME_VERSION` (`page/version.ts`): `callRuntime` coi bản khác là "thiếu" và nạp lại.

**Đăng nhập OAuth (`oauth.ts`).** `OAuthManager` thuần (kiểm thử bằng kho/`fetch`/cửa sổ đăng nhập giả): PKCE S256 + `state`, địa chỉ chỉ https (http chỉ localhost), lỗi không bao giờ chép nguyên văn phản hồi, một phiên đăng nhập một lúc, làm mới đơn luồng với refresh token xoay vòng. Hai luồng: `openrouter` (đổi mã lấy KHOÁ API → kho khoá) và `oauth2` (access/refresh token ở `nd.oauth`; `resolveKey` ưu tiên token). `chrome.identity.launchWebAuthFlow` chạy được trên Edge/Chrome 156 headless (đã đo) nên e2e đi qua API thật, chỉ trang đăng nhập là giả. Không có đăng nhập bằng gói thuê bao Claude/ChatGPT/Gemini (xem README).


## 8. Tệp tải lên và lịch sử an toàn (0.3.0)

**Đọc tệp (`src/shared/doc*.ts`, `pdfText.ts`).** Ba tầng, tách để trang tiện ích trình duyệt không phải nạp phần nặng:
- `docKinds.ts` — loại tệp (đuôi → `DocKind`), giới hạn (25 MB, 5 tệp/tin nhắn), `docCharBudget(contextTokens)` (~40% cửa sổ ngữ cảnh, kẹp 60k–300k ký tự). Giao diện dùng trực tiếp.
- `docWrap.ts` — phần NHẸ: `DocError`, kiểu `ExtractedDoc`/`DocExtractor`, lọc ký tự vô hình, `wrapUploaded` (khung `<tep_tai_len id=… ten=… loai=…>` mã ngẫu nhiên + lời nhắc “dữ liệu, không phải chỉ dẫn”), `buildDocParts` (gom các đính kèm `kind:'doc'` theo MỘT ngân sách chung; kiểm lại mọi trường vì giao diện không đáng tin), `parseUploadedDocument` (base64 → bộ đọc → `{doc}|{error}`, không bao giờ ném). Cả hai controller và hai bộ dựng tin nhắn (`host/userContent.ts`, `browser/context.ts`) chỉ phụ thuộc tầng này.
- `docExtract.ts` + `pdfText.ts` — phần NẶNG: `fflate` (zip), bộ tách thẻ cho OOXML (`w:vanish`, trang tính ẩn, chuỗi dùng chung, số/ngày), `node-html-parser` qua `htmlToMarkdown({fullDocument})`, CSV/TXT với đoán bảng mã, PDF qua `unpdf` (nạp lười; luôn đưa `new Uint8Array(bytes)` vì host Node trả `Buffer` mà pdf.js từ chối). Không DOMParser, không `eval`.

Luồng: ô nhập đọc tệp → base64 → `parse_document` → controller gọi bộ đọc → `document_parsed` (`DocInfo` kèm chữ) → chip. Khi gửi, `AttachmentInfo{kind:'doc', doc}` đi cùng tin nhắn; builder bọc khung rồi **bản hiển thị bỏ chữ** (chữ chỉ nằm trong tin nhắn gửi mô hình). Controller giữ bản đầy đủ của tin cuối (`docStash`) để “Sửa tin nhắn cuối” trả tệp về ô nhập. Trình duyệt: bộ đọc là `docparse.js` (ESM riêng, mục tiêu esbuild `docparse`) nạp bằng `import(chrome.runtime.getURL(…))` ở lần đầu; test nền tảng bảo đảm `panel.js` không chứa pdf.js/`eval` còn `docparse.js` không chứa `eval`. VS Code: gọi thẳng `extractDocument` trong host; `userContent.ts` còn đọc `@x.pdf|docx|xlsx` trong workspace qua `host.readBytes`. Trình duyệt: có tệp tải lên → `scope.taint()` (xem §7, cờ “nhiễm”).

**Tệp bối cảnh qua lần nén (`core/engine/compaction.ts`).** `summarizeHistory` tách các khối `<tep_tai_len>` khỏi phần đem tóm tắt (thay bằng một dòng), chọn tối đa `pinnedDocChars` (tệp MỚI nhất trước), rồi thêm vào tin nhắn tóm tắt một khối `<tep_boi_canh_cua_phien>` chứa nguyên văn các khối đó (kèm ghi chú nếu có tệp bị lược). `collectDocBlocks` chỉ nhìn các khối `text` của tin nhắn **user** và bỏ qua mọi khung `<trang_web id=…>…</trang_web id=…>` (mã ngẫu nhiên nên trang không giả được thẻ đóng) — chặn “rửa lời dụ qua bước nén”: nội dung web/kết quả công cụ không thể giả làm tệp để vào tin nhắn tóm tắt tin cậy. Nén nhiều lần: khối đã ghim nằm trong tin tóm tắt cũ nên được nhận lại (bỏ trùng theo mã).

**Kho lịch sử (`shared/sessionStore.ts`).** Vẫn là “thư mục phẳng gồm các tệp có tên” trên `StoreIO`, chỉ mục tự lành. Thêm: (1) **không giới hạn số cuộc** (bản cũ xoá cuộc cũ nhất khi quá 200); (2) **Thùng rác**: `trash.<id>.json` (= phiên + `deletedAt`) và `trash.index.json`; `moveToTrash` ghi bản thùng TRƯỚC rồi mới gỡ bản sống, `restore` ghi bản sống TRƯỚC rồi mới gỡ bản thùng, `syncTrash` cho bản sống thắng khi còn cả hai và dọn mục quá `TRASH_DAYS` (30) ngày — gián đoạn ở bất cứ bước nào đều không mất dữ liệu; tên `trash.*.json` không khớp `SESSION_FILE` (`[\w-]+\.json`) nên không lẫn vào danh sách; (3) `exportSessions` / `importSessions` / `importBackupText`. `list()`/`listTrash()` luôn đi cùng nhau qua `listings()` của controller (`ViewState.sessions` + `ViewState.trash`).

**Tệp sao lưu (`shared/sessionBackup.ts`).** `{format:'ai-agent-sessions', version:1, exportedAt, app, sessions:[{workspace, session, transcript, deletedAt?}]}` — JSON gọn, lossless (tin nhắn gửi mô hình gồm cả chữ tệp bối cảnh). Ghi: `makeBackup` luôn đặt `approvals: []`. Đọc (`parseBackup` → `sanitizeBackupSession`) coi tệp là KHÔNG đáng tin: giới hạn dung lượng/số cuộc/số tin, id theo `[\w-]{1,80}`, khối nội dung chỉ nhận `text`/`image`(mediaType ảnh)/`tool_use`/`tool_result` (bỏ `thinking` — gắn với lịch sử gốc, đặt `historyEdited`), chế độ `bypass` → `default`, `approvals`/`readFiles` đặt lại, giao diện chỉ giữ trường tối thiểu (khối công cụ đang chạy → `cancelled`; chữ tệp không nhân đôi trong giao diện), artifact chỉ nhận id an toàn. `importSessions` không bao giờ ghi đè (bản y hệt/mới hơn → bỏ qua; khác → bản sao có hậu tố; cuộc đang ở thùng mà tệp có bản sống → bản sống thay). Xuất bản trình duyệt đọc từ KHO (đã qua `storageRedact`) nên không lộ nội dung trang đã đăng nhập; VS Code lưu bằng `showSaveDialog` (mặc định thư mục cá nhân, không phải workspace).

**Giao thức.** `AttachmentInfo.kind` thêm `'doc'` (+ `DocInfo`); `parse_document` ↔ `document_parsed`; `restore_session`, `purge_session`, `empty_trash`, `export_backup {id?}`, `import_backup {name,text}`; `ViewState.trash`.

Kiểm thử: `test/docExtract.test.ts` (tệp thật: PDF, DOCX qua thư viện `docx`, XLSX dựng tay, HTML/CSV/TXT, chữ ẩn, giới hạn), `test/docWrap.test.ts`, `test/compactionDocs.test.ts`, `test/sessionTrash.test.ts` (Thùng rác, sao lưu, khôi phục, chuẩn hoá dữ liệu không đáng tin), phần “tệp tải lên” và “Thùng rác, sao lưu” của `test/browser/controller.test.ts`, `@x.pdf` trong `test/host.test.ts`, và e2e Edge + Chrome thật (chọn PDF/Word/Excel, kéo-thả CSV, sửa tin nhắn cuối, xoá → Thùng rác → khôi phục → sao lưu → xoá vĩnh viễn → khôi phục từ tệp).


## 9. Điều phối nhiều AI, agent con, MCP, plugin và Chợ (0.5.0)

Tất cả nằm trong `src/core` (không phụ thuộc `vscode`) trừ lớp nối ở `src/host`. Vòng lặp một `while` của engine **không đổi**: các thành phần dưới đây chỉ cắm vào qua `LLMProvider` (điều phối) và `ToolRegistry` (agent, MCP).

| Thành phần | Tệp | Vai trò |
| --- | --- | --- |
| Phân hạng model | `orchestration/tiers.ts` | `top` / `balanced` / `fast` — lấy `ModelInfo.tier` của adapter, nếu thiếu thì suy ra từ tên |
| Kho model | `orchestration/pool.ts` | `ModelPool`: chỉ gồm nhà cung cấp **đã có khoá** (trừ demo/Auto); `rank(tier)` trả chuỗi đích theo hạng; cooldown khi bị giới hạn; đếm lượt dùng để chia tải; cổng đồng thời theo hãng |
| Dự phòng | `orchestration/failover.ts` | `FailoverProvider` bọc một chuỗi đích; chuyển đích khi lỗi `rate_limit/overloaded/server/network/timeout/auth/not_found` **trước khi có chữ nào được phát**; đã phát giữa chừng thì ném lỗi cho engine (không trộn hai câu trả lời). An toàn khi đổi hãng nhờ `BlockOrigin` (adapter chỉ phát lại khối suy luận do chính nó sinh ra) |
| Locaith Auto | `orchestration/autoProvider.ts` | Nhà cung cấp ảo `locaith-auto`: kế hoạch hoặc suy luận cao → `top`, còn lại → `balanced`; bám hãng cũ trong cùng phiên; đăng ký bằng `ProviderRegistry.addExtraProvider` |
| Agent con | `agents/definitions.ts`, `runner.ts`, `tools.ts` | Phiên mới (`newSession`) + `AgentEngine` mới + kho công cụ thu hẹp (`buildSubRegistry`); chọn đích bằng `resolveChain` (tắt điều phối ⇒ kế thừa model của phiên cha); thẻ xin phép của agent con được chuyển lên giao diện chính với `callId` có tiền tố `<callId cha>~<callId con>`; agent có quyền ghi/chạy lệnh dùng chung một khoá ghi (`writeLock`) |
| Workflow | `agents/workflow.ts` | `worker_threads` (môi trường rỗng) + `vm` không có `eval`/`Function`; cầu nối `bridge` là hàm không có prototype chỉ truyền chuỗi JSON; `agent/parallel/pipeline/store/phase/log`; trần cứng 16 đồng thời, 1.000 agent/lần; hạn giờ và `AbortSignal` giết worker |
| MCP | `mcp/client.ts`, `manager.ts`, `presets.ts` | JSON-RPC 2.0 qua stdio hoặc HTTP; `McpManager` quản lý vòng đời + đăng ký công cụ `mcp__<server>__<tool>` vào **mọi** kho công cụ đang mở (`attach`), duyệt theo băm cấu hình cho server từ workspace/plugin |
| Plugin | `plugins/loader.ts` | Quét `plugin.json` / `.claude-plugin/plugin.json`, chặn đường dẫn thoát khỏi thư mục plugin, đọc `skills/`, `agents/`, `commands/`, `.mcp.json` |
| Chợ | `market/market.ts`, `scripts/build-market.mjs` | `market/index.json` + `market/skills.zip` (fflate); `install` giải nén đúng một kỹ năng, chặn `..`, không ghi đè thư mục không có dấu `.locaith-market.json` |

Luồng quyền: agent con và công cụ MCP đi qua cùng `decidePermission` + `host.requestPermission` như công cụ thường; `workflow_run` và công cụ MCP khai báo `permission()` nên luôn hỏi (trừ chế độ `bypass`). Cấu hình nhạy cảm (`orchestration.mode`, `mcp.servers`, `plugins.paths`, `agents.maxConcurrent`) nằm trong `SECURE_KEYS` — chỉ đọc từ cài đặt người dùng.

Kiểm thử: `test/orchestration.test.ts` (phân hạng, kho, dự phòng, Auto), `test/workflow.test.ts` (runtime, hộp cát, hạn giờ, Dừng), `test/mcp.test.ts` (stdio với server giả, HTTP/SSE, quản lý, duyệt), `test/agents.test.ts` (định nghĩa, thu hẹp công cụ, chọn đích, đầu-cuối `agent`/`workflow_run` với engine thật), `test/plugins-market.test.ts`.

### Hàng đợi tin nhắn (steering)

Người dùng gửi thêm tin khi agent đang chạy: `ChatController` đặt tin vào `queue` (đã dựng nội dung bằng `buildUserContent` trên bản nháp `readFiles`; chỉ gộp vào phiên khi tin thật sự được giao). Engine nhận một callback `takeQueued()` (tuỳ chọn — agent con và bản trình duyệt không khai báo) và gọi ở hai ranh giới của vòng lặp `while`:

1. **Sau lượt công cụ**, trước lần gọi model kế tiếp: tin được thêm vào CHUNG tin nhắn user chứa `tool_result` (`[...kết quả, dòng báo steer, ...tin]`) — mỗi tin assistant chỉ được theo sau bởi MỘT tin user nên vai trò vẫn xen kẽ ở mọi hãng; cả bốn adapter đã xử lý tin user vừa có kết quả công cụ vừa có chữ. Vì vậy `atBoundary` (ranh giới lượt, nơi được phép xoá khối suy luận khi tiền tố prompt đổi) loại các tin có `tool_result`: nếu không, suy luận của tin assistant đang chờ kết quả bị xoá giữa vòng công cụ → Anthropic trả 400 (có test đột biến).
2. **Khi model dừng mà không gọi công cụ**: tin thành lượt user kế tiếp của CÙNG lần chạy.

Giao diện: engine đóng đoạn trả lời hiện tại (`assistant_end`), phát `user` (cờ `steer` nếu chèn giữa vòng công cụ), rồi mở đoạn mới (`assistant_start` với id mới) — `run_state` là sự kiện riêng nên `running` không đổi. Hậu quả: một lần chạy có thể có nhiều đoạn assistant; thử lại/sửa tin cuối chọn điểm bắt đầu là tin user KHÔNG có `steer` và không chứa `tool_result`. Dừng hoặc lỗi nhà cung cấp → tin chưa giao quay về ô nhập (`insert`); kết thúc bình thường mà còn tin → `drainQueue` chạy chúng như một lượt mới trong cùng khoá `runAgentTurn` (tin mới không chen ngang hàng đợi). Lệnh gạch chéo và nén ngữ cảnh vẫn từ chối khi bận. `ViewState.canQueue` do host VS Code bật; giao diện không có cờ này (bản trình duyệt) giữ nguyên hành vi cũ.

Kiểm thử: `test/queue.test.ts` (engine, transcript, sao lưu) và bước 13 của `test/vscode/suite.cjs` (VS Code thật: giữa chừng, cuối lượt, xoá, sửa, Dừng, hàng đợi đầy, lệnh gạch chéo).

## 10. Kết nối, bộ nhớ, Chrome, lịch sử (0.5.1)

| Thành phần | Tệp | Vai trò |
| --- | --- | --- |
| Kho kết nối | `core/mcp/catalog.ts` | Danh mục dịch vụ MCP (HTTP/stdio), ghi rõ kiểu đăng nhập; mục không hỗ trợ kèm lý do |
| OAuth MCP | `core/mcp/oauth.ts`, `oauthFlow.ts` | Khám phá (RFC 9728/8414), đăng ký tự động (RFC 7591), PKCE S256 + `resource`, làm mới token (một lần dù nhiều yêu cầu cùng gặp 401); `McpClient` nhận `McpAuth` và gửi lại một lần khi 401 |
| Dịch vụ kết nối | `host/connectors.ts` | Cổng loopback tạm nhận chuyển hướng; token chỉ ở SecretStorage; GitHub dùng phiên VS Code hoặc PAT |
| Bio-Memory | `host/bioMemory.ts`, `core/mcp/bioInstall.ts` | Cài vào venv riêng; một `STORAGE_DIR` + `workspace-id` cố định cho mọi phiên; `autoAllow` công cụ chỉ đọc; hook `onCompacted` của engine lưu bản tóm tắt trước khi chi tiết cũ biến mất |
| Chợ plugin | `core/plugins/marketplace.ts` | Đọc `marketplace.json`, tải zip từ codeload, giải nén đúng thư mục con (chặn `..`), ghi dấu `.locaith-plugin.json`; không cài nguồn ngoài GitHub |
| Cầu Chrome | `core/chrome/bridge.ts`, `tools.ts`, `host/chrome.ts` | Máy chủ HTTP 127.0.0.1 (long-poll), ghép đôi bằng mã một lần, token 256 bit trong SecretStorage dùng chung mọi cửa sổ, kiểm Host/Origin; công cụ `chrome` ẩn, `NEVER_FOR_SUB` |
| Swarm | `core/types.ts`, `engine.ts`, `context.ts`, `agents/tools.ts` | `ThinkingLevel` thêm `swarm`; engine gửi nhà cung cấp mức `max`, mở `workflow_run`, thêm khối `<swarm_mode>`; ngân sách mặc định lớn hơn nhưng không vượt trần cứng |
| Hàn gắn lịch sử | `shared/transcriptRebuild.ts`, `sessionStore.ts` | Dựng lại transcript từ `messages` khi ít lượt hơn; `backupRaw` giữ bản gốc một lần; `listAll` thấy mọi thư mục |

Kiểm thử: `test/{bridge,chromeTool,connectors,bio,pluginMarket,swarm,historyHeal}.test.ts`, bước 14 của `test/vscode/suite.cjs` (VS Code thật). Phía extension Chrome 0.4.2 được thử bằng Chromium thật (ghép đôi qua CORS thật, duyệt trang, điều khiển trang) — kịch bản nằm ngoài kho này.

## 11. Điểm cắm của engine — `RunExtension` (0.7.0)

Vòng lặp `AgentEngine.run()` là trục của hệ thống; mọi tính năng "quanh vòng lặp" (cổng hoàn thành, kiểm tra độc lập, hook của người dùng, chốt chặn kỷ luật, thông báo tác vụ nền, chẩn đoán IDE…) **không** được chèn thẳng vào thân hàm đó. Mỗi tính năng là một `RunExtension` nằm trong tệp riêng (`src/core/engine/seams.ts` định nghĩa giao diện):

| Móc | Khi nào | Có thể làm gì |
|---|---|---|
| `begin(scope)` | đầu mỗi `run()` | trả về bộ móc riêng cho lần chạy (trạng thái nằm trong closure) |
| `beforeModel(turn)` | trước mỗi lần gọi model | trả về chữ để nối vào lịch sử (được lưu) |
| `toolBefore(call, def, ctx)` | sau khi đối số hợp lệ, **trước** khi hỏi quyền | chặn (`{block}`) hoặc sửa đối số (`{input}`) |
| `toolAfter(call, def, ctx, result)` | sau khi công cụ chạy xong | sửa/ghi chú vào kết quả |
| `queuedTurn()` | tin xếp hàng thành lượt kế tiếp | đặt lại trạng thái theo lượt |
| `finalize(ctx)` | model dừng mà không gọi công cụ | `accept` / `continue` (buộc làm tiếp) / `halt` |
| `end(info)` | mọi đường thoát | dọn dẹp, ghi vết |

Quy ước: ngoại lệ trong một móc **không** làm hỏng lần chạy (ghi log, coi như móc đó không làm gì); `finalize` — extension đầu tiên trả về khác `accept` thắng. `RunTrace` (do engine cập nhật) cho extension biết lần chạy đã thực sự ghi tệp, chạy lệnh gì, qua những công cụ nào.

Đăng ký: `src/core/engine/extensions/index.ts` (dùng chung mọi bề mặt: VS Code, Chrome, CLI, agent con) và `src/host/hostExtensions.ts` (chỉ VS Code). Lệnh gạch chéo mới đăng ký qua `src/host/slashRegistry.ts`. Mỗi tính năng có sẵn một dòng riêng ở các tệp đăng ký để nhiều người sửa song song mà git gộp không xung đột.
