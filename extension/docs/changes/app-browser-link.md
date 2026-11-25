# Kết nối trình duyệt từ ứng dụng (vé + trang /link) và mỗi ứng dụng một token

**Vấn đề.** Muốn trợ lý trong một ứng dụng trên máy (VS Code, bản desktop Locaith Work) điều khiển trình duyệt của người dùng, người dùng phải tự mở tiện ích
Locaith AI trong trình duyệt, vào Cài đặt, bật «Kết nối với VS Code», rồi quay lại ứng dụng bấm «Cho phép». Bản desktop thì mở một Chromium riêng để kết nối
mạng xã hội — không phải trình duyệt người dùng đang dùng, nơi họ đã đăng nhập sẵn. Ngoài ra tiện ích chỉ giữ MỘT token: ghép với Locaith Work là mất ghép với VS Code.

**Cách làm.**

1. Ứng dụng tạo **vé** dùng một lần (`BrowserBridge.linkTicket()`: 24 ký tự ngẫu nhiên, sống 2 phút, giữ tối đa 3 vé) và mở
   `http://127.0.0.1:<cổng>/link?t=<vé>` trong trình duyệt mặc định của máy (VS Code: `vscode.env.openExternal`; bản desktop: trình duyệt dùng gần nhất).
2. Trang `/link` do chính máy chủ cầu phục vụ (CSP `default-src 'none'; script-src 'self'; connect-src 'self'…`, `no-referrer`, `no-store`, không CORS) gửi vé cho tiện ích
   bằng `chrome.runtime.sendMessage(<mã tiện ích>, { type: 'nd-link-ticket', t })`. Mã mặc định là mã trên Chrome Web Store; `&ext=<mã>,<mã>` thêm mã khác (bản nhà phát triển).
   Manifest có `externally_connectable: { matches: ['http://127.0.0.1/*', 'http://localhost/*'] }` — chỉ trang trên chính máy này gửi tin được.
3. Dịch vụ nền (`linkSw.ts`, `onMessageExternal`) chỉ nhận vé từ `http://127.0.0.1|localhost:<cổng>` với cổng thuộc 47615–47620, cần cổng đồng ý dữ liệu, rồi mở MỘT cửa sổ
   nhỏ «Kết nối trình duyệt này với ứng dụng trên máy?» nêu tên ứng dụng tự xưng (`/v1/hello`) và cổng. Trang tải lại không mở cửa sổ thứ hai.
4. Bấm **Kết nối** → `POST /v1/pair/ticket { t }` (bắt buộc Origin `chrome-extension://…`, vé dùng một lần) → token của RIÊNG ứng dụng đó → nối ngay, không cần bật công tắc trước.
   Bấm **Không kết nối** hoặc đóng cửa sổ → `POST /v1/pair/ticket/deny`. Vé hết hạn sau 2 phút.
5. Trang `/link` báo về `GET /link/state?t=&page=asked|missing`: «asked» = tiện ích đã trả lời; «missing» = 3 giây không tiện ích nào trả lời (chưa cài / bản cũ chưa có
   `externally_connectable`). Ứng dụng đọc được qua `lastTicket().page` để nhắc cài / cập nhật; trang cũng có nút Chrome Web Store.

**Mỗi ứng dụng một token.** `GET /v1/hello` (không token) trả `{ v: 2, app: { kind, name } }`; `kind` cố định theo loại ứng dụng (`vscode` cho mọi cửa sổ VS Code,
`work` cho Locaith Work). Tiện ích lưu `nd.bridge.apps = { [kind]: { token, name, at } }`, dò mỗi cổng bằng đúng token của ứng dụng ở cổng đó, và khi một ứng dụng
không còn nhận trình duyệt thì chỉ bỏ token của ứng dụng đó (`nd.bridge.lost = { at, apps: [tên] }`); ứng dụng khác vẫn nối. Mọi câu trả lời ghép đôi
(`/v1/pair/status`, `/v1/pair`, `/v1/pair/ticket`) đều kèm `app`.

**Token cũ (≤ 0.7.19, `nd.bridge`).** Chưa biết của ứng dụng nào → khoá tạm `?`. Được máy chủ mới nhận → chuyển sang `kind` của máy chủ đó. Máy chủ cũ (không có `/v1/hello`)
nhận → giữ nguyên `?` (không đoán là VS Code). Lời từ chối chỉ làm mất token khi nó chứng minh token hết hiệu lực: máy chủ mới từ chối token của CHÍNH loại ứng dụng nó;
token `?` bị VS Code bản mới hoặc một máy chủ cũ từ chối. Locaith Work từ chối token `?` khi VS Code đang đóng thì KHÔNG mất token.

**`/v1/hello` luôn có `?v=2`.** Máy chủ 0.7.18–0.7.19 coi GET từ trình duyệt không dấu, không token là tiện ích bản cũ đang rò và giữ 45 giây không trả lời; có dấu thì
nó trả 401 ngay → tiện ích hiểu là máy chủ cũ và vẫn nối bằng token cũ.

**Đổi tên.** Cài đặt → «Kết nối với ứng dụng trên máy» / “Connect to desktop apps” (trước: «Kết nối với VS Code»), có danh sách từng ứng dụng (đang nối / chưa mở);
menu chuột phải và các câu trạng thái nói «ứng dụng» và nêu tên (`{apps}`). Tab Chrome của Chợ trong VS Code có nút «Kết nối trình duyệt này» (đã ghép: «Kết nối lại
trình duyệt») và lời nhắn theo vé gần nhất (đang mở / chờ bấm Kết nối / chưa có tiện ích + nút Chrome Web Store / đã từ chối / hết hạn).

