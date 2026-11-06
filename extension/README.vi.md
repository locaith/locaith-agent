# Hướng dẫn tiếng Việt

Trợ lý AI **tự chủ (agent)** cho **VS Code** và cho **Chrome / Microsoft Edge** (khung chat bên cạnh trang web). Dùng **Claude, ChatGPT, Gemini, DeepSeek, Grok** và mọi API tương thích OpenAI (OpenRouter, Ollama, LM Studio, Groq…) với **cùng một cách làm việc kiểu Claude**:

- **Vòng lặp suy luận đan xen công cụ** — trợ lý tự lập kế hoạch, tìm kiếm, đọc/sửa tệp, chạy lệnh, tự đối chiếu số liệu và đổi hướng khi cần; không có kịch bản `if-else` cứng.
- **Nạp kỹ năng theo nhu cầu** — hướng dẫn thiết kế chỉ vào ngữ cảnh đúng lúc cần (tiết kiệm token, model thông minh hơn).
- **Tóm tắt luồng suy nghĩ theo thời gian thực** — một model nhỏ chạy nền biến hàng nghìn token suy nghĩ/mã đang sinh thành các dòng trạng thái ngắn ("Đang đối chiếu điểm số giữa các phiên bản…") để bạn không bao giờ nhìn màn hình trống.
- **Giao diện tối ưu cho tiếng Việt** — font **Be Vietnam Pro** (thiết kế riêng cho tiếng Việt, dấu thanh rõ nét), **JetBrains Mono** cho mã; gõ Telex/VNI không bị gửi nhầm tin; tìm kiếm không phân biệt dấu.

> Kiến trúc chi tiết và bản đồ "đặc tả → mã nguồn": `docs/ARCHITECTURE.md`.

**Hai bản, một lõi:** bản **VS Code** (làm việc với tệp và terminal trong workspace — xem các mục bên dưới) và bản **Chrome / Edge** (đọc trang đang xem, tra cứu web, dựng báo cáo, và — khi bạn cho phép — thao tác trên trang). Cả hai dùng chung engine, các nhà cung cấp AI, kỹ năng và giao diện.

## Mới trong 0.6.1

- **Bớt phải vào Cài đặt (mới ở 0.6.1)** — «Bỏ qua mọi xác nhận» luôn có trong danh sách chế độ quyền (bấm chọn lần đầu: một hộp xác nhận bật luôn, không cần vào Cài đặt); công tắc **Remote** ngay trên thanh tiêu đề khung chat (một cú bấm bật/tắt, không mã); Locaith-v5 tự bật **Trí nhớ sinh học**; mọi model Locaith có logo Locaith ở bộ chọn; extension Chrome / Edge (0.4.4) nối với VS Code bằng công tắc **VS Code** + thẻ **Cho phép** — không phải gõ mã.
- **Chợ không còn bị thanh tab đè lên danh sách** — khi cuộn xuống, chữ của danh sách từng lộ qua thanh tab dính. Nay thanh tab là một dải cố định, chỉ phần danh sách bên dưới cuộn.

## Mới trong 0.6.0

- **Mô hình Locaith-v5 — dùng ngay, không cần API key** — họ AI Local của riêng Locaith: **Locaith-v5-flash** (nhanh) và **Locaith-v5-SI** (suy luận sâu), dùng bằng tài khoản Locaith, **cửa sổ ngữ cảnh 1 triệu token** (trước đây các model DeepSeek cũng bị hiển thị nhầm 128K; nay đúng 1 triệu). Người dùng mới chưa có API key sẽ được đặt sẵn mô hình này; người đã có khoá giữ nguyên lựa chọn của mình. Kèm hai kỹ năng riêng: **soạn văn bản hành chính đúng thể thức Nghị định 30/2020/NĐ-CP** và **ghi nhớ lâu dài** (Bio-Memory hoặc tệp ghi nhớ trong dự án).
- **`/remote` — một bước tới Remote** — gõ `/remote` trong khung chat: trình duyệt mở thẳng trang Remote trên locaith.ai. **Từ 0.6.5 trang tự vào máy này nhờ cùng tài khoản Locaith — không mã, không ghép đôi, không «Cho phép».** Khi tắt `locaithAgent.remote.trustAccount`, hoặc không tới được danh bạ máy, `/remote` quay về liên kết ghép đôi dùng một lần (bí mật 128 bit nằm sau dấu `#`) và bạn bấm **Cho phép** ở VS Code một lần như trước.
- **«Gửi ngay» và giao diện gọn khi nhiều việc chạy song song (mới ở 0.6.0)** — tin đang xếp hàng có nút **Gửi ngay** (dừng bước đang chạy và giao tin đó làm lượt kế tiếp); một bước có nhiều lệnh công cụ gom thành một dòng (*89 lệnh gọi công cụ · 1 lỗi*), mỗi agent con đang chạy có một dòng sống: việc đang làm, hoạt động hiện tại và `461,4k token · 12 lệnh · 5 phút 18 giây`. Lệnh sửa tệp luôn hiện riêng.
- **Sổ tay làm video cho mọi model (mới ở 0.6.0)** — kỹ năng dựng sẵn `quy-trinh-video-locaith` (cách Locaith làm mọi thể loại video: chọn đường làm, bảy bước, các cổng chất lượng, bẫy đã trả giá) dùng được với bất kỳ nhà cung cấp nào và được nhắc mặc định cho Locaith-v5.
- **Thông báo dữ liệu ngay trong khung chat (không phải hộp thoại của VS Code)** — vì yêu cầu tới Locaith-v5 đi qua dịch vụ của Locaith nên lần đầu dùng, khung chat hiện một thẻ: nội dung bạn gửi được gửi tới máy chủ của Locaith, được **lưu lại (đã che các khoá API, mật khẩu, token nhận diện được) để tìm lỗi và cải thiện mô hình** và có thể do đối tác hạ tầng AI xử lý. Chưa bấm **Đồng ý và dùng** thì không có byte nào rời máy; không muốn chia sẻ thì bấm **Dùng API riêng** hoặc chọn bất kỳ nhà cung cấp nào khác bằng khoá của bạn. Sự đồng ý được ghi theo **tài khoản** ở máy chủ (đồng ý một lần là đủ cho mọi máy), rút lại ở Cài đặt → *Mô hình Locaith*.
- **Hàng chờ khi đông người dùng** — khi hơn 100 người dùng cùng lúc, thay vì báo lỗi, khung chat hiện dải *«Đang có nhiều lượt sử dụng, vui lòng chờ xử lý»* kèm **vị trí thật** của bạn và **đếm ngược từng giây** tới lần tự thử lại; bấm **Hủy** để dừng. Không dùng thông báo hay thanh trạng thái của VS Code.

Chi tiết: `docs/LOCAITH-MODELS.md`.

## Mới trong 0.5.2

