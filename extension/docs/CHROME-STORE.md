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

Kèm theo là test tự động (`npx vitest run test/browser`): dựng thật một gói rồi kiểm, và cố ý đưa vào từng lỗi trên (biểu tượng «N», mô tả có «Claude», CDN, quyền `tabs`/thừa, mất thông báo đồng ý…) để chứng minh bộ kiểm bắt được.

Bản `--test` (dùng cho `npm run test:browser-e2e`) cố ý KHÔNG có thông báo đồng ý để kiểm thử tự động không kẹt; bộ kiểm từ chối nó vì có chữ TEST trong tên.

## 3. Những gì anh phải tự làm ở bảng điều khiển

Bộ kiểm chỉ thấy nội dung TRONG gói. Những thứ này nằm ở bảng điều khiển cửa hàng và KHÔNG tự cập nhật theo gói:

1. **Mô tả chi tiết** (tab «Trang thông tin trên cửa hàng») — dán từ `docs/chrome-store/MO-TA-CHI-TIET-VI.txt` và `…-EN.txt`. Hai bản này chỉ nêu tính năng CÓ THẬT trong bản trình duyệt hiện tại; tính năng đổi thì sửa mô tả.
2. **Ảnh chụp màn hình** (1280×800) và ô quảng bá nhỏ (440×280) — chụp lại nếu giao diện hoặc tính năng đổi. Ảnh nào còn hiện tính năng đã bỏ là rủi ro bị gỡ vì «mô tả sai sự thật».
3. **Tab «Quyền riêng tư»**: lý do cho từng quyền (xem `LY-DO-QUYEN-CHROME.md` trong bộ hồ sơ nộp), URL chính sách quyền riêng tư (https://www.locaith.ai/chinh-sach-quyen-rieng-tu-chrome/ — trang phải còn truy cập được), khai báo «sử dụng dữ liệu». Nội dung khai báo phải khớp thông báo trong tiện ích.
4. **Ghi chú cho người duyệt** nếu cần.
5. Nộp vào ĐÚNG mục «Locaith AI — Trợ lý trình duyệt» (không phải «Locaith Memory Sync» — sản phẩm khác).

## 4. Bài học chính sách (đừng lặp lại)

- **«Yellow Argon» (lần nộp đầu):** mô tả có danh sách tên hãng (Claude, ChatGPT, Gemini…) bị coi là nhồi từ khoá. Việc tiện ích dùng được với nhà cung cấp nào nêu theo chức năng, trong mô tả chi tiết, không liệt kê thương hiệu ở mô tả ngắn.
- **Mã tải từ xa:** khung xem trước artifact từng cho tải script/style từ ba CDN. Ở Chrome Web Store đó là «mã lưu trữ từ xa» → bị từ chối. Nay bản trình duyệt có danh sách CDN RỖNG (cờ build `__ND_NO_REMOTE_CODE__`): CSP sandbox không có tên miền, kiểm tra artifact coi tài nguyên ngoài là sai, lời hướng dẫn cho model bảo viết nội tuyến. Bản VS Code giữ nguyên ba CDN.
- **Thông báo dữ liệu trong sản phẩm:** chính sách dữ liệu người dùng đòi nói rõ, ngay trong tiện ích và TRƯỚC khi nội dung trang/tin nhắn rời máy, rằng gì được gửi cho ai. Lớp phủ «Đồng ý và tiếp tục» ở lần mở đầu tiên khoá khung chat; menu chuột phải không chuyển gì vào khung chat khi chưa đồng ý.
- **Nói đúng nơi lưu khoá API:** bản chia sẻ giao diện với VS Code từng hiện «khoá nằm trong kho bí mật của VS Code». Ở Chrome khoá nằm trong `chrome.storage.local`, không mã hoá. Phải nói thật.
- **Sự cố biểu tượng «N» (bản 0.6.27):** gói dựng từ mã nguồn có biểu tượng của dự án cũ; không ai mở gói ra xem. Từ nay biểu tượng bị khoá bằng băm và bị kiểm ở ba chỗ: test, bộ kiểm gói, và lệnh nén.
- **Quyền không dùng:** khai báo `tabs` mà không gọi → cửa hàng đòi lý do. Chỉ khai quyền mã thật sự dùng.

## 5. Khi muốn đổi logo hoặc thêm quyền / chuỗi hạn chế

- Đổi logo có chủ đích: cập nhật bốn PNG ở `src/browser/static/icons/` và các băm trong `scripts/browser-brand-icons.json`.
- Thêm quyền mới: bộ kiểm sẽ đòi mã có gọi API tương ứng; nếu thêm quyền có API không theo mẫu `chrome.<tên>.`, bổ sung vào bảng `used` trong `scripts/verify-browser-package.mjs`.
- Thêm chuỗi giao diện nhắc nơi lưu khoá/dữ liệu: phải có biến thể `.browser` (xem `set.providers.hint.browser` trong `webview/src/i18n.ts`).
