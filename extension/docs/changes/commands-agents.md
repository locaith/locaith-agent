# Lệnh tuỳ chỉnh, lệnh dựng sẵn, agent con, phong cách trả lời (lane: commands-agents)

- **Lệnh gạch chéo tuỳ chỉnh theo dự án/cá nhân.** Tạo tệp `.locaith/commands/<tên>.md` trong dự án (hoặc `~/.locaith/commands/` cho riêng bạn) rồi gõ `/<tên>`. Thư mục con thành không gian tên: `.locaith/commands/frontend/component.md` → `/frontend:component`. Đọc luôn `.claude/commands/` (tương thích Claude Code; tắt bằng cài đặt `locaithAgent.commands.readClaudeDir`; thư mục `.claude` của dự án chỉ được đọc khi workspace đã tin cậy). Agent con trùng tên: agent của dự án thắng agent cá nhân, `.locaith` thắng `.claude`. Menu `/` ghi nguồn «(dự án)», «(cá nhân)», «(plugin)»; trùng tên thì lệnh dự án thắng lệnh cá nhân. Sửa/thêm/xoá tệp là menu tự làm mới.
  - Frontmatter: `description`, `argument-hint`, `allowed-tools` (chỉ dùng để cho phép lệnh ``!`…` ``, không cấp thêm công cụ cho lượt), `model` (đổi model CHỈ cho lượt chạy lệnh đó: gõ id đầy đủ, `nhàCungCấp:id` hoặc một đoạn chữ duy nhất như `gemini`; không khớp/mơ hồ thì chạy bằng model hiện tại kèm một dòng cảnh báo; `inherit` = giữ nguyên), `disable-model-invocation`.
  - Thân lệnh: `$ARGUMENTS`, `$1`…`$9`; `@đường/dẫn` nhúng tệp trong workspace (chặn `..`/đường dẫn tuyệt đối, bỏ qua `.env`/khoá/`.git/`/`.ssh/`/`.aws/`, không đi theo liên kết (symlink/junction) trỏ ra ngoài workspace, tối đa 10 tệp, 100 KB mỗi tệp); ``!`lệnh` `` chạy lệnh shell và chèn kết quả — chỉ khi workspace đã tin cậy, và lệnh khớp `allowed-tools` (ví dụ `Bash(git status:*)`) hoặc bạn bấm cho phép trên thẻ xin phép.
  - Frontmatter viết sai: hiện một dòng cảnh báo trong khung chat, menu vẫn chạy bình thường.
- **Trợ lý tự gọi lệnh tuỳ chỉnh** qua công cụ mới `slash_command` khi yêu cầu của bạn khớp một lệnh. Tắt cho từng lệnh bằng `disable-model-invocation: true`. Lệnh của workspace chưa tin cậy không bao giờ được tự gọi.
- **Lệnh dựng sẵn mới:**
  - `/review [nhánh|đường dẫn]` — rà soát thay đổi chưa commit/nhánh hiện tại bằng `git diff`, xếp lỗi theo mức Critical/High/Medium/Low kèm `tệp:dòng`, không sửa mã.
  - `/simplify` — rà thay đổi vừa làm về tái sử dụng, đơn giản hoá, hiệu năng rồi sửa luôn và chạy kiểm tra.
  - `/security-review` — rà lỗ hổng bảo mật trên các thay đổi (luồng dữ liệu nguồn → đích, kịch bản khai thác, cách sửa).
  - `/status` — phiên bản, tài khoản, model, chế độ quyền, suy luận, MCP, hook, hướng dẫn dự án, ký ức, phong cách, số lệnh/agent, cửa sổ ngữ cảnh.
  - `/doctor` — chẩn đoán shell, Git, Node.js, workspace trust, quyền ghi, tài khoản, kết nối model, dung lượng phiên, ngữ cảnh; mỗi mục ✓/⚠ kèm cách sửa.
  - `/agents` — danh sách agent con theo nguồn (dựng sẵn, dự án, cá nhân, plugin); `/agents new <tên>` tạo mẫu `.locaith/agents/<tên>.md` và mở ra; `/agents open <tên>` mở tệp định nghĩa.
  - `/output-style [tên] [--save]` — chọn phong cách trả lời cho phiên; `--save` đặt làm mặc định.
  - `/mcp` — liệt kê máy chủ MCP ngay trong khung chat và mở bảng MCP.
- **Agent con dựng sẵn mới `test-runner`**: tìm đúng lệnh kiểm thử của dự án, chạy, báo đúng con số đạt/đỏ và `tệp:dòng`, không sửa mã. Agent từ tệp (`.locaith/agents`, `~/.locaith/agents`, `.claude/agents`) nhận thêm trường `color`.
- **Phong cách trả lời**: `default`, `explanatory` (kèm phần «Vì sao»), `learning` (để bạn tự viết vài đoạn nhỏ, đánh dấu `TODO(human)`), `concise` (ngắn gọn), hoặc tệp riêng `.locaith/output-styles/*.md` / `~/.locaith/output-styles/*.md`. Cài đặt mặc định: `locaithAgent.agent.outputStyle`. Phong cách chỉ đổi giọng văn và định dạng — không bao giờ nới lỏng quy tắc kiểm chứng, an toàn, quyền.

Cài đặt mới: `locaithAgent.commands.readClaudeDir` (mặc định bật), `locaithAgent.agent.outputStyle` (mặc định `default`).

## English

- Custom slash commands from `.locaith/commands/**/*.md` (project), `~/.locaith/commands/**/*.md` (user) and `.claude/commands/` (setting `commands.readClaudeDir`; project `.claude` only in trusted workspaces). Sub-folders become namespaces (`/frontend:component`). Supports `description`, `argument-hint`, `allowed-tools`, `model`, `disable-model-invocation`, `$ARGUMENTS`, `$1..$9`, `@file` embedding (workspace-only, secrets skipped, capped) and ``!`cmd` `` (trusted workspace + `allowed-tools` match or explicit approval). Menu shows the source, refreshes on file changes; project beats user on name clashes; bad frontmatter yields a one-line warning.
- New `slash_command` tool lets the assistant run invocable custom commands.
- New built-ins: `/review`, `/simplify`, `/security-review`, `/status`, `/doctor`, `/agents`, `/output-style`, `/mcp`.
- New built-in sub-agent `test-runner`; file agents accept `color`.
- Output styles (`default`, `explanatory`, `learning`, `concise`, custom files), setting `agent.outputStyle`; styles never relax the constitution's rules.