**Cho host khác (bản desktop).** `setBridgeApp({ kind, name })` (`src/host/bridgeApp.ts`) đặt tên ứng dụng TRƯỚC khi `ChromeService` được tạo; lệnh nội bộ (không khai
trong package.json) `locaithAgent.chrome.linkTicket` → `{ url, expiresAt }` hoặc `{ error: 'busy' | 'failed', message }`, `locaithAgent.chrome.linkState` →
`{ app, running, paired, connected, pairRequest, ticket? }`; `bridgeEvents` phát `change` khi ghép đôi / kết nối / vé đổi (kể cả vé tự hết hạn — nhịp 5 giây).

**An toàn.** Trang web trên mạng không gửi tin được cho tiện ích (externally_connectable chỉ khớp localhost) và vẫn bị chặn ở mọi đường của máy chủ cầu (Origin `https://…` → 403,
Host lạ → 403). Vé 144 bit, dùng một lần, 2 phút; đổi vé cần Origin của tiện ích. Một tiến trình trên máy giả làm máy chủ cầu ở cổng 47615–47620 vẫn cần người dùng
bấm «Kết nối» trong cửa sổ nêu đúng cổng — như trước, tiến trình cục bộ không phải đối tượng cần chống. Mỗi trang web vẫn hỏi duyệt riêng, cửa sổ hỏi nêu ứng dụng đã gửi lệnh.

**Test.** `test/bridge.test.ts` (hello, vòng đời vé, CSP trang, dùng một lần, từ chối, hết hạn có sự kiện, tối đa 3 vé, bắt buộc Origin, trang báo về, `app` trong mọi câu trả
lời ghép đôi, sự kiện kết nối); `test/browser/link.test.ts` (hai máy chủ cầu thật cùng lúc: token riêng, cả hai nhận lệnh, cửa sổ duyệt trang nêu đúng ứng dụng, một ứng dụng
huỷ thì ứng dụng kia vẫn nối; vé từ origin / cổng / dạng sai bị bỏ; từ chối và đóng cửa sổ; cổng đồng ý; chuyển token cũ; token cũ bị ứng dụng khác từ chối; máy chủ cũ không
có `/v1/hello`); `test/browser-e2e/link.e2e.test.ts` trên Chrome và Edge thật (bản nén): trang `/link` không thấy tiện ích → «missing»; có tiện ích → cửa sổ Kết nối thật → bấm →
nối, trang báo «Đã kết nối», mở lại liên kết thì «hết hạn hoặc đã dùng»; `verify-browser-package` kiểm `externally_connectable` chỉ localhost và đường nhận vé;
`test/webview/browserLinkCopy.test.ts` kiểm chữ hai ngôn ngữ.

**Phát hành** trong 0.7.20 (25/11/2026): VS Code 0.7.20 + gói Chrome / Edge 0.7.20 nộp Chrome Web Store (khoá manifest mới `externally_connectable`, không quyền mới). Tới khi
cửa hàng duyệt xong, bản 0.7.17 trên cửa hàng không nhận được vé nên trang /link báo «missing». Bản cài từ cửa hàng Edge Add-ons (nếu có) mang mã khác:
ứng dụng thêm mã đó qua `&ext=`.

---

# Connect the browser from the app (ticket + /link page), one token per app

**Problem.** To let an app on this computer (VS Code, the Locaith Work desktop app) drive the user's own browser, the user had to open the extension, go to Settings,
turn on "Connect to VS Code" and then click Allow back in the app. The desktop app opened its own Chromium for social logins instead of the browser the user actually uses.
And the extension kept a single token, so pairing Locaith Work dropped the VS Code pairing.

**Flow.** The app creates a one-time ticket (24 random characters, 2 minutes, at most 3) and opens `http://127.0.0.1:<port>/link?t=<ticket>` in the default browser.
That page — served by the bridge itself with a strict CSP — hands the ticket to the extension (`externally_connectable` matches only `http://127.0.0.1/*` and
`http://localhost/*`). The background worker accepts it only from a bridge port (47615–47620) and after the data-notice consent, opens one small "Connect this
browser to an app on this computer?" window naming the app (as it announces itself at `/v1/hello`) and its port, and on **Connect** redeems the ticket at
`POST /v1/pair/ticket` (extension Origin required, single use) for that app's own token. **Don't connect** or closing the window denies it. The page reports back
`asked` / `missing`, so the app can say "install or update the extension".

**One token per app.** `/v1/hello` announces `{ kind, name }` (`vscode` for every VS Code window, `work` for Locaith Work). The extension stores
`nd.bridge.apps[kind]`, probes each port with that app's token, and drops only the token of an app that no longer accepts the browser. A token saved by 0.7.19 or older
moves to the app that accepts it; a refusal by a different app does not delete it. `/v1/hello` carries `?v=2` so 0.7.18–0.7.19 bridges answer 401 at once (they would
otherwise hold the request as an old leaking client); those keep working with the token they gave.

**Renamed:** Settings → "Connect to desktop apps", with one row per paired app. VS Code's Market → Chrome tab gets **Connect this browser** and a note that follows
the last ticket. Other hosts: `setBridgeApp`, internal commands `locaithAgent.chrome.linkTicket` / `locaithAgent.chrome.linkState`, and `bridgeEvents` `change`.

**Released** in 0.7.20 (25 Nov 2026): VS Code 0.7.20 + the Chrome / Edge 0.7.20 package submitted to the Chrome Web Store (new manifest key, no new permission).
