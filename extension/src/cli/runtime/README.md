# Lõi chạy của Locaith CLI (`src/cli/runtime`)

Lõi KHÔNG giao diện: dựng `AgentEngine` mỗi lượt đúng công thức của extension (`ChatController.createEngine`), giữ phiên, quyền, hàng đợi tin,
nén ngữ cảnh, lệnh gạch chéo, và cắm các mô-đun tính năng. Giao diện (`../tui`) và chế độ in một lần chỉ biết `CliRuntime` (`contract.ts`).
Không import `vscode` (bản đóng gói được kiểm trong `test/cli/runtime/bundle.e2e.test.ts`).

```ts
import { createRuntime, NotLoggedInError } from './runtime';

const rt = await createRuntime({ cwd, version, interactive: true /* false = in một lần */, trusted });
```

## Chế độ in một lần (`locaith -p "…"`)

```ts
const rt = await createRuntime({ cwd, version: VERSION, interactive: false, model, permissionMode, allowedTools, maxTurns, timeoutSec, noPersist });
rt.on((e) => { /* stream-json: in từng RuntimeEvent; text thường: e.t==='ui' && e.ev.t==='text' → e.ev.delta */ });
await rt.submit(promptFromArgsAndStdin);
await rt.idle();                                   // chờ lượt chạy + hàng đợi + lệnh đang chạy
const { stopReason, text, turns } = rt.lastResult!();   // mã thoát: 0 nếu stopReason === 'end_turn', 1 nếu error/max_turns/timeout/aborted
await rt.dispose();                                // ghi phiên, dọn mô-đun, đóng socket keep-alive
```

- `interactive:false` ⇒ quyền không tự có thì **TỪ CHỐI ngay** (không treo) kèm thông điệp nói rõ cách cho phép (`--permission-mode`, `--allowedTools "tool(mẫu)"`); `ask()` trả `null`.
- Thiếu khoá ⇒ `createRuntime` ném `NotLoggedInError` (`.vi` / `.en` / `.message` theo `lang`); `index.ts` bắt nó để chạy onboarding rồi gọi lại.
- Summarizer nền (dòng trạng thái «Đang đối chiếu…») mặc định TẮT khi không tương tác (đỡ tốn token); bật bằng cài đặt `summarizer.enabled`.

## Giao diện terminal (TUI)

```ts
rt.on((e) => {
  switch (e.t) {
    case 'ui':         /* UiEvent: dùng reduceView/applyEvent của extension nếu muốn; bỏ qua tool_permission */ break;
    case 'status':     /* dải dưới ô nhập: context %, model, git, hàng đợi, todos… (đã giới hạn ≤ 10/giây) */ break;
    case 'permission': /* hộp xin quyền → rt.respondPermission(e.request.id, { decision: 'allow' | 'allow_session' | 'deny', feedback }) */ break;
    case 'permission_cancel': /* lượt bị dừng: đóng hộp */ break;
    case 'ask':        /* chọn/xác nhận/nhập → rt.answer(e.ask.id, giáTrị | null) */ break;
    case 'output': case 'toast': case 'replay': case 'action': /* xem contract.ts */ break;
  }
});
await rt.submit(line);              // `/lệnh`, `!shell`, `@tệp`, hoặc tin cho model (đang chạy ⇒ xếp hàng, engine nhận ở ranh giới vòng công cụ)
rt.interrupt();                     // Esc / Ctrl+C: dừng lượt, từ chối quyền đang chờ, trả tin đang chờ về ô nhập (action `insert`)
const c = await rt.complete({ kind: 'file', query: 'src/ap' });   // gợi ý @ ; kind:'slash' cho menu /
```

Sự kiện `toast`/`output` phát trước khi có người nghe (khi khởi tạo mô-đun) được giữ lại và giao cho người nghe đầu tiên.
Tuỳ chọn thêm so với hợp đồng gốc (đều tuỳ chọn): `RuntimeEvent action 'insert'`, `CliRuntime.settings`, `RuntimeStatus.subAgentTokens`,
`RuntimeOptions.features|fetchImpl`, `AskInput`, và các móc của `FeatureContext` ở dưới.

## Cài đặt, tin cậy, tệp

