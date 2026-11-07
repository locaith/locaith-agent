# Harness giao diện webview

Xem và chụp giao diện **mà không cần mở VS Code**. Harness giả lập môi trường webview: biến `--vscode-*`
(theme tối / sáng / tương phản cao), các lớp `body.vscode-*`, stylesheet mặc định của VS Code,
`acquireVsCodeApi()` và một *host giả lập* phát lại kịch bản.

```bash
node webview/dev/build.mjs            # build webview chính (dist/webview) + harness (webview/dev/.build)
node webview/dev/shoot.mjs            # chụp ~35 ảnh vào webview/dev/shots/
node webview/dev/shoot.mjs picker     # chỉ chụp ảnh có tên chứa "picker"
node webview/dev/shoot.mjs --ime      # kiểm tra hành vi: bộ gõ tiếng Việt, dán ảnh, @mention, /lệnh, phím tắt
```

Mở thủ công `webview/dev/harness.html` bằng Chrome (cần `--allow-file-access-from-files` để nạp font):

| Tham số | Ý nghĩa |
| --- | --- |
| `theme=dark\|light\|hc\|hclight` | Theme VS Code giả lập |
| `scenario=` | `welcome` · `onboarding` · `research` · `long` · `perm-edit` · `perm-cmd` · `perm-plan` · `error` · `history` · `settings` · `settings-nokeys` · `high-context` · `parallel-agents` · `parallel-narrow` · `media` (0.6.3: lượt đã xong gấp quá trình + xem trước ảnh/GIF/video/âm thanh/tài liệu từ tệp mẫu thật ở `webview/dev/media`) · `media-live` (cùng nội dung, đang chạy) |
| `speed=0` | Phát kịch bản tức thì (mặc định 1 = theo thời gian thực) |
| `stop=` | Dừng giữa chừng ở mốc: `tasks` · `searching` · `pills` · `fetch` · `writing` · `artifact` · `streaming` · `done` |
| `expand=1` | Trải toàn bộ dòng thời gian (để chụp cả cuộc trò chuyện) |
| `lang=en` · `font=manrope\|inter\|system` · `bypass=1` · `w=<px>` | Ngôn ngữ, font, bật chế độ bỏ qua xác nhận, bề rộng |
| `platform=browser` | Chạy như bản Chrome/Edge (không nút mở tệp, không hàng chờ tin) |

Cảnh `cc-timeline` / `cc-working` (lane cc-timeline-ui) tái hiện ba ảnh mẫu Claude Code: `node webview/dev/shoot.mjs cc-` chụp và KIỂM DOM (dòng nhóm, chấm màu, dòng agent, dòng nén, giờ/ngày, IN/OUT, xem trước tệp).

Gõ vào ô nhập của harness sẽ chạy kịch bản "so sánh Intelligence Index" (nếu có từ khoá) hoặc một câu trả lời mẫu.

Ảnh chụp dài được cắt thành các lát `…-partN.png` (760px CSS mỗi lát) để đọc rõ.
Thư mục `.build/` và `shots/` đã nằm trong `.gitignore` và bị `.vscodeignore` loại (`webview/**`).
