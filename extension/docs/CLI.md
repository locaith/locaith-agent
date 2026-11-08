# Locaith CLI — hướng dẫn sử dụng (0.4.1)

Trợ lý lập trình Locaith ngay trong terminal. **Cùng lõi** với extension VS Code: cùng engine, công cụ, kỹ năng, hooks, checkpoints/rewind,
tác vụ nền, MCP, luật quyền, nén ngữ cảnh. Model chạy ở cổng Locaith (`locaith-v5-flash`, `locaith-v5-si`) hoặc khoá hãng khác của bạn
(Anthropic, OpenAI, Gemini, DeepSeek, xAI…); công cụ (đọc/ghi tệp, shell, ffmpeg…) chạy trên máy của bạn.

Kiến trúc và đặc tả dành cho người phát triển: [CLI-ARCHITECTURE.md](CLI-ARCHITECTURE.md).

## Cài đặt

```bash
pip install locaith-cli          # hoặc: pipx install locaith-cli
locaith                          # mở phiên tương tác (lần đầu có hướng dẫn: ngôn ngữ → đăng nhập → tin cậy thư mục)
```

Cần Python 3.8+. Gói tự dùng Node 20+ có sẵn trên máy, nếu không có thì dùng Node đóng kèm (`nodejs-wheel-binaries`) — không phải cài thêm gì.
Nâng cấp: `locaith update` (hoặc `pip install -U locaith-cli`). Kiểm máy: `locaith doctor`.

## Bắt đầu nhanh

```bash
cd du-an-cua-ban
locaith                                  # phiên tương tác
locaith "sửa lỗi type trong src/app.ts"  # phiên tương tác, gửi sẵn câu này
locaith -c                               # tiếp tục phiên gần nhất của thư mục
locaith -p "tóm tắt repo này"            # in một lần rồi thoát (cho script/CI)
cat build.log | locaith -p "vì sao lỗi?" # nhận cả stdin
```

**Lần chạy đầu** (hoặc chưa đăng nhập / chưa tin cậy thư mục): màn hình hướng dẫn hỏi lần lượt
1. ngôn ngữ (Tiếng Việt / English — đổi lại bằng cài đặt `language`, cờ `--lang`, hoặc biến `LOCAITH_LANG`);
2. đăng nhập: trình duyệt (khuyến nghị) · dán token `lat_…` · dùng khoá hãng khác · bỏ qua (đăng nhập sau bằng `/login`);
3. thông báo dữ liệu của Locaith (bản ghi lưu theo TÀI KHOẢN ở cổng, dùng chung với bản VS Code; đã đồng ý ở nơi khác thì khỏi hỏi lại);
4. **tin cậy thư mục**: hooks, MCP, lệnh và luật «cho phép» của dự án chỉ chạy khi bạn tin cậy; chọn «Không» thì Locaith thoát.

Khoá tài khoản lưu ở `~/.locaith/cli.json` (quyền 600). Máy chủ/CI: đặt `LOCAITH_API_KEY`. **Không truyền khoá qua dòng lệnh.**

## Màn hình tương tác

Khung chào (logo «Lo», tài khoản, model, thư mục, mẹo) → hội thoại → ô nhập có viền bo tròn → dải trạng thái (chế độ quyền · model · ngữ cảnh % · nhánh git).
Mọi dòng đã xong được **in thẳng vào scrollback** của terminal (cuộn, chọn, sao chép bằng chuột/phím của terminal); chỉ vùng nhỏ ở đáy được vẽ lại.

| Bạn thấy | Nghĩa |
|---|---|
| `● Read(src/app.ts)` rồi `⎿ Đọc 120 dòng` | công cụ đã chạy và kết quả của nó |
| `● Update(src/app.ts)` + khối đỏ/xanh | sửa tệp, kèm diff có số dòng |
| `✻ Đang xử lý… (12s · ↓ 1,2k token · esc để dừng)` | trợ lý đang làm việc; chờ lâu hơn 8 giây thì chú chó robot chạy bên cạnh |
| hộp «Sửa tệp / Chạy lệnh» | xin quyền: `1. Có` · `2. Có, và không hỏi lại…` · `3. Không, và nói Locaith làm khác đi` |
| `⎿ đang chờ: …` trên ô nhập | tin bạn gõ khi trợ lý còn chạy — được xếp hàng và gửi ở ranh giới vòng công cụ kế tiếp |

