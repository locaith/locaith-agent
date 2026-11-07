# Remote qua relay (locaith.ai) — đặc tả, mô hình đe doạ, cách kiểm thử

Từ 0.5.2, ngoài đường HTTP cục bộ (`127.0.0.1`, xem [REMOTE.md](REMOTE.md)), tab **«VS Code từ xa»** trên locaith.ai điều khiển được VS Code **từ bất kỳ đâu** (điện thoại, máy khác)
qua một **relay Supabase Realtime**. Relay chỉ chuyển **bản mã**: mọi nội dung (hội thoại, lệnh, khoá) được mã hoá đầu-cuối giữa extension và trình duyệt.

Có **hai cách để một trình duyệt được vào**:

* **Tin cậy theo tài khoản (từ 0.6.5, BẬT SẴN)** — trình duyệt đã đăng nhập ĐÚNG tài khoản locaith.ai của chủ máy vào thẳng, không mã, không liên kết/QR, không «Cho phép» (§2b). Gõ `/remote` trong khung chat (hoặc mở locaith.ai trên điện thoại → «VS Code từ xa» → chọn máy).
* **Ghép đôi từng thiết bị** (0.5.2) — liên kết/QR + mã so khớp + «Cho phép» ở VS Code. Vẫn dùng khi tắt `locaithAgent.remote.trustAccount`, cho thiết bị không đăng nhập tài khoản, và khi danh bạ không dùng được.

```
 trình duyệt (locaith.ai)  ──ws──▶  Supabase Realtime (kênh công khai lcr1:<hostId>)  ◀──ws──  extension trong VS Code
        RelayClient                       chỉ thấy bản mã + tin bắt tay                          RelayHost + RemoteServer
```

## 1. Mô hình tin cậy

| Bên | Tin cậy được gì |
|---|---|
| Người ngồi ở máy | Quyết định MỞ cửa sổ ghép đôi (lệnh trong VS Code) và bấm «Cho phép» sau khi so mã SAS — cổng để một trình duyệt **không** đăng nhập tài khoản có quyền. Cũng là người bật/tắt `remote.trustAccount`, xoay khoá và tắt Remote. |
| Tài khoản locaith.ai | Bắt buộc đăng nhập để dùng extension và tab Remote; danh bạ «Máy của bạn». **Từ 0.6.5 (khi `remote.trustAccount` bật — mặc định) tài khoản LÀ gốc tin cậy của đường «tài khoản»**: ai đăng nhập được tài khoản này đọc được khoá tài khoản của máy và điều khiển được máy (§2b). Với thiết bị đã ghép đôi thì tài khoản vẫn không quyết định gì — việc đó do ghép đôi + khoá `K_dev`. |
| Quản trị/CSDL Locaith (Supabase) | **Với đường «tài khoản»: được tin.** Cột `ext_private.hosts.account_psk` đọc được ở dạng rõ (trình duyệt phải lấy lại khoá), nên ai đọc được CSDL của Locaith có khoá; còn cần vào kênh công khai `lcr1:<hostId>` (biết `hostId` từ chính danh bạ). Với thiết bị đã ghép đôi thì không có khoá nào nằm ở CSDL. |
| Relay (Supabase) | **Không tin.** Thấy: tên kênh (mã máy), kích thước/thời điểm tin, hiện diện `{v, epoch}` (không có tên máy/thư mục). Không đọc/sửa/chèn được tin nghiệp vụ. Có thể rớt/trễ/**đảo thứ tự**/phát lại tin (đã được xử lý — xem bên dưới). |
| Kẻ biết tên kênh (`hostId`) | Gửi được tin rác/giả lên kênh (kênh công khai) → mọi tin được xác thực (HMAC/GCM), tin sai bị bỏ im lặng; chỉ gây tốn tài nguyên, không có quyền gì. |

