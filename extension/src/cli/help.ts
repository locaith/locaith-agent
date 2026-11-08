/**
 * Trợ giúp của Locaith CLI: `locaith --help` (tóm tắt) và `locaith help <chủ đề>` (hướng dẫn đầy đủ, vi/en).
 * Văn bản thuần (không màu) để xem được trong ống/tệp; giao diện tương tác có `/help` riêng.
 */

import type { Lang } from './i18n';

export const HELP_TOPICS = ['commands', 'shortcuts', 'print', 'settings', 'permissions', 'hooks', 'mcp', 'sessions', 'memory', 'troubleshooting'] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

export function usageText(version: string, lang: Lang): string {
  return lang === 'en'
    ? `Locaith CLI ${version} — the Locaith coding agent in your terminal (same engine as the VS Code extension)

USAGE
  locaith                       interactive session (needs a terminal)
  locaith "task"                interactive session, with this first message sent for you
  locaith -p "task"             print once and exit (also reads stdin: cat log | locaith -p "summarize")
  locaith <command>             doctor · login · logout · whoami · consent · update · sessions · config · help [topic] · version

COMMON OPTIONS
  -p, --print                   non-interactive: print the answer and exit
  --output-format <f>           text (default) | json | stream-json   (with -p)
  -c, --continue                continue the most recent session in this folder
  -r, --resume [id]             resume a session (no id: pick from a list)
  --model <id>                  model (default locaith-v5-flash; also: locaith-v5-si)
  --permission-mode <m>         default | acceptEdits | plan | bypassPermissions
  --allowedTools <rules>        e.g. "Bash(npm test:*)" "Read"      (also --disallowedTools)
  --add-dir <dir>               allow reading one more folder
  --append-system-prompt <t>    extra instructions for this run
  --max-turns <n>   --timeout <s>   --cwd <dir>   --mcp-config <file>
  --no-session-persistence      do not save this session
  --verbose   --no-color   --lang vi|en   -h/--help   -v/--version

KEYS: set LOCAITH_API_KEY (CI/servers) or run \`locaith login\`. Never pass keys on the command line.
More: locaith help <${HELP_TOPICS.join('|')}>`
    : `Locaith CLI ${version} — trợ lý lập trình Locaith ngay trong terminal (cùng lõi với extension VS Code)

CÁCH DÙNG
  locaith                       phiên tương tác (cần terminal)
  locaith "việc cần làm"        phiên tương tác, gửi sẵn câu này
  locaith -p "việc"             in một lần rồi thoát (nhận cả stdin: cat log | locaith -p "tóm tắt")
  locaith <lệnh>                doctor · login · logout · whoami · consent · update · sessions · config · help [chủ đề] · version

TUỲ CHỌN THƯỜNG DÙNG
  -p, --print                   không tương tác: in câu trả lời rồi thoát
  --output-format <f>           text (mặc định) | json | stream-json   (đi với -p)
  -c, --continue                tiếp tục phiên gần nhất của thư mục này
  -r, --resume [id]             mở lại một phiên (không có id: chọn từ danh sách)
  --model <id>                  model (mặc định locaith-v5-flash; còn locaith-v5-si)
  --permission-mode <m>         default | acceptEdits | plan | bypassPermissions
  --allowedTools <luật>         ví dụ "Bash(npm test:*)" "Read"      (và --disallowedTools)
  --add-dir <thư mục>           cho đọc thêm một thư mục
  --append-system-prompt <t>    chỉ dẫn thêm cho lượt này
  --max-turns <n>   --timeout <giây>   --cwd <thư mục>   --mcp-config <tệp>
  --no-session-persistence      không lưu phiên này
  --verbose   --no-color   --lang vi|en   -h/--help   -v/--version

KHOÁ: đặt LOCAITH_API_KEY (CI/máy chủ) hoặc chạy \`locaith login\`. Không truyền khoá qua dòng lệnh.
Xem thêm: locaith help <${HELP_TOPICS.join('|')}>`;
}