### Phím tắt

| Phím | Việc |
|---|---|
| Enter | gửi · `Ctrl+J` / `Alt+Enter` / `\` + Enter: xuống dòng · dán nhiều dòng giữ nguyên |
| ↑ ↓ · `Ctrl+R` | lịch sử (lưu đĩa) · tìm ngược trong lịch sử |
| `Esc` | dừng lượt đang chạy (rảnh: xoá ô nhập; bấm 2 lần: menu rewind) |
| `Ctrl+C` | xoá ô nhập / dừng lượt / (rảnh + trống) bấm lần nữa để thoát · `Ctrl+D` thoát khi ô trống |
| `Shift+Tab` | đổi chế độ quyền: default → acceptEdits → plan (→ bypass nếu được phép) |
| `Ctrl+O` | mở rộng / gập kết quả công cụ · `Ctrl+T` bảng việc · `Ctrl+L` vẽ lại |
| `/` · `@` · `!` · `?` | menu lệnh · nhắc tệp (`@src/app.ts`, `@tệp#L10-20`) · chạy shell ngay · bảng phím tắt |
| `Tab` / `→` | chấp nhận gợi ý · `Ctrl+V` dán ảnh (Windows) |
| `Ctrl+A/E/K/U/W` · `Alt+B/F` | chỉnh sửa kiểu emacs |

### Lệnh gạch chéo (gõ `/` để mở menu)

`/help` `/clear` (= `/new`) `/compact [giữ gì]` `/context` `/cost` `/status` `/model [id]` `/mode [tên]` `/thinking [mức]` `/resume [id]` `/sessions`
`/rewind` `/fork` `/tasks` `/hooks` `/permissions` `/agents` `/mcp` `/memory` `/init` `/skills` `/plugins` `/review` `/simplify` `/security-review` `/verify`
`/output-style` `/config` `/theme` `/login` `/logout` `/whoami` `/provider` `/doctor` `/update` `/export` `/copy` `/exit`.
Lệnh tuỳ chỉnh: tạo `.locaith/commands/ten.md` (dự án) hoặc `~/.locaith/commands/ten.md` (cá nhân), dùng `$ARGUMENTS`, `@tệp`, `` !`lệnh` ``.
Lệnh do máy chủ MCP cung cấp cũng hiện trong menu.

## Dòng lệnh

| Lệnh | Việc |
|---|---|
| `locaith` · `locaith "việc"` | phiên tương tác (có/không câu mở đầu) |
| `locaith -p "việc"` · `locaith ask "việc"` | in một lần (`ask` là tên cũ, vẫn chạy) |
| `locaith doctor [--json]` | kiểm Node, git, ffmpeg, khoá, kết nối thật tới cổng, bản mới — và nói cách sửa |
| `locaith login [--no-browser]` · `logout` · `whoami` | đăng nhập / xoá khoá đã lưu / xem tài khoản, gói, model |
| `locaith consent --yes` | ghi nhận đồng ý thông báo dữ liệu (một lần, bởi chủ tài khoản) |
| `locaith provider [add\|key\|list\|test\|remove]` | nhà cung cấp mô hình: thêm API tuỳ chỉnh (OpenRouter, Ollama…), lưu khoá hãng khác, thử kết nối — xem mục «Nhà cung cấp mô hình» |
| `locaith sessions [--all]` | liệt kê phiên đã lưu (mở lại bằng `-r <id>` hoặc `-c`) |
| `locaith config` | chỉ ra nơi đặt cài đặt, khoá, phiên, MCP, bộ nhớ |
| `locaith update [--check]` · `help [chủ đề]` · `version` | nâng cấp · hướng dẫn chi tiết · phiên bản |

