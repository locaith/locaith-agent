# Nộp gói Chrome / Edge lên Chrome Web Store

Dành cho chủ dự án. Gói «Locaith AI — Trợ lý trình duyệt» dựng từ mã nguồn dùng chung giao diện với bản VS Code (`src/browser`). Mọi thứ cửa hàng bắt lỗi đã được đưa vào MÃ NGUỒN và có bộ kiểm tự động — không vá tay sau khi build.

## 1. Mỗi lần nộp: dựng + kiểm

Chạy trong thư mục `extension/`:

```
npm run package:browser
```

Lệnh này làm lần lượt: kiểm kiểu (`tsc`) → dựng bản phát hành (`dist-browser/`) → **chạy bộ kiểm `scripts/verify-browser-package.mjs`** → chỉ khi đạt mới nén ra `locaith-agent-browser-<phiên bản>.zip`. Bộ kiểm hỏng thì KHÔNG có zip và lỗi liệt kê mọi mục hỏng.

Muốn kiểm lại đúng thứ sẽ tải lên (khuyên làm): giải nén zip ra một thư mục MỚI RỖNG rồi

```
node scripts/verify-browser-package.mjs <thư-mục-vừa-giải-nén>
```

Tải **tệp zip** lên tab «Gói» của mục cửa hàng (manifest ở gốc zip). Đừng tải thư mục `dist-browser` hay zip của bản `--test`.

## 2. Bộ kiểm tự bảo đảm điều gì

| Mục | Vì sao |
|---|---|
| Bốn biểu tượng 16/32/48/128 đúng bằng logo «Lo» (băm SHA-256 trong `scripts/browser-brand-icons.json`) và đúng kích thước | Bản 0.6.27 lên cửa hàng mang chữ «N» của dự án cũ |
| Tên, tên ngắn và mô tả ngắn MỌI ngôn ngữ không chứa Claude, ChatGPT, Gemini, DeepSeek, Grok, OpenAI, Anthropic, OpenRouter, xAI, Google; tên ≤ 75, mô tả ≤ 132 ký tự | Lần nộp đầu bị từ chối «Yellow Argon» vì danh sách tên hãng |
| CSP trong manifest không có cdn.jsdelivr / cdnjs / unpkg, không nguồn http(s) nào; không tệp nào trong gói nhắc các tên miền đó; không nạp script từ URL | Chính sách «mã lưu trữ từ xa» |
| Không khai báo quyền `tabs`; mọi quyền khai báo (kể cả tuỳ chọn) đều có API tương ứng được gọi trong mã | Cửa hàng bắt viết lý do cho quyền không dùng |
| `panel.js` có câu riêng cho bản trình duyệt nói khoá API nằm trong kho riêng của tiện ích, không mã hoá, và câu đó không nhắc VS Code | Chính sách dữ liệu người dùng đòi nói đúng sự thật |
| `sidepanel.html` nạp `store-consent.js` trước `panel.js`; có `store-consent-sw.js`; dịch vụ nền nạp nó; URL chính sách thật (không còn chỗ giữ chỗ); giao diện và cổng nền dùng chung một khoá đồng ý | Phải có thông báo dữ liệu + đồng ý NGAY TRONG tiện ích |
| Không có `testHooks`, không phải bản `--test`, `manifest.version` khớp `package.json`, các tệp manifest tham chiếu đều có trong gói | Lỗi đóng gói cơ học |
| Mã gửi đánh giá một chạm tới `<máy chủ>/api/feedback` thì máy chủ đó PHẢI nằm trong `host_permissions`; và thông báo đồng ý phải nói việc chấm sao được gửi tới Locaith | Backend không cho CORS với origin tiện ích: thiếu quyền là mọi lần chạm sao lỗi âm thầm; dữ liệu rời máy phải được nói trước |
| (0.7.10) Mã gọi cổng mô hình `<máy chủ>/api/llm/v1` thì máy chủ đó PHẢI nằm trong `host_permissions`; thông báo đồng ý nói việc dùng mô hình Locaith là TUỲ CHỌN, nội dung gửi tới Locaith được lưu để tìm lỗi và cải thiện mô hình; `panel.js` có chuỗi riêng của bản trình duyệt (thẻ kết nối, thông báo dữ liệu nói về trang web) và câu nói thật «mã kết nối … không mã hoá» | Cùng lý do với dòng trên; và dữ liệu rời máy tới Locaith phải được nói trước khi gửi |

