# Hạn mức: ba lỗi trong bản 0.7.15 đầu và cách vá

Bản 0.7.15 phát hành ngày 24/11/2026 có dải hạn mức trong ô nhập prompt, `/usage`, và lịch làm mới
theo Claude Code. Nhưng **ba câu trong CHANGELOG của bản đó chưa đúng với mã**: một người rà độc lập
đọc mã và chỉ ra, đối chiếu thì đúng.

## 1. Có hằng số gộp 300 ms nhưng không có chỗ nào gộp

`USAGE_DEBOUNCE_MS = 300` được khai trong `src/core/account/usageRefresh.ts` và CHANGELOG ghi
«reads are coalesced (300 ms debounce)», nhưng **không có dòng mã nào dùng hằng đó**. Ba sự kiện xảy
ra cùng lúc (lượt trả lời kết thúc + đổi chế độ quyền + nén ngữ cảnh) là ba lần gọi cổng.

**Vá:** thêm `UsageCoalescer` — nhận yêu cầu đọc, hẹn một lần chạy sau 300 ms, gộp mọi yêu cầu trong
cửa sổ đó thành MỘT lần đọc. Kích hoạt mạnh (`manual`, `window-reset`) thắng khi gộp vì người dùng
đang chờ số mới; `force` được giữ nếu bất kỳ lần nào yêu cầu. Đồng hồ và hàm đọc được tiêm từ ngoài
nên test được bằng đồng hồ giả. `ChatController` đưa mọi đường đọc qua lớp này
(`requestUsage` → `UsageCoalescer.request` → `readUsageNow`).

## 2. `/usage` in số CŨ rồi mới đọc lại

`refreshLocaithUsage()` là fire-and-forget: gọi xong trả về ngay, mã chạy tiếp và đọc
`this.view.locaith?.usage` **trước khi** lần đọc mạng kết thúc. Lần đầu còn tệ hơn — báo «chưa có số
liệu» trong khi lần đọc vẫn đang bay.

**Vá:** tách `requestUsage()` trả `Promise<void>` (xong khi lần đọc hoàn tất và view đã cập nhật),
giữ `refreshLocaithUsage()` làm vỏ không chờ. Nhánh `/usage` nay `await this.requestUsage({ force: true,
always: true, trigger: 'manual' })` rồi mới đọc `this.view.locaith?.usage`.

## 3. Cửa sổ đã qua mốc làm mới vẫn hiện phần trăm cũ

`dropExpiredWindows()` có hàm nhưng production **không gọi**. Nếu timer reset không kịp chạy (tab bị
ngủ, máy vừa thức, lượt đọc lỗi mạng) thì dải vẫn vẽ phần trăm đã hết hiệu lực.

**Vá:** `locaithView()` lọc qua `dropExpiredWindows(raw, raw.at)` trước khi gửi xuống webview; bản
webview (`Composer.tsx`) lọc lại theo đồng hồ hiện tại và **tự hẹn vẽ lại đúng lúc mốc làm mới tới** —
vì render chỉ chạy khi có patch, còn hạn mức thì không đổi nếu người dùng ngồi im. Hết cả hai cửa sổ
thì ẩn dòng hạn mức thay vì vẽ số 0.

`dropExpiredWindows` dùng `{...u}` nên vẫn giữ `canUpgrade` / `upgradeUrl` / `plan` / `at` — liên kết
nâng gói không bị mất khi một cửa sổ hết hạn.

## Chốt chặn

- `test/usageCoalescer.test.ts` — 300 ms gộp đúng một lần; kích hoạt mạnh thắng; `force` được giữ;
  lỗi mạng không nuốt sự kiện kế tiếp.
- `test/usageWiring.test.ts` — ghim ở **mã thật**: `USAGE_DEBOUNCE_MS` phải được dùng làm giá trị mặc
  định; `chatController` phải dựng `UsageCoalescer`; nhánh `/usage` phải `await` TRƯỚC khi đọc view;
  host và webview đều phải gọi `dropExpiredWindows`.
- `npx vitest run` — 4052 test / 271 tệp xanh; `npm run typecheck` cả 3 cấu hình xanh.
- `ND_TEST_ONLY=usage node test/vscode/runTest.mjs` — chạy trong VS Code THẬT: dải hạn mức nằm trong
  ô nhập prompt, ảnh `shots-715d/xx-usage-strip.png` và `xx-usage-strip-limit.png`.

## English (short)

Three claims in the 0.7.15 CHANGELOG were not backed by code, found by an independent reviewer:

1. **`USAGE_DEBOUNCE_MS` was declared but never used** — no real 300 ms coalescing. Added
   `UsageCoalescer`: requests within the window collapse into one read, strong triggers (`manual`,
   `window-reset`) win, `force` survives, clock and reader are injected so it is testable. Every read
   path in `ChatController` now goes through it.
2. **`/usage` printed the old numbers** — `refreshLocaithUsage()` was fire-and-forget, so the command
   read the view before the network read finished (and said "no data yet" on the first run). Split out
   `requestUsage(): Promise<void>` and `await` it before reading the view.
3. **Expired windows still showed stale percentages** — `dropExpiredWindows()` existed but production
   never called it. The host now filters before sending to the webview, and the webview filters against
   the live clock *and* schedules a redraw at the next reset moment; if both windows are gone the line
   hides instead of drawing 0%. The `{...u}` spread keeps `canUpgrade` / `upgradeUrl`, so the upgrade
   link survives.

Guards: `test/usageCoalescer.test.ts` and `test/usageWiring.test.ts` (the latter pins the real source:
the constant must be used as a default, the coalescer must be constructed, `/usage` must `await`
before reading the view, both host and webview must call `dropExpiredWindows`). 4052 tests / 271 files
green, typecheck green on all three configs, and a real VS Code run with screenshots.