Tuỳ chọn thường dùng: `-p/--print` · `--output-format text|json|stream-json` · `-c/--continue` · `-r/--resume [id]` · `--model <id>` ·
`--permission-mode default|acceptEdits|plan|bypassPermissions` · `--allowedTools "Bash(npm test:*)" "Read"` (và `--disallowedTools`) · `--add-dir <thư mục>` ·
`--append-system-prompt <chữ>` · `--max-turns <n>` · `--timeout <giây>` · `--cwd <thư mục>` · `--mcp-config <tệp>` · `--no-session-persistence` · `--verbose` · `--no-color` · `--lang vi|en`.
Cờ cũ của 0.3.x vẫn chạy: `--allow none|reads|all` (= plan / default / bypassPermissions), `--json`, `--quiet`.

`locaith help <commands|shortcuts|print|settings|permissions|providers|hooks|mcp|sessions|memory|troubleshooting>` in hướng dẫn từng chủ đề ngay trong terminal.

## Chế độ in một lần (script/CI)

```bash
locaith -p "tóm tắt repo này"                                   # chỉ câu trả lời cuối ra stdout, thống kê ra stderr
locaith -p --output-format json "…"                             # một đối tượng JSON
locaith -p --output-format stream-json "…"                      # NDJSON: system → assistant/user (công cụ) → result
locaith -p --permission-mode acceptEdits "sửa lỗi type"         # cho sửa tệp không hỏi
locaith -p --allowedTools "Bash(npm test:*)" "chạy test và sửa" # cho đúng lệnh cần thiết
```

- JSON có `result`, `is_error`, `subtype` (`success` · `error` · `error_max_turns` · `error_timeout` · `interrupted`), `session_id`, `num_turns`, `duration_ms`, `usage`; giữ cả khoá cũ của 0.3.x (`ok`, `stopReason`, `turns`, `text`, `model`, `ms`).
- Không có terminal để hỏi: thao tác chưa được cấp quyền bị **từ chối ngay** (không treo) kèm cách cho phép. Thư mục chưa được tin cậy mặc định chỉ đọc (plan) — chạy `locaith` một lần trong thư mục đó để tin cậy, hoặc thêm `--permission-mode`.
- Có câu lệnh trong đối số thì stdin chỉ là dữ liệu phụ: chờ tối đa 3 giây cho byte đầu rồi chạy tiếp (một ống mở nhưng im lặng không làm treo). Không có câu lệnh thì stdin LÀ việc cần làm.
- Mã thoát: **0** xong · **1** lỗi / chưa xong (hết giờ, hết vòng, model lỗi, `doctor` còn mục ✘) · **2** dùng sai · **127** thiếu Node · **130** bị ngắt (Ctrl+C).
- Lỗi mạng: dùng cùng bộ thử lại với extension (4 lần, 1+2+4+8 giây) trước khi báo lỗi.

## Nhà cung cấp mô hình — khoá hoặc API của hãng khác

Locaith chạy bằng mô hình Locaith qua tài khoản **hoặc** bằng khoá/API của chính bạn. Hai cách cùng tồn tại; đổi lúc nào cũng được (`/model`, `--model`).

| Loại | Có sẵn |
|---|---|
| Hãng dựng sẵn (chỉ cần khoá) | Anthropic (Claude) · OpenAI · Gemini · DeepSeek · xAI (Grok) |
| API tương thích OpenAI (mẫu thêm nhanh) | OpenRouter · Ollama · LM Studio · Groq · Together · Mistral · Fireworks |
| Địa chỉ bất kỳ | máy chủ riêng, proxy, vLLM, LiteLLM… — chỉ cần địa chỉ gốc (thường kết thúc bằng `/v1`) |