- `~/.locaith/settings.json` < `<cwd>/.locaith/settings.json` < `settings.local.json` < env (`LOCAITH_SETTINGS` = JSON, `LOCAITH_MODEL`, `LOCAITH_LANG`, `LOCAITH_PERMISSION_MODE`, `LOCAITH_THINKING`) < cờ dòng lệnh. Khoá chấm hoặc lồng; mảng `permissions.*`/`hooks` được nối.
- Thư mục **chưa tin cậy** (`opts.trusted === false`, hoặc vắng + không có trong `~/.locaith/trusted.json`): tầng dự án chỉ được thêm `permissions.ask|deny`; chế độ ban đầu là `plan` trừ khi người dùng chọn rõ. `agent.allowBypassPermissions` chỉ đọc từ cài đặt người dùng.
- Khoá: `LOCAITH_API_KEY` / `~/.locaith/cli.json`; BYOK qua `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`. Chọn model: `--model [nhàCungCấp:]id` → cài đặt `model`/`defaultModel` → Locaith nếu đã đăng nhập → hãng đầu tiên có khoá.
- Cài đặt riêng của CLI: `agent.contextWindow` (ép cửa sổ ngữ cảnh), `summarizer.enabled`, `ui.theme`, `secrets.<tên>` (chỉ tầng người dùng).
- Phiên `~/.locaith/sessions/<id>.json` (định dạng `shared/sessionStore`, quyền 600, ghi nguyên tử); đọc được phiên CLI 0.3.x. Nhật ký `~/.locaith/logs/cli.log` (khoá luôn bị che).

## Điểm mở rộng: `FeatureModule`

Danh sách mô-đun ở `features/index.ts` (`defaultFeatures()`); `RuntimeOptions.features` thay thế danh sách đó khi kiểm thử. Mỗi mô-đun nhận `FeatureContext`:

| Cần | Dùng |
|---|---|
| lệnh `/x` | `ctx.slash(def, source?)`; lệnh nạp động `ctx.replaceSlashSource('project'\|'user'\|'plugin'\|'mcp', defs)`; trong `run`: `output/toast/ask/runPrompt` |
| bám quanh vòng lặp (hook, verifier, thông báo nền) | `ctx.addRunExtension(ext, { subAgents?, last? })` — `verifier` nên `last:true` |
| công cụ mới (MCP, nền) | `ctx.addToolContributor(add => add(toolDef))` — gọi lại mỗi lượt |
| đoạn system prompt (MCP, phong cách) | `ctx.addPromptContributor(() => string \| null)` |
| số liệu trên dải trạng thái | `ctx.addStatusContributor(fn)` → `.refresh()` khi đổi |
| hook UserPromptSubmit / PreCompact / sau nén / Notification | `ctx.beforeSend`, `ctx.onBeforeCompact`, `ctx.onCompacted`, `ctx.onPermissionRequest` |
| checkpoints | `ctx.onFileWrite((abs, before, after) => …)` |
| fork / rewind | `ctx.saveSession()`, `ctx.replaceSession(next, { reason, transcript? })`, `ctx.transcript()` |
| thư mục kỹ năng/agent ngoài workspace | `ctx.addReadRoot(dir)`, `ctx.skills.loadDirs(ctx.host, …)`, `ctx.agents.loadDirs(…)` |
| dọn khi thoát / đổi phiên | `ctx.onDispose`, hàm trả về từ `attach`, `ctx.onSessionChange` |
| cờ dòng lệnh | `ctx.options` (`mcpConfig`, `addDirs`, `allowedTools`…) |

Lõi cô lập lỗi: mô-đun ném lỗi lúc `attach` (hoặc treo > 8 giây), lệnh/extension/đóng góp ném lỗi lúc chạy — đều được ghi log, phát `toast` cảnh báo (một lần) và hiện trong `notices`/`/doctor`, không làm sập runtime.
Luật quyền (`permissions.allow|ask|deny` + `--allowedTools/--disallowedTools`) do chính lõi lắp (extension `permission-rules`, áp cho cả agent con) — mô-đun không cần tự đăng ký.

## Kiểm thử

`test/cli/runtime/*.test.ts` dùng `providerOverride` (`test/helpers/fakeProvider.ts`) + `home`/`cwd` tạm, không gọi mạng thật, không đọc `~/.locaith`.
`bundle.e2e.test.ts` đóng gói lõi bằng esbuild và chạy bằng Node với máy chủ HTTP giả.