Điều **không** được bảo vệ: phần mềm độc hại đã chạy trên máy trình duyệt/máy VS Code (đọc được `K_dev` hoặc điều khiển trực tiếp); relay có thể chặn hoàn toàn dịch vụ (từ chối dịch vụ);
metadata (tên máy/thư mục trong hiện diện, thời điểm và kích thước tin). **Từ 0.6.5, mặc định:** kẻ chiếm được phiên đăng nhập locaith.ai của bạn (lộ mật khẩu, phiên bị đánh cắp) điều khiển được các máy đang bật tin cậy theo tài khoản — hãy bảo vệ tài khoản bằng mật khẩu mạnh/xác thực hai lớp, hoặc tắt `locaithAgent.remote.trustAccount` để quay về ghép đôi.

## 2. Định danh và mã hoá

* `hostId` — 16 byte ngẫu nhiên (base64url 22 ký tự), sinh từ bí mật của máy + khoá workspace, ổn định theo cửa sổ/thư mục. Kênh: `lcr1:<hostId>` (Realtime thêm tiền tố `realtime:`).
* Mọi chuỗi nhị phân là **base64url không đệm**. Chuỗi dài tối đa theo `parseWire` (e2e.ts).
* Nguyên thuỷ (WebCrypto): ECDH P-256 · HKDF-SHA256 · HMAC-SHA256 · AES-256-GCM. `lp(nhãn, …)` = nối có tiền tố độ dài 2 byte (chống nhập nhằng).
* Mã tham chiếu duy nhất: `src/core/remote/e2e.ts` (extension) = `src/screens/remote/relay/e2e.ts` (trang web). **Hai bản phải giống từng byte**; vector cố định ở `test/fixtures/relay-vectors.json`.

### Ghép đôi (một lần cho mỗi trình duyệt)

1. Người dùng chạy **«Locaith AI: Remote: ghép đôi thiết bị mới»** → host sinh `psk` (128 bit, hiệu lực 5 phút, **một lần** — đóng ngay sau yêu cầu đầu tiên được đưa ra hỏi, dù kết quả thế nào; yêu cầu sai MAC bị bỏ im lặng và KHÔNG làm đóng cửa sổ — `psk` 128 bit nên dò vô ích, còn đóng cửa sổ sau vài lần sai sẽ cho người lạ trên kênh công khai phá việc ghép đôi; chỉ giới hạn 30 yêu cầu/phút) và hiện liên kết/QR
   `https://locaith.ai/#remote?r=<hostId>&k=<psk>[&n=<tên máy>]` (nằm sau `#` nên không gửi tới máy chủ web). `psk` đi **ngoài relay** (màn hình → mắt/clipboard/QR).
2. Trình duyệt → `pair_req { A, nC, label, mac = HMAC(psk, pair_req|A|nC|label) }` (A = khoá ECDH tạm).
3. Host → `pair_hello { r=nC, B, nH, mac = HMAC(psk, pair_hello|A|B|nC|nH) }`. Cả hai tính `z = ECDH`, `K_dev = HKDF(z, salt=psk, device|A|B|nC|nH)` và **SAS** 6 chữ số.
   Trình duyệt hiện SAS; host hiện hộp thoại «Cho phép thiết bị … ? Mã xác nhận 123 456».
4. Người dùng bấm Cho phép → `pair_ok { r, dev, mac = HMAC(K_dev, pair_ok|dev|A|B|nC|nH) }` (hoặc `pair_no { r, reason, mac }`). Host lưu `{dev, label, K_dev, hostId}` trong SecretStorage; trình duyệt lưu `{hostId, dev, K_dev}`.
   Relay có thể đảo thứ tự hai tin đi sát nhau, nên trình duyệt giữ lại (tối đa 4) `pair_ok` tới trước `pair_hello` và kiểm MAC sau khi đã có khoá; tin sai MAC bị loại.

### 2b. Tin cậy theo tài khoản (0.6.5, `locaithAgent.remote.trustAccount`, mặc định BẬT)

Ghép đôi từng trình duyệt (liên kết/QR + so mã + «Cho phép») quá nặng với người dùng điện thoại, nên một trình duyệt đã đăng nhập ĐÚNG tài khoản locaith.ai của chủ máy vào thẳng:

