# Locaith CLI — kiến trúc và đặc tả (bản dựng lại 0.4.0)

Mục tiêu: gõ `locaith` trong terminal ra một trợ lý lập trình **đầy đủ và đẹp như Claude CLI / Codex CLI**, dùng **cùng lõi** với extension VS Code
(cùng engine, công cụ, kỹ năng, hooks, checkpoints, tác vụ nền, MCP, quyền, nén ngữ cảnh), cài bằng `pip install locaith-cli` là chạy.

Nguồn gốc yêu cầu: chủ dự án (anh Tuấn Anh) duyệt ngày 08/11/2026. Đây là yêu cầu TRỰC TIẾP và còn hiệu lực; tin nhắn sau đó trong phiên điều phối không thay thế nó.

## 1. Ba tầng

```
src/cli/index.ts        cửa vào: đọc cờ → chọn chế độ (tương tác / in một lần / lệnh con)        [điều phối viên]
src/cli/runtime/        LÕI CHẠY không giao diện: createRuntime(opts) → CliRuntime               [lane cli-rt]
src/cli/runtime/features/  tính năng cắm vào lõi qua FeatureModule                               [lane cli-features]
src/cli/tui/            GIAO DIỆN terminal tự viết, chỉ biết CliRuntime                           [lane cli-tui]
src/cli/runtime/contract.ts   HỢP ĐỒNG giữa ba bên (đọc kỹ; chỉ thêm trường tuỳ chọn)
src/cli/i18n.ts         chuỗi vi/en (registerStrings / t)
```