Kèm theo là test tự động (`npx vitest run test/browser`): dựng thật một gói rồi kiểm, và cố ý đưa vào từng lỗi trên (biểu tượng «N», mô tả có «Claude», CDN, quyền `tabs`/thừa, mất thông báo đồng ý…) để chứng minh bộ kiểm bắt được.

Bản `--test` (dùng cho `npm run test:browser-e2e`) cố ý KHÔNG có thông báo đồng ý để kiểm thử tự động không kẹt; bộ kiểm từ chối nó vì có chữ TEST trong tên.

## 3. Những gì anh phải tự làm ở bảng điều khiển

Bộ kiểm chỉ thấy nội dung TRONG gói. Những thứ này nằm ở bảng điều khiển cửa hàng và KHÔNG tự cập nhật theo gói:

1. **Mô tả chi tiết** (tab «Trang thông tin trên cửa hàng») — dán từ `docs/chrome-store/MO-TA-CHI-TIET-VI.txt` và `…-EN.txt`. Hai bản này chỉ nêu tính năng CÓ THẬT trong bản trình duyệt hiện tại; tính năng đổi thì sửa mô tả. **Từ 0.7.10** có thêm: mô hình Locaith-v5 (tuỳ chọn, qua «mã kết nối») và một gạch đầu dòng quyền riêng tư nói thật việc đó. **Mô tả ngắn** (lấy từ gói, không sửa tay): «…Dùng khoá API của bạn hoặc tài khoản Locaith.»
2. **Ảnh chụp màn hình** (1280×800) và ô quảng bá nhỏ (440×280) — chụp lại nếu giao diện hoặc tính năng đổi. Ảnh nào còn hiện tính năng đã bỏ là rủi ro bị gỡ vì «mô tả sai sự thật».
3. **Tab «Quyền riêng tư»**: lý do cho từng quyền (xem `LY-DO-QUYEN-CHROME.md` trong bộ hồ sơ nộp), URL chính sách quyền riêng tư (https://www.locaith.ai/chinh-sach-quyen-rieng-tu-chrome/ — trang phải còn truy cập được), khai báo «sử dụng dữ liệu». Nội dung khai báo phải khớp thông báo trong tiện ích. **Từ 0.7.10 (mô hình Locaith, tuỳ chọn)** khai thêm các loại dữ liệu: *thông tin xác thực* (mã kết nối Locaith, chỉ khi người dùng tự kết nối), *thông tin nhận dạng cá nhân* (tên + email hiển thị sau khi kết nối), *nội dung trang web* và *hoạt động của người dùng* (đã khai cho nhà cung cấp AI; nay còn gửi tới Locaith khi dùng mô hình Locaith, sau khi người dùng đồng ý thông báo dữ liệu); mục đích = cung cấp tính năng; KHÔNG bán, KHÔNG dùng cho quảng cáo / xếp hạng tín dụng; xác nhận ba cam kết «Dữ liệu người dùng».
4. **Ghi chú cho người duyệt** nếu cần.
5. **ĐĂNG trang chính sách quyền riêng tư mới TRƯỚC khi nộp.** Bản 0.7.0 gửi số sao (ẩn danh) về Locaith khi người dùng chạm sao, nên chính sách phải có mục «Khi bạn chấm sao đánh giá» và bỏ phần nói về tính năng bản này không có (Theo dõi tin nhắn, cầu nối VS Code, mô hình Locaith). Bản đã soạn: `chrome-store-assets/publish-07/chinh-sach-quyen-rieng-tu-chrome/index.html` (chép vào `public/chinh-sach-quyen-rieng-tu-chrome/` của repo locaith-ai-v2 rồi đẩy lên; URL giữ nguyên).
6. **Lý do quyền máy chủ** `studio-api.locaith.com` (mới so với 0.6.27): dán từ `LY-DO-QUYEN-CHROME.md`, mục `host_permissions`. Cập nhật lên 0.7.0 Chrome sẽ hỏi người đang dùng bản cũ chấp nhận quyền mới. **Từ 0.7.10** máy chủ này còn phục vụ cổng mô hình Locaith (`/api/llm/v1`): bổ sung vào lý do — «gửi đánh giá một chạm và, chỉ khi người dùng tự kết nối tài khoản Locaith, gửi yêu cầu tới mô hình Locaith». Không có quyền mới nào được thêm so với 0.7.9 (máy chủ tài khoản Supabase trả CORS cho mọi origin).
7. Nộp vào ĐÚNG mục «Locaith AI — Trợ lý trình duyệt» (không phải «Locaith Memory Sync» — sản phẩm khác).

## 4. Bài học chính sách (đừng lặp lại)

- **«Yellow Argon» (lần nộp đầu):** mô tả có danh sách tên hãng (Claude, ChatGPT, Gemini…) bị coi là nhồi từ khoá. Việc tiện ích dùng được với nhà cung cấp nào nêu theo chức năng, trong mô tả chi tiết, không liệt kê thương hiệu ở mô tả ngắn.
- **Mã tải từ xa:** khung xem trước artifact từng cho tải script/style từ ba CDN. Ở Chrome Web Store đó là «mã lưu trữ từ xa» → bị từ chối. Nay bản trình duyệt có danh sách CDN RỖNG (cờ build `__ND_NO_REMOTE_CODE__`): CSP sandbox không có tên miền, kiểm tra artifact coi tài nguyên ngoài là sai, lời hướng dẫn cho model bảo viết nội tuyến. Bản VS Code giữ nguyên ba CDN.
- **Thông báo dữ liệu trong sản phẩm:** chính sách dữ liệu người dùng đòi nói rõ, ngay trong tiện ích và TRƯỚC khi nội dung trang/tin nhắn rời máy, rằng gì được gửi cho ai. Lớp phủ «Đồng ý và tiếp tục» ở lần mở đầu tiên khoá khung chat; menu chuột phải không chuyển gì vào khung chat khi chưa đồng ý.
- **Nói đúng nơi lưu khoá API:** bản chia sẻ giao diện với VS Code từng hiện «khoá nằm trong kho bí mật của VS Code». Ở Chrome khoá nằm trong `chrome.storage.local`, không mã hoá. Phải nói thật.
- **Sự cố biểu tượng «N» (bản 0.6.27):** gói dựng từ mã nguồn có biểu tượng của dự án cũ; không ai mở gói ra xem. Từ nay biểu tượng bị khoá bằng băm và bị kiểm ở ba chỗ: test, bộ kiểm gói, và lệnh nén.
- **Quyền không dùng:** khai báo `tabs` mà không gọi → cửa hàng đòi lý do. Chỉ khai quyền mã thật sự dùng.
- **Mô hình Locaith trong bản cửa hàng (0.7.10) là TUỲ CHỌN:** không bắt đăng nhập để dùng khoá API riêng; trước khi nội dung rời máy tới Locaith có hai lớp báo trước (màn «Trước khi dùng» ở lần mở đầu — nói việc dùng mô hình Locaith là tuỳ chọn và Locaith lưu để cải thiện mô hình — và thẻ thông báo dữ liệu riêng trong khung chat, ghi nhận theo tài khoản). Bộ kiểm bắt cả hai.
- **Mã kết nối là bí mật:** ô dán mã là ô mật khẩu; mã dán nhầm vào ô chat bị chặn trước khi gửi cho nhà cung cấp AI; mã nằm trong `chrome.storage.local` KHÔNG mã hoá — phải nói thật (chuỗi `acct.b.hint`), không nói «kho bí mật».

## 5. Khi muốn đổi logo hoặc thêm quyền / chuỗi hạn chế

- Đổi logo có chủ đích: cập nhật bốn PNG ở `src/browser/static/icons/` và các băm trong `scripts/browser-brand-icons.json`.
- Thêm quyền mới: bộ kiểm sẽ đòi mã có gọi API tương ứng; nếu thêm quyền có API không theo mẫu `chrome.<tên>.`, bổ sung vào bảng `used` trong `scripts/verify-browser-package.mjs`.
- Thêm chuỗi giao diện nhắc nơi lưu khoá/dữ liệu: phải có biến thể `.browser` (xem `set.providers.hint.browser` trong `webview/src/i18n.ts`).


## 5. Kết nối với VS Code (từ 0.7.12)

Bản 0.6.27–0.7.11 (dựng lại từ `src/browser`) làm rơi cầu nối VS Code của gói 0.4.x — gói cũ chỉ có nó dưới dạng bản vá, không có mã nguồn. 0.7.12 viết lại thành mã nguồn thật: `src/browser/link/` (`linkSw.ts` dịch vụ nền, `inPage.ts` mã chạy trong trang, `approvePage.ts` cửa sổ hỏi duyệt từng trang, `host.ts` phía khung chat, `origin.ts`), phía VS Code vẫn là `src/core/chrome/bridge.ts` (`BrowserBridge`).

- **Giao thức:** extension GỌI VÀO máy chủ cầu của VS Code (127.0.0.1, cổng 47615–47620) bằng long-poll; ghép đôi không mã (`POST /v1/pair/request` → thẻ «Cho phép / Từ chối» trong VS Code → `POST /v1/pair/status` nhận token một lần). **Hỏi kết quả bằng POST, không phải GET:** Chrome không gắn `Origin` vào GET gửi từ extension (đã đo trên Chrome và Edge) mà máy chủ cầu cần Origin để biết extension nào hỏi. VS Code bản cũ chưa có POST → 404 → extension báo «VS Code quá cũ».
- **Tắt mặc định, không dữ liệu nào tới máy chủ Locaith:** công tắc ở Cài đặt → «Kết nối với VS Code»; chưa đồng ý thông báo dữ liệu của tiện ích thì không nối. Nội dung trang đi tới VS Code trên CHÍNH máy này rồi tới nhà cung cấp AI mà VS Code đang dùng. Bộ kiểm gói khoá: dịch vụ nền không có đường nào tới `studio-api.locaith.com`/`locaith.ai`, không xin quyền máy chủ cho 127.0.0.1 (máy chủ cầu cấp CORS cho origin tiện ích).
- **Duyệt từng trang trong Chrome:** mọi lệnh trên một trang hỏi người dùng ở cửa sổ `bridge-approve.html` («Cho phép lần này» / «Luôn cho phép trang này» / «Từ chối»), theo origin đầy đủ; trang chưa duyệt chỉ lộ tên miền trong danh sách tab; thu hồi trong Cài đặt (thu cả quyền trang của Chrome nếu không còn origin nào cùng tên miền). Chụp màn hình cần quyền tuỳ chọn «Truy cập trang web» (`<all_urls>`).
- **Quyền mới:** `alarms` (nhịp 30 giây dựng lại vòng chờ khi dịch vụ nền bị tắt; không có cảnh báo) và `tabs` TUỲ CHỌN, xin lúc người dùng bật công tắc (`permissions.request` trong cú bấm). Nâng cấp lên 0.7.12 Chrome sẽ hỏi người dùng bản cũ chấp nhận `alarms`; hồ sơ nộp: lý do quyền cho `alarms`, `tabs` (tuỳ chọn), `host_permissions` (không đổi) và menu chuột phải biểu tượng.
- **Bài học kiểm thử:** kiểm trên Chrome/Edge THẬT, bản NÉN (`esbuild --test --production`): hàm `inPage` được chuyển nguyên mã nguồn qua `executeScript` nên bản nén phải được thử; bản `--test` trỏ cầu nối sang cổng giả (`nd.test.linkPorts` trong `chrome.storage.local`) để không chạm VS Code thật của người chạy test. Bộ e2e: `test/browser-e2e/link.e2e.test.ts`; unit: `test/browser/link.test.ts` (chạy với `BrowserBridge` thật).
- **(0.7.20) «Kết nối với ứng dụng trên máy» + ghép đôi do ứng dụng khởi xướng:** công tắc đổi tên (trước: «Kết nối với VS Code»), mỗi ứng dụng một token (`nd.bridge.apps`, theo `kind` ở `GET /v1/hello`: VS Code, bản desktop Locaith Work). Ứng dụng mở trang `http://127.0.0.1:<cổng>/link?t=<vé>` trong trình duyệt của người dùng; trang chuyển vé qua **`externally_connectable` — khoá manifest mới, chỉ khớp `http://127.0.0.1/*` và `http://localhost/*`** (không phải quyền, không có cảnh báo); dịch vụ nền chỉ nhận từ đúng cổng 47615–47620, hỏi người dùng một cửa sổ «Kết nối» rồi đổi vé ở `POST /v1/pair/ticket`. Bộ kiểm gói khoá: `externally_connectable` chỉ hai mẫu đó, không `ids`, và có đường nhận vé. Ghi chú: `docs/changes/app-browser-link.md`.