1. **Khoá tài khoản `AK`** = 16 byte ngẫu nhiên (CSPRNG), sinh một lần cho mỗi `hostId` và giữ trong SecretStorage (`remote.accountKey.<hostId>` = `{u: mã tài khoản, k: AK}`) — **gắn với tài khoản đã sinh ra nó**: người khác đăng nhập vào cùng VS Code thì khoá của người trước bị thay, nên tab của người trước không điều khiển được máy của người sau. Extension báo `AK` lên danh bạ cùng lần báo danh (`ext_host_upsert(…, p_account_psk = AK)`, 5 phút/lần và ngay khi gõ `/remote`).
   Chỉ `ext_hosts_list()` — cần phiên đăng nhập, chỉ trả máy của chính `auth.uid()` — trả cột `account_psk`; `ext_devices_list` không trả.
2. **Trình duyệt** đăng nhập cùng tài khoản đọc `AK` của máy từ `ext_hosts_list()`, tính `K_dev = HKDF-SHA256(ikm = AK, salt = rỗng, info = lp("account_dev", hostId), 32)` và bắt tay **y như mọi thiết bị** (`hello`, MAC bằng `K_dev`, ECDH tạm → khoá phiên, có bí mật chuyển tiếp)
   với mã thiết bị cố định `ACCOUNT_DEV` (12 byte 0 = `AAAAAAAAAAAAAAAA`). **Không có `pair_*`.** Vector cố định ở `test/fixtures/relay-vectors.json` (mục `account`, tính độc lập bằng `node:crypto`); `e2e.ts` hai bản vẫn giống từng byte.
3. **Host** nhận `hello` có `dev = ACCOUNT_DEV`: không tra kho thiết bị, tự suy `K_dev` từ `AK` hiện hành, kiểm MAC (sai ⇒ **im lặng**) và nonce. Không có `AK` (tính năng tắt) ⇒ trả `hello_no unknown_device` — trình duyệt hiểu phải ghép đôi. **Nonce của `hello` nhớ theo SỐ LƯỢNG (4096), không theo thời gian** (hello không có dấu thời gian; nonce hết hạn sau vài phút thì hello ghi lại phát lại được mãi mãi) và được giữ chỗ TRƯỚC khi kiểm MAC (hai bản giống hệt đến cùng lúc chỉ mở một phiên); chỉ hello đúng MAC mới được nhớ nên kẻ lạ không làm tràn bảng. Mỗi phiên mang mã riêng `ACCOUNT_DEV:<sid>` (giới hạn tốc độ lệnh/luồng
   tính theo từng phiên), tên hiển thị «Tài khoản Locaith»; **không** tạo bản ghi thiết bị (không có trong «Thiết bị đã ghép», không hết hạn theo `idleDays`). Tối đa 10 phiên «tài khoản» cùng lúc, phiên cũ nhất bị đóng trước (kiểm ngay trước khi đăng ký phiên, nên nhiều `hello` đến cùng lúc không vượt được trần).
4. **Hiệu lực thời gian thực.** `RelayHost` đọc lại `accountKey()` ở mỗi `hello` và mỗi nhịp bảo trì (5 s); phiên ghi nhớ «thế hệ» khoá lúc xác thực. Tắt cài đặt ⇒ `closeAccountSessions()` gửi `bye revoked` rồi đóng ngay; phiên nào sót bị nhịp bảo trì cắt.
   **Đổi khoá** («Đổi khoá tài khoản» trong *Remote: thiết bị đã ghép*) theo THỨ TỰ: lưu khoá mới → báo lên danh bạ → (chỉ khi danh bạ đã nhận) đổi khoá của máy và cắt phiên cũ. Cắt trước khi danh bạ có khoá mới thì trình duyệt tự chữa có thể đọc lại khoá cũ và kẹt ở «đang nối lại» vì host im lặng khi MAC sai;
   báo danh bạ không được ⇒ không đổi gì (khoá cũ còn nguyên). Phía web còn có bộ hẹn «khoá cũ»: phiên tài khoản mãi chưa vào được sau 8 s thì tải lại danh bạ (≤ 1 lần/phút/máy) và nối lại nếu khoá đã đổi.
   **Thu hồi** = khoá bị XOÁ (bật lại sinh khoá **mới**, khoá cũ không sống lại): tắt `trustAccount`; tắt Remote hoặc đường Internet; đăng xuất; đổi tài khoản đăng nhập (khoá gắn với tài khoản). Tắt Remote / đăng xuất cũng `ext_host_remove` xoá hàng khỏi danh bạ (cố gắng hết sức: mất mạng thì hàng nằm lại tới lần báo danh sau; đăng xuất còn được máy chủ xoá theo thiết bị).
   **Đóng VS Code thì KHÔNG xoá khoá** (mở lại là nối tiếp, tab trình duyệt tự vào lại).
