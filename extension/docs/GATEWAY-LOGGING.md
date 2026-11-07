# Nhãn chẩn đoán gửi tới cổng Locaith và việc cần làm ở phía máy chủ (H02)

Tài liệu này dành cho người sửa **backend** của cổng (`locaith-ai-v2/backend/app/locaith_llm`). Extension chỉ gửi nhãn; phía máy chủ chưa ghi chúng. **Không có thay đổi backend nào được thực hiện trong đợt này** — backend là dịch vụ đang chạy thật và cần quyết định riêng của chủ dự án.

## Vấn đề

Trong log cổng (04–07/11/2026): 74/83 lỗi là 401 và 83/83 bản ghi lỗi **thiếu client / tài khoản / thiết bị**, nên không biết ai (họ máy khách nào, máy nào, phiên nào) đang dùng lại token hỏng.

Nguyên nhân đã đọc được trong mã (chỉ đọc, `gateway.py` / `auth.py` / `logstore.py`):

* `Gateway.log_auth_failure()` dựng `Identity("", "", "anonymous", False, <client>, "", False)` — bản ghi lỗi 401 chỉ mang `client` (rút gọn 40 ký tự), còn `account = ""` (token hỏng nên không biết tài khoản) và `session = ""` (bị bỏ dù tiêu đề `X-Locaith-Session` có gửi). Thêm nữa nó **lấy mẫu 1 dòng / 2 giây**, nên một đợt 401 dồn dập chỉ để lại vài dòng.
* Với `lat_` token sai, `Authenticator._device()` nhớ kết quả «không hợp lệ» **30 giây** (`NEGATIVE_TTL_S`) và trả 401 từ bộ đệm — vì vậy một client cứ gửi lại token hỏng sẽ nhận 401 liên tục mà không tới Supabase. Đây là lý do client phải đánh dấu token hỏng và không gửi lại (đã làm ở extension, H01).

## Các tiêu đề extension gửi trên MỌI yêu cầu tới cổng

| Tiêu đề | Giá trị | Ghi chú |
|---|---|---|
| `X-Locaith-Client` | `vscode/<phiên bản>` (cũng `browser/…`, `cli/…`) | Họ + phiên bản, chỉ ký tự `[A-Za-z0-9.+-]`. Đã có từ trước (backend đã đọc vào `Identity.client`). |
| `X-Locaith-Device` | 16 ký tự hex | `sha256("locaith-device:" + deviceId)[0:16]`. `deviceId` = `device.id` mà `ext_auth_exchange` / `ext_auth_whoami` trả về cho máy này (extension lưu trong SecretStorage cùng token). **Không** phải token, **không** phải email. |
| `X-Locaith-Session` | 16 ký tự hex | `sha256("locaith-session:" + sessionId)[0:16]`. Trước đây là id phiên thô; nay là băm một chiều. Backend chỉ ghi nó vào log nên đổi định dạng không ảnh hưởng chức năng. |

Không tiêu đề nào chứa email, tên, đường dẫn, tên dự án hay token. Nối bản ghi: cổng muốn biết «thiết bị X của tài khoản Y» thì tự băm id thiết bị (lấy từ `ext_auth_whoami` ở bước xác thực token) bằng cùng công thức rồi so khớp; không thể suy ngược từ hai mã băm.

## Backend nên ghi gì (đề xuất, chưa làm)

Mỗi dòng log của `chat-YYYY-MM-DD.jsonl` (thư mục `backend/data/locaith_llm`, đổi bằng `LOCAITH_LLM_LOG_DIR`) hiện có `v, ts, id, kind, client, session, account, model, …`. Cần bổ sung/sửa:

1. **`client_family` + `client_version`** — tách `X-Locaith-Client` thành hai trường (`vscode` / `browser` / `cli` / `web`; phiên bản). Để lọc «lỗi chỉ ở 0.6.31» mà không cần regex.
2. **`device`** — giá trị `X-Locaith-Device` đã làm sạch (`^[0-9a-f]{16}$`, ngoài khuôn thì ghi rỗng). Quan trọng nhất cho H02: bản ghi 401 thì `account` rỗng nhưng `device` vẫn cho biết máy nào gửi.
3. **`account_hash`** — đã có dưới tên `account` (`account_hash(uid)`); với 401 token hỏng thì rỗng, đúng như mong đợi. Có thể thêm `token_hash` = `sha256(token)[0:12]` (đã tính sẵn trong `_device()` làm khoá bộ đệm) để thấy cùng một token hỏng bị gửi lại bao nhiêu lần — **không ghi token thô**.
4. **`request id`** — đã có (`id: "r_…"`, trả về qua `X-Locaith-Request-Id`). Giữ nguyên; đề nghị extension/CLI hiện nó trong thông báo lỗi để người dùng báo lại.
5. **mã lỗi** — `error.code` (`locaith_unauthorized`, …) và `stage` (`auth`, …) đã nằm trong `error`; giữ, và thêm `error.cached: true` khi 401 đến từ bộ đệm âm 30 giây (phân biệt «token hỏng thật» với «token hỏng được nhớ»).
6. **`log_auth_failure`** — đưa `session` và `device` đã làm sạch vào `Identity` anonymous trước khi ghi; cân nhắc lấy mẫu theo `(device, code)` thay vì 1 dòng/2 giây toàn cục, để đợt 401 của một thiết bị không che mất thiết bị khác (giữ trần tổng để chống quét).
7. **Làm sạch đầu vào** — dùng cùng kiểu với `_CLIENT_RE` / `_SESSION_RE` hiện có: chỉ nhận `^[0-9a-f]{16}$` cho `X-Locaith-Device` và `X-Locaith-Session`; giá trị lạ → rỗng. Không bao giờ ghi tiêu đề thô chưa lọc.

Chỉ số nên theo dõi sau khi sửa: số 401 / thiết bị / giờ; tỉ lệ 401 «cached»; số thiết bị gửi lại token hỏng quá 1 lần (kỳ vọng 0 với extension ≥ bản có H01).

## Hành vi 401 của extension (để đối chiếu với log)

Khi cổng trả 401: extension đánh dấu token đó hỏng, làm mới **đúng một lần** (đọc lại kho; không có thì hỏi `ext_auth_whoami`), gửi lại **đúng một lần** bằng token mới. Vẫn 401 → dừng, khoá phiên và hiện «Phiên đăng nhập Locaith hết hạn — Đăng nhập lại». Nhiều yêu cầu 401 đồng thời chỉ gây một lần làm mới. Sau thất bại, extension nghỉ 30 giây (bằng `NEGATIVE_TTL_S`) rồi mới thử làm mới lại. Vì vậy, trong log, một thiết bị chạy extension mới sẽ hiện tối đa **2** dòng 401 liền nhau cho mỗi lần token hỏng — nhiều hơn là dấu hiệu bản extension cũ.

Lưu ý: không có API đúc lại token thiết bị mà không đăng nhập lại. «Làm mới» chỉ là đọc lại kho + xác minh lại với máy chủ tài khoản; token bị thu hồi thật thì người dùng buộc phải đăng nhập lại.