- **Đăng nhập tài khoản Locaith (bắt buộc từ 0.5.2)** — extension cần tài khoản locaith.ai: trình duyệt mở ra, bạn bấm **Cho phép**, quay lại VS Code. Không nhập mật khẩu vào VS Code; khoá API bạn nhập **không bao giờ** được gửi lên Locaith, còn nội dung trò chuyện chỉ đi tới nhà cung cấp bạn chọn — **trừ mô hình Locaith-v5** (mục dưới đây), nơi nội dung đi tới dịch vụ của Locaith sau khi bạn đồng ý thông báo dữ liệu. Chưa đăng nhập thì extension bị khoá (kiểm ở phía host, không chỉ ở giao diện). Xem `docs/ACCOUNT.md` và `docs/LOCAITH-MODELS.md`.
- **Điều khiển từ xa (Remote)** — tab **VS Code từ xa** trên locaith.ai xem trực tiếp và điều khiển khung chat này: tin nhắn, suy luận, công cụ, diff, việc cần làm; gửi tin (xếp hàng khi trợ lý đang chạy), duyệt quyền, dừng, đổi cuộc trò chuyện/model/chế độ quyền/mức suy luận. **Hai đường:** *qua Internet* — dùng được từ điện thoại/máy khác, **mã hoá đầu-cuối** qua relay Supabase Realtime (relay không đọc được gì): đăng nhập locaith.ai bằng **cùng tài khoản** rồi chọn máy là vào được ngay, **không ghép đôi từ 0.6.5**; trình duyệt không đăng nhập tài khoản của bạn thì ghép đôi bằng liên kết/QR, mã xác nhận 6 chữ số và «Cho phép» ở VS Code — và *trên máy này* qua 127.0.0.1. **Bật sẵn** cho người đã đăng nhập (chỉ đường Internet; đường 127.0.0.1 mặc định tắt, không mở cổng nào): máy tự nối vào relay và tắt được ngay ở Cài đặt → Remote. **Cái bạn đang tin:** ai đăng nhập được tài khoản Locaith của bạn thì điều khiển được các máy bật tính năng này (máy giữ một khoá ngẫu nhiên trong danh bạ máy của tài khoản) — hãy giữ tài khoản an toàn; lần đầu tính năng có hiệu lực VS Code báo bạn một lần, mỗi khi có trình duyệt mở phiên khung chat hiện một dòng, **Remote: thiết bị đã ghép → Đổi khoá tài khoản** ngắt mọi trình duyệt đang vào, và `locaithAgent.remote.trustAccount` = false quay về ghép đôi từng thiết bị. Relay quá tải thì khung chat hiện đếm ngược thay vì báo lỗi. Thu hồi thiết bị đã ghép bằng **Remote: thiết bị đã ghép**; trình duyệt vào được làm được mọi việc trợ lý làm được trên máy này. Xem `docs/REMOTE.md`, `docs/REMOTE-RELAY.md`.
- **Logo cho plugin, MCP và nguồn kỹ năng** — mỗi dịch vụ/plugin/hãng có biểu tượng thương hiệu (SVG tích hợp sẵn, không tải từ mạng), thiết kế lại hàng danh sách kiểu thư mục ứng dụng của ChatGPT/Claude; dịch vụ chưa có logo hiện chữ cái đầu cùng kích thước. Nguồn và giấy phép: `docs/BRAND-ASSETS.md`.

## Mới trong 0.5.1

Bản **0.5.0** đã đăng lên Marketplace lúc đầu **chưa có** tính năng "gửi thêm tin khi trợ lý đang làm việc"; nó có trong 0.5.1.

- **Lịch sử đầy đủ hơn** — danh sách trước đây chỉ hiện cuộc trò chuyện của thư mục làm việc đang mở; nay hiện cả cuộc ở thư mục khác (nhóm "Từ thư mục khác"). Phiên mà phần hiển thị bị mất các lượt cũ (lịch sử gửi model vẫn nguyên) được dựng lại khi mở, bản gốc được giữ cạnh tệp (`<id>.healbak.json`). "Sao lưu tất cả" nay gồm mọi thư mục. Nguyên nhân gốc của việc mất lượt chưa tìm ra.
- **Ảnh** — bấm ảnh đã dán ở ô nhập, hoặc ảnh trong tin đã gửi, để xem phóng to. Tin đã gửi chỉ giữ ảnh thu nhỏ; ảnh gốc lấy từ lịch sử (không còn nếu đã nén ngữ cảnh).
- **Kết nối MCP** (Chợ → MCP) — kho 35 dịch vụ (3 mục "chưa hỗ trợ" vì không cho đăng ký OAuth tự động hoặc dùng SSE cũ), đăng nhập OAuth một chạm theo chuẩn MCP, thêm từ URL, GitHub bằng tài khoản GitHub trong VS Code hoặc token cá nhân (lưu trong SecretStorage, không ghi vào cài đặt).
- **Bio-Memory-Locaith** — bộ nhớ sinh học của Locaith dưới dạng MCP: cài vào môi trường Python riêng (~/.locaith/bio-memory, cần Python 3.10+), MỘT kho dữ liệu dùng chung cho mọi cuộc trò chuyện và mọi cửa sổ VS Code; công cụ chỉ đọc chạy không hỏi, `store_memory` vẫn hỏi; bản tóm tắt được lưu vào đây trước khi nén ngữ cảnh. Server `memory` của Anthropic được ghi rõ là của Anthropic.
- **Chợ plugin** — danh sách plugin chính thức của Anthropic; bấm Cài để tải về (mặc định tắt cho tới khi bạn bật). Dùng kỹ năng, agent, lệnh, MCP của plugin; hooks và LSP không chạy.
- **Swarm** — mức suy luận thứ sáu (`/thinking swarm`): suy luận tối đa + `workflow_run` luôn sẵn sàng + chỉ dẫn chia việc cho nhiều agent con rồi kiểm chứng chéo. Mặc định 300 agent / 16 cùng lúc / 5 triệu token; mỗi lần chạy vẫn cần bạn duyệt; rất tốn token.
- **Cầu nối Chrome** — điều khiển trang trên Chrome thật qua extension Locaith AI cho Chrome 0.4.2: mã ghép đôi, chỉ nghe trên 127.0.0.1, mỗi trang web được hỏi riêng trong Chrome, công cụ `chrome` (ẩn cho tới khi nạp kỹ năng `chrome-bridge`; agent con không dùng được).
- **Giấy phép** — extension nay theo **Giấy phép Freeware của Locaith** (miễn phí cho cá nhân và kinh doanh; được chia sẻ gói nguyên vẹn; không sửa đổi, dịch ngược, bán lại) thay cho "UNLICENSED"; kèm `LICENSE.txt` và `THIRD_PARTY_NOTICES.md` (sinh từ các thư viện và phông chữ thực sự nằm trong gói).

## Mới trong 0.5.0

- **Gửi thêm tin khi trợ lý đang làm việc** — không cần bấm Dừng: gõ rồi Enter, tin được xếp hàng và trợ lý nhận ngay ở bước kế tiếp (giữa hai lần gọi công cụ) hoặc ngay sau khi nó trả lời xong. Tin đang chờ hiện phía trên ô nhập: bấm để sửa, ✕ để xoá.
- **Locaith Auto và điều phối nhiều AI** — chọn model **Locaith Auto** để bộ điều phối tự chọn model theo việc (lập kế hoạch hoặc suy luận cao → hạng mạnh, còn lại → cân bằng) trong số các khoá API **bạn đã nhập**; hãng nào bị giới hạn tốc độ hay quá tải thì tự chuyển sang hãng khác và báo cho bạn biết. Chế độ *Dự phòng* / *Tự động* nằm ở Cài đặt → Điều phối nhiều AI (mặc định tắt).
- **Agent con và workflow kiểu Claude Code** — công cụ `agent` chạy việc ở phiên riêng (ngữ cảnh riêng, công cụ riêng) rồi chỉ báo cáo kết quả; `workflow_run` cho mô hình viết script JavaScript điều phối hàng chục đến hàng trăm agent (tối đa 16 chạy cùng lúc, 1.000 agent mỗi lần). Kết quả trung gian không đi vào ngữ cảnh chính nên không làm "rác" cuộc trò chuyện.
- **MCP và plugin** — nối server MCP (stdio hoặc HTTP) để thêm công cụ ngoài; plugin gom kỹ năng + agent + lệnh + MCP trong một thư mục (cùng định dạng plugin của Claude Code).
- **Chợ** — 835 kỹ năng đóng gói sẵn (chỉ gồm kỹ năng có giấy phép cho phép phân phối lại), bấm **Thêm** là mọi model dùng được; kèm thư viện MCP dựng sẵn, plugin và agent.
- **Bộ đếm token khi suy nghĩ** — số token suy nghĩ chạy trực tiếp cùng đồng hồ giây; cuối lượt hiện số token suy nghĩ thật nếu nhà cung cấp báo.
- **Giao diện** — logo Locaith chuyển động thay các vòng xoay, màu theo logo (xanh ngọc → tím chàm), bố cục co giãn khi kéo rộng/hẹp khung (cột nội dung rộng dần tới ~1000 px, không tràn ngang ở khung hẹp ~240 px).

## Dùng thử ngay (không cần API key)

Mở biểu tượng **L** ở thanh bên → trợ lý tự chuyển sang **chế độ demo** khi chưa có khoá nào. Gõ: *"so sánh điểm các model AI và dựng bảng thang điểm"* để xem toàn bộ quy trình: danh sách tác vụ → nạp kỹ năng → công cụ → dòng trạng thái → artifact hiện ở khung xem trước.

## Cài đặt

**Từ Marketplace:** mở Extensions, tìm **Locaith AI Agent**, rồi chọn Install. Hoặc chạy code --install-extension LocaithAI.locaith-agent.

**Từ VSIX:** chọn **Install from VSIX...** và mở locaith-agent-0.5.0.vsix.