5. **Mọi giới hạn khác giữ nguyên**: tập lệnh cho phép (`parseCommand`), `bypass` chỉ khi `remote.allowBypass` bật, tốc độ lệnh ≤ 120/phút, chống phát lại, nội dung vẫn mã hoá đầu-cuối.
6. **Chủ máy được báo**: khi phiên «tài khoản» THỰC SỰ có người dùng (đã giải mã được khung dữ liệu đầu tiên — hello bị phát lại chỉ tạo «phiên ma» không có khoá phiên nên không báo) hiện một dòng NGAY TRONG khung chat («Một trình duyệt đăng nhập cùng tài khoản Locaith vừa mở VS Code này từ xa. Không phải bạn? Tắt công tắc Remote…»), tối đa mỗi 60 s; khung chat đang ẩn thì tin được GIỮ LẠI (tối đa 3) và hiện khi khung chat mở lại, vì webview ẩn không nhận tin; lệnh đáng chú ý vẫn hiện «Từ xa · Tài khoản Locaith: …». Lần đầu tính năng có hiệu lực trên một máy, VS Code báo một lần kèm nút «Tắt tính năng này». Không có hộp thông báo nào khác.
7. **Liên kết** `https://locaith.ai/#remote?h=<hostId>` (lệnh `/remote`) chỉ nói «mở máy này», **không mang bí mật**; trang tự lấy khoá bằng phiên đăng nhập. Nếu danh bạ không giữ được khoá (đã tắt tính năng, mất mạng tới danh bạ, máy chủ chưa nâng cấp migration `20261105`), `/remote` quay về liên kết ghép đôi `#remote?r=…&k=…`.
   Khi hai kiểu cùng có mặt, liên kết ghép đôi thắng.

**Điều được đánh đổi (nói thẳng).** Với đường này gốc tin cậy là **tài khoản Locaith**, không còn riêng máy của chủ:

* Kẻ đăng nhập được tài khoản (lộ mật khẩu, phiên bị đánh cắp) điều khiển được mọi máy đang bật tin cậy theo tài khoản của tài khoản đó. Chủ máy chỉ có: thông báo trong chat (mục 6 ở trên), công tắc Remote (tắt = xoá khoá khỏi danh bạ và rời relay), tắt `trustAccount`.
* **«Đổi khoá» ngắt được trang bị bỏ quên hoặc khoá bị lộ, nhưng KHÔNG chặn được kẻ đang giữ phiên đăng nhập hợp lệ** — trình duyệt đó tự lấy khoá mới từ danh bạ rồi vào lại. Muốn chặn hẳn: tắt Remote hoặc `trustAccount`, rồi đổi mật khẩu/thu hồi phiên đăng nhập của tài khoản.
* **Toàn vẹn origin locaith.ai nay là một phần của gốc tin cậy.** Mọi script chạy được trong trang locaith.ai gọi được `ext_hosts_list` bằng phiên đăng nhập của bạn và lấy khoá của MỌI máy — rộng hơn K_dev ghép đôi trước đây (chỉ máy đã ghép ở trình duyệt đó). Hiện trang tải Tailwind từ `cdn.tailwindcss.com` không SRI và chưa có CSP; việc nên làm: dựng Tailwind lúc build, thêm CSP `script-src 'self'` + `frame-ancestors 'none'`.
* **Thiết bị extension bị lộ token** (token `lat_…` của MỘT thiết bị VS Code của bạn) không đọc được khoá, nhưng ghi được danh bạ: có thể cấy một «máy giả» kèm khoá của kẻ tấn công vào danh sách «Máy của bạn» (kênh `lcr1:<hostId>` công khai nên giả được cả hiện diện «trực tuyến»). Giảm thiểu ở trang: chỉ tự mở máy ĐÃ MỞ THÀNH CÔNG trước đó ở trình duyệt này (`relay/lastMachine.ts`, chỉ lưu mã máy) — máy lạ phải do người dùng bấm «Mở». Cách xử lý: «Đăng xuất thiết bị» đó ở locaith.ai (tab «VS Code từ xa» → «Thiết bị đã đăng nhập extension»), rồi đổi khoá tài khoản. Chưa chặn ở tầng CSDL vì gán lại hàng cho thiết bị mới là luồng hợp lệ (đăng nhập lại khi lần đăng xuất trước rớt mạng).
* Khoá nằm trong CSDL ở dạng đọc được. Biện pháp: schema `ext_private` không phơi qua PostgREST, bảng bật RLS không chính sách và thu hồi mọi quyền của `anon/authenticated`, chỉ hàm `SECURITY DEFINER` (search_path rỗng) chạm tới; khoá chỉ đi trong thân yêu cầu HTTPS (không URL), không vào log, không vào trạng thái giao diện. Bên giữ khoá (Locaith/CSDL) về nguyên tắc có thể đóng vai người đứng giữa một phiên «tài khoản»; với thiết bị đã ghép đôi thì không (khoá `K_dev` không bao giờ rời hai đầu).

