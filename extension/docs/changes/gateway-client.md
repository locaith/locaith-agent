# Cổng Locaith: xử lý 401 đúng cách + nhãn chẩn đoán (lane gateway-client)

- **Hết phiên đăng nhập không còn lặp lỗi**: khi cổng Locaith trả 401, extension đánh dấu token đó hỏng, làm mới **đúng một lần** (đọc lại kho tài khoản, không có thì hỏi máy chủ tài khoản), gửi lại yêu cầu **đúng một lần**. Vẫn 401 thì dừng, khoá phiên để màn hình đăng nhập hiện nút, và báo: «Phiên đăng nhập Locaith hết hạn — Đăng nhập lại để tiếp tục (lệnh locaithAgent.account.signIn), rồi bấm «Thử lại»». Token đã hỏng không bao giờ được gửi lại cho tới khi làm mới thành công; nhiều yêu cầu 401 cùng lúc (agent con) chỉ gây một lần làm mới. Không có cài đặt mới.
- **Thông báo lỗi cổng rõ theo nhóm, kèm việc cần làm** (vi/en): hết hạn mức ngày, bị giới hạn tốc độ, cổng quá tải/bảo trì/xếp hàng, model không còn, mất mạng («kiểm tra mạng (hoặc VPN/proxy) rồi bấm «Thử lại»»). Tiếng Việt giữ nguyên lời cổng soạn (có giờ/hạn mức cụ thể); tiếng Anh dùng câu chuẩn.
- **Nhãn chẩn đoán trên mọi yêu cầu tới cổng** (để quản trị tra lỗi): `X-Locaith-Client: vscode/<phiên bản>`, `X-Locaith-Device` (băm một chiều của mã thiết bị) và `X-Locaith-Session` (băm một chiều của id phiên chat; trước đây gửi id thô). Không gửi email, đường dẫn hay token. CLI cũng gửi `cli/<phiên bản>`. Hướng dẫn phía máy chủ: `docs/GATEWAY-LOGGING.md`.

## English (short)

- Gateway 401: the token is flagged bad, refreshed exactly once, the request resent exactly once; a second 401 stops, locks the session and shows "Locaith session expired — sign in again" (command `locaithAgent.account.signIn`). Parallel 401s share one refresh; a flagged token is never reused until a refresh succeeds.
- Gateway errors are grouped (quota, rate limit, overload/maintenance/queue, retired model, offline) with an action; Vietnamese keeps the gateway's own wording, English uses standard sentences.
- Every gateway request carries `X-Locaith-Client`, `X-Locaith-Device` (one-way hash) and `X-Locaith-Session` (one-way hash); no raw ids, emails or paths. Server-side logging guidance: `docs/GATEWAY-LOGGING.md`.
