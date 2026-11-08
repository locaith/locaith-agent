# Locaith CLI

**Trợ lý lập trình Locaith ngay trong terminal** — đọc và sửa mã, chạy lệnh, nối công cụ MCP, hooks, quay lại (rewind), nhớ việc qua nhiều phiên.
Cùng lõi với extension **Locaith AI Agent** cho VS Code (cùng engine, công cụ, kỹ năng, quyền, nén ngữ cảnh), nên làm trong terminal hay trong editor đều như nhau.
*Locaith CLI is the Locaith coding agent for your terminal — same engine as the VS Code extension. Quick start below; English notes at the end.*

```bash
pip install locaith-cli      # đã kèm Node.js — không cần cài gì thêm
locaith                      # mở phiên tương tác (lần đầu: đăng nhập, chọn ngôn ngữ, tin cậy thư mục)
```

## Lần đầu chạy

1. `locaith` hỏi ngôn ngữ (Tiếng Việt / English), rồi **đăng nhập**: trình duyệt mở trang locaith.ai, bấm «Cho phép» — terminal tự nhận. Máy không có trình duyệt (SSH, server): `locaith login --no-browser`, mở liên kết trên máy khác rồi dán mã.
2. Đồng ý **thông báo dữ liệu** (một lần cho tài khoản, dùng chung với extension).
3. Chọn **tin cậy thư mục** làm việc. Thư mục chưa tin cậy: Locaith không chạy hooks, MCP và lệnh tuỳ chỉnh của dự án.
4. Gõ việc cần làm, ví dụ: `đọc repo này và cho tôi biết cách chạy test`.

Máy chủ / CI không tương tác: đặt `LOCAITH_API_KEY` thay cho `login` và dùng `locaith -p "…"` (xem «Chế độ in một lần»).

## Dùng trong phiên tương tác

| Gõ | Việc |
|---|---|
| `/` | menu lệnh (lọc khi gõ, ↑↓ chọn, Enter) |
| `@đường-dẫn` | nhắc một tệp / ảnh / tài liệu (có gợi ý Tab) |
| `!lệnh` | chạy shell ngay, kết quả đi vào ngữ cảnh |
| `?` | bảng phím tắt |

