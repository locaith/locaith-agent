# Locaith CLI (POC)

Chạy agent Locaith trên terminal/máy chủ, **cùng lõi** với extension: cùng provider cổng Locaith (`locaith-v5-flash`), cùng engine, cùng công cụ và kỹ năng. Model chạy ở backend Locaith qua API; công cụ (đọc/ghi tệp, shell, **ffmpeg**) chạy trên máy khách.

## Dựng và chạy

```bash
npm run build:cli          # esbuild → dist-cli/locaith.cjs (một tệp, cần Node 20+)
node dist-cli/locaith.cjs --help
```

Cài toàn cục (khi phát hành): chép `locaith.cjs` vào máy khách, thêm shim `locaith`/`locaith.cmd`.

## Lệnh

| Lệnh | Việc |
|---|---|
| `locaith doctor` | Kiểm Node, ffmpeg, ffprobe, font, đĩa trống, khoá, và **gọi thật** tới cổng để xác nhận khoá + model |
| `locaith doctor --json` | Cùng thông tin, dạng JSON cho script/CI |
| `locaith ask "<việc>"` | Chạy một việc rồi in câu trả lời |
| `locaith ask --json "<việc>"` | Kết quả JSON: `ok`, `stopReason`, `turns`, `usage`, `text` |
| `locaith ask --allow all "<việc>"` | Cho phép sửa tệp và chạy lệnh (mặc định `reads`: chỉ đọc) |

Tuỳ chọn khác: `--model`, `--base-url`, `--cwd`, `--max-turns`, `--timeout`, `--quiet`.

## Đăng nhập và tài khoản

```bash
locaith login        # dán token tài khoản locaith.ai (lat_…); token được KIỂM THẬT rồi mới lưu (sai thì không ghi tệp)
locaith whoami       # đã đăng nhập chưa, đồng ý thông báo dữ liệu chưa, model dùng được
```

Token lưu ở `~/.locaith/cli.json` quyền 600; cũng nhận `LOCAITH_API_KEY` từ môi trường (tiện cho server/CI).

**Không giới hạn, không thu phí:** giai đoạn này `locaith-v5-flash` mở không giới hạn để thu hút người dùng; CLI không có bước nạp tiền.

**Gói free / pro / plus:** hạn mức do **tài khoản** quyết định ở backend. Cổng `studio-api.locaith.com` hiện **chưa có endpoint** trả thông tin gói — đã dò hơn 20 đường dẫn (`/api/account/me`, `/api/me`, `/api/plan`, `/api/usage`, `/api/llm/v1/{me,account,plan,usage,limits,quota,whoami}`…) đều 404, chỉ `/api/llm/v1/models` và `/api/llm/v1/consent` tồn tại. Vì vậy `whoami` **không tự bịa** gói: nó in "cổng chưa trả thông tin gói — xem trên locaith.ai". Khi backend thêm endpoint, chỉ cần nối vào `whoami`.

## Khoá

- `LOCAITH_API_KEY` (khuyến nghị), hoặc tệp `~/.locaith/cli.json` quyền 600 với `{ "apiKey": "lat_…" }`.
- **Không** truyền khoá qua dòng lệnh: sẽ lộ trong lịch sử shell và tiến trình.
- CLI không ghi khoá ra log; lỗi 401 của cổng được hiện nguyên văn.

## Quyền

| `--allow` | Đọc tệp | Sửa tệp | Chạy lệnh |
|---|---|---|---|
| `none` | ✗ | ✗ | ✗ |
| `reads` (mặc định) | ✓ | hỏi (nếu có terminal) | hỏi |
| `all` | ✓ | ✓ | ✓ |

Không có terminal (CI) và cần quyền ghi → mặc định **từ chối**; phải nói rõ `--allow all`.

## Máy khách cần gì

- Node 20+.
- **ffmpeg/ffprobe** cho kỹ năng video (`doctor` chỉ cách cài). Khuyến nghị 4 vCPU / 8 GB RAM / ≥ 10 GB đĩa cho clip 720p; 8 vCPU / 16 GB cho 1080p. Không cần GPU.
- Mạng ra `studio-api.locaith.com` (hoặc `--base-url` khác).

## Mã thoát

| Mã | Nghĩa |
|---|---|
| 0 | Xong bình thường (`end_turn`) |
| 1 | Lỗi (mạng, 401 của cổng, model dừng vì lý do khác) hoặc `doctor` còn mục ✘ |
| 2 | Dùng sai lệnh/tuỳ chọn, hoặc `ask` thiếu nội dung |

Với `--json`, lỗi vẫn ra **stdout** dạng `{ "ok": false, "error": "…" }` để script đọc được; tiến trình và thống kê đi **stderr**, nên `locaith ask --json … > out.json` cho tệp JSON sạch.

> Đã sửa một lỗi thoát thật: trước đây gọi `process.exit()` ngay sau khi có I/O làm libuv abort trên Windows (`0xC0000409`) và mã thoát đúng bị mất. Nay CLI đặt `exitCode`, đóng socket keep-alive của `fetch`, xả stdout rồi mới thoát.

## Đã kiểm những gì

- `test/cli.test.ts` (7 ca): chạy trên **tệp đã đóng gói** — version, help, tuỳ chọn sai, thiếu nội dung, `doctor` JSON/người đọc, không in khoá.
- `test/cli.e2e.test.ts` (4 ca): máy chủ giả **OpenAI-compatible có stream SSE** — vòng lặp công cụ 2 lượt (`read_file` → trả lời), `--json`/`--quiet`/người đọc, lỗi mạng thành JSON + mã thoát 1.

Chưa kiểm: gọi cổng Locaith **thật** (cần khoá của chủ dự án) và một việc có ffmpeg.



- **Cổng riêng cho khách** (khoá `lcx_…`, quota, đo usage, chặn `system` của client): chưa viết; POC gọi thẳng cổng hiện tại bằng token tài khoản.
- **SDK** (`@locaith/sdk`, `locaith-sdk` Python): chưa có.
- Không lưu phiên giữa các lần chạy; không có chế độ `serve`; chưa xử lý luồng đồng ý thông báo dữ liệu ngoài việc hiện lỗi của cổng.
- Chưa ký số tệp phát hành, chưa có bộ cài.