### Phiên (mỗi lần kết nối)

1. `hello { dev, A2, n1, mac = HMAC(K_dev, hello|dev|A2|n1) }` → host kiểm MAC (sai ⇒ **im lặng**), kiểm nonce chưa dùng (5 phút), thiết bị chưa hết hạn/thu hồi.
2. Host → `hello_ok { r=n1, dev, sid, B2, n2, e=epoch, mac }`; khoá phiên `HKDF(ECDH(a2,B2), salt=K_dev, session|dev|sid|A2|B2|n1|n2, 64)` → `c2h` ‖ `h2c`. Có **bí mật chuyển tiếp** (ECDH tạm mới mỗi phiên).
3. Khung dữ liệu: `{ t:'d', s:sid, q, c }` — AES-GCM, IV = `0⁴‖u64be(q)`, AAD = `d|hướng|sid|q`; `q` tăng dần ở bên gửi. Bên nhận chống phát lại bằng **cửa sổ trượt 1024 khung**: mỗi `q` chỉ nhận một lần, cũ hơn cửa sổ thì bỏ, nhưng khung **đến lộn thứ tự** trong cửa sổ vẫn nhận. (Supabase Realtime THẬT có đảo thứ tự khi gửi dồn — phát hiện khi chạy thử trên dịch vụ thật; kiểm `q` tăng ngặt làm rơi mảnh và tin lớn không bao giờ ghép được.)
4. `{t:'reset', s}` — host báo «không biết phiên này» (VS Code vừa khởi động lại) → trình duyệt bắt tay lại ngay. `hello_no` (`unknown_device` | `expired` | `busy`) rate-limit ≤ 6/phút.

### Tin ứng dụng (bên trong khung mã hoá; cắt mảnh ≤ 36 KB trước khi mã hoá, ghép lại ở đầu kia)

| Hướng | Tin | Ý nghĩa |
|---|---|---|
| →host | `{k:'sub', since?, epoch?}` | Bắt đầu/nối lại luồng: host trả `resume` (+ phần bù) hoặc `snapshot` rồi sự kiện trực tiếp. |
| →host | `{k:'cmd', id, cmd}` | Một lệnh (`RemoteCommand`, kiểm bởi `parseCommand`). Host trả `{k:'res', id, ok, error?, message?}`. |
| →host | `{k:'ping', t}` / `{k:'unpair'}` | Nhịp (mỗi 20 s) / tự huỷ ghép đôi. |
| →client | `{k:'ev', m}` / `{k:'batch', m:[…]}` | Tin luồng `snapshot` `events` `patch` `toast` `image` `resume` `bye` — cùng định dạng với SSE của HTTP cục bộ (`protocol.ts`). Host gom ~60 ms/khung. |
| →client | `{k:'hb', s}` | Nhịp tim 15 s, `s` = seq mới nhất của host (client thiếu thì xin bù). |
| →client | `{k:'res'…}`, `{k:'pong'}` | Phản hồi. |