**Phím**: Enter gửi · `Ctrl+J` / `Alt+Enter` / `\`+Enter xuống dòng · ↑↓ lịch sử · `Ctrl+R` tìm lịch sử · `Esc` dừng lượt đang chạy (bấm 2 lần: menu rewind) · `Ctrl+C` xoá/dừng/thoát · `Ctrl+D` thoát · `Shift+Tab` đổi chế độ quyền · `Ctrl+O` mở/gập kết quả công cụ · `Ctrl+T` bảng việc · `Ctrl+L` vẽ lại.
Gõ tiếp khi trợ lý đang chạy: tin được **xếp hàng** và gửi ở ranh giới vòng công cụ kế tiếp.

**Lệnh gạch chéo** (đầy đủ: `/help` trong phiên hoặc `locaith help commands`):
`/clear` `/compact` `/context` `/cost` `/model` `/mode` `/thinking` `/resume` `/sessions` `/rewind` `/fork` `/tasks` `/hooks` `/permissions` `/agents` `/mcp` `/memory` `/init` `/skills`
`/review` `/simplify` `/security-review` `/verify` `/output-style` `/config` `/theme` `/login` `/logout` `/whoami` `/doctor` `/update` `/export` `/copy` `/exit`.
Tự thêm lệnh: tạo `.locaith/commands/ten.md` (dự án) hoặc `~/.locaith/commands/ten.md` (cá nhân), dùng `$ARGUMENTS`, `@tệp`, ``!`lệnh` ``.

## Quyền — bạn luôn nắm quyền

Chế độ (đổi bằng `Shift+Tab` hoặc `--permission-mode`): **default** (hỏi trước khi sửa tệp/chạy lệnh) · **acceptEdits** (tự nhận chỉnh sửa tệp) · **plan** (chỉ đọc, lập kế hoạch) · **bypassPermissions** (không hỏi — thận trọng).
Luật chi tiết trong cài đặt `permissions.allow / ask / deny`, cú pháp `Bash(npm test:*)`, `Edit(src/**)`, `Read(.env*)`, `WebFetch(domain:github.com)`, `mcp__máy-chủ__*`; thứ tự **deny > ask > allow**.
Mọi thao tác ngoài thư mục làm việc, tệp bí mật và lệnh nguy hiểm luôn hỏi. Mọi sửa đổi tệp được chụp lại (checkpoints) để **quay lại** bằng `/rewind`.

## Chế độ in một lần (script, CI)

```bash
locaith -p "tóm tắt repo này trong 5 gạch đầu dòng"
cat build.log | locaith -p "vì sao build lỗi?"
locaith -p --output-format json "…"            # một đối tượng JSON (result, usage, session_id, num_turns…)
locaith -p --output-format stream-json "…"      # NDJSON từng sự kiện
locaith -p --permission-mode acceptEdits "sửa lỗi type trong src/api.ts rồi chạy test"
locaith -p --allowedTools "Bash(npm test:*)" "chạy test và sửa"
```

Không có terminal để hỏi: thao tác chưa được cấp quyền bị **từ chối** (không treo). Tiến trình đi `stderr`, kết quả đi `stdout`.

| Mã thoát | Nghĩa |
|---|---|
| 0 | Xong |
| 1 | Lỗi (mạng, 401, vượt hạn mức, chưa xong) |
| 2 | Dùng sai lệnh/tuỳ chọn |
| 127 | Không tìm thấy Node.js ≥ 20 |
| 130 | Bị ngắt (Ctrl+C) |

## Phiên, ký ức, cài đặt

- Mỗi cuộc trò chuyện tự lưu ở `~/.locaith/sessions`. `locaith -c` tiếp tục phiên gần nhất của thư mục; `locaith -r [id]` mở lại; `locaith sessions` liệt kê.
- Ngữ cảnh tự **nén** ở 80% cửa sổ (kết quả công cụ cũ được lược trước, bản tóm tắt có cấu trúc giữ nguyên yêu cầu của bạn); `/compact <giữ gì>` để nén tay.
- **Chỉ dẫn dự án**: `LOCAITH.md` (hoặc `AGENTS.md`, `CLAUDE.md`) ở gốc dự án và `~/.locaith/LOCAITH.md`; `/init` tạo giúp. **Ký ức bền** ở `.locaith/memory/MEMORY.md` và `~/.locaith/memory/MEMORY.md`.
- **Cài đặt** (JSON, khoá giống extension bỏ tiền tố `locaithAgent.`): `~/.locaith/settings.json` (cá nhân) < `<dự-án>/.locaith/settings.json` < `<dự-án>/.locaith/settings.local.json`.
  `locaith config` in đường dẫn các tệp; `locaith help settings` có ví dụ.
- **Hooks** (cùng lược đồ Claude Code), **MCP** (`.mcp.json`, `~/.locaith/mcp.json`, `--mcp-config`), kỹ năng (`.locaith/skills`), agent con (`.locaith/agents`): `locaith help hooks`, `locaith help mcp`.

Biến môi trường: `LOCAITH_API_KEY`, `LOCAITH_LANG=vi|en`, `NO_COLOR=1`, `LOCAITH_ASCII=1` (khung/biểu tượng ASCII), `LOCAITH_HOME` (đổi thư mục `~/.locaith`), `LOCAITH_NODE` (đường dẫn Node riêng).

## Lệnh con

`locaith doctor` (kiểm máy + cách sửa) · `login` / `logout` / `whoami` · `consent --yes` · `update` · `sessions` · `config` · `help [chủ đề]` · `--version`.

## Cập nhật, gỡ cài đặt, thu hồi quyền

```bash
locaith update                  # hoặc: pip install -U locaith-cli
pip uninstall locaith-cli
locaith logout                  # xoá khoá đã lưu (~/.locaith/cli.json)
```
Thu hồi phía máy chủ: locaith.ai → «VS Code từ xa» → thu hồi thiết bị có nhãn chứa `Locaith CLI`. Token sống 90 ngày không dùng; mỗi lần chạy gia hạn thêm. Không ai đưa token cho bạn qua chat/email — đừng dán token cho người lạ.

## Kỹ thuật

`pip install locaith-cli` kéo theo `nodejs-wheel-binaries` (Node.js đi kèm). Nếu máy đã có Node ≥ 20 thì dùng Node của hệ thống; đặt `LOCAITH_NODE` để chỉ định. Gói chứa đúng một tệp lõi `locaith.cjs` (cùng mã nguồn với extension).
Khoá không bao giờ được ghi ra log; `locaith doctor --json` đã tự ẩn khoá. Phát hành: xem `packages/locaith-cli-py/build.mjs` (dựng wheel; việc đăng PyPI là bước riêng có chủ ý).

---

## English notes

- **Install**: `pip install locaith-cli` (Node.js is bundled via `nodejs-wheel-binaries`; a system Node ≥ 20 is used when present). **Run**: `locaith` (first run: language, sign-in, folder trust).
- **Interactive**: `/` commands, `@file` mentions, `!shell`, `Shift+Tab` permission modes, `Esc` to interrupt, messages typed while it works are queued. `/help` lists everything.
- **Non-interactive**: `locaith -p "task"` (reads stdin, `--output-format json|stream-json`, `--permission-mode`, `--allowedTools`); unprompted actions are denied, never hang. Exit codes: 0 ok · 1 error · 2 usage · 127 Node missing · 130 interrupted.
- **Same engine as the VS Code extension**: permission rules, hooks, checkpoints/rewind, background tasks, MCP, skills, sub-agents, context compaction, independent verification.
- **Config**: `~/.locaith/settings.json` < project `.locaith/settings.json` < `.locaith/settings.local.json`; env `LOCAITH_API_KEY`, `LOCAITH_LANG`, `NO_COLOR`, `LOCAITH_ASCII`, `LOCAITH_HOME`, `LOCAITH_NODE`. Project settings need a trusted folder.
- **Diagnose**: `locaith doctor` · **Update**: `locaith update` · **Help topics**: `locaith help commands|shortcuts|print|settings|permissions|hooks|mcp|sessions|memory|troubleshooting`.