**Mã nguồn:** gói VSIX là bản build sẵn. Repo phân phối hiện chỉ có các gói phát hành, không kèm source code hoặc build scripts. Các lệnh phát triển bên dưới chỉ dùng trong checkout source gốc.

## Bản Chrome / Edge

Đây là bản companion riêng, không nằm trong VSIX VS Code này. Các bước build bên dưới yêu cầu checkout source gốc.


Cùng một gói Manifest V3 chạy trên **Microsoft Edge** (từ phiên bản 116) và **Google Chrome**; giao diện nằm ở **thanh bên (side panel)** cạnh trang bạn đang xem.

**Cài đặt (nạp thư mục đã giải nén):**

```bash
npm install
npm run build:browser      # → thư mục dist-browser/
```

Rồi mở `edge://extensions` (Chrome: `chrome://extensions`) → bật **Chế độ nhà phát triển** → **Tải tiện ích đã giải nén / Load unpacked** → chọn thư mục `dist-browser`. Để có tệp `.zip` (nộp Chrome Web Store / Edge Add-ons, hoặc gửi người khác giải nén rồi nạp như trên): `npm run package:browser` → `locaith-agent-browser-0.4.1.zip`.

**Mở khung chat:** bấm biểu tượng **L** của tiện ích (nên ghim lên thanh công cụ), hoặc phím tắt **Alt+Shift+L** trên Edge (Chrome để trống phím mặc định: đặt ở `chrome://extensions/shortcuts`; Edge đổi ở `edge://extensions/shortcuts`). **Khung thuộc về tab bạn bấm**: nó chỉ hiện ở tab đó, mỗi tab có cuộc trò chuyện riêng (xem *Mỗi tab một khung* bên dưới).

**Bắt đầu:** chưa có khoá thì trợ lý chạy **chế độ demo**. Bấm ⚙ → thêm API key của dịch vụ bạn có (Claude, ChatGPT, Gemini, DeepSeek, Grok) hoặc **Thêm API tương thích OpenAI…** (Ollama, LM Studio, OpenRouter…; với máy cục bộ như Ollama cần cho phép nguồn `chrome-extension://*`, ví dụ `OLLAMA_ORIGINS=chrome-extension://*`).

**Đăng nhập bằng tài khoản (OAuth) thay cho dán khoá.** ⚙ → *Thêm API tương thích OpenAI…* → chọn mẫu **OpenRouter** → *Thêm & đăng nhập OpenRouter*: cửa sổ đăng nhập của OpenRouter mở ra; đồng ý xong tiện ích nhận một khoá của riêng bạn (thu hồi được ở trang OpenRouter), một khoá dùng được hàng trăm model. Cổng API riêng có OAuth 2.0: mở *Đăng nhập bằng OAuth 2.0 (nâng cao)* và nhập địa chỉ authorize, địa chỉ token, client ID (client công khai, PKCE S256; access token tự làm mới bằng refresh token; địa chỉ chuyển hướng cần đăng ký với nhà cung cấp hiện sẵn trong biểu mẫu). Quyền `identity` của trình duyệt chỉ được xin khi bạn bấm *Đăng nhập*; token lưu trong bộ nhớ riêng của tiện ích (không mã hoá trên đĩa, như khoá API).
**Không có đăng nhập bằng gói thuê bao Claude / ChatGPT / Gemini**, vì nhà cung cấp không cho phép ứng dụng bên thứ ba dùng token OAuth của gói thuê bao: Anthropic cấm dùng token OAuth gói Free/Pro/Max ngoài ứng dụng chính thức của họ; Google cũng không; OpenAI có chương trình riêng "Sign in with ChatGPT — plan usage" (đăng ký client động + địa chỉ gọi lại loopback) nhưng tiện ích này chưa hỗ trợ. Với các nhà cung cấp đó hãy dùng khoá API.

**Mỗi tab một khung — đổi tab thoải mái, tác vụ ở tab kia vẫn chạy.** Bấm biểu tượng tiện ích ở tab nào thì khung chat mở ở đúng tab đó (chip *Đang bám …* cho biết tab của khung). Bạn sang tab khác để sao chép hay tra cứu thì **khung ẩn đi** (không hiện lẫn ở tab khác) còn trợ lý **vẫn làm việc trên tab cũ** — nó không đi theo bạn và không biết bạn đang xem trang nào khác. Quay lại tab đó là thấy khung và đúng tiến độ (Chrome hiện khung lại **tự động**; Edge thường cũng tự hiện lại, nếu không thì **bấm biểu tượng tiện ích một lần** — tác vụ vẫn chạy nguyên vẹn, bấm là thấy). Bấm biểu tượng lần nữa khi khung đang hiện thì đóng khung (tác vụ vẫn chạy). Mỗi tab có cuộc trò chuyện riêng nên mở nhiều tab là chạy được nhiều tác vụ song song; một cuộc trò chuyện chỉ mở được ở một khung một lúc. Muốn dùng trợ lý ở tab khác: bấm biểu tượng tiện ích ở tab đó. Khi trợ lý ở tab khác **chờ bạn duyệt** hoặc **làm xong**, biểu tượng tiện ích hiện dấu (`?` hổ phách / số tab đã xong) ở mọi tab để bạn biết mà quay lại.

**Trợ lý "thấy" gì:** chip *Đang xem …* trên ô nhập cho biết tab nó đang nhìn; mỗi tin nhắn kèm tiêu đề, địa chỉ (đã che token) và đoạn bạn bôi đen. Gõ **@** để đính kèm nội dung một tab khác. Chuột phải trên trang: *Hỏi Locaith AI về đoạn đã chọn*, *Giải thích đoạn đã chọn*, *Tóm tắt trang này*.

| Nhóm | Công cụ | Ghi chú |
| --- | --- | --- |
| Đọc (luôn có) | `page_read`, `page_snapshot`, `page_screenshot`, `page_find`, `tabs_list` | văn bản nhìn thấy (bỏ chữ ẩn/trong suốt/ngoài màn hình), danh sách phần tử bấm được kèm số tham chiếu, ảnh chụp, tìm chữ không phân biệt dấu |
| Web | `web_search`, `fetch_url` | không dùng cookie của bạn |
| Thao tác (nạp kỹ năng `browser-control`) | `page_click`, `page_type`, `page_select`, `page_press_key`, `page_scroll`, `page_hover`, `page_wait`, `page_navigate`, `tab_open`, `tab_activate`, `tab_close` | ẩn cho tới khi model nạp kỹ năng (tiết kiệm token, buộc đọc quy tắc an toàn trước) |

**Biết trợ lý đang làm gì — và dừng ngay tại trang.** Trang nào trợ lý đang đọc/điều khiển có **viền sáng xanh lam ngọc** quanh khung nhìn và một thanh nhỏ ở dưới với nút **■ Dừng** đỏ: bấm là dừng cả lượt (kể cả thẻ xin phép đang chờ). Mỗi chỗ trợ lý bấm/gõ/chọn có **con trỏ chuột ảo** bay tới, vòng sóng lúc bấm và một **dấu số (1, 2, 3…)** giữ lại trên trang. Số này **trùng số bước trong khung chat** (và trong kết quả công cụ, kèm địa chỉ nơi diễn ra), nên sau này bạn có thể nhờ “quay lại bước 3”. Trợ lý làm việc **ngầm trên tab nền** và **không bao giờ tự chuyển tab của bạn**, kể cả khi chụp màn hình: trình duyệt chỉ chụp được tab đang hiện (đã đo trên Chrome/Edge 156: chụp tab đang ẩn, kể cả qua giao thức gỡ lỗi, bị treo), nên chụp tab nền bị từ chối và trợ lý dùng `page_snapshot`/`page_read` thay thế. Ai muốn chụp cả tab nền thì bật *Cho phép trợ lý đưa tab lên trước khi cần* (khi đó tab được đưa lên thoáng qua rồi trả bạn về, có thể nhấp nháy). Tab trợ lý tự mở thêm được **gom vào nhóm tab “Locaith AI” màu xanh lam ngọc** trên thanh tab để phân biệt với tab của bạn. Ảnh chụp màn hình hiện thành **hình thu nhỏ bấm xem được** dưới dòng công cụ (không lưu vào lịch sử). Tắt/bật hiệu ứng trên trang và cho phép trợ lý đưa tab lên trước ở ⚙ → *Hành vi*.