```bash
locaith provider add                       # trình hướng dẫn: chọn hãng/mẫu, dán khoá (ô ẩn), thử kết nối
locaith provider add openrouter            # mẫu đã có địa chỉ; khoá nhập ở ô ẩn
locaith provider add ollama --models qwen3-coder                                   # máy cục bộ, không cần khoá
locaith provider add my-llm --url https://llm.example.com/v1 --key-env MY_LLM_KEY  # API riêng, khoá lấy từ biến môi trường
echo "$GROQ_KEY" | locaith provider add groq --key-stdin                           # cho script/CI
locaith provider key anthropic             # lưu/đổi khoá của một hãng (ô ẩn; hoặc --key-stdin · --key-env TÊN · --remove để xoá)
locaith provider list [--json]             # nhà cung cấp, địa chỉ, khoá đến từ đâu, điều gì cấu hình sai
locaith provider test [id]                 # thử kết nối thật (GET /models), nói đúng nguyên nhân khi hỏng
locaith provider remove <id>               # gỡ API tuỳ chỉnh và khoá đã lưu của nó
```

Trong phiên tương tác gõ `/provider` (cùng trình hướng dẫn; nhà cung cấp vừa thêm **dùng được ngay**, không cần khởi động lại). Rồi chọn model:
`/model openrouter:anthropic/claude-sonnet-5-5` · `locaith --model ollama:qwen3-coder` · hoặc `"model": "ollama:qwen3-coder"` trong cài đặt.
Lần chạy đầu, bước «dùng khoá hãng khác» cũng mở đúng trình hướng dẫn này thay vì bắt thoát ra tự đặt biến môi trường.

**Khoá**
- Biến môi trường **thắng** khoá đã lưu: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (hoặc `GOOGLE_API_KEY`), `DEEPSEEK_API_KEY`, `XAI_API_KEY`, và `<ID>_API_KEY` cho API tuỳ chỉnh (`OPENROUTER_API_KEY`, `MY_LLM_API_KEY`…).
- Khoá đã lưu nằm ở `~/.locaith/provider-keys.json` (quyền 600, ghi nguyên tử) và **gắn với địa chỉ lúc lưu**: nếu địa chỉ của nhà cung cấp bị đổi (sửa `baseUrls`/`customProviders`), khoá **ngừng được gửi đi** —
  để một cấu hình bị sửa không hứng được khoá của bạn. `locaith provider list` và `/doctor` báo rõ; lưu lại bằng `locaith provider key <id>`.
- **Không nhập khoá ở dòng lệnh** (lộ trong lịch sử shell và danh sách tiến trình): chỉ ô ẩn, `--key-stdin` hoặc `--key-env`. `--key sk-…` bị từ chối và không bị in lại; khoá được che khỏi nhật ký. Lỡ gõ khoá vào dòng lệnh: thu hồi khoá đó ở trang của hãng rồi tạo khoá mới.

**Địa chỉ**: `https://` luôn được. `http://` chỉ cho máy này (`localhost`, `127.0.0.1`), hoặc mạng nội bộ (`192.168.x`, `10.x`, `*.local`…) khi API **không cần khoá**. `http://` tới máy công cộng, hay địa chỉ có `user:mật-khẩu@`, bị từ chối kèm lý do.

**Cấu hình tay** — chỉ trong `~/.locaith/settings.json` của bạn. Cài đặt nằm trong kho mã **không** thêm được nhà cung cấp hay đổi địa chỉ (để một kho lạ không chuyển hướng yêu cầu hoặc khoá của bạn):

```json
{ "customProviders": [ { "id": "ollama", "label": "Ollama", "baseUrl": "http://localhost:11434/v1", "models": ["qwen3-coder"], "requiresKey": false } ],
  "baseUrls": { "deepseek": "https://proxy.example.com/v1" } }
```

`kind` (tuỳ chọn): `openai-chat` (mặc định) · `openai-responses` · `anthropic` · `gemini`. Mục sai bị bỏ qua và được báo ở `locaith provider list`, `/doctor`, `locaith doctor` — CLI không sập vì chúng.
Nhiều máy chủ OpenAI-compatible không có `/models`: khai `models` để dùng được và chọn được trong `/model`.

