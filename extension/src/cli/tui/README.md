# Giao diện terminal của Locaith CLI (`src/cli/tui`)

TUI **tự viết** (không Ink/React, không thêm dependencies). Chỉ biết `CliRuntime` (`../runtime/contract.ts`) và các kiểu chung ở `shared/protocol.ts`;
không import engine/host/core. Đặc tả: `docs/CLI-ARCHITECTURE.md` mục 5.

## Cổng vào (`index.ts`)

| Hàm | Việc |
|---|---|
| `runTui(rt, { version, lang, stdin?, stdout?, theme?, … })` | vòng tương tác trọn vẹn → mã thoát. Không có TTY → **ném lỗi** (người gọi chuyển sang chế độ in một lần trước). |
| `runOnboarding(opts)` | lần chạy đầu: ngôn ngữ → đăng nhập (trình duyệt / dán token / khoá hãng khác / bỏ qua) → đồng ý thông báo dữ liệu → tin cậy thư mục. Dùng `loginCmd` của `cli/account.ts` (người gọi đưa `accountDeps(io)`). |
| `renderWelcome(info)` | khung chào: logo «Lo» nửa ô, tên + phiên bản, tài khoản, model, thư mục, mẹo. |
| `MockRuntime` | `CliRuntime` giả có kịch bản (phát triển + kiểm thử). |

Tuỳ chọn thêm của `runTui` (đều tuỳ chọn): `env`, `cwd`, `noColor`, `ascii`, `historyFile` (null = không lưu), `home`, `banner`, `initialInput`, `readImage`.

## Kiến trúc vẽ

```
phím (stdin raw) → KeyParser (keys.ts) → TuiApp (app.ts) ─┬→ rt.submit / interrupt / respondPermission / answer …
sự kiện rt ───────→ Conversation (conversation.ts) ───────┤
                       dòng HOÀN CHỈNH ─→ Screen.print() ─┴→ in thẳng vào scrollback
                       vùng sống (stream dở, lệnh đang chạy, spinner, ô nhập, menu, dải trạng thái) → Screen.setProvider()
```

