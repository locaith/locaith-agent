# Dòng chờ: logo «Lo» biến hình khi chờ lâu (0.7.2)

Anh duyệt 08/11/2026 bộ ảnh «Locaith-Y-Tuong-Logo-Dong» và yêu cầu làm thật.

- **Hành vi.** Ở dòng «Đang xử lý» cuối lượt, ô bên trái (nay cố định 20×20 px) vẫn là logo Lo phát sáng trong 8 giây đầu. Chờ lâu hơn thì logo quét sáng biến hình thành nhân vật nhỏ rồi quét ngược về logo. Chu kỳ 80 giây: 0–8 s logo · chó robot 12 s · logo 6 s · robot người 12 s · logo 6 s · drone 12 s · logo 6 s · tên lửa 18 s. Từ chu kỳ thứ hai thứ tự bốn nhân vật là ngẫu nhiên nhưng không bao giờ có hai lần liền cùng một nhân vật (kể cả chỗ nối chu kỳ); hạt giống lấy từ id lượt nên render lại không đổi.
- **Chuyển cảnh 0,5 s** bằng vệt sáng quét của logo: lúc vào quét trái → phải, lúc ra quét ngược phải → trái; bên trái vệt luôn là nhân vật, bên phải là logo.
- **Vòng lặp 6 khung / 0,9 s**, nháy mắt ở khung 4 (chó, robot người). 6 khung của mỗi nhân vật là chuỗi SVG tĩnh dựng MỘT lần lúc nạp module (`webview/src/brand/sprites.ts`, chuyển từ `scripts/brand/sprites.mjs`); lúc chạy chỉ là CSS `steps()` bật/tắt khung và `clip-path` cho chuyển cảnh, JS chỉ kiểm lịch 4 lần/giây và đổi state khi đổi cảnh. Chỉ MỘT bộ lọc glow trên ô.
- **Lịch là hàm thuần** `actorPlan(elapsedSec, seed)` ở `webview/src/brand/actorPlan.ts` (test `test/webview/loActor.test.ts`). Thành phần `components/LoActor.tsx` chỉ thay `LoSpinner` trong `WorkingIndicator`; các nơi dùng LoSpinner khác giữ nguyên.
- **Không đổi chiều cao dòng**: ô 20 px có đệm âm 4 px trên/dưới, nên chiều cao dòng chờ bằng đúng dòng chữ ở mọi trạng thái (harness kiểm bằng đo DOM).
- **Truy cập.** `prefers-reduced-motion` → chỉ còn logo (không dựng nhân vật); tương phản cao / forced-colors → màu hệ thống (Highlight / CanvasText), vẫn nhận ra hình; nền sáng → quầng sáng nhẹ hơn và mắt tối; `aria-hidden`; sidebar 300 px không tràn.
- **Cài đặt `locaithAgent.ui.workingCharacters`** (mặc định bật; công tắc trong màn Cài đặt; chuỗi vi/en). Tắt → giữ `LoSpinner` cũ. Bản Chrome/Edge đọc cùng khoá trong cấu hình riêng (mặc định bật).
- **Lệch nhỏ so với bản mẫu:** tên lửa trong `sprites.mjs` có 6 khung giống hệt nhau (sin rơi đúng nút) nên không «nhấp nháy»; bản này cho thân rung ±0,45 mỗi khung và ba tia lửa lệch pha. Cánh quạt drone đổi trạng thái mỗi khung.
- **Kiểm:** `node webview/dev/shoot.mjs actor-` (28 cảnh: sáu khung và chuyển cảnh phóng to, ba theme, rộng 300/420/800, kiểm DOM 20×20 + chiều cao + không tràn ngang). Tham số gỡ lỗi `actor=dog:char|bot:in|drone:out…` chỉ có trong harness.

## English (short)

- On the "working" line the 20×20 px icon stays the glowing Lo logo for the first 8 s; on long waits it sweeps into a small character (robot dog, robot, drone, rocket) and sweeps back. 80 s cycle (8 s logo, dog 12, rest 6, robot 12, rest 6, drone 12, rest 6, rocket 18); later cycles shuffle the order with no immediate repeat (seeded by turn id, so re-renders are stable). 0.5 s sheen-wipe transitions in and out.
- Six pre-built SVG frames per character (built once at module load), animated purely with CSS `steps()` / `clip-path`; one glow filter; blink on frame 4. The pure schedule `actorPlan(elapsedSec, seed)` is unit-tested.
- Line height never changes (negative padding on the 20 px cell). Reduced motion: logo only. High contrast / forced colors: system colors. Light theme: softer glow, dark eyes.
- New setting `locaithAgent.ui.workingCharacters` (default on, toggle in Settings); off keeps the old spinner. The Chrome/Edge build shares the webview and defaults to on.