## Cài đặt, quyền, tin cậy

- Cài đặt (JSON; khoá giống extension, bỏ tiền tố `locaithAgent.`): `~/.locaith/settings.json` < `<dự án>/.locaith/settings.json` < `<dự án>/.locaith/settings.local.json` < biến môi trường < cờ dòng lệnh.
  Ví dụ: `{ "language": "vi", "agent": { "compactAtPercent": 90, "verify": "auto" }, "permissions": { "allow": ["Bash(npm test:*)"] }, "checkpoints": { "enabled": true } }`.
- **Chế độ quyền**: `default` (hỏi trước khi sửa/chạy lệnh) · `acceptEdits` · `plan` (chỉ đọc, lập kế hoạch rồi xin duyệt) · `bypassPermissions` (không hỏi — thận trọng; chỉ bật được nếu `agent.allowBypassPermissions` ở cài đặt cá nhân).
- **Luật quyền** `permissions.allow|ask|deny` (cú pháp `tool(đặc-tả)`: `Bash(npm test:*)`, `Edit(src/**)`, `Read(.env*)`, `WebFetch(domain:github.com)`, `mcp__máy-chủ__*`); deny > ask > allow, tính trước chế độ; lệnh ghép phải khớp từng phần; luật áp cả cho agent con và agent kiểm tra.
  Trên hộp xin quyền chọn «Không hỏi lại…» sẽ ghi luật; `/permissions` để xem/sửa/thử.