* `screen.ts`: mỗi khung = `ESC[?2026h` · lùi con trỏ lên đầu vùng sống · in các dòng mới (đẩy vào scrollback) · ghi đè từng dòng vùng sống (bỏ qua dòng không đổi, trừ dòng cuối) + `ESC[K` · `ESC[J` · `ESC[?2026l`. Con trỏ thật luôn ẩn; con trỏ trong ô nhập là ô đảo màu. Dòng cuối không bao giờ rộng đúng bằng số cột. Đổi cỡ: ước lượng số hàng thật rồi vẽ lại. Không xoá màn hình trừ `/clear` (`clearScreen`).
* `markdown.ts`: máy trạng thái theo dòng dùng chung cho stream và render một lần (stream từng ký tự cho kết quả y hệt render một lần — có test). Dòng dài chưa có `\n` được cam kết dần theo hàng khi không còn dấu `**`/`` ` ``/`[` mở.
* `conversation.ts`: rút gọn `UiEvent` bằng `applyEvent` của extension; in khối theo thứ tự; công cụ chỉ in khi xong (`● Read(path)` + `⎿ kết quả`); ≥ 3 lệnh đọc/tìm liền nhau gom một dòng; agent con có số liệu sống.
* `widgets.ts` / `dialogs.ts`: ô nhập, dải trạng thái, spinner (chữ chạy bóng gradient), bảng việc, menu gợi ý, hộp xin quyền / chọn (có tìm kiếm, không phân biệt dấu) / xác nhận / nhập.
* `terminal.ts`: raw mode, bracketed paste, hẹn giờ ESC đơn, khôi phục terminal khi thoát / crash / SIGINT / SIGTERM / SIGHUP (đồng bộ, idempotent).
* `theme.ts`: truecolor → 256 → 16 → `NO_COLOR`; ASCII khi `LOCAITH_ASCII=1` hoặc locale không UTF-8; nền sáng/tối từ `COLORFGBG` hoặc `/theme`.
* Quy ước với runtime: giao diện **tự in** dòng `> /lệnh` và `> !shell` (runtime không phát `user` cho chúng); tin gửi model được in khi nhận `ui:user` (nếu runtime quên, giao diện in bù ở `assistant_start`). `/theme` do giao diện xử lý. `action:'copy'` ghi clipboard (OSC 52 + `clip`/`pbcopy`/`xclip`); `action:'open_editor'` mở `$VISUAL/$EDITOR`. `/sessions` và `/resume` mở cùng `PickDialog` (có ô tìm); `locaith -r` (không mã) chạy giao diện với `initialPrompt: '/resume'` — hộp chọn hiện ngay khi sẵn sàng (xem `wantsSessionPicker` ở `args.ts`).

## Phím tắt

Enter gửi · Ctrl+J / Alt+Enter / `\`+Enter xuống dòng (dán nhiều dòng giữ nguyên) · Esc dừng lượt (rảnh: xoá ô; Esc×2 = `/rewind`) · Ctrl+C (có chữ: xoá; đang chạy: dừng; rảnh+trống: nhấn lần nữa để thoát) · Ctrl+D thoát khi trống · Ctrl+L đẩy màn hình lên scrollback · Ctrl+O bật/tắt mở rộng kết quả (+ in đầy đủ kết quả bị rút gọn gần nhất) · Ctrl+T bảng việc · Ctrl+R tìm ngược · Ctrl+G soạn ngoài · Shift+Tab đổi chế độ quyền · ↑/↓ lịch sử · Tab/→ chấp nhận gợi ý · `/` menu lệnh · `@` menu tệp · `!` chế độ shell · `?` bảng phím tắt · Alt+V / `/paste` (`/image`) / Ctrl+V dán ảnh clipboard (Windows Terminal giữ Ctrl+V để dán chữ nên Ctrl+V không tới ứng dụng; «dán» rỗng cũng thử đọc ảnh) · Ctrl+A/E/K/U/W/Y, Alt+B/F/D emacs.

## Chạy thử, ảnh, kiểm thử

```
node scripts/cli-tui-demo.mjs [--lang en] [--speed 0.5] [--light] [--no-color] [--ascii]   # xem bằng mắt (cần TTY)
node scripts/cli-screens.mjs [lọc…]                                                       # ảnh PNG → docs/cli-screens/ (pty thật + Chrome)
node scripts/cli-gen-logo.mjs                                                              # sinh lại logoArt.ts từ webview/src/brand/lo.ts
npx vitest run test/cli/tui                                                                # đơn vị + tích hợp (xterm headless)
LOCAITH_E2E_PTY=1 npx vitest run test/cli/e2e                                              # e2e pty thật (ConPTY; useConptyDll:false)
npx tsc -p tsconfig.json --noEmit
```

Gỡ lỗi nhanh khi sửa vẽ: `test/cli/tui/helpers/vt.ts` (terminal ảo + stdin giả), `helpers/boot.ts` (khởi động TuiApp + MockRuntime; đặt `LOCAITH_TUI_DUMP=<thư mục>` để `b.dump(name)` ghi màn hình ra tệp).

## Bẫy đã gặp

* `ESC[K`/`ESC[J` khi con trỏ ở trạng thái «chờ cuộn» (dòng rộng đúng bằng số cột) xoá mất ký tự cuối → dòng cuối luôn ≤ cols−1, và dòng cuối luôn được ghi lại trước `ESC[J`.
* `wrapAnsi` chế độ `pre` (khối mã, diff) phải phát mã ANSI NGAY, không gom vào «từ» (lỗi cũ làm mã màu dồn về cuối dòng).
* Emoji rộng 2 ở terminal thật nhưng xterm headless (Unicode 6) tính 1 → test chỉ dùng CJK cho kiểm cột.
* pty trên Windows: bắt buộc `useConptyDll:false` + `process.execPath` tuyệt đối.