**Quyền truy cập trang web.** Mặc định tiện ích chỉ xin quyền tối thiểu; trợ lý đọc được tab đang xem sau khi bạn bấm biểu tượng tiện ích. Muốn nó đọc mọi trang: ⚙ → **Truy cập trang web** → *Cấp quyền* (trình duyệt sẽ hỏi; thu hồi được bất cứ lúc nào, cả trong `edge://extensions`).

**An toàn khi trợ lý thao tác trên trang** (trình duyệt của bạn đang đăng nhập nhiều tài khoản):

- Nội dung trang luôn là **dữ liệu không đáng tin**, được bọc trong khung riêng kèm lời nhắc; **thẻ mở/đóng của khung mang một mã ngẫu nhiên riêng cho từng lần** nên trang không giả được thẻ đóng để "thoát" ra ngoài; chữ ẩn bị bỏ (trong suốt kể cả `rgba(…,0)`, cỡ chữ 0, thụt lề âm, hộp 1px bị cắt, thu nhỏ về 0, nằm trong `<pre>`); ký tự vô hình/đổi chiều chữ/"ký tự thẻ" Unicode bị lọc; token trong URL bị che. Đoạn bạn bôi đen chỉ gồm phần nhìn thấy.
- **Chế độ quyền**: *Hỏi trước khi thao tác* (mặc định — hỏi trước mỗi lần bấm/gõ/chuyển trang), *Tự thao tác thường* (tự làm thao tác thường trên origin đã tin cậy), *Lập kế hoạch* (chỉ đọc), **Toàn quyền** (không hỏi gì nữa — chọn ở bộ chọn chế độ, qua hộp xác nhận nêu rủi ro; thanh đỏ nhắc khi đang bật và tắt được bằng một cú bấm; trợ lý vẫn không nhập mật khẩu/thẻ/OTP; rút lại được ở Cài đặt). Chỉ nên bật khi bạn tin nội dung các trang trợ lý sẽ đọc: một trang xấu có thể lừa mô hình làm việc bạn không muốn, và ở chế độ này sẽ không có thẻ xin phép nào chặn lại.
- Quyền theo **origin**, không theo tab: tab bạn đang xem chỉ được đọc không hỏi khi còn ở trang bạn đã giao; nếu trang tự chuyển sang trang khác, mọi thao tác phải hỏi lại. Đọc tab khác, mở tab, chuyển sang tên miền mới đều hỏi.
- Trang ngân hàng/ví/thanh toán/đăng nhập, gửi biểu mẫu có ô mật khẩu/thẻ/OTP, đóng tab của chính bạn: luôn hỏi và **không thể** "cho phép cả phiên".
- Trợ lý **không nhập** vào ô mật khẩu, số thẻ hay mã OTP (công cụ từ chối); giá trị các ô đó không bao giờ hiện cho model. Hãy tự nhập rồi để trợ lý làm tiếp. Nhận diện theo TỪ (không nhầm "Passenger name", "passport"…).
- Chế độ *Tự thao tác thường* chỉ tự duyệt thao tác thường trên tab đã giao, ở origin tin cậy, và **chỉ khi phiên chưa đọc nội dung tab khác**: đọc/liệt kê tab khác luôn hỏi (kể cả ở chế độ này); sau khi trợ lý đã đọc tab khác, mọi thao tác trang đều hỏi lại, vì nội dung đó có thể bị chép ra một trang khác. Lùi/tiến trang luôn hỏi; đổi trang của tab của bạn là yêu cầu nâng cao.
- Đích gửi của biểu mẫu được đọc qua nguyên mẫu gốc của trình duyệt (chống "DOM clobbering" — `<input name="action">` che đích thật), tính cả `formaction` của nút gửi; đích bất thường hoặc sang origin khác là yêu cầu nâng cao. Thẻ xin phép nêu **chữ bạn nhìn thấy** trên nút và cảnh báo khi nhãn ẩn (aria-label) khác hẳn, hiện **nguyên văn** (tới 1500 ký tự) điều sắp được gõ, và phơi ra ký tự ẩn/đổi chiều chữ.
- Các lựa chọn "cho phép cả phiên" **không** được lưu xuống đĩa: chỉ sống trong bộ nhớ của tiện ích nền và mất khi bạn đóng tab hoặc trình duyệt dừng tiện ích nền; mở lại cuộc trò chuyện cũ từ Lịch sử phải duyệt lại.
- Nội dung trang đã đọc **không được lưu** dạng văn bản trong lịch sử trò chuyện (chỉ giữ địa chỉ/tiêu đề); khoá API lưu trong bộ nhớ riêng của tiện ích và **không mã hoá trên đĩa** — hãy dùng khoá có hạn mức chi tiêu.

**Giới hạn của bản trình duyệt:** tác vụ chạy ở nền của tiện ích nên **đóng khung chat không dừng nó** (chỉ nút Dừng, nút Dừng trên trang hoặc đóng tab mới dừng); nếu trình duyệt tự dừng tiện ích nền giữa chừng (hiếm: hết bộ nhớ, cập nhật tiện ích) thì cuộc trò chuyện vẫn được lưu và mở lại khi bạn mở khung nhưng tác vụ đang dở đã dừng; tab nền không chụp được màn hình (xem trên); không đọc được trang hệ thống (`edge://`, `chrome://`, cửa hàng tiện ích, trình xem PDF) và nội dung trong khung nhúng (iframe); Edge không phải lúc nào cũng tự hiện lại thanh bên khi quay về tab cũ — bấm lại biểu tượng (không mất gì); `fetch_url` không ghim được địa chỉ IP trong trình duyệt nên chỉ chặn được tên/IP nội bộ nhìn thấy trên URL; đường HTTP thật của các adapter (kiểm tra kết nối → danh sách model → trả lời streaming, kể cả Claude qua SDK chính thức) đã được thử trên **Edge và Chrome thật** bằng máy chủ giả cục bộ, nhưng **chưa thử với khoá API thật của hãng** (không có khoá trong quá trình phát triển); với API tuỳ chỉnh, tiện ích xin quyền riêng cho máy chủ đó khi bạn lưu (nếu không, trình duyệt có thể chặn vì CORS); chưa nộp lên cửa hàng.

## Bắt đầu với API thật

