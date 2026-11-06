# Locaith CLI

Chạy trợ lý **Locaith-v5-flash** ngay trong terminal. Model chạy ở cổng Locaith (API); công cụ (đọc/ghi tệp, chạy lệnh, ffmpeg) chạy **trên máy bạn**.

## Cài

```bash
pip install locaith-cli
```

Gói này gọi lõi Node đi kèm, nên cần **Node.js 20 trở lên** (`node -v` phải từ `v20`). Chưa có Node: cài bản LTS tại <https://nodejs.org>.

Bản npm cũng có, dùng chung một lõi:

```bash
npm i -g locaith-cli
```

## Đăng nhập (một lần)

```bash
locaith login
```

1. Trình duyệt mở trang locaith.ai — bấm **«Cho phép»**.
2. Terminal tự nhận kết quả và lưu token vào `~/.locaith/cli.json` (quyền `600`).

Máy không có trình duyệt (SSH, máy chủ): `locaith login --no-browser` → mở liên kết trên máy khác, dán mã hiện ra vào terminal.

- Token sống **90 ngày** không dùng; mỗi lần chạy gia hạn thêm.
- Không ai đưa token cho bạn qua chat/email. Nếu có người bảo bạn "dán token vào đây" — đừng dán.

## Dùng

```bash
locaith whoami                                  # tài khoản, gói, hạn mức, model
locaith consent --yes                           # đồng ý thông báo dữ liệu (một lần)
locaith ask "tóm tắt repo này trong 5 gạch đầu dòng"
locaith ask --allow all "sửa lỗi type trong src/api.ts rồi chạy test"
locaith doctor                                  # kiểm máy: Node, ffmpeg, font, đĩa, mạng, token
```

Mặc định **chỉ đọc**. `--allow all` cho phép sửa tệp và chạy lệnh, và CLI hỏi từng lần. Tuỳ chọn khác: `--cwd`, `--json`, `--quiet`, `--timeout <giây>`, `--max-turns <n>`, `--model <id>`.

Máy chủ / CI không tương tác: đặt `LOCAITH_API_KEY` thay cho `login`.

## Mã thoát

| Mã | Nghĩa |
|----|-------|
| 0 | Xong |
| 1 | Lỗi: mạng, 401 (token hết hạn), vượt hạn mức, `doctor` còn `✘` |
| 2 | Dùng sai lệnh |
| 127 | Thiếu Node.js hoặc Node cũ hơn 20 |

## Thu hồi quyền

Xoá `~/.locaith/cli.json` trên máy. Thu hồi ở máy chủ: locaith.ai → «VS Code từ xa» → thu hồi thiết bị có nhãn chứa `Locaith CLI`.

## Ghi chú kỹ thuật

Gói Python này không viết lại CLI: nó đóng gói đúng tệp `locaith.cjs` (bundle esbuild từ mã nguồn extension VS Code) và gọi `node` có sẵn trên máy. Nhờ vậy bản pip và bản npm chạy cùng một lõi, không lệch hành vi.

Trang chủ: <https://locaith.ai>