Client theo dõi `seq`: tin tới **trước** snapshot được giữ lại rồi áp sau; hở số ở luồng trực tiếp ⇒ chờ 400 ms cho chỗ trống được lấp (đảo thứ tự) rồi mới `sub{since}` để bù; `epoch` đổi (host khởi động lại) ⇒ snapshot mới (hiện diện cũng mang `epoch` để biết ngay); im lặng 45 s ⇒ bắt tay lại.

### Trường hiển thị tuỳ chọn cho dòng thời gian gọn (0.6.31, `REMOTE_API_VERSION` KHÔNG đổi)

Trang Remote vẽ dòng thời gian theo đặc tả [TIMELINE-SPEC.md](TIMELINE-SPEC.md). Dữ liệu chỉ thêm **trường tuỳ chọn** vào loại đã có — reducer `switch` kín của bản web cũ vẫn chạy, chỉ không vẽ thứ mới:

| Ở đâu | Trường | Ý nghĩa | `sanitize.ts` |
|---|---|---|---|
| sự kiện `thinking` | `ts?: number` | lúc delta được phát (engine đóng dấu) | giữ nếu là số nguyên không âm hợp lệ, bỏ nếu lạ (`sanitizeEvent`) |
| khối `thinking` | `startedAt?`, `durationMs?` | reducer `transcript.ts` tính từ `ts`: «Đã suy nghĩ 14 giây» | số nguyên không âm; giá trị lạ bị bỏ (`sanitizeBlock`); chữ vẫn cắt 4000 |
| khối/mục `notice` | `compact?: CompactInfo` | dòng «Đã nén cuộc trò chuyện · tự động · giải phóng 968k token» | đã có từ trước (`sanitizeCompact`) |
| khối `tool` | `args.description` (chuỗi) | mô tả một dòng do model đặt, ưu tiên hiển thị | cắt 600 ký tự như mọi đối số |
| khối `tool` | `summary` «58 dòng» | số dòng của Write — nguồn DUY NHẤT ở Remote vì `args.content` bị cắt 600 ký tự | không đổi |
| khối `tool` | `args.run_in_background` / `args.background` = true | dòng phụ «Chạy nền» | không đổi |

Bản web không cần đổi gì để tiếp tục chạy; muốn vẽ giống VS Code thì chép các hàm thuần liệt kê trong TIMELINE-SPEC.md. Kiểm thử: `npx vitest run test/thinkingDuration.test.ts test/compactNotice.test.ts test/remoteSanitize.test.ts`.

## 3. Giới hạn & hằng số

Realtime (gói Free): ≤ 250 KB/tin (ta giữ < 80 KB), 100 tin/giây/dự án, 200 kết nối đồng thời. Host: ≤ 5 phiên/thiết bị, ≤ 10 phiên «tài khoản» (0.6.5), ≤ 20 phiên tổng, phiên chưa xác lập 30 s, im lặng 90 s thì bỏ;
tối đa 10 thiết bị ghép đôi; lệnh ≤ 120/phút/thiết bị; hết hạn sau `remote.idleDays` (30) ngày không dùng.

### Relay quá tải: hàng chờ có đếm ngược

Mỗi máy bật Remote và mỗi trình duyệt đang xem chiếm MỘT kết nối Realtime; gói Free chỉ cho 200 (≈ 100 máy cùng lúc). Khi Realtime từ chối lượt vào kênh — `too_many_connections`, `too_many_joins`,
`too_many_channels`, `tenant_events`, hoặc từ chối cả bước bắt tay HTTP (429, hoặc 403 kèm thân nêu các mã đó) — máy khách KHÔNG nối lại âm thầm và cũng không báo "mất mạng":

1. `classifyRealtimeFailure` (`src/core/remote/queue.ts`) tách lỗi **quá tải** khỏi lỗi thường (sai khoá, mất mạng, relay khởi động lại — những lỗi này vẫn nối lại theo `backoff` 1–30 s, không hiện hàng chờ).
2. `RealtimeLink` vào **hàng chờ phía máy khách**: đóng ổ cắm, hẹn lần thử kế tiếp theo `queueWaitMs` — kết nối đồng thời/kênh: 20 s × 1,5^(n−1), trần 120 s; lượt-mỗi-giây/tin-mỗi-giây: 6 s × 1,6^(n−1), trần 45 s; mọi lần xáo trộn ±20% để
   hàng nghìn máy không gõ cửa lại đồng loạt. Trong lúc chờ KHÔNG mở thêm kết nối nào.