1. Bấm bánh răng trong khung chat (hoặc `Ctrl+Shift+P` → **Locaith AI: Đặt API key…**), dán khoá của dịch vụ bạn có. Khoá được lưu bằng **SecretStorage** của VS Code (mã hoá theo kho khoá của hệ điều hành), **không** ghi vào tệp cài đặt và **không** gửi sang webview. Có thể dùng biến môi trường (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`).
2. Chọn **model** ở dưới ô nhập. Danh sách model **lấy trực tiếp từ nhà cung cấp** (không phải danh sách cứng), nên model mới hiện ra ngay và model đã ngừng cấp phát không còn gây lỗi.
3. Chọn **chế độ quyền** và **mức suy luận**, rồi giao việc.

| Nhà cung cấp | Mặc định | Ghi chú |
| --- | --- | --- |
| Claude (Anthropic) | `claude-opus-5-5` | Suy luận thích ứng, stream mã dài |
| ChatGPT (OpenAI) | `gpt-6.1-sol` | Responses API (GPT-6 không còn gọi công cụ qua Chat Completions) |
| Gemini (Google) | `gemini-3.8-flash` | `generateContent`; Interactions API chưa hỗ trợ |
| DeepSeek | `deepseek-flash` | Bật/tắt suy luận bằng mức suy luận |
| Grok (xAI) | `grok-4.7` | Responses API, giữ mạch suy luận giữa các lần gọi công cụ |
| API tuỳ chỉnh | — | Lệnh **Thêm API tương thích OpenAI…** hoặc `locaithAgent.customProviders` |

## Cách dùng

| Việc | Cách làm |
| --- | --- |
| Đính kèm tệp/thư mục | gõ `@` rồi chọn (tìm không cần dấu: `tai lieu` khớp `tài liệu`) |
| Lệnh nhanh | gõ `/` — `/new`, `/compact`, `/model`, `/mode`, `/thinking`, `/skills`, `/retry`, `/export`, `/init`, `/help` |
| Hỏi về mã đang chọn | chuột phải → **Thêm vùng chọn vào chat** / **Giải thích** / **Tìm và sửa lỗi** (`Ctrl+Alt+K` để thêm) |
| Mở chat | `Ctrl+Alt+A` · mở thêm tab riêng: **Mở trợ lý AI trong tab mới** |
| Dừng | nút **Dừng** hoặc `Esc` |
| Gửi thêm khi trợ lý đang chạy | gõ rồi `Enter` — tin được xếp hàng (xem "Gửi tin nhắn khi trợ lý đang làm việc") |
| Dán ảnh | `Ctrl+V` vào ô nhập (model hỗ trợ ảnh) |
| Tải tệp lên (PDF, Word, Excel, HTML, CSV, TXT) | bấm 📎, **kéo-thả** vào ô nhập, hoặc dán tệp — xem mục *Tệp tải lên* bên dưới |
| Làm tiếp việc còn dở | khi trợ lý đã dừng mà bảng tác vụ còn bước chưa xong, mỗi bước là một nút bấm (*Tiếp tục: …*, *Tiếp tục tất cả*); hết việc thì bảng tự ẩn |
| Xoá / sao lưu / khôi phục cuộc trò chuyện | biểu tượng đồng hồ → **Lịch sử** — xem mục *Lịch sử, Thùng rác và sao lưu* bên dưới |

### Tệp tải lên

Chọn, kéo-thả hoặc dán tệp vào ô nhập: **PDF**, **Word (.docx)**, **Excel (.xlsx)**, **HTML**, **CSV/TSV** và văn bản thuần (**TXT, MD, JSON, XML, LOG…**) — tối đa 5 tệp mỗi tin nhắn, 25 MB mỗi tệp. Tệp được **đọc ngay trên máy bạn** thành chữ (không có máy chủ trung gian); chip hiện số trang / trang tính / hàng, và chữ chỉ được gửi tới nhà cung cấp AI bạn đã chọn khi bạn gửi tin nhắn (với mô hình Locaith-v5: tới dịch vụ của Locaith, sau khi bạn đồng ý thông báo dữ liệu).

- **PDF** đọc lớp chữ có sẵn (PDF quét thành ảnh không có chữ → báo rõ, hãy gửi dưới dạng ảnh); **Word/Excel** đọc nội dung hiển thị (chữ ẩn trong Word, trang tính ẩn bị bỏ qua); **HTML** bỏ phần tử ẩn; **CSV** giữ nguyên bảng; tệp không phải UTF-8 được đoán bảng mã (Windows-1258, TCVN…) và ghi chú. Định dạng Office đời cũ (`.doc`, `.xls`, `.ppt`) chưa đọc được — hãy "Lưu thành" `.docx` / `.xlsx` hoặc xuất PDF.
- **Tệp là bối cảnh của cả cuộc trò chuyện.** Chữ của tệp nằm trong lịch sử của phiên: trợ lý dùng lại ở các lượt sau mà không cần tải lên lần nữa, mở lại cuộc trò chuyện cũ vẫn còn, và **khi hội thoại dài phải nén ngữ cảnh, tệp được giữ nguyên văn** (không bị tóm tắt; tệp mới nhất ưu tiên nếu quá nhiều tệp so với cửa sổ ngữ cảnh của model).
- Tệp quá dài so với cửa sổ ngữ cảnh của model thì chỉ đưa phần đầu (chip có dấu cảnh báo, kèm số ký tự đầy đủ).
- **Nội dung tệp là dữ liệu, không phải mệnh lệnh**: được bọc trong khung có mã ngẫu nhiên kèm lời nhắc, lọc ký tự ẩn/đổi chiều chữ; lời dụ nằm trong tệp (ví dụ trong CV hay hợp đồng do người khác gửi) không được làm theo. Bản trình duyệt còn coi phiên là "nhiễm" khi có tệp tải lên: mỗi thao tác trên trang đều hỏi lại, kể cả ở chế độ *Tự thao tác thường*.
- Bản VS Code: tệp `.pdf` / `.docx` / `.xlsx` trong workspace đính kèm bằng `@` hoặc kéo từ Explorer cũng được đọc thành chữ.

### Lịch sử, Thùng rác và sao lưu

Lịch sử trò chuyện được **lưu ngay trên máy bạn** — bản trình duyệt: IndexedDB của tiện ích (`nd-sessions`, có quyền `unlimitedStorage` nên không bị trình duyệt tự dọn khi đầy ổ); bản VS Code: thư mục lưu trữ toàn cục của extension (`sessions/*.json`). Lưu liên tục trong lúc trợ lý làm việc (mỗi ~1,5 giây) và khi đóng khung chat. Không có máy chủ nào của chúng tôi giữ bản sao; khoá API không nằm trong lịch sử.

- **Không tự mất.** Không còn giới hạn số cuộc trò chuyện (trước 0.3.0 kho âm thầm xoá cuộc cũ nhất khi quá 200).
- **Xoá = chuyển vào Thùng rác** (mục cuối màn hình Lịch sử), giữ **30 ngày** rồi mới dọn hẳn. Từ Thùng rác: *Khôi phục* (về đúng như cũ, kể cả tệp bối cảnh), *Tải bản sao lưu*, *Xoá vĩnh viễn*, *Dọn Thùng rác*.
- **Sao lưu ra tệp `.json`**: *Sao lưu tất cả* (mọi cuộc kèm Thùng rác) hoặc nút tải xuống ở từng cuộc. Tệp gồm toàn bộ tin nhắn, bảng tác vụ, artifact và **chữ của các tệp bối cảnh đã tải lên**. Bản trình duyệt: tệp về thư mục Tải xuống; bản VS Code: hộp thoại lưu (gợi ý thư mục cá nhân, không phải workspace — lịch sử có thể chứa thông tin riêng, đừng để lỡ commit lên git). Bản trình duyệt vẫn lược nội dung trang web bạn đã đăng nhập khỏi tệp (như khỏi kho).
- **Khôi phục từ tệp** (*Khôi phục từ tệp* ở màn hình Lịch sử): không bao giờ ghi đè — cuộc đã có bản y hệt/mới hơn thì bỏ qua, bản khác cùng mã thì thêm thành bản sao "(bản khôi phục)", cuộc từng nằm trong Thùng rác quay về Thùng rác. Tệp sao lưu được kiểm tra chặt (định dạng, kích thước, kiểu dữ liệu); **quyền "cho phép cả phiên", chế độ "không hỏi gì" và khối suy luận cũ không được mang theo**. Chỉ khôi phục tệp do chính bạn tạo, vì lịch sử nạp lại sẽ là lịch sử của mô hình.
- Gỡ tiện ích hoặc xoá dữ liệu trình duyệt sẽ xoá lịch sử: hãy **sao lưu định kỳ** nếu cần giữ lâu dài hoặc chuyển sang máy khác.

### Chế độ quyền

| Chế độ | Hành vi |
| --- | --- |
| **Hỏi trước khi sửa** (mặc định) | hỏi trước khi sửa/tạo tệp (có diff), chạy lệnh, đọc ngoài workspace, vào tên miền web mới |
| **Tự nhận chỉnh sửa** | tự sửa/tạo tệp *mã* trong workspace; vẫn hỏi khi chạy lệnh, khi ra mạng (`fetch_url`) và khi sửa tệp nhạy cảm (xem dưới) |
| **Lập kế hoạch** | chỉ đọc và nghiên cứu, trình kế hoạch để bạn duyệt rồi mới bắt tay làm |
| **Bỏ qua mọi xác nhận** | không hỏi gì — chỉ bật được khi đặt `locaithAgent.agent.allowBypassPermissions` |

Các thao tác **luôn hỏi** (trừ chế độ bỏ qua) và **không thể "cho phép cả phiên"**: ghi ngoài workspace, ghi vào `.git`/`.vscode`/workflow CI/tệp rc của shell, vào các tệp mà sửa chúng biến một lệnh đã duyệt thành chạy mã tuỳ ý (`package.json`, `Makefile`, `vitest.config.*`, `pyproject.toml`, `Dockerfile`…), đọc/ghi tệp chứa khoá (`.env`, `*.pem`…), lệnh có thể xoá dữ liệu. Quyền được xét trên **đường dẫn thật** (qua liên kết/junction, tên ngắn 8.3, luồng dữ liệu NTFS) và thẻ xin quyền hiện đích thật.

"Luôn cho phép lệnh này trong phiên" chỉ áp cho **đúng nguyên văn lệnh** (và thư mục chạy) bạn đã duyệt — không phải mọi lệnh cùng đầu (`npm test` ≠ `npm run evil`). Chỉ một danh sách rất hẹp lệnh chỉ-đọc (`git status`, `git diff`, `ls`, `--version`…) được chạy không cần hỏi. Lệnh dài, nhiều dòng hoặc chứa ký tự ẩn/đổi chiều chữ được cảnh báo ngay trên thẻ.

### Hướng dẫn riêng cho dự án

Tạo `LOCAITH.md` (lệnh **Tạo tệp hướng dẫn dự án**) ở thư mục gốc workspace — trợ lý đọc nó ở mọi cuộc trò chuyện. Cũng nhận `AGENTS.md` và `CLAUDE.md` nếu dự án đã có sẵn.

### Kỹ năng (skills)

Kỹ năng dựng sẵn: `artifacts` (dựng bảng/biểu đồ/trang HTML), `web-research` (nghiên cứu có đối chiếu nguồn), `software-engineering`, `vietnamese-writing`, `data-analysis`, `locaith-brand` (nhận diện thương hiệu Locaith AI cho tài liệu gửi khách), `multi-agent` (điều phối agent con và workflow). Thêm hàng trăm kỹ năng khác bằng một cú bấm trong **Chợ** (xem bên dưới).

Thêm kỹ năng của bạn: tạo `.locaith/skills/<tên>/SKILL.md` trong workspace hoặc `~/.locaith/skills/` (cũng quét `.claude/skills`). Định dạng:

```markdown
---
name: bao-gia
description: Soạn báo giá theo mẫu công ty — dùng khi khách yêu cầu báo giá.
---
Luôn ghi rõ "chưa bao gồm VAT 10%"…
```

### Gửi tin nhắn khi trợ lý đang làm việc

Không cần bấm Dừng: cứ gõ và nhấn Enter. Tin của bạn được **xếp hàng** (tối đa 20 tin) và hiện phía trên ô nhập; bấm vào tin để lấy lại vào ô nhập và sửa, hoặc bấm ✕ để xoá.

- **Giữa chừng (steering):** ngay khi trợ lý chạy xong lượt công cụ hiện tại — trước lần gọi model kế tiếp — mọi tin đang chờ được gửi **cùng kết quả công cụ**, nên trợ lý đổi hướng được ngay mà không phải đợi xong cả lượt. Trợ lý được báo rõ đây là tin bạn vừa gửi thêm; trong khung chat tin đó có nhãn "Gửi khi trợ lý đang làm việc".
- **Cuối lượt:** nếu trợ lý trả lời xong mà không gọi công cụ nào nữa, tin đang chờ trở thành lượt kế tiếp của cùng lần chạy.
- **Dừng** (`Esc` hoặc nút ■) huỷ việc đang làm; các tin chưa giao được **trả về ô nhập** để bạn sửa hoặc gửi lại — không tự gửi và không mất chữ nào. Lỗi nhà cung cấp cũng vậy.
- Khi trợ lý đang chạy agent con hoặc workflow, tin được giao khi lượt công cụ đó xong. Agent con chạy ở phiên riêng nên không thấy tin của bạn; trợ lý chính sẽ nhận và quyết định có dừng hay đổi hướng.
- Lệnh gạch chéo (`/compact`, `/model`…) và việc nén ngữ cảnh vẫn cần trợ lý rảnh.

### Điều khiển từ xa từ locaith.ai

1. Chạy lệnh **Locaith AI: Remote: ghép đôi thiết bị mới** (lần đầu sẽ hỏi bật; máy chủ chỉ nghe `127.0.0.1`).
2. Bấm **Mở trang Remote** trong thông báo — trang tự ghép đôi — hoặc mở tab **VS Code từ xa** trên locaith.ai và nhập mã 8 ký tự.
3. Thu hồi: lệnh **Locaith AI: Remote: thiết bị đã ghép / dừng** (thu hồi từng thiết bị hoặc tắt hẳn). Thiết bị không dùng 30 ngày tự hết hạn.

Cài đặt (chỉ ở cài đặt người dùng, không đọc từ workspace): `locaithAgent.remote.enabled`, `.webUrl` (đặt `http://localhost:3000` khi dev trang web), `.allowedOrigins`, `.publicUrl` (nếu bạn tự đưa máy chủ ra ngoài qua tunnel HTTPS), `.idleDays`, `.allowBypass`, `.trustAccount` (từ 0.6.5, bật sẵn: trình duyệt đăng nhập cùng tài khoản Locaith vào được không cần ghép đôi).

### Chợ (kỹ năng, plugin, MCP, agent)

Mở bằng biểu tượng cửa hàng trên thanh tiêu đề của khung chat (hoặc lệnh **Locaith AI: Mở Chợ (kỹ năng, plugin, MCP, agent)**). Có bốn tab:

- **Kỹ năng** — 835 kỹ năng đóng gói sẵn, tìm kiếm không phân biệt dấu, lọc theo nguồn. **Thêm** = giải nén đúng một kỹ năng vào `~/.locaith/skills/<tên>`; **Gỡ** chỉ xoá thư mục do Chợ cài (có tệp đánh dấu `.locaith-market.json`), không bao giờ đụng vào thư mục của bạn. Kỹ năng chỉ vào danh mục dưới dạng *tên + mô tả*; nội dung đầy đủ chỉ nạp khi mô hình gọi `load_skill`, nên thêm nhiều cũng không tốn token. Khi tìm kỹ năng, mô hình còn được gợi ý các kỹ năng trong Chợ chưa thêm để nhờ bạn bấm Thêm (nó không tự cài).
- **Plugin** — cài từ thư mục hoặc từ Git; plugin mới tìm thấy mặc định **tắt** cho tới khi bạn bật.
- **MCP** — danh sách server, trạng thái, công cụ từng server, công tắc bật/tắt và thư viện dựng sẵn (filesystem, memory, sequential-thinking, playwright, context7).
- **Agent** — các agent dựng sẵn và agent của bạn.

Nguồn và giấy phép của các kỹ năng đóng gói sẵn: `market/NOTICE.md` và `market/licenses/` (nằm trong thư mục cài đặt của tiện ích).

### Điều phối nhiều AI (Locaith Auto)

Chỉ dùng các nhà cung cấp **đã có khoá API**; không bao giờ gọi hãng bạn chưa cấu hình. Mặc định **tắt**.

| Chế độ (`locaithAgent.orchestration.mode`) | Hành vi |
| --- | --- |
| `off` | Chỉ dùng model đang chọn. Agent con kế thừa model đó. |
| `failover` | Model đang chọn đứng đầu; khi hãng đó bị giới hạn tốc độ, quá tải, mất kết nối hay từ chối khoá (trước khi nó trả chữ nào) thì tạm chuyển sang hãng khác **cùng hạng**, và báo trong cuộc trò chuyện. Hãng lỗi được cho "nghỉ" một lúc rồi thử lại. |
| `auto` | Như `failover`, và agent con/workflow chọn model theo **hạng** (mạnh / cân bằng / nhanh) trong toàn bộ khoá đã nhập, chia tải đều giữa các hãng (mỗi hãng tối đa 4 lệnh gọi đồng thời). |

Chọn model **Locaith Auto** ở ô nhập để giao hẳn việc chọn model cho bộ điều phối: lập kế hoạch hoặc mức suy luận cao → hạng mạnh, còn lại → cân bằng; trong cùng một cuộc trò chuyện nó ở lại hãng cũ trừ khi hãng đó đang nghỉ (giữ prompt-cache). Bảng "hạng → model" của từng hãng hiện ở Cài đặt. Hạng của model lấy từ nhà cung cấp (Claude, Gemini) hoặc suy ra từ tên (ví dụ `flash`, `mini` → nhanh; `opus`, `reasoner`, `gpt-5` → mạnh).

**Lưu ý quyền riêng tư:** khi bật `failover`/`auto` hoặc chọn Locaith Auto, nội dung cuộc trò chuyện có thể đi tới *bất kỳ hãng nào bạn đã nhập khoá* — và tới mô hình Locaith-v5 nếu bạn đã đồng ý thông báo dữ liệu của nó (chưa đồng ý thì Locaith không được tự chọn). Cài đặt này chỉ đọc từ cài đặt người dùng.

### Agent con và workflow

- **`agent`** — chạy một agent con ở phiên riêng: ngữ cảnh riêng, danh sách tác vụ riêng, công cụ thu hẹp (mặc định chỉ đọc + web). Chỉ báo cáo cuối quay về cuộc trò chuyện chính. Gọi nhiều `agent` trong cùng một lượt thì chúng chạy song song. Loại dựng sẵn: `explore` (do thám nhanh), `plan` (kế hoạch), `researcher` (web, đối chiếu nguồn), `reviewer` (phản biện), `general` (có ghi tệp/chạy lệnh — mọi thao tác vẫn xin phép bạn ngay trên khung chat chính và chạy tuần tự).
- **`workflow_run`** — mô hình viết thân hàm async JavaScript với `agent()`, `parallel()`, `pipeline()`, `store`, `phase()`, `log()`; chỉ giá trị `return` quay về cuộc trò chuyện. Công cụ này ẩn cho tới khi kỹ năng `multi-agent` được nạp. Giới hạn: ≤ 16 agent cùng lúc, ≤ 1.000 agent/lần, ngân sách token và hạn giờ. **Mỗi lần chạy đều cần bạn duyệt**; script chạy trong một worker riêng (không có `process`, `require`, `fetch`, `eval`), bị giết khi quá hạn hoặc khi bạn bấm Dừng.
- **Agent của bạn** — tệp `.md` trong `~/.locaith/agents/`, `<workspace>/.locaith/agents/` (cũng nhận `.claude/agents/`). Khai báo `name`, `description`, `tools` (`readonly` / `all` / danh sách, nhận cả tên công cụ kiểu Claude như `Read`, `Grep`, `Bash`), `model` (`top` / `balanced` / `fast` / `inherit` / `nhà-cung-cấp:model`, nhận cả `opus` / `sonnet` / `haiku`), `maxTurns`, `thinking`; nội dung là vai trò của agent.

### MCP và plugin

Khai báo server MCP trong cài đặt người dùng:

```json
"locaithAgent.mcp.servers": {
  "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/du-an"] },
  "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
}
```

hoặc đặt `.mcp.json` ở thư mục gốc workspace (định dạng `{ "mcpServers": { … } }`, cũng nhận `.locaith/mcp.json`). Công cụ hiện ra dưới tên `mcp__<server>__<công cụ>`.

- Server khai báo ở **cài đặt người dùng** tự chạy; server từ **workspace** hoặc **plugin** chỉ chạy sau khi bạn bật công tắc trong Chợ (lưu theo băm cấu hình — đổi lệnh là phải duyệt lại; workspace chưa tin cậy thì không chạy).
- **Mỗi lần gọi công cụ MCP đều xin phép** (có "cho phép trong phiên này" theo từng công cụ). Tiến trình MCP không thừa hưởng biến môi trường trông giống bí mật (KEY, TOKEN, SECRET, PASSWORD…); chỉ biến bạn khai báo trong `env` mới được truyền.
- **Plugin** là một thư mục có `plugin.json` (hoặc `.claude-plugin/plugin.json`) và các thư mục `skills/`, `agents/`, `commands/`, tệp `.mcp.json`. Đặt trong `~/.locaith/plugins/` hoặc `<workspace>/.locaith/plugins/` (thêm đường dẫn khác ở `locaithAgent.plugins.paths`). Lệnh trong `commands/*.md` thành lệnh gạch chéo `/<plugin>:<lệnh>`; `$ARGUMENTS` được thay bằng phần bạn gõ sau tên lệnh.

### Bộ đếm token khi suy nghĩ

Trong lúc mô hình suy nghĩ, khối "Suy nghĩ…" hiện số token đang chạy cùng số giây (ước lượng từ chữ đã nhận về — hãng không báo số thật cho tới cuối lượt). Cuối lượt, dòng thống kê hiện số token suy nghĩ thật nếu nhà cung cấp báo (`… token vào · … token ra · … suy nghĩ`).

## Bảo mật & quyền riêng tư

- Khoá API lưu trong SecretStorage của VS Code và **không bao giờ** được gửi lên Locaith. Nội dung bạn gửi đi chỉ tới **nhà cung cấp bạn chọn**. **Ngoại lệ duy nhất là mô hình Locaith-v5:** chọn nó thì nội dung đi tới dịch vụ của chính Locaith (cổng do Locaith vận hành), nên extension hỏi bạn đồng ý **thông báo dữ liệu** trước — nội dung gửi tới Locaith-v5 được lưu (đã che các khoá API, mật khẩu, token nhận diện được) để tìm lỗi và cải thiện mô hình, và có thể do đối tác hạ tầng AI của Locaith xử lý. Không muốn chia sẻ thì dùng khoá API của chính bạn với nhà cung cấp khác: phần đó không đi qua Locaith. Rút lại đồng ý ở Cài đặt → *Mô hình Locaith*.
- Nội dung web/tệp/kết quả lệnh được coi là **dữ liệu, không phải mệnh lệnh** (chống prompt injection); `fetch_url` chặn địa chỉ mạng nội bộ và metadata đám mây.
- **Tệp tải lên và tệp sao lưu là dữ liệu không đáng tin.** Chữ trong tệp tải lên (PDF, Word, Excel, HTML…) được đọc cục bộ, bọc khung dữ liệu có mã ngẫu nhiên, lọc ký tự ẩn/chữ ẩn; khi nén ngữ cảnh chỉ các khối do chính bạn tải lên (không phải nội dung trang web hay kết quả công cụ) mới được giữ nguyên văn. Tệp sao lưu khi khôi phục bị kiểm tra chặt và không mang theo quyền "cho phép cả phiên" hay chế độ "không hỏi gì". Tệp sao lưu là bản rõ trên đĩa của bạn (cả chữ của tệp bối cảnh) — hãy cất như một tài liệu riêng tư.
- Tiến trình con của `run_command` **không thừa hưởng** các biến môi trường chứa khoá API của nhà cung cấp.
- Webview dùng CSP chặt (script có nonce, không tải gì từ internet); Markdown của model được lọc bằng DOMPurify và ảnh từ xa bị chặn. Artifact chạy trong iframe cô lập, không có mạng, không khung con/worker; WebRTC bị vô hiệu. Mặc định chỉ SVG/Markdown tự mở, **HTML có script phải do bạn bấm "Mở"** (`locaithAgent.artifacts.autoOpen`).
- `fetch_url` phân giải DNS **một lần**, kiểm tra mọi địa chỉ (kể cả IPv4 bọc trong IPv6, NAT64, 6to4) rồi **ghim** kết nối vào đúng IP đã kiểm tra (chống DNS rebinding) và kiểm tra lại từng bước chuyển hướng.
- Các cài đặt quyết định "khoá API gửi đi đâu" và "tác nhân được làm gì" (`baseUrls`, `customProviders`, `agent.permissionMode`, `agent.allowBypassPermissions`, `agent.instructionFiles`, `skills.paths`, `fetch.allowPrivateNetwork`, `search.searxngUrl`, `summarizer.model`, `artifacts.autoOpen`, `orchestration.mode`, `mcp.servers`, `plugins.paths`, `agents.maxConcurrent`) **chỉ đọc từ cài đặt người dùng**, không bao giờ từ `.vscode/settings.json` của một kho mã lạ. URL API bắt buộc https (http chỉ cho localhost/mạng nội bộ).
- `grep` bỏ qua tệp chứa khoá (`.env`, khoá riêng…) và có hạn giờ cho mỗi tệp nên một biểu thức chính quy "thảm hoạ" không treo VS Code. Tệp không phải UTF-8 (Windows-1258, TCVN3…) bị từ chối sửa/ghi thay vì làm mất chữ có dấu.
- Bộ tóm tắt nền gửi các đoạn suy nghĩ/mã *đang sinh* tới model nhỏ của cùng nhà cung cấp (hoặc nơi bạn chỉ định). Tắt bằng `locaithAgent.summarizer.enabled`.
- Workspace chưa được tin cậy → trợ lý chỉ đọc, không sửa tệp hay chạy lệnh.
- **Agent con, workflow, MCP và plugin** (0.5.0): agent con không được tự sinh agent con, mặc định chỉ đọc, thao tác cần phép vẫn hiện thẻ xin phép trên khung chat chính; `workflow_run` luôn cần bạn duyệt và chạy script trong worker riêng với môi trường rỗng; server MCP từ workspace/plugin không tự chạy, tiến trình MCP không thừa hưởng khoá API, mỗi lần gọi công cụ MCP đều xin phép; plugin mới tìm thấy mặc định tắt. Điều phối nhiều AI mặc định tắt và chỉ đọc từ cài đặt người dùng.

## Cài đặt chính (`locaithAgent.*`)

| Khoá | Ý nghĩa |
| --- | --- |
| `ui.fontFamily` | `be-vietnam-pro` (mặc định) · `manrope` (font thương hiệu Locaith AI) · `inter` · `system` |
| `ui.fontSize`, `ui.lineHeight` | cỡ chữ (12–20) và giãn dòng (≥ 1.6 khuyến nghị cho tiếng Việt) |
| `language` | `vi` / `en` — ngôn ngữ giao diện và trả lời mặc định |
| `defaultModel` | `nhà-cung-cấp:model` cho cuộc trò chuyện mới |
| `agent.permissionMode`, `agent.thinkingLevel` | mặc định cho phiên mới |
| `agent.maxTurns`, `agent.maxOutputTokens` | giới hạn vòng lặp và độ dài mỗi lần gọi |
| `summarizer.enabled`, `summarizer.model` | bộ tóm tắt nền (`auto` = model rẻ của cùng nhà cung cấp) |
| `search.backend` | `duckduckgo` (không cần khoá) · `brave` · `tavily` · `serper` · `searxng` |
| `terminal.shell`, `terminal.timeoutSeconds` | shell và thời gian tối đa mỗi lệnh |
| `baseUrls`, `customProviders` | đổi URL gốc / nạp thêm API (chỉ cài đặt người dùng, bắt buộc https) |
| `artifacts.autoOpen` | `static` (mặc định: tự mở SVG/Markdown) · `never` · `always` |
| `orchestration.mode` | `off` (mặc định) · `failover` · `auto` — điều phối nhiều AI theo các khoá đã nhập (chỉ cài đặt người dùng) |
| `mcp.servers` | server MCP khai báo ở cài đặt người dùng (`command`/`args`/`env` hoặc `url`) |
| `plugins.paths` | thư mục plugin bổ sung (luôn quét `~/.locaith/plugins` và `.locaith/plugins`) |
| `agents.maxConcurrent` | số agent con chạy cùng lúc (1–16, mặc định 8) |

## Phát triển

Source code và build scripts không được đóng gói trong bản VSIX này. Hãy dùng checkout source gốc để chạy các lệnh build và test.

## Trạng thái & giới hạn đã biết

- Khối suy luận đã ký của Claude chỉ hợp lệ khi system prompt, danh sách công cụ và lịch sử phía trước không đổi. Khi một trong số đó đổi giữa chừng (duyệt kế hoạch, nạp kỹ năng, sang ngày mới, nén ngữ cảnh) extension **xoá suy luận cũ ở ranh giới lượt kế tiếp** (không bao giờ giữa một vòng công cụ) thay vì để API trả 400 — nên suy luận trước đó không được dùng lại. Nếu API vẫn từ chối giữa một vòng công cụ (ví dụ vừa duyệt kế hoạch), extension gọi lại không kèm suy luận cũ. Chưa kiểm chứng với API thật.
- Artifact HTML do model viết vẫn có thể chạy script trong iframe cô lập: CSP chặn mạng, nhưng không có cách tin cậy tuyệt đối để chặn mọi kênh rò dữ liệu trong trình duyệt (ví dụ WebRTC qua khung con). Vì vậy HTML không tự mở mặc định. **Đã đo trên Chrome 156 / Edge 156** (31 kênh, qua đường ống xem trước thật): CSP + sandbox chặn hết, TRỪ `<link rel="prerender">` (HTTP GET tới URL trong `href`) và `rel="preconnect"` (kết nối/DNS). Bản trình duyệt chặn bằng bộ lọc nguồn ở vỏ (thẻ có sẵn) và đoạn mở đầu trong tài liệu (mã tạo `<link>` lúc chạy: createElement, innerHTML, insertAdjacentHTML, document.write…); đây là lớp "nâng rào", còn đường vòng hiếm gặp — đừng mở artifact HTML nếu cuộc trò chuyện vừa đọc trang không đáng tin và chứa dữ liệu nhạy cảm. Test canary trong e2e sẽ đỏ nếu một phiên bản trình duyệt mới đổi hành vi.
- Các adapter đã được kiểm thử bằng **máy chủ giả mô phỏng định dạng SSE của từng hãng**, chưa gọi API thật trong quá trình phát triển. Các điểm dễ lệch nhất khi gặp API thật: tên tham số suy luận của Gemini (`thinkingLevel`), việc phát lại item suy luận mã hoá của OpenAI/xAI, và `reasoning_content` rỗng của DeepSeek. Adapter có cơ chế tự hạ cấp tham số khi server từ chối; nếu gặp lỗi, mở **Locaith AI: Xem nhật ký** và gửi lại thông báo.
- Gemini dùng `generateContent` (Google gọi là "legacy nhưng vẫn được hỗ trợ đầy đủ); chưa dùng Interactions API.
- `web_search` mặc định không cần khoá (DuckDuckGo, tự dự phòng sang Bing) nên có thể bị chặn khi truy vấn nhiều — dùng Brave/Tavily/Serper (lệnh **Đặt API key…**) để ổn định.
- Tệp **tải lên** đọc được PDF/Word/Excel/HTML/CSV/TXT (xem *Tệp tải lên*); riêng công cụ `fetch_url` / `read_file` của trợ lý vẫn chưa đọc PDF/Office (chuyển sang văn bản bằng `run_command` nếu máy có `pdftotext`/`pandoc`, hoặc tải tệp lên khung chat). Chưa đọc: PDF có mật khẩu, PDF quét thành ảnh (không có lớp chữ), Office đời cũ (`.doc`/`.xls`/`.ppt`/`.rtf`); công thức Excel chỉ hiện giá trị đã tính sẵn trong tệp.
- Bản đóng gói thêm bộ đọc PDF (pdf.js): bản VS Code nặng thêm ~1,7 MB; bản trình duyệt thêm tệp `docparse.js` (~1,7 MB) chỉ được nạp ở lần tải tệp đầu tiên nên khung chat vẫn mở nhanh như trước.
- **Điều phối nhiều AI, agent con, workflow, MCP, plugin và Chợ (0.5.0)** được kiểm thử bằng test đơn vị/tích hợp với nhà cung cấp giả, server MCP giả và kho kỹ năng giả; **chưa gọi API thật** nhiều hãng cùng lúc trong quá trình phát triển. Việc phân hạng model suy ra từ tên là heuristic — model đặt tên lạ có thể bị xếp sai hạng.
- Worker của workflow là lớp cách ly nhiều tầng (worker riêng, `vm` không có `eval`/`Function`, cầu nối chỉ truyền chuỗi JSON, môi trường rỗng) chứ **không phải hộp cát tuyệt đối**; vì vậy mỗi lần chạy đều cần bạn duyệt và agent con mặc định chỉ đọc.
- Thư viện MCP dựng sẵn dùng `npx` để tải gói npm lần đầu (cần Node.js và mạng; có thể mất vài chục giây). Tên gói là các gói công khai phổ biến nhưng chưa được kiểm chứng tự động.
- Kỹ năng trong Chợ chỉ gồm kho có văn bản giấy phép mở đi kèm (MIT, Apache-2.0, MPL-2.0). Các kỹ năng Anthropic dạng "proprietary", kỹ năng không rõ giấy phép và wrapper tự sinh của Composio **không** được đóng gói. Việc lọc dựa trên nhãn giấy phép của kỹ năng/kho, không thay thế thẩm định pháp lý.
- Số token suy nghĩ hiện trong lúc chạy là **ước lượng** từ chữ nhận về; nhà cung cấp ẩn nội dung suy luận (hoặc chỉ trả bản tóm tắt) thì số này thấp hơn thực tế.
- Tin gửi lúc trợ lý đang làm việc chỉ được giao ở ranh giới giữa hai lần gọi model: một lệnh chạy rất lâu (ví dụ `npm test` hàng chục phút, hoặc một workflow lớn) chưa xong thì tin vẫn chờ. Bấm Dừng nếu cần ngắt ngay — tin chưa giao sẽ về ô nhập.

## Giấy phép

Locaith AI Agent **miễn phí sử dụng** (cá nhân lẫn kinh doanh) theo **Giấy phép Freeware của Locaith** — xem `LICENSE.txt`: được cài đặt, dùng và chia sẻ gói cài đặt nguyên vẹn; không được sửa đổi, dịch ngược, bán lại hay đóng gói lại khi chưa có đồng ý bằng văn bản của Locaith. Thành phần bên thứ ba giữ giấy phép riêng: thư viện mã nguồn mở và phông chữ ở `THIRD_PARTY_NOTICES.md`, kỹ năng trong Chợ ở `market/NOTICE.md`. Bản tiếng Anh của `LICENSE.txt` là bản có hiệu lực.