- **Tin cậy thư mục** (`~/.locaith/trusted.json`): chưa tin cậy thì cài đặt dự án chỉ được thêm luật `ask`/`deny`; hooks, MCP, lệnh tuỳ chỉnh và luật «cho phép» của dự án không chạy.
- Biến môi trường: `LOCAITH_API_KEY` · `LOCAITH_LANG=vi|en` · `LOCAITH_MODEL` · `LOCAITH_PERMISSION_MODE` · `LOCAITH_SETTINGS` (JSON) · `LOCAITH_HOME` (đổi thư mục «nhà»: dữ liệu nằm ở `$LOCAITH_HOME/.locaith`) ·
  `NO_COLOR` · `LOCAITH_ASCII=1` · khoá hãng khác: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`.

## Đồng bộ với extension VS Code

| Tính năng | Trong CLI |
|---|---|
| Checkpoints và Rewind | mỗi lượt lưu bản gốc tệp đã sửa; `/rewind` (mã / hội thoại / cả hai, có xem trước), `/rewind last`, `/rewind redo` |
| Hooks | `SessionStart` … `Notification`, lược đồ Claude Code; chỉ chạy ở thư mục tin cậy, `/hooks` |
| Tác vụ nền | `run_command` với `background: true`; `/tasks`, `/tasks stop <id>` |
| MCP | `.mcp.json`, `~/.locaith/mcp.json`, `mcpServers`, `--mcp-config`; `/mcp` |
| Kỹ năng, agent, plugin, lệnh tuỳ chỉnh | `/skills`, `/agents`, `/plugins`, `.locaith/commands` |
| Kiểm tra độc lập | agent «reviewer mù» chạy trước khi báo xong khi lượt có sửa tệp; `/verify`; `agent.verify` = `off` · `auto` · `always` |
| Nén ngữ cảnh | tự động ở 80% cửa sổ (`agent.compactAtPercent`), `/compact [giữ gì]`, `/context` |
| Ký ức và chỉ dẫn | `LOCAITH.md` / `AGENTS.md` / `CLAUDE.md` ở gốc dự án và `~/.locaith/LOCAITH.md`; `/init`, `/memory`; ký ức bền `.locaith/memory/MEMORY.md` |
| Phiên | `~/.locaith/sessions` (đọc được phiên của CLI 0.3.x); `-c`, `-r`, `/resume`, `/fork`, `/export` |
| Ảnh | `@ảnh.png`, `Ctrl+V` (Windows) — thu nhỏ trước khi gửi |

## Sự cố thường gặp

| Triệu chứng | Cách xử lý |
|---|---|
| 401 / token hết hạn | `locaith login` lại (token sống 90 ngày không dùng) |
| «Chưa đồng ý thông báo dữ liệu» | `locaith consent --yes` (hoặc đồng ý ở lần chạy đầu) |
| màu/khung bị vỡ | `NO_COLOR=1` hoặc `LOCAITH_ASCII=1`; dùng Windows Terminal / PowerShell 7 để có đủ màu |
| trợ lý treo | `Esc` để dừng; với `-p` đặt `--timeout <giây>`; `locaith doctor` để kiểm mạng |
| `-p` bị chặn ghi tệp | thư mục chưa tin cậy → chạy `locaith` một lần ở đó, hoặc `--permission-mode acceptEdits` |

Báo lỗi: https://locaith.ai, kèm kết quả `locaith doctor --json` (khoá đã được tự ẩn).

## Dành cho người phát triển

```bash
npm run build:cli                          # esbuild → dist-cli/locaith.cjs (một tệp, Node ≥ 20, KHÔNG kéo vscode)
node dist-cli/locaith.cjs --help
npx vitest run test/cli                    # lõi, tính năng, giao diện (xterm headless), chế độ in một lần
LOCAITH_E2E_PTY=1 npx vitest run test/cli/e2e   # chạy trong terminal THẬT (ConPTY/pty), cần @lydell/node-pty
node scripts/cli-screens.mjs               # dựng lại ảnh màn hình trong docs/cli-screens/
node packages/locaith-cli-py/build.mjs --extension <thư mục extension>   # bundle thu nhỏ + wheel/sdist PyPI (không tự đăng)
```

Gói PyPI: [packages/locaith-cli-py](../../packages/locaith-cli-py/README.md) — chỉ là «vỏ» Python chọn Node và chạy `locaith.cjs`; toàn bộ logic nằm ở `src/cli`.
Ảnh màn hình mẫu của giao diện: [cli-screens/](cli-screens/).

---

## English (short)

**Locaith CLI** is the Locaith coding agent in your terminal, sharing one engine with the VS Code extension (tools, skills, hooks, checkpoints/rewind, background tasks, MCP, permission rules, context compaction).

- Install: `pip install locaith-cli` (or `pipx install locaith-cli`), then run `locaith`. It uses your Node 20+ or the bundled one. First run walks you through language → sign-in → data notice → trusting the folder.
- Interactive: `locaith`, `locaith "task"`, `locaith -c` (continue), `locaith -r [id]` (resume). Type `/` for commands, `@` for files, `!` for shell, `Shift+Tab` to change the permission mode, `Esc` to stop, `Ctrl+O` to expand tool results, `?` for shortcuts.
- Print mode: `locaith -p "task"` (also reads stdin), `--output-format text|json|stream-json`, `--permission-mode`, `--allowedTools`. Without a terminal, anything not allowed is denied immediately; exit codes 0 / 1 / 2 / 127 / 130.
- Other vendors' keys and APIs (0.4.1): `locaith provider add|key|list|test|remove` (and `/provider` in a session) — Anthropic, OpenAI, Gemini, DeepSeek, xAI, plus OpenAI-compatible presets (OpenRouter, Ollama, LM Studio, Groq, Together, Mistral, Fireworks) or any address. Keys are typed at a hidden prompt, `--key-stdin` or `--key-env` — never on the command line — and saved to `~/.locaith/provider-keys.json` (mode 600), bound to the address they were saved for. A repository cannot add providers or change addresses; only your own `~/.locaith/settings.json` can. `locaith help providers`.
- Settings: `~/.locaith/settings.json` < `.locaith/settings.json` < `.locaith/settings.local.json` < environment < flags. Untrusted folders can only add `ask`/`deny` rules; hooks, MCP and project commands do not run there.
- `locaith doctor` checks your setup; `locaith help <topic>` prints detailed guides; `LOCAITH_LANG=en` or `--lang en` switches the language.