3. Extension báo rõ NGAY TRONG khung chat (không dùng thông báo hay thanh trạng thái của hệ thống VS Code): dải gọn phía trên ô nhập «Remote đang xếp hàng · tự thử lại sau 0:31 (lần 2)» có thanh tiến trình mảnh, «Thử ngay», «Tắt Remote» và một dòng giải thích (chat vẫn dùng bình thường); Cài đặt → Remote hiện cùng trạng thái; khung hiện mã QR ghép đôi (khi người dùng chủ động ghép) có biểu ngữ đếm ngược cùng nội dung — mã QR dùng được ngay khi vào được; mã hết hạn sau 5 phút. Máy chủ chỉ báo mốc `retryAt` (view.remote.queue), giao diện tự đếm ngược.
4. «Thử ngay» chỉ được một lần mỗi 5 s (`QUEUE_MIN_RETRY_GAP_MS`) để một nút bấm không thành đòn dội vào relay đang quá tải. Vào được kênh → hàng chờ tự xoá, thông báo đóng, hiện «đã vào được máy chủ relay» ở thanh trạng thái.

Đây là hàng chờ **phía máy khách** (đếm ngược tới lần thử kế tiếp), không phải thứ tự toàn cục: relay không có máy chủ nào biết "bạn đứng thứ mấy" nên không bịa số thứ tự. Muốn có hàng chờ có thứ tự thật cần một dịch vụ cấp vé riêng (hoặc nâng gói:
Pro 500, Team 10.000 kết nối). **Chưa quan sát được** chuỗi lỗi chính xác của Realtime thật khi chạm trần (không thể thử mà không làm sập dịch vụ thật): bộ nhận diện theo tài liệu Supabase và rộng tay về từ khoá, được kiểm bằng máy chủ giả mô phỏng giới hạn
(`test/relayQueue.test.ts`, `FakeRealtime.maxConnections/rejectUpgrade`, bộ VS Code thật). Nếu thực tế chuỗi khác, chỉ cần thêm từ khoá vào `queue.ts`.

## 4. Đăng nhập tài khoản (bắt buộc để dùng extension)

Luồng «mã uỷ quyền + PKCE» (xem migration `20261104_extension_account_and_remote_registry.sql`):

1. Extension mở `https://locaith.ai/#ext-auth?client=vscode&challenge=<S256(verifier)>&state=<ngẫu nhiên>&redirect=<vscode://locaithai.locaith-agent/auth>&label=<tên máy>&m_platform=…&m_vscode=…&m_ext=…[&manual=1]`.
2. Trang locaith.ai bắt đăng nhập (như thường), hiện màn «Cho phép», rồi gọi RPC `ext_auth_approve(challenge, redirect, label, meta)` → mã dùng một lần (5 phút).
3. Trang chuyển trình duyệt tới `redirect?code=<mã>&state=<state>` (hoặc `?error=access_denied&state=…` khi từ chối); luôn hiện thêm mã để dán thủ công (SSH/WSL/Codespaces).
4. Extension kiểm `state`, gọi `ext_auth_exchange(code, verifier, meta)` → token thiết bị `lat_…` (SecretStorage). Gọi `ext_auth_whoami` mỗi 30 phút (ân hạn mất mạng 7 ngày). Thu hồi: `ext_auth_logout` / trang web `ext_device_revoke`.
5. Máy đang bật Remote báo danh `ext_host_upsert(token, hostId, label, workspace, meta[, accountKey])` (5 phút/lần) để tab web liệt kê «Máy của bạn» qua `ext_hosts_list()` (chỉ chủ tài khoản đọc được). Từ 0.6.5 lần báo danh mang thêm khoá tài khoản (§2b):
   bỏ trống = giữ nguyên khoá đang có, `''` = xoá khoá (tắt tin cậy theo tài khoản), 22 ký tự base64url = đặt/xoay khoá, khác = `bad_key`. Máy chủ chưa nâng cấp (hàm cũ không có tham số, PostgREST trả 404) ⇒ extension gửi lại KHÔNG kèm khoá và coi như «chưa có tin cậy theo tài khoản».