const VI: Record<HelpTopic, string> = {
  commands: `LỆNH GẠCH CHÉO (gõ "/" trong phiên để mở menu, Tab/Enter để chọn)
  /help            hướng dẫn và phím tắt           /clear (/new)     phiên mới, xoá ngữ cảnh
  /compact [gì]    nén ngữ cảnh (ưu tiên giữ "gì")  /context         đồng hồ ngữ cảnh, token, số lần nén
  /cost            token và chi phí ước tính        /model [id]       xem/đổi model
  /mode [tên]      chế độ quyền (Shift+Tab)         /thinking [mức]   mức suy luận
  /resume [id]     mở lại phiên đã lưu              /sessions         liệt kê phiên
  /rewind          quay lại một lượt (mã / hội thoại / cả hai)       /fork   rẽ nhánh từ đây
  /tasks           tác vụ nền (dev server, build…)  /hooks           xem hooks đang chạy
  /permissions     luật cho phép/hỏi/chặn           /agents           agent con
  /mcp             máy chủ MCP                      /memory           LOCAITH.md và ký ức bền
  /init            tạo LOCAITH.md cho dự án         /skills           kỹ năng đã nạp
  /review /simplify /security-review /verify        rà soát mã, đơn giản hoá, bảo mật, kiểm chứng độc lập
  /output-style    phong cách trả lời               /config           cài đặt      /theme   giao diện sáng/tối
  /login /logout /whoami /doctor /update /export /copy /exit
  !lệnh            chạy shell ngay (kết quả đưa vào ngữ cảnh)        @đường-dẫn  nhắc tệp/ảnh/tài liệu
Lệnh tuỳ chỉnh: tạo tệp .locaith/commands/ten.md (dự án) hoặc ~/.locaith/commands/ten.md (cá nhân); dùng $ARGUMENTS, @tệp, !\`lệnh\`.`,
  shortcuts: `PHÍM TẮT TRONG PHIÊN
  Enter gửi · Ctrl+J / Alt+Enter / "\\" rồi Enter: xuống dòng · ↑/↓ lịch sử · Ctrl+R tìm trong lịch sử
  Esc: dừng lượt đang chạy (rảnh: xoá ô nhập; bấm 2 lần: menu rewind)
  Ctrl+C: xoá ô nhập / dừng lượt / (rảnh + trống) bấm lần nữa để thoát · Ctrl+D: thoát khi ô trống
  Shift+Tab: đổi chế độ quyền · Ctrl+O: mở/gập kết quả công cụ · Ctrl+T: bảng việc · Ctrl+L: vẽ lại
  Tab/→: chấp nhận gợi ý · "/" menu lệnh · "@" tệp · "!" shell · "?" phím tắt
  Ctrl+A/E: đầu/cuối dòng · Ctrl+K/U/W: xoá tới cuối/đầu/từ trước · Alt+B/F: nhảy từ · Ctrl+V: dán ảnh (Windows)
Gõ tiếp khi trợ lý đang chạy: tin được XẾP HÀNG và gửi ở ranh giới vòng công cụ kế tiếp.`,
  print: `CHẾ ĐỘ IN MỘT LẦN (không giao diện) — dùng cho script/CI
  locaith -p "tóm tắt repo này"                         in câu trả lời cuối ra stdout
  cat build.log | locaith -p "vì sao lỗi?"               nhận stdin làm dữ liệu
  locaith -p --output-format json "…"                    một đối tượng JSON (result, usage, session_id, num_turns…)
  locaith -p --output-format stream-json "…"             NDJSON từng sự kiện (system/assistant/user/result)
  locaith -p --permission-mode acceptEdits "sửa lỗi type"  cho sửa tệp không hỏi
  locaith -p --allowedTools "Bash(npm test:*)" "chạy test và sửa"  cho đúng lệnh cần thiết
Không có terminal để hỏi: thao tác chưa được cấp quyền bị TỪ CHỐI (không treo). Tiến trình đi stderr, kết quả đi stdout.
Mã thoát: 0 xong · 1 lỗi/chưa xong · 2 dùng sai · 127 thiếu Node · 130 bị ngắt (Ctrl+C).`,
  settings: `CÀI ĐẶT (JSON; khoá giống cài đặt extension, bỏ tiền tố "locaithAgent.")
  ~/.locaith/settings.json              cá nhân (mọi dự án)
  <dự-án>/.locaith/settings.json        dự án (chia sẻ qua git)
  <dự-án>/.locaith/settings.local.json  cục bộ (không commit)
  Ví dụ: { "agent": { "compactAtPercent": 90 }, "permissions": { "allow": ["Bash(npm test:*)"] }, "checkpoints": { "enabled": true } }
Biến môi trường: LOCAITH_API_KEY, LOCAITH_LANG=vi|en, NO_COLOR, LOCAITH_ASCII=1, LOCAITH_HOME (đổi thư mục ~/.locaith).
Cài đặt của dự án chỉ có tác dụng đầy đủ khi bạn TIN CẬY thư mục (hỏi lần đầu); chưa tin cậy thì chỉ được thêm luật ask/deny.`,
  permissions: `QUYỀN
Chế độ (Shift+Tab hoặc --permission-mode): default (hỏi trước khi sửa/chạy lệnh) · acceptEdits (tự nhận chỉnh sửa tệp) · plan (chỉ đọc và lập kế hoạch) · bypassPermissions (không hỏi — thận trọng).
Luật (cài đặt permissions.allow / ask / deny, hoặc /permissions): cú pháp tool(đặc-tả) — Bash(npm test:*) · Edit(src/**) · Read(.env*) · WebFetch(domain:github.com) · mcp__máy-chủ__*.
Thứ tự: deny > ask > allow, tính TRƯỚC chế độ. Lệnh ghép (&&, ;, |) phải khớp từng phần. "Luôn cho phép…" trên hộp xin quyền ghi luật vào cài đặt.
Mọi thao tác ngoài thư mục làm việc, tệp bí mật (.env, khoá) và lệnh nguy hiểm luôn hỏi (trừ bypassPermissions).`,
  hooks: `HOOKS — chạy lệnh shell của bạn ở các mốc (cùng lược đồ Claude Code)
Cài đặt "hooks" trong settings.json: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, SessionEnd, Notification.
  { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node scripts/guard.js" } ] } ] } }
Hook nhận JSON qua stdin; mã thoát 2 = chặn (stderr hiện cho trợ lý); hạn 60 giây; không nhận khoá API trong môi trường.
Hooks của DỰ ÁN chỉ chạy ở thư mục đã tin cậy và sau khi bạn duyệt đúng các lệnh đó. /hooks để xem.`,
  mcp: `MCP — nối công cụ ngoài
Cấu hình (lược đồ Claude): <dự-án>/.mcp.json, ~/.locaith/mcp.json, cài đặt "mcpServers", hoặc --mcp-config tệp.json
  { "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } } } }
Máy chủ của dự án cần thư mục đã tin cậy và bạn duyệt từng cái. /mcp xem trạng thái, bật/tắt, kết nối lại. Công cụ MCP đi qua cùng luật quyền (mcp__máy-chủ__công-cụ).`,
  sessions: `PHIÊN
Mỗi cuộc trò chuyện tự lưu ở ~/.locaith/sessions. locaith -c tiếp tục phiên gần nhất của thư mục; locaith -r [id] mở lại; /sessions, /resume trong phiên; /fork rẽ nhánh; /rewind quay lại một lượt (khôi phục mã và/hoặc hội thoại — cần checkpoints.enabled, mặc định bật).
Nén ngữ cảnh tự động ở 80% cửa sổ (agent.compactAtPercent); kết quả công cụ cũ được lược trước; /compact để nén tay.`,
  memory: `KÝ ỨC VÀ CHỈ DẪN
LOCAITH.md (hoặc AGENTS.md / CLAUDE.md) ở gốc dự án và ~/.locaith/LOCAITH.md: chỉ dẫn luôn được nạp. /init tạo LOCAITH.md bằng cách quét dự án; /memory mở để sửa.
Ký ức bền (.locaith/memory/MEMORY.md và ~/.locaith/memory/MEMORY.md) được nạp lại mỗi lượt; trợ lý ghi bằng công cụ remember (không ghi bí mật).`,
  troubleshooting: `GẶP SỰ CỐ
  locaith doctor           kiểm Node, terminal, git, ffmpeg, khoá, cổng Locaith, bản mới — và nói cách sửa
  401 / hết hạn            locaith login lại (token sống 90 ngày không dùng)
  Chưa đồng ý thông báo dữ liệu   locaith consent --yes (hoặc làm ở lần chạy đầu)
  Màu/khung bị vỡ          đặt NO_COLOR=1 hoặc LOCAITH_ASCII=1; dùng Windows Terminal/PowerShell 7 để có đủ màu
  Trợ lý bị treo           Esc để dừng; --timeout <giây> với -p; locaith doctor để kiểm mạng
  Cập nhật                 locaith update (hoặc pip install -U locaith-cli)
Báo lỗi: https://locaith.ai (kèm kết quả locaith doctor --json, đã tự ẩn khoá).`,
};