Quy tắc:
- `src/core` KHÔNG import `vscode` (140 tệp) và dùng lại nguyên vẹn. Trong `src/host`, 22/46 tệp không import `vscode` (host/extensions/*, host/checkpoints/*,
  slashRegistry, sessionsUx, commandModel, userContent, connectors…): dùng lại được. Tệp import `vscode` (chatController, vscodeHost, config, hooks/hostHooks…)
  **không được import vào CLI** (esbuild sẽ kéo cả `vscode` vào): đọc làm tài liệu rồi viết bản CLI trong `src/cli/`.
- KHÔNG sửa tệp của extension trừ khi bắt buộc để tái dùng (ví dụ tách hàm thuần ra khỏi tệp có `vscode`); nếu sửa, thay đổi phải thuần tuý
  (không đổi hành vi) và test của extension vẫn xanh. Ưu tiên bọc/sao chép nhỏ trong `src/cli/` hơn là động vào lõi.
- Không thêm phụ thuộc chạy (dependencies) mới: bundle một tệp `dist-cli/locaith.cjs` (esbuild, Node ≥ 20). Chỉ devDependencies cho kiểm thử
  (`@xterm/headless`, `@lydell/node-pty` đã có sẵn trong node_modules dùng chung).
- Bản dựng: `npm run build:cli` → `dist-cli/locaith.cjs`. Kiểm kiểu: `npx tsc -p tsconfig.json --noEmit` (hiện bao `src/**`; nếu `src/cli/**` có kiểu
  Node cần thì dùng `@types/node` sẵn có). Test: `npx vitest run test/cli/...` (chỉ chạy test của lane mình; cả bộ chỉ chạy MỘT lần cuối).

## 2. Tái dùng — bản đồ nhanh

| Việc | Dùng lại | Ghi chú |
|---|---|---|
| Vòng agent | `core/engine/engine.ts` (`AgentEngine`), `core/engine/types.ts` (`ToolHost`, `EngineSettings`, `newSession`) | công thức dựng engine mỗi lượt: `host/chatController.ts` hàm `createEngine()` (~dòng 1600–1725) |
| Extension chạy chung | `core/engine/extensions/index.ts` → `coreRunExtensions()` | |
| Extension phía host | `host/hostExtensions.ts` + `host/extensions/{permissionRules,hooks,backgroundTasks,verifier,ideDiagnostics}.ts` | nhận `HostExtensionContext` (dính `ControllerDeps`): dùng bản CLI mỏng gọi cùng lõi |
| Host công cụ Node | `core/host/nodeHost.ts` (`NodeToolHost`), `core/host/bgProcess.ts`, `core/host/shell.ts` | CLI hiện có `CliHost` trong index.ts (cũ) |
| Công cụ, kỹ năng | `core/tools/index.ts` (`createToolRegistry`), `core/skills/*`, `skills/*/SKILL.md` | |
| Nén ngữ cảnh | `core/engine/{compaction,compactTuning,toolResultClearing,summarizer}.ts` | CLI cũ truyền `summarizer: null` ⇒ KHÔNG nén thật — phải sửa |
| Ký ức, hướng dẫn dự án | `core/engine/{memory,instructions}.ts` | `LOCAITH.md`, `AGENTS.md`, `CLAUDE.md`; `.locaith/memory/MEMORY.md` |
| Hooks | `core/hooks/*` | cài đặt `hooks` cùng lược đồ Claude Code; chạy shell, JSON stdin, mã 2 = chặn |
| Checkpoints/rewind | `host/checkpoints/{store,restore,feature}.ts` (không dính vscode) | kho: `~/.locaith/checkpoints/<phiên>/` |
| Tác vụ nền | `core/tasks/backgroundTasks.ts`, `host/extensions/backgroundTasks.ts`, `shared/bgTasks.ts` | |
| MCP | `core/mcp/*` (`McpManager`, catalog) | đọc `.mcp.json` (dự án), `~/.locaith/mcp.json`, cài đặt `mcpServers` (lược đồ Claude: `{command,args,env}` / `{url}`) |
| Lệnh tuỳ chỉnh, agent, plugin | `core/commands/*`, `core/agents/*`, `core/plugins/loader.ts` (`expandCommand`) | `.locaith/commands/*.md`, `~/.locaith/commands`, `.claude/commands` tuỳ chọn |
| Lệnh gạch chéo | `host/slashRegistry.ts` (`SlashRegistry`) | CLI đăng ký qua `FeatureContext.slash` |
| Phiên | `shared/sessionStore.ts` (trừu tượng ghi tệp), `shared/transcript.ts` (`reduceView`, `newId`), `shared/transcriptRebuild.ts` (`reconcileTranscript`), `shared/sessionMeter.ts` | |
| Quyền | `shared/permissionRules.ts`, `core/engine/permissions.ts`, `host/permissionsFeature.ts` (đọc để biết cách «Luôn cho phép») | |
| @tệp, tài liệu | `host/userContent.ts` (`buildUserContent`), `shared/docExtract.ts` | |
| Đăng nhập tài khoản | `cli/account.ts`, `cli/browserLogin.ts`, `core/account/*`, `core/providers/locaithGateway.ts`, `core/providers/gatewayDiagnostics.ts` | |
| Nhà cung cấp khác (BYOK) | `core/providers/{index,presets,registry,service}.ts` + `cli/providerStore.ts` (kho khoá đã lưu, kiểm `customProviders`/`baseUrls`, ghi cài đặt người dùng), `cli/providerWizard.ts` (trình hướng dẫn qua `WizardIO`), `cli/providerCmd.ts` (`locaith provider …`), `cli/runtime/providers.ts` (`CliProviders`), `/provider` ở `runtime/slash.ts` | khoá từ biến môi trường (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, XAI_API_KEY, `<ID>_API_KEY`) hoặc khoá ĐÃ LƯU ở `~/.locaith/provider-keys.json` (0.4.1); xem §3 |

## 3. Cài đặt, tin cậy, tệp

- Tệp cài đặt (JSON, khoá lồng hoặc chấm đều nhận): người dùng `~/.locaith/settings.json` < dự án `<cwd>/.locaith/settings.json` < cục bộ `<cwd>/.locaith/settings.local.json` < biến môi trường.
  Khoá giống cài đặt extension bỏ tiền tố `locaithAgent.` (ví dụ `agent.compactAtPercent`, `permissions.allow`, `hooks`, `checkpoints.enabled`, `agent.outputStyle`).
- **Tin cậy thư mục** (`~/.locaith/trusted.json`): chưa tin → cài đặt dự án CHỈ được thêm luật `ask/deny`; hooks, MCP, lệnh `.locaith/commands` của dự án KHÔNG chạy; chế độ mặc định thành `plan`-an toàn như extension (`workspace untrusted`).
- Khoá tài khoản: `LOCAITH_API_KEY` hoặc `~/.locaith/cli.json` (quyền 600) — giữ nguyên cơ chế hiện có. Không bao giờ in khoá ra log/màn hình.
- **Khoá hãng khác (0.4.1)** — các bất biến phải giữ khi sửa phần này:
  1. Khoá đã lưu ở `~/.locaith/provider-keys.json` (`{version:1, keys:{id:{key,baseUrl,savedAt}}}`, quyền 600, ghi nguyên tử), TÁCH khỏi `cli.json`. Biến môi trường luôn THẮNG khoá đã lưu (`CliProviders.savedKeyForUse` trả undefined khi env đặt → registry rơi về env).
  2. Mỗi khoá GẮN với địa chỉ lúc lưu; chỉ gửi khi `effectiveBaseUrl(id)` — địa chỉ THẬT mà registry sẽ gọi (hãng dựng sẵn: `baseUrls` hoặc mặc định; API tuỳ chỉnh: `baseUrl` của chính nó) — còn khớp. Lệch → không gửi, `problems()`/`provider list`/`/doctor` báo.
  3. `customProviders` và `baseUrls` nằm trong `SECURE_KEYS` (`runtime/config.ts`): chỉ đọc từ cài đặt NGƯỜI DÙNG; cài đặt dự án/cục bộ bị bỏ qua dù thư mục đã tin cậy (kho lạ không được chuyển hướng khoá). `baseUrls` chỉ nhận id hãng dựng sẵn + `locaith`.
  4. Địa chỉ: https luôn được; http chỉ tới máy này, hoặc mạng nội bộ khi API không cần khoá (`checkBaseUrl`). Mục sai bị bỏ KÈM lý do (`validateCustomProviders`/`validateBaseUrls`), không lặng lẽ.
  5. Không nhận khoá ở dòng lệnh: ô nhập ẩn, `--key-stdin`, `--key-env`; `parseArgs` từ chối `--key=…` mà không in lại giá trị; đối số thừa không bị in lại. Mọi khoá được `logger.registerSecret`.
  6. Ghi cài đặt/khoá chỉ qua `providerStore` (đọc-sửa-ghi nguyên tử; tệp hỏng → KHÔNG ghi đè). Trình hướng dẫn chỉ nói chuyện qua `WizardIO` nên kiểm thử bằng giao diện giả; `submit('/provider …')` trả về khi lệnh trao quyền cho người dùng (ask) — chờ `idle()`.
- Phiên: `~/.locaith/sessions/<id>.json` (định dạng của `shared/sessionStore`: `{session, transcript, …}`), **đọc được cả định dạng cũ của CLI 0.3.x** (`{id,title,model,cwd,messages}`) và chuyển lên khi lưu lại. Ghi nguyên tử (tệp tạm + rename), quyền 600.
  Ảnh đính kèm thu nhỏ (≤ 1568 px, JPEG/PNG vừa phải) trước khi lưu/gửi; transcript chỉ giữ bản xem trước nhỏ.
- Lịch sử gõ: `~/.locaith/history` (300 dòng, quyền 600). Thư mục kiểm tra: `~/.locaith/{checkpoints,skills,commands,memory}`.

## 4. Lệnh gạch chéo (đồng bộ với extension)

Dựng sẵn (lane cli-rt): `/help` `/clear` (= `/new`) `/compact [giữ gì]` `/context` `/cost` `/model [id]` `/mode [tên]` `/thinking [mức]` `/status` `/login` `/logout`
`/whoami` `/resume [id]` `/sessions` `/exit` (= `/quit`) `/config` (mở/ghi cài đặt) `/doctor` `/update` `/theme` `/export [tệp]` `/copy`.
Tính năng (lane cli-features): `/rewind` `/fork` `/tasks` `/hooks` `/permissions` `/agents` `/mcp` `/memory` `/init` (tạo LOCAITH.md) `/review` `/simplify` `/security-review`
`/verify` `/output-style` `/skills` + lệnh tuỳ chỉnh từ `.locaith/commands` / `~/.locaith/commands` (có `$ARGUMENTS`, `@file`, ``!`cmd` ``) + lệnh do MCP cung cấp.
Mô tả mỗi lệnh có vi + en. `!lệnh` chạy shell trực tiếp. `@đường-dẫn` mở rộng thành nội dung (ảnh → khối ảnh).

## 5. Giao diện terminal (lane cli-tui) — đặc tả

Phong cách: gọn, ít khung, như Claude Code (tham khảo cách trình bày: dấu `●` đầu đoạn trợ lý/công cụ, `⎿` cho kết quả, khung bo tròn quanh ô nhập, dải trạng thái mờ phía dưới).
Màu thương hiệu: gradient `#22bcec` → `#625aec` (logo «Lo»). Truecolor khi có (`COLORTERM=truecolor|24bit`), rơi về 256 rồi 16 màu; `NO_COLOR` / `--no-color` tắt màu;
không phải UTF-8 hoặc `LOCAITH_ASCII=1` → ký tự ASCII thay khung/biểu tượng. Chiều rộng ký tự đúng cho tiếng Việt (chữ dựng sẵn, dấu kết hợp rộng 0) và CJK/emoji rộng 2.

**Kiến trúc vẽ (BẮT BUỘC):** dòng đã hoàn chỉnh ĐƯỢC IN THẲNG vào scrollback của terminal (cuộn được bằng chuột/bàn phím của terminal, chọn/sao chép được); chỉ có một
«vùng sống» nhỏ ở đáy (spinner + hàng đợi + ô nhập + dải trạng thái + menu gợi ý) được vẽ lại bằng cách lùi con trỏ lên rồi xoá và vẽ lại (CSI), bọc trong
«synchronized output» (`\x1b[?2026h/l`) khi terminal hỗ trợ. Văn bản trợ lý đang stream: in từng DÒNG khi đã đủ dòng (xuống dòng/ngắt theo chiều rộng); phần dòng dở hiện ở vùng sống.
Không dùng Ink/React; không xoá màn hình trừ `/clear` hay Ctrl+L. Khi đổi cỡ cửa sổ: vẽ lại vùng sống theo chiều rộng mới, không làm hỏng scrollback.
Không có TTY (ống, CI): không chạy giao diện — `index.ts` chuyển sang chế độ in một lần.

**Màn hình khởi động:** khung bo tròn gồm logo «Lo» dựng bằng khối nửa ô (▀▄█, gradient truecolor; tạo bằng script sinh từ đường vẽ logo `webview/src/brand/lo.ts`, nhúng thành hằng — có bản ASCII dự phòng),
tên + phiên bản, tài khoản/gói, model, thư mục, mẹo xoay vòng («/help · @ nhắc tệp · ! chạy shell · Shift+Tab đổi chế độ · Esc dừng · Ctrl+O mở rộng kết quả»).
**Lần chạy đầu / chưa đăng nhập:** chọn ngôn ngữ (Tiếng Việt/English), đăng nhập (mở trình duyệt; hoặc `--no-browser` dán token; hoặc khoá hãng khác) bằng hàm có sẵn ở `cli/account.ts`/`browserLogin.ts`,
đồng ý thông báo dữ liệu (`consent`), **hỏi tin cậy thư mục** («Locaith có thể đọc/sửa tệp và chạy lệnh ở đây — tin cậy? 1. Có 2. Không, thoát»).

**Ô nhập:** khung bo tròn, dấu nhắc `>`; nhiều dòng (Ctrl+J, Alt+Enter, hoặc `\` + Enter; dán nhiều dòng giữ nguyên nhờ bracketed paste); cao tối đa ~8 dòng rồi cuộn trong ô;
con trỏ giả (đảo màu) để không phụ thuộc toạ độ con trỏ thật; chỉnh sửa kiểu emacs (Ctrl+A/E/K/U/W/Y, Alt+B/F, Home/End, Del); lịch sử ↑/↓ (lưu đĩa) + Ctrl+R tìm ngược; Tab/→ chấp nhận gợi ý;
chữ mờ gợi ý khi trống («Nhập việc cần làm… / lệnh · @ tệp · ! shell»). `/` mở menu lệnh (lọc theo chữ gõ, ↑↓ chọn, Enter chạy/điền); `@` mở menu tệp (mờ ảo, `complete()` của runtime);
`!` ở đầu dòng đổi dấu nhắc sang chế độ shell; `?` khi trống hiện phím tắt. Dán ảnh: Ctrl+V trên Windows đọc clipboard ảnh (PowerShell), nơi khác dán đường dẫn ảnh.
Phím: Enter gửi · Esc dừng lượt (đang rảnh: xoá ô; Esc 2 lần = menu rewind) · Ctrl+C (có chữ: xoá; đang chạy: dừng; rảnh + trống: nhắc «nhấn lần nữa để thoát») · Ctrl+D thoát khi trống ·
Ctrl+L vẽ lại · Ctrl+O bật/tắt «mở rộng kết quả công cụ» · Shift+Tab đổi chế độ quyền (hiện ở dải trạng thái) · Ctrl+T bật/tắt bảng việc.
Gõ khi đang chạy → xếp hàng (hiện «đang chờ: …» trên ô nhập).

**Dải dưới ô nhập:** trái: gợi ý theo ngữ cảnh (`? phím tắt`, `esc để dừng`, chế độ quyền «⏵⏵ tự nhận chỉnh sửa · shift+tab đổi»); phải: model · ngữ cảnh % (đổi màu khi ≥ 80%) · nhánh git.
Trên ô nhập khi cần: dòng spinner `✻ Đang xử lý… (12s · ↓ 1,2k token · esc để dừng)` — chữ chạy bóng gradient, từ trạng thái xoay vòng vui nhưng gọn; bảng việc (☐/◐/☒) nếu có `todos`; tác vụ nền («2 tác vụ nền · /tasks»).
(Tuỳ chọn nếu còn thời gian: nhân vật nhỏ dựng bằng nửa ô — chó/robot chạy khi chờ > 8 s — dùng khung đã vẽ ở `scripts/brand/sprites.mjs`; mặc định tắt khi `NO_COLOR`/ASCII.)

**Trình bày hội thoại** (từ `RuntimeEvent`): tin người dùng `> …` nền mờ nhẹ; trợ lý: markdown (tiêu đề, **đậm**, *nghiêng*, `mã`, khối mã có tên ngôn ngữ + tô màu từ khoá cơ bản, danh sách, bảng căn cột, trích dẫn, liên kết),
dòng đầu `● `; suy nghĩ: «✻ Đã suy nghĩ 14 giây» mờ (mở rộng bằng Ctrl+O); công cụ: `● Read(src/app.ts)` rồi `  ⎿ Đọc 120 dòng`; sửa tệp: `● Update(src/a.ts)` + diff có số dòng, nền đỏ/xanh nhạt, tối đa ~12 dòng rồi «… +N dòng (ctrl+o)»;
Bash: `● Bash(npm test)` + `⎿` 4 dòng đầu/cuối, đỏ khi mã thoát ≠ 0; nhóm nhiều lệnh liền nhau gọn như timeline của extension; agent con: dòng «● agent <tên> — <việc> (n lệnh · tokens · thời gian)»;
tasks/todos; thông báo nén «Đã nén cuộc trò chuyện · tự động · giải phóng 968k token»; kiểm chứng độc lập; lỗi đỏ có gợi ý; token/thời gian cuối lượt mờ.
**Hộp xin quyền** (thay ô nhập khi có `permission`): tiêu đề + chi tiết (lệnh/diff xem trước) + lựa chọn `❯ 1. Có  2. Có, và không hỏi lại cho … trong phiên  3. Không, và nói Locaith làm khác đi (Esc)`; 3 → hỏi lý do (nhập một dòng) gửi làm `feedback`.
**Chọn từ danh sách** (`ask`: /resume, /model, /rewind, /theme, …): hộp có tìm kiếm khi `searchable`, ↑↓ chọn, Enter, Esc huỷ; ghi nhớ mục hiện tại.
Giao diện phải bền: không ném lỗi ra ngoài, khôi phục terminal (bỏ raw mode, hiện con trỏ, tắt bracketed paste) khi thoát/crash/SIGINT/SIGTERM.

## 6. Chế độ in một lần (điều phối viên làm)

`locaith -p "<việc>"` / `locaith ask`, nhận từ stdin (`cat log | locaith -p "tóm tắt"`), `--output-format text|json|stream-json`, `--permission-mode`, `--allowedTools/--disallowedTools`,
`--model`, `--max-turns`, `--timeout`, `--continue/-c`, `--resume/-r`, `--add-dir`, `--append-system-prompt`, `--mcp-config`, `--verbose`, `--no-color`, `--no-session-persistence`.
Mã thoát như cũ (0 xong, 1 lỗi, 2 dùng sai, 127 thiếu Node). Quyền không tự có khi không tương tác → từ chối (không treo chờ).

## 7. Kiểm thử

- Lõi: vitest với nhà cung cấp giả (`test/helpers/fakeProvider.ts` hoặc máy chủ SSE giả như `test/cli.e2e.test.ts`) — `providerOverride` của `RuntimeOptions`.
- Giao diện: (1) đơn vị cho từng mảnh thuần (tách dòng/độ rộng, markdown, diff, trình soạn thảo, bộ phân tích phím); (2) tích hợp với `MockRuntime` và «terminal ảo» `@xterm/headless`
  (kiểm toạ độ/cuộn/đổi cỡ, không cần terminal thật); (3) e2e THẬT bằng `@lydell/node-pty` (ConPTY): `pty.spawn(process.execPath, [...], { useConptyDll: false })` — BẮT BUỘC
  `useConptyDll: false` và đường dẫn tuyệt đối tới node, nếu không bị treo — đọc ra qua xterm headless, chụp ảnh màn hình (render HTML → PNG bằng Chrome ở
  `C:\Program Files\Google\Chrome\Application\chrome.exe` qua puppeteer-core) để người duyệt xem.
- Mọi lỗi đã thấy phải thành test.

## 8. Quy ước làm việc

- Comment và chuỗi nội bộ tiếng Việt (như phần còn lại của repo), định danh tiếng Anh. Chuỗi hiển thị cho người dùng: vi + en qua `i18n.ts`.
- Windows 11, PowerShell 5.1 + Git Bash. KHÔNG có python (chỉ shim Store) — dùng node. `node -e "…"` trong Bash dễ hỏng dấu nháy: ghi script `.mjs` rồi chạy.
  Script `.ps1` phải thuần ASCII. KHÔNG chạm ổ D:. KHÔNG kill tiến trình theo tên (`taskkill /im node.exe`…) — máy có dịch vụ thật chạy nền; chỉ kill đúng PID mình khởi chạy.
- Worktree có junction `node_modules` và `market` dùng chung: KHÔNG `npm install`, KHÔNG xoá nội dung trong đó.
- Commit nhỏ, thường xuyên, trên nhánh của lane; tác giả `Locaith <locaithsolution@locaith.com>`; thông điệp KHÔNG có dòng ghi công Claude/Co-Authored-By; KHÔNG push, KHÔNG đụng nhánh khác.
- Máy 12 CPU/32 GB: nhiều agent chạy vitest cùng lúc làm test spawn tiến trình bị hết giờ giả — chạy test mục tiêu, không chạy cả bộ liên tục.