Hợp đồng RPC (tất cả `POST {SUPABASE_URL}/rest/v1/rpc/<tên>`, trả JSON `{ok, …}`; lỗi mong đợi là `{ok:false,error}` chứ không ném):

| RPC | Gọi bằng | Tham số | Kết quả |
|---|---|---|---|
| `ext_auth_approve` | phiên người dùng | `p_challenge, p_redirect_uri, p_label, p_meta` | `{code, expires_in}` hoặc lỗi SQL (`not_authenticated` `bad_challenge` `bad_redirect` `too_many_pending`) |
| `ext_devices_list` | phiên người dùng | — | `[{id,label,meta,created_at,last_seen_at,expires_at,hosts:[…]}]` |
| `ext_device_revoke` | phiên người dùng | `p_device_id` | `{ok}` |
| `ext_hosts_list` | phiên người dùng | — | `[{host_id,label,workspace,meta,last_seen_at,device_id,device_label,account_psk}]` (`account_psk` = khoá tài khoản của máy hoặc `null`; **bí mật**) |
| `ext_auth_exchange` | khoá anon | `p_code, p_verifier, p_meta` | `{ok, token, device, user}` |
| `ext_auth_whoami` | khoá anon | `p_token` | `{ok, user, device}` / `{ok:false,error:'invalid_token'}` |
| `ext_auth_logout` | khoá anon | `p_token` | `{ok:true}` |
| `ext_host_upsert` | khoá anon | `p_token, p_host_id, p_label, p_workspace, p_meta, p_account_psk` | `{ok}` / `{ok:false,error:'invalid_token'\|'bad_host'\|'bad_key'\|'conflict'}` |
| `ext_host_remove` | khoá anon | `p_token, p_host_id` | `{ok}` |

## 5. Kiểm thử

* `npx vitest run test/relayCrypto.test.ts test/relayHost.test.ts test/realtimeLink.test.ts test/account.test.ts` — mật mã (có vector cố định), ghép đôi, phiên, rớt/phát lại/giả mạo, WebSocket thật với Realtime giả.
* `node _work/relay-live.mjs` — cùng ngăn xếp qua **Supabase Realtime thật** (kênh công khai, khoá anon, không dùng cơ sở dữ liệu): ghép đôi ~130 ms, snapshot 282 KB ~750 ms, lệnh khứ hồi trung vị ~120 ms, 300 sự kiện đúng thứ tự, nối lại sau khi bị cắt ~1,3 s.
* SQL: PGlite chạy nguyên văn migration (92 kiểm tra) — xem `scratchpad/pg/sqltest.mjs` trong bản ghi làm việc. Migration `20261105_remote_account_trust.sql` (khoá tài khoản) có bộ kiểm riêng chạy trên PostgreSQL thật (PGlite): `_work/pg-account-trust/run.mjs` — một bản `ext_host_upsert` duy nhất (không mơ hồ PostgREST), tương thích ngược với extension cũ, đặt/giữ/xoá/xoay khoá, cô lập giữa tài khoản, quyền `anon` / `authenticated`, khoá không lọt vào `ext_devices_list`.
* Tin cậy theo tài khoản: `test/relayHost.test.ts` (mục «tin cậy theo tài khoản»: vào không ghép đôi, sai khoá im lặng, xoay khoá/tắt cắt phiên, song song với thiết bị đã ghép, trần 10 phiên, chống phát lại, khoá không lên dây), `test/relayCrypto.test.ts` (vector `account`), `test/account.test.ts` (`hostUpsert` kèm khoá + lùi về máy chủ cũ), `test/accountLink.test.ts`, và bộ VS Code thật (`test/vscode/suite.cjs`, R2b–R2f: danh bạ giữ khoá, trình duyệt giả vào bằng tài khoản, đổi khoá, `/remote`, tắt/bật lại).