const EN: Record<HelpTopic, string> = {
  commands: `SLASH COMMANDS (type "/" in a session for the menu; Tab/Enter to pick)
  /help            guide and shortcuts              /clear (/new)     new session, clear context
  /compact [what]  compact context (keep "what")    /context          context meter, tokens, compactions
  /cost            tokens and estimated cost        /model [id]       show/change model
  /mode [name]     permission mode (Shift+Tab)      /thinking [level] reasoning level
  /resume [id]     reopen a saved session           /sessions         list sessions
  /rewind          go back to a turn (code / conversation / both)   /fork   branch from here
  /tasks           background tasks (dev servers…)  /hooks            show active hooks
  /permissions     allow/ask/deny rules             /agents           sub-agents
  /mcp             MCP servers                      /memory           LOCAITH.md and persistent memory
  /init            create LOCAITH.md for the repo   /skills           loaded skills
  /review /simplify /security-review /verify        code review, simplify, security review, independent check
  /output-style    answer style                     /config           settings     /theme   light/dark
  /login /logout /whoami /doctor /update /export /copy /exit
  !command         run a shell command now (result goes into context)    @path   mention a file/image/document
Custom commands: create .locaith/commands/name.md (project) or ~/.locaith/commands/name.md (personal); use $ARGUMENTS, @file, !\`cmd\`.`,
  shortcuts: `SESSION SHORTCUTS
  Enter send · Ctrl+J / Alt+Enter / "\\" then Enter: newline · ↑/↓ history · Ctrl+R search history
  Esc: stop the running turn (idle: clear the input; twice: rewind menu)
  Ctrl+C: clear input / stop the turn / (idle + empty) press again to quit · Ctrl+D: quit when empty
  Shift+Tab: cycle permission mode · Ctrl+O: expand/collapse tool output · Ctrl+T: todo panel · Ctrl+L: redraw
  Tab/→: accept suggestion · "/" commands · "@" files · "!" shell · "?" shortcuts
  Ctrl+A/E: line start/end · Ctrl+K/U/W: kill to end/start/previous word · Alt+B/F: word jump · Ctrl+V: paste image (Windows)
Keep typing while the assistant works: your message is QUEUED and delivered at the next tool-loop boundary.`,
  print: `PRINT MODE (no UI) — for scripts/CI
  locaith -p "summarize this repo"                       final answer to stdout
  cat build.log | locaith -p "why did it fail?"          stdin is data
  locaith -p --output-format json "…"                    one JSON object (result, usage, session_id, num_turns…)
  locaith -p --output-format stream-json "…"             NDJSON events (system/assistant/user/result)
  locaith -p --permission-mode acceptEdits "fix the type errors"   allow edits without asking
  locaith -p --allowedTools "Bash(npm test:*)" "run tests and fix"  allow exactly what is needed
With no terminal to ask, anything not already allowed is DENIED (it never hangs). Progress goes to stderr, results to stdout.
Exit codes: 0 done · 1 error/unfinished · 2 usage · 127 Node missing · 130 interrupted (Ctrl+C).`,
  settings: `SETTINGS (JSON; keys match the extension settings without the "locaithAgent." prefix)
  ~/.locaith/settings.json              personal (all projects)
  <project>/.locaith/settings.json      project (shared via git)
  <project>/.locaith/settings.local.json  local (not committed)
  Example: { "agent": { "compactAtPercent": 90 }, "permissions": { "allow": ["Bash(npm test:*)"] }, "checkpoints": { "enabled": true } }
Environment: LOCAITH_API_KEY, LOCAITH_LANG=vi|en, NO_COLOR, LOCAITH_ASCII=1, LOCAITH_HOME (relocate ~/.locaith).
Project settings only take full effect when you TRUST the folder (asked on first run); untrusted folders can only add ask/deny rules.`,
  permissions: `PERMISSIONS
Modes (Shift+Tab or --permission-mode): default (ask before edits/commands) · acceptEdits (auto-accept file edits) · plan (read-only planning) · bypassPermissions (no prompts — be careful).
Rules (settings permissions.allow / ask / deny, or /permissions): tool(spec) — Bash(npm test:*) · Edit(src/**) · Read(.env*) · WebFetch(domain:github.com) · mcp__server__*.
Order: deny > ask > allow, evaluated BEFORE the mode. Compound commands (&&, ;, |) must match on every part. "Always allow…" on the prompt writes a rule into settings.
Anything outside the working folder, secret files (.env, keys) and dangerous commands always ask (except bypassPermissions).`,
  hooks: `HOOKS — run your shell commands at key moments (same schema as Claude Code)
Setting "hooks" in settings.json: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, SessionEnd, Notification.
  { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node scripts/guard.js" } ] } ] } }
Hooks get JSON on stdin; exit code 2 blocks (stderr is shown to the assistant); 60 s limit; API keys are not in their environment.
PROJECT hooks only run in a trusted folder and after you approve those exact commands. /hooks lists them.`,
  mcp: `MCP — connect external tools
Config (Claude schema): <project>/.mcp.json, ~/.locaith/mcp.json, setting "mcpServers", or --mcp-config file.json
  { "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } } } }
Project servers need a trusted folder and your approval one by one. /mcp shows status, enable/disable, reconnect. MCP tools go through the same permission rules (mcp__server__tool).`,
  sessions: `SESSIONS
Every conversation is saved in ~/.locaith/sessions. locaith -c continues the folder's latest session; locaith -r [id] reopens one; /sessions, /resume inside; /fork branches; /rewind goes back a turn (restores code and/or conversation — needs checkpoints.enabled, on by default).
Context auto-compacts at 80% of the window (agent.compactAtPercent); old tool results are trimmed first; /compact compacts by hand.`,
  memory: `MEMORY AND INSTRUCTIONS
LOCAITH.md (or AGENTS.md / CLAUDE.md) at the repo root and ~/.locaith/LOCAITH.md: instructions always loaded. /init creates LOCAITH.md by scanning the project; /memory opens it for editing.
Persistent memory (.locaith/memory/MEMORY.md and ~/.locaith/memory/MEMORY.md) is reloaded every turn; the assistant writes with the remember tool (never secrets).`,
  troubleshooting: `TROUBLESHOOTING
  locaith doctor           checks Node, terminal, git, ffmpeg, key, the Locaith gateway, new versions — and says how to fix
  401 / expired            run locaith login again (tokens live 90 days unused)
  Data notice not accepted locaith consent --yes (or do it on first run)
  Broken colors/boxes      set NO_COLOR=1 or LOCAITH_ASCII=1; use Windows Terminal/PowerShell 7 for full color
  Assistant seems stuck    Esc to stop; --timeout <s> with -p; locaith doctor to check the network
  Update                   locaith update (or pip install -U locaith-cli)
Report bugs: https://locaith.ai (attach locaith doctor --json output; keys are masked).`,
};

export function helpTopicText(topic: string | undefined, lang: Lang): string | undefined {
  if (!topic) return undefined;
  const k = topic.toLowerCase() as HelpTopic;
  if (!(HELP_TOPICS as readonly string[]).includes(k)) return undefined;
  return (lang === 'en' ? EN : VI)[k];
}

export function topicList(lang: Lang): string {
  return (lang === 'en' ? 'Topics' : 'Chủ đề') + ': ' + HELP_TOPICS.join(', ');
}
