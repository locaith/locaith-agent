---
name: quy-trinh-video-locaith
description: Quy trình TỔNG của Locaith để làm mọi thể loại video chủ dự án đã nhờ — quay sản phẩm thật (showcase), video cho đối tác/khách có bộ nhận diện riêng, quảng cáo bất động sản/sản phẩm 9:16 từ thư mục tài liệu của khách, video không lời điện ảnh (clip nền sân khấu), video "một nút" từ đề bài, video TUA NHANH phát lại bản quay màn hình thật (GIF/MP4) với nhạc chủ dự án chọn, và app Locaith Studio cho người dùng cuối. Dùng khi chủ dự án nhờ làm BẤT KỲ video nào ("làm video cho …", "dựng clip giới thiệu …", "quảng cáo 1 phút khổ dọc từ dữ liệu này", "quay lại sản phẩm …") hoặc hỏi "video này nên làm theo đường nào". Giúp chọn đúng đường làm, đi đủ 7 bước, qua các cổng chất lượng và tránh các bẫy đã trả giá. Bổ sung cho kỹ năng lam-video (động cơ dựng).
---

# Quy trình làm video của Locaith (mọi thể loại)

Đây là **cuốn sổ tay đã chắt lại từ mọi video đã làm** (15–18/10/2026). Nó trả lời ba câu: *thể loại này làm đường nào? Phải qua những cổng nào? Đã vấp ở đâu?*
Chi tiết lệnh của động cơ nằm ở `showcase/studio/README.md` và kỹ năng **lam-video**; skill này nói việc **ra quyết định**. Cần nghiên cứu phim tham chiếu → **boc-tach-phim**; cần phân rã kịch bản nhiều góc máy → **kich-ban-chieu-sau**; TVC cảm xúc bằng ảnh/Veo → **tvc-cam-xuc-ai**; viết HTML→video thủ công → **hyperframes**, **media-use**.

## 1. Chọn đường làm (làm ngay, đừng hỏi lại điều đề bài đã nói)

| # | Thể loại | Dấu hiệu trong đề bài | Đường làm | Đã làm |
|---|---|---|---|---|
| A | **Quay sản phẩm thật** (showcase, giới thiệu sự kiện) | "quay lại cách dùng locaith.ai", có sản phẩm chạy thật, cần cảnh màn hình | Playwright quay sản phẩm THẬT chỉ-đọc → lời + giọng + nhạc → HyperFrames, bản làm tay trong `showcase/` | showcase locaith.ai (16:9 ~2:47, 9:16, quảng cáo 0:46) |
| B | **Video cho đối tác/thương hiệu khác** | "đối tác cũng muốn một video như vậy", có bộ nhận diện riêng | Cùng đường A + **hồ sơ thương hiệu riêng** (`LC_BRAND`), đổi cả bố cục/chuyển động chứ không chỉ màu | video giới thiệu cho một đối tác (bộ nhận diện riêng) |
| C | **Một nút từ đề bài** | đề bài ngắn, có/không có trang web công khai, 30–60 s | `studio.py make "đề bài" --url … --formats …` hoặc tự viết `spec.json` rồi `preview` → `make --spec` | video mẫu cho một thương hiệu F&B, video giải pháp phần mềm, "Locaith — Giao việc cho AI" (editorial, 50 s, 16:9 + 9:16) |
| D | **Quảng cáo giải pháp cho khách** | "làm clip quảng cáo giải pháp X", có tài liệu nội bộ/báo giá | Như C, nhưng **nguồn sự thật = tài liệu**, che tên khách, số chưa chốt ghi "đề xuất" | video giải pháp phần mềm cho một doanh nghiệp (nguồn: tài liệu nội bộ của họ) |
| E | **Quảng cáo bất động sản/sản phẩm từ thư mục dữ liệu của khách** | "từ dữ liệu này tạo video ~1 phút khổ 9:16" | **Locaith Studio** (đọc ảnh/video/PDF → hồ sơ dữ kiện có nguồn → kịch bản → dựng) | quảng cáo một dự án bất động sản, khổ 9:16 ~1 phút |
| F | **Video không lời điện ảnh** | clip nền sân khấu, hoài niệm, không thuyết minh | `silent: true`, cảnh `still`/`triptych`, ảnh sinh/ảnh Wikimedia, grade phim, Ken Burns | clip nền sân khấu hoài niệm cho một sự kiện |
| H | **Tua nhanh bản quay màn hình thật** | "anh có GIF/video quay thao tác phần mềm, làm video tua nhanh, không lời, nhạc bài X" | Mục 3.H: chọn khung → làm mờ → phát toàn màn hình theo nhịp nhạc → ghép nhạc; thẻ mở/kết dựng bằng HyperFrames | bộ 20 GIF tua nhanh (3:59), bộ 11 chương có trợ lý AI (2:13), bản FULL ghép hai video (6:12) |
| G | **Giao quy trình cho người khác tự làm** | "đóng gói để khách dùng", "cài lên máy khách" | **Locaith Studio** (Windows + Mac), 5 bộ não, cuốn playbook | Locaith Studio 1.0.0 |

Chưa chắc loại nào: hỏi MỘT câu — *"có tài liệu/ảnh/video của khách không, hay quay từ trang web/sản phẩm?"*. Có thư mục dữ liệu → E. Có sản phẩm chạy được → A/B/C. Không lời → F.

## 2. Bảy bước chung (mọi thể loại)

1. **Hiểu đề bài** — sản phẩm/thương hiệu là gì, ai xem, đăng ở đâu (9:16 cho Zalo/TikTok/Shorts, 16:9 cho web/sự kiện, 1:1 cho feed), dài bao lâu (mặc định 45–60 s), giọng và tông. Thiếu thì chọn mặc định hợp lý rồi **nói rõ đã giả định gì**.
2. **Đọc nguồn** — web công khai (chỉ-đọc), thư mục khách, PDF, ảnh. Mỗi dữ kiện gắn **mã nguồn** (A07, D02 tr.2…). Mâu thuẫn giữa các nguồn → ghi lại, đừng chọn bừa. Cái GÌ CÒN THIẾU (giá, pháp lý, bàn giao…) cũng ghi, không tự bịa.
3. **Viết kịch bản** — mỗi cảnh một ý; lời ngắn, có nhịp (≈ 3,0 từ/giây với giọng Achird); số liệu phải có trong nguồn; chọn **phong cách** theo tính cách thương hiệu (editorial, neon, playful, luxury, bold, clean, cinematic, organic).
4. **Chỉnh lời** — số đọc bằng chữ theo luật (`{439/456|bốn trăm ba mươi chín trên bốn trăm năm mươi sáu}`), tên riêng khai cách đọc, `cue` phải là cụm có thật trong lời.
5. **Xem trước + tự duyệt** — `preview` (không giọng/nhạc, ~2 phút/khổ) → MỞ `contact-*.jpg` xem từng cảnh: chữ tràn? hình trùng? hình không hợp ý lời? nền tối làm chìm chữ nhấn? Sửa rồi mới tốn TTS.
6. **Dựng** — `make` (thêm `--draft` để có bản nháp nhanh). Chạy nền, **không chạy hai tác vụ nặng cùng lúc** (Whisper + render tranh bộ nhớ ảo Windows).
7. **Giao** — mp4 + phụ đề `.srt` + bản nén gửi Zalo/chat + ghi chú 3–10 dòng: phong cách đã chọn và vì sao, thời lượng, **điều máy chưa kiểm được** (cách đọc tên riêng, số liệu có rào chắn "hơn/dự kiến", câu miễn trừ).

### 2b. Từng bước: dùng công cụ gì, làm thế nào (đúng như bản Word «Em làm video như thế nào», chặng 1–8)

1. **Hiểu đề bài** — Claude điền «phiếu đề bài» (cho ai, nói gì, đăng ở đâu, dài bao lâu, khổ 16x9 1920×1080 / 9x16 1080×1920 / 1x1 1080×1080, giọng/tông); đọc lại bộ nhớ ghi chú video trước (cách đọc "Locaith", bẫy cũ, sở thích chủ dự án). Điều tự giả định ghi ở đầu ghi chú giao hàng.
2. **Đọc nguồn** — *Web/sản phẩm:* Playwright + Google Chrome thật chạy ẩn (`lib/footage_worker.py job.json`, Python của `backend/.venv`), cuộn từng đoạn, chụp + quay màn hình, **chặn mọi POST/PUT/PATCH/DELETE** tới chính tên miền đang quay. *PDF:* `pypdfium2` đổi từng trang thành ảnh → Gemini nhìn ảnh (đọc cả chữ/số nằm trong hình). *Video/flycam:* `ffmpeg` cắt khung → Gemini mô tả từng đoạn (đoạn nào là cảnh gì, đoạn nào chỉ là teaser lạc đề). Kết quả = **hồ sơ dữ kiện**: mỗi dòng một dữ kiện + mã nguồn (A07, D02 tr.2), hai danh sách riêng THIẾU và MÂU THUẪN, và «lưới an toàn» bổ sung lại mọi số đã đọc mà bước gộp bỏ rơi.
3. **Chọn phong cách** — `studio.py styles` liệt kê 8 gói trong `lib/styles.py` (editorial, neon, playful, luxury, bold, clean, cinematic, organic): mỗi gói = bảng màu + cặp phông (Fraunces, Be Vietnam Pro, Space Grotesk, Playfair Display, Montserrat, JetBrains Mono, Anton, Barlow Condensed, Manrope, Newsreader; tải một lần qua fontsource, `lib/fonts.py`) + kiểu chuyển cảnh + nhịp. Ghi `style.preset` + `style.why`; đổi màu/chuyển cảnh theo thương hiệu bằng `style.overrides`. Chữ/nền tối phải ≥ 7:1.
4. **Viết kịch bản** — tệp `spec.json`. Mỗi cảnh: `type` (title, media, stat, list, steps, quote, compare, outro, still, triptych, screen, trio, walk), chữ hiển thị, `say` (lời đọc), `media`, `cue` (cụm sáng khi giọng nhắc tới, phải có thật trong lời), `facts` (dữ kiện kèm nguồn). Cách đọc: `{28%|hai mươi tám phần trăm}`; tên riêng khai ở `brand.pronounce` (Locaith → lô kết, ERP → ê rờ pê). `lib/plan.py` tự từ chối kịch bản sai loại cảnh / cue không có trong lời / thiếu tệp hình. Video đơn giản: `studio.py plan "đề bài"` nhờ Gemini lập bản nháp; video quan trọng Claude tự viết.
5. **Xem thử** — `studio.py preview --spec spec.json --formats 16x9` (~2 phút, không giọng/nhạc, mốc từ giả chia đều theo số chữ) → `runs/<slug>/out/contact-16x9-preview.jpg`. **MỞ ảnh ghép xem từng khung**; `hyperframes check` báo chữ tràn/phần tử ra ngoài. Sửa spec rồi chạy lại cho sạch.
6. **Dựng thật** — `studio.py make --spec spec.json --formats 16x9,9x16 [--takes 2] [--sync-check] [--draft]`:
   * **Giọng** (`lib/voice.py` + `tts/gemini_tts.py`): Gemini TTS `gemini-3.8-flash-tts`, giọng Achird, kèm «lời dặn giọng»; đọc LIỀN MỘT MẠCH cho mỗi đoạn dài (đọc từng dòng thì giọng lệch); tên riêng/số đã thay bằng cách đọc; `--takes 2` đọc hai lần giữ bản khớp lời hơn; `ffmpeg loudnorm` về −17 LUFS.
   * **Mốc từ + phụ đề**: `faster-whisper` cỡ medium (int8, chạy máy mình) nghe lại giọng → từng từ bắt đầu/kết thúc → cắt về từng cảnh (đệm đầu 0,10 s / đuôi 0,22 s) → `.srt`, chữ sáng đúng `cue`, so với lời gốc để bắt từ đọc sai.
   * **Nhạc** (`lib/music.py` + `music_worker.py`): Lyria 3 Pro `lyria-3-pro-preview`, lời mô tả tiếng Anh + quy tắc cố định (mở ~5 s, giữa nhẹ chừa chỗ cho giọng, 15 s cuối nâng rồi kết trọn hợp âm, không lời), dài = video + 6 s (30–170 s); ffmpeg cắt đầu + nối đuôi kết bằng crossfade cho vừa đúng độ dài; `volume` ≈ 0,14. Chủ dự án chỉ định bài → dùng bài đó (xem 3.H).
   * **Dựng hình** (`lib/compose.py` + `render.py`): spec → dự án HyperFrames (HTML + CSS + GSAP, mỗi cảnh một khối) → `npx hyperframes@0.8.153 check` → `render --quality delivery` (Chrome ẩn chụp 30 khung/giây, ffmpeg ghép giọng + nhạc → MP4 H.264/AAC). Phiên bản được ghim để dựng lại ra cùng một video.
   * Chạy từng việc nặng một (Whisper và render không chạy cùng lúc).
7. **Tự kiểm** — `lib/qa.py`: `ffprobe` (khổ, độ dài, có tiếng), `ffmpeg ebur128` (âm lượng đích −17…−14 LUFS, đỉnh < 0 dB), `contact-16x9.jpg` của video THẬT (mở xem), `--sync-check` (Whisper nghe lại video thành phẩm đối chiếu phụ đề: % từ khớp, độ lệch trung vị/p90; ví dụ một TVC: 92%, 0,002 s), đối chiếu từng con số trên màn hình với hồ sơ dữ kiện.
8. **Giao** — `ffmpeg libx264 -crf 24–25` thu về 1280–1600 px ngang cho bản Zalo (1 phút ≈ 5–25 MB); `.srt`; `GHI-CHU` (phong cách, nguồn, điều thiếu/mâu thuẫn, điều cần nghe lại); đặt gọn một thư mục trên Desktop và mở thư mục cho chủ dự án khi được hỏi.

## 3. Công thức từng thể loại

**A. Quay sản phẩm thật.** Quay bằng Playwright/Chrome GPU thật (WebGL cần GPU thật), mỗi cảnh một kịch bản thao tác (`capture/scenes/*.py`), `mark()` đánh dấu mốc. Lời trong `script/narration*.py` → giọng Gemini TTS → `faster-whisper` lấy mốc từng từ → Lyria nhạc → `video/build_video.py` + `edl*.py` → `render_all.sh`. Một lần quay → ba bản: ngang đầy đủ, dọc cùng cắt, quảng cáo ngắn. Dữ liệu demo là dữ liệu tạo riêng, xoá sau khi quay; **quay xong mới dọn**.

**B. Đối tác.** Lấy bộ nhận diện thật của họ (skill thiết kế của họ, logo từ chính trang họ). Làm lại **ngôn ngữ bố cục + chuyển động** (bản đầu chỉ đổi màu đã bị chê "như Locaith đổi màu"). Giọng **một lần đọc liền** cho cả bài (đọc từng dòng thì giọng lệch). Chỉ nói điều có trên trang công khai của họ. Cuối cùng nhờ chính họ nghe lại tên sản phẩm.

**C/D. Một nút.** Tự viết `spec.json` cho video quan trọng (Gemini lập kế hoạch chỉ để lấy khung). Với D: tên khách làm mờ nếu chưa được phép; số tiền/thời hạn chưa chốt ghi là *đề xuất*; có thể thêm benchmark công khai nhưng phải dẫn nguồn.

**E. Từ thư mục dữ liệu (Locaith Studio).** Đọc cả ảnh, video, PDF — kể cả trang PDF ít chữ (thông số nằm trong ảnh: phải *nhìn* trang) — rồi gộp thành hồ sơ dữ kiện. **Lưới an toàn**: mọi dữ kiện số đã đọc mà bước gộp bỏ rơi được bổ sung lại (từng mất số căn, tỉ lệ %, số tầng). Kịch bản chỉ dùng mã tài liệu có thật (không bịa tên tệp); ảnh phối cảnh phải ghi "Ảnh minh hoạ"; khu đất đang thi công thì nói đúng "tiến độ thực tế"; số có rào chắn ("hơn", "dự kiến khởi công") giữ nguyên rào chắn; **không tự ghi giá, pháp lý, bàn giao** nếu tài liệu không có; câu miễn trừ trong tài liệu được liệt kê cho người đăng. Chọn đoạn video là khâu yếu nhất (AI hay chọn đoạn teaser lạc đề) → để bước tự duyệt + "duyệt kịch bản trước khi dựng" làm việc.

**F. Không lời điện ảnh.** `silent: true` (không giọng/nhạc/phụ đề/SFX). Cảnh `still` (grade `vintage|mono|warm|cool|dream`, chuyển động `in|out|left|right|up|down|pan-up|pan-down`) và `triptych`. Giữ nhân vật nhất quán bằng ảnh tham chiếu (`refs`); có thể nhờ Gemini SỬA ảnh thật (giữ toà nhà thật, thêm người). Ảnh Wikimedia Commons phải ghi tác giả/giấy phép vào `credits.json` (bắt buộc ghi nguồn). **Không** cào ảnh Bing.

**H. Tua nhanh bản quay màn hình thật** (mẫu trong `showcase/studio/examples/tua-nhanh-*.py`). Đề bài hay gặp: chủ dự án đưa các GIF/MP4 quay thao tác phần mềm + một bài nhạc + "không voice". **Phát lại đúng khung quay, toàn màn hình, tua nhanh — không dựng ảnh tĩnh thu nhỏ trong khung** (bản ảnh tĩnh nhỏ đã bị chê "không xem được gì").
1. Tách khung: Pillow `ImageSequence` → `frames/<gif>/NNN.jpg` + `gifmeta.json` (kích thước, thời lượng từng khung 0,3–2,8 s).
2. **Phân loại khung** bằng Gemini nhìn ảnh (lô 8 khung): màn hình nào, đang làm gì, `key` 0–3, `misclick`, `blank`, cờ nhạy cảm. Bỏ khung trống/chuyển tiếp/bấm nhầm. **Đọc ghi chú của chủ dự án thành luật bỏ khung** (khung đầu hỏng, tài khoản sai, khách mượn, chứng từ đã hủy…) rồi tự nhìn contact sheet các khung nghi ngờ — Gemini bỏ sót khá nhiều cú bấm nhầm.
3. **Tên tập tin báo trước nội dung**: tên `loi-…` = bản quay TÁI HIỆN LỖI. Làm theo lời đề bài nhưng chỉ giữ phần chạy đúng, bỏ khung lộ lỗi và chữ thử lỗi, và **nói thẳng** trong ghi chú giao hàng những gì đã bỏ + khuyên quay lại sau khi sửa.
4. **Làm mờ** tên khách/đối tác/người/SĐT/email/số tài khoản ngân hàng: Gemini trả hộp `[ymin,xmin,ymax,xmax]` (0–1000) cho TỪNG khung giữ lại (≈ 270 lời gọi cho 800 khung); Pillow làm mờ Gaussian + phủ tối nhẹ. Máy dò có thể sót → ghi vào ghi chú.
5. **Nhịp nhạc**: đo BPM + pha bằng numpy (`tua-nhanh-do-nhip.py`: onset từ phổ, tự tương quan, quét pha), tìm chỗ "vào bài" bằng năng lượng theo ô nhịp. Mọi đổi chương rơi đúng vạch ô nhịp; điểm nối nhạc ở đầu cụm 8 ô nhịp. Ví dụ: bài 130,43 BPM (ô nhịp 1,8401 s, pha 0,29 s); bài 120 BPM (2,0 s, pha 0,08 s, vào bài ở 32,09 s).
6. **Phân bổ thời gian**: mỗi GIF = một chương; số ô nhịp chia theo tổng thời lượng gốc; trong chương, thời lượng khung = trọng số `(dur/1500)^0.6` (nén chênh lệch để khung nhanh không chớp quá, khung chậm không lê thê), co giãn cho khít đúng số ô nhịp. Tốc độ tua ≈ 2–5,5× (ghi trên thanh trên cùng "TUA NHANH ×N"). Đoạn quay ngắn thì đừng ép ×5: video 1 phút 9 giây từ 95 giây gốc là ×2.
7. **Ghép khung**: Pillow đặt khung vào nền 1920×1080 (thanh trên 60 px: số chương, tên chương, ngành, thanh tiến độ, huy hiệu tốc độ; màn hình chiếm ~1800×1000) → ffmpeg `concat` có `duration` → băng chú thích đầu chương (PNG RGBA, `overlay … enable`, fade vào/ra) → clip mỗi chương dài ĐÚNG số ô nhịp (`-t`) → nối các clip bằng `concat -c copy`. Thẻ mở/kết dựng bằng HyperFrames (spec 2 cảnh `title` + `outro`, `silent`), cắt đúng vạch ô nhịp.
8. **Nhạc**: `tua-nhanh-make-music.py` cắt đầu bài (vài ô nhịp trước chỗ vào bài) + nối bằng `acrossfade` 0,4 s sang đoạn kết, `afade` ra 2,6 s; ghép: `ffmpeg -i video -i bed.wav -map 0:v -map 1:a -c:v copy -af "volume=-4.5dB,alimiter=limit=0.7:level=disabled" -c:a aac -b:a 256k`. Bài thương mại master rất to (−7,7 LUFS, đỉnh +4 dB) → PHẢI hạ ≈ 4,5 dB + limiter, nếu không AAC bị vỡ tiếng (đo lại `ebur128`, đích ≈ −12 … −13 LUFS, đỉnh < −0,5 dB).
9. Giao: bản gốc + bản nén Zalo (1600 px, CRF 24) + GHI-CHU (khung đã bỏ và vì sao, bản quyền nhạc, điểm nối nhạc chưa nghe bằng tai, tên khách có thể còn sót).

**G. Giao cho người khác.** Dùng Locaith Studio: 7 giai đoạn cố định trong mã, mô hình chỉ dùng để *phán đoán*; cuốn playbook (`director/playbook/*.md`) là "bí quyết" mọi bộ não cùng đọc; mọi lỗi lặp lại phải được chặn bằng **kiểm tra máy**, không chỉ dặn mô hình.

## 4. Quy tắc cứng

* **Chỉ nói điều có thật.** Không bịa số, giải thưởng, khách hàng, "số 1". Điều chưa đo thì nói chưa đo.
* **Quay web chỉ đọc**: không đăng nhập, không gửi biểu mẫu; chặn mọi POST/PUT/PATCH/DELETE tới chính tên miền đang quay. Trang cần đăng nhập → xin ảnh/video.
* **Locaith đọc là "lô kết"** ({Locaith|Lô kết}); mọi tên riêng khác khai `brand.pronounce`. Máy nghe lại KHÔNG thay được tai người → nhờ người nghe 10 giây đầu.
* **Không đụng ổ D:** (đang hỏng). Làm việc trên C:; thư mục dữ liệu của khách chỉ ĐỌC; kết quả ra `runs/` (không vào git).
* **Không in khoá API / không đọc dòng `.env`**; xưởng đọc khoá từ cấu hình backend trong bộ nhớ.
* Không quay toàn màn hình máy tính (đã từng chụp nhầm cuộc trò chuyện riêng). Quay đúng cửa sổ trình duyệt/trang cần quay.
* Commit/PR **không** ghi dòng ghi công. Triển khai backend chỉ bằng `backend/restart_backend.ps1`.
* Viết mã có dấu tiếng Việt/dấu gạch chéo bằng công cụ Write/Edit, **không** dùng `python - <<EOF` trong bash.

## 5. Bẫy kỹ thuật đã trả giá

* **Đọc tên Locaith**: Gemini TTS đọc đúng ~1/4 lần nếu chỉ viết chữ; cần chỉ dẫn phát âm trong lời dặn giọng + thử lại đến khi Gemini lẫn Whisper cùng nghe đúng.
* **Whisper `mkl_malloc`**: lỗi khi bộ nhớ ảo Windows gần đầy; nạp mô hình một lần, chờ/thử lại, không chạy cạnh render. Đặt `HF_HUB_OFFLINE=1` để mất mạng không giết cả bản dựng.
* **Whisper ghi số bằng chữ số** → tỉ lệ "khớp" thấp ở câu nhiều số dù đúng; đánh giá bằng độ lệch mốc từ (trung vị ~ −3 ms, p90 ~ 24 ms) và contact sheet, không bằng % thô.
* **Đường dẫn dài** (Windows ~260 ký tự) làm Node/Chrome gãy → dựng ở thư mục làm việc ngắn, tên dự án ≤ 24 ký tự; truyền đường dẫn TUYỆT ĐỐI cho tiến trình con.
* **Dựng lỗi tạm thời** ("FFmpeg cannot start", "VIDEO_EXTRACTION_FAILED") → thử lại ≤ 3 lần và dọn Chrome còn sót; dựng lỗi mà vẫn báo "Xong" là lỗi nghiêm trọng — kiểm tệp ra thật.
* **Màu thương hiệu tối** làm chữ nhấn chìm vào nền tối → nâng tương phản (≥ 7:1 trên nền tối), hai bảng màu cùng sáng/tối.
* **Chip dài đè phụ đề** ở cảnh kết → giữ chỗ theo số hàng chip, rút "ảnh minh hoạ" thành "Ảnh minh hoạ".
* **`mark()` sau click lệch ~0,5 s** so với thay đổi thật → cắt cảnh bắt đầu sớm ~0,5 s trước mốc.
* **AI của sản phẩm không tất định** (Office, website): quay vài lần, chọn bằng contact sheet; chờ dấu hiệu hoàn tất trước khi thao tác.
* **Phông**: chỉ dùng phông có đủ dấu tiếng Việt, dùng các tệp tĩnh (phông biến thiên bị hiển thị một độ đậm).
* **HyperFrames lint**: không `tl.set(...,0)` để ẩn ban đầu (dùng `gsap.set`); không hai tween chồng trên một thuộc tính; phụ đề là sub-composition riêng; mọi mục tiêu GSAP phải tồn tại.
* **`claude -p` làm "bộ não"** nạp cả môi trường người dùng (hàng trăm nghìn token) nếu không tắt công cụ/slash/MCP — dùng bộ cờ tối giản.
* PyMuPDF là AGPL → dùng `pypdfium2`.
* **ffmpeg ghép hai video bằng bộ lọc `concat`/`xfade` có thể âm thầm mất cả chục giây hình** (xảy ra 24/10: video phần sau chỉ còn 112 s trên 133 s, không báo lỗi). Cách làm đúng: mỗi tệp tự `fade` vào/ra bằng một lượt mã hoá lại rồi nối bằng **concat demuxer `-c copy`**; LUÔN kiểm `nb_frames` và `duration` của tệp ghép (`ffprobe -count_frames`) so với tổng hai phần.
* **Nhạc thương mại master rất to**: hạ 4,5 dB cho đoạn nhẹ nhưng đoạn cao trào cần −6 dB + `alimiter=limit=0.66`, rồi đo lại bằng `ebur128` (đích ≈ −12…−13 LUFS, đỉnh ≤ −0,5 dB; AAC làm đỉnh thật cao hơn đỉnh mẫu ~2 dB).
* **Đo nhịp bài nhạc bằng numpy** (không có librosa trong venv): phổ → onset → tự tương quan → quét (BPM, pha); Một bài ra đúng 120,00 BPM nhưng điểm vào bài lệch +0,07…0,1 s so với lưới → lấy pha từ chỗ năng lượng nhảy vọt, không từ lưới lý thuyết. Mọi điểm nối nhạc đặt ở đầu cụm 8 ô nhịp.
* **GIF quay tái hiện lỗi** (tên `loi-…`, `AI-X-…-sai…`): nhờ Gemini phân loại khung KÈM gợi ý lỗi lấy từ tên tệp (cờ `defect`); loại hẳn đoạn mà chính kết quả của tính năng là cái lỗi; trong đoạn còn lại cắt khung lộ lỗi; nói thẳng với chủ dự án những gì đã bỏ và rằng không kiểm chứng được phần còn lại.
* **Nhiều đợt GIF theo thời gian**: mỗi đợt một thư mục `runs/<tên>/` riêng (`frames/`, `triage/`, `keep*.json`, `blur/`), dựng bản mở rộng bằng cấu hình mới (`make_v2.py` sinh `keep2.json`, `build_ff2.py`, `make_music2.py`) thay vì sửa đè bản cũ; bản FULL = ghép các video đã duyệt.
* **Git Bash: `find /` đi vào cả `/d` (ổ D hỏng)** — luôn bắt đầu từ đường dẫn `/c/...` cụ thể; không dùng glob/đệ quy từ gốc.

## 6. Số đo tham khảo

* Nhịp đọc: Achird ≈ 3,0 từ/giây (Puck ≈ 3,6); bộ lập kế hoạch Gemini hay đoán 2,6 → ước lượng độ dài dễ lệch.
* Âm lượng giao hàng: −17 … −14 LUFS. Video ~1 phút 1080x1920: ~55–75 MB bản gốc; bản nén Zalo ~8–25 MB.
* Thời gian: xem trước ~2 phút/khổ; dựng thật ~10–18 phút/video 1 phút trên máy 12 nhân; một video ~54 giây ra 76,7 MB.
* Giọng đã nghe kiểm tiếng Việt: **Achird** (nam). Giọng khác chưa kiểm — nghe thử rồi mới giao.

## 7. Giao hàng — danh sách kiểm cuối

- [ ] mp4 đúng khổ (xem `ffprobe`), có tiếng (trừ thể loại F), độ dài đúng đề bài.
- [ ] `contact-*.jpg` đã MỞ xem: không chữ tràn, không hình trùng, không khung đen/mờ.
- [ ] Mọi con số trên màn hình có trong nguồn (hồ sơ dữ kiện/đề bài).
- [ ] Tên riêng đã khai cách đọc; danh sách "cần nghe lại" đưa cho người nhận.
- [ ] Ảnh phối cảnh/AI có nhãn "minh hoạ"; ảnh có giấy phép có `credits.json`.
- [ ] Bản nén gửi chat + `.srt`; thư mục giao gọn (mp4, srt, GHI-CHU).
- [ ] Báo thẳng điều chưa kiểm; không nói "xong mọi thứ".

## 8. Bản đồ file

| Cần | Ở đâu |
|---|---|
| Động cơ một nút | `showcase/studio/` (`studio.py`, `Lam-video.cmd`, `lib/`, `examples/`, `runs/`) |
| Video quay sản phẩm (làm tay) | `showcase/` (`capture/`, `script/`, `tts/`, `video/`, `render_all.sh`, `out/final/`) |
| Hồ sơ thương hiệu đối tác | `showcase/<tên đối tác>/`, `video/<tên>_style.py`, `assets/brands/<tên>/` |
| Locaith Studio (app cho người dùng cuối) | `studio-app/` (code, installer Windows + `installer/mac/`), bản phát hành của Locaith Studio |
| Cuốn playbook cho mọi bộ não | `studio-app/app/locaith_studio/director/playbook/*.md` |
| Ghi chú đã trả giá | trí nhớ dự án (Bio-Memory): quy trình quay showcase, xưởng video, cách đọc tên Locaith, app Locaith Studio |
| Sổ tay bản người đọc | `Locaith-So-tay-quy-trinh-video.docx` |
| Mẫu video tua nhanh màn hình thật | `showcase/studio/examples/tua-nhanh-*.py` |
| Sản phẩm bàn giao | một thư mục gọn trên Desktop cho mỗi lần giao (mp4, srt, bản nén Zalo, GHI-CHU); video locaith.ai ở `showcase/out/final/` |
| Thư mục làm việc video tua nhanh | `showcase/studio/runs/<tên bộ GIF>/` (`frames/`, `triage/`, `keep*.json`, `blur/`; `build_ff.py`/`build_ff2.py`, `make_v2.py`) — nằm ngoài git |

## 9. Công nghệ ở từng khâu (chi tiết)

| Khâu | Công nghệ | Làm gì cụ thể | Chạy ở đâu |
|---|---|---|---|
| Lập kế hoạch / kịch bản | **Gemini** (`gemini-3.1-pro-preview`, dự phòng `gemini-3.8-flash`) qua Gemini API; hoặc tự viết `spec.json` bằng Claude | Từ đề bài → danh sách cảnh (loại cảnh, chữ, lời, `cue`), chọn phong cách | Trực tuyến, tính phí theo lượng dùng |
| Đọc tư liệu | **Playwright + Google Chrome** (quay web chỉ-đọc, chặn POST/PUT/PATCH/DELETE), **pypdfium2** (PDF → ảnh trang), **Gemini nhìn ảnh** (đọc thông số nằm trong ảnh) | Hồ sơ dữ kiện có mã nguồn | Máy mình + Gemini |
| Giọng đọc | **Gemini TTS** `gemini-3.8-flash-tts`, giọng **Achird**, lời dặn giọng (style) + `{chữ|cách đọc}` cho số/tên riêng | Đọc từng cảnh ra WAV; `--takes 2` đọc 2 bản chọn bản tốt; `loudnorm` về **−17 LUFS** | Trực tuyến |
| Phụ đề + mốc từng từ | **faster-whisper** (Whisper `medium`, int8, CPU; dự phòng `small`) | Nghe lại chính giọng đọc → mốc từng từ → `.srt` và chữ sáng theo từng từ; đối chiếu lời gốc để bắt từ đọc sai | Máy mình |
| Nhạc nền | **Lyria 3 Pro** (`lyria-3-pro-preview`, Gemini API) từ lời mô tả, hoặc nhạc chủ dự án chỉ định; **numpy** đo nhịp; **ffmpeg** cắt/nối | Nhạc ~96 BPM dưới giọng đọc, hạ nhỏ (volume 0,14) | Lyria: trực tuyến; còn lại máy mình |
| Ảnh minh hoạ | **Gemini image** (`gemini-3.1-flash-image` → `gemini-3-pro-image` → `gemini-2.5-flash-image`), **Wikimedia Commons** (ghi nguồn vào `credits.json`) | Ảnh bổ sung, nhãn "Ảnh minh hoạ" | Trực tuyến |
| Dựng cảnh | **HyperFrames 0.8.153** (ghim phiên bản; HTML + CSS + **GSAP** → Chrome headless chụp từng khung → ffmpeg ghép MP4, `npx hyperframes render --quality delivery`), mã cảnh Python `studio/lib/scenes*.py`, phông **Google Fonts qua fontsource** (có dấu tiếng Việt, tải một lần) | Mỗi cảnh = một khối HTML có hoạt hình; chuyển cảnh fade/wipe; chữ nhấn sáng đúng `cue` | Máy mình (GPU thật cho WebGL) |
| Tua nhanh màn hình thật | **Pillow** (ghép khung, làm mờ, phóng), **Gemini vision** (phân loại khung, hộp làm mờ), **ffmpeg** (`concat`, `overlay`, `acrossfade`, `alimiter`), **numpy** (nhịp) | Mục 3.H | Máy mình + Gemini |
| Kiểm tra | **ffmpeg** `ebur128` (âm lượng), `ffprobe`, **contact sheet** (ảnh các cảnh để MỞ xem), Whisper nghe lại đối chiếu phụ đề (`--sync-check`), `hyperframes check` | Chặn lỗi trước khi giao | Máy mình |
| Nén & giao | **ffmpeg** `libx264` CRF 24–25, `-movflags +faststart`, thu về 1280–1600 px | Bản gửi Zalo/chat | Máy mình |

**Điều kiện cần:** Python 3.11+, Node.js 20+ (để `npx`), ffmpeg + ffprobe, Google Chrome, một **khoá Gemini API** (dùng cho giọng, nhạc Lyria, ảnh, lập kế hoạch, nhìn ảnh). Video không rời máy; chỉ lời đọc, lời mô tả nhạc/ảnh và ảnh cần phân tích được gửi tới Gemini.

## 10. Dùng trên macOS

**Trả lời ngắn:** quy trình (các bước, cổng chất lượng, luật cứng, bẫy) dùng được nguyên trên Mac vì không gắn với hệ điều hành. **Mã xưởng `showcase/studio` đã sửa để chạy được trên Mac nhưng CHƯA thử trên một chiếc Mac thật** (chỉ đọc mã + chạy lại trên Windows không hỏng). Máy Mac cần cùng bộ công nghệ ở mục 9.

Cài đặt (Apple Silicon hoặc Intel, macOS 12+):

```bash
brew install python@3.11 node ffmpeg            # + cài Google Chrome từ trang chủ
python3.11 -m venv showcase/.venv && showcase/.venv/bin/pip install faster-whisper pillow numpy pypdfium2
python3.11 -m venv backend/.venv  && backend/.venv/bin/pip install playwright google-genai   # chỉ khi quay web / sinh ảnh / nhạc qua worker
export GEMINI_API_KEY="…khoá của bạn…"           # xưởng dùng biến này nếu máy không có backend Locaith
export PYTHONIOENCODING=utf-8
showcase/.venv/bin/python showcase/studio/studio.py make --spec đường/dẫn/spec.json --formats 16x9
```

Khác biệt so với Windows (đã xử lý hoặc cần biết):
* Python của venv là `.venv/bin/python` (không phải `Scripts\python.exe`) — `studio/lib/config.py` tự chọn theo hệ điều hành.
* Khoá Gemini: có biến `GEMINI_API_KEY` thì dùng, không cần backend. `footage_worker.py` và `music_worker.py` còn `import app.…` của backend Locaith → máy không có repo backend thì **quay web / sinh ảnh / Lyria** qua hai worker này chưa chạy. Giọng, phụ đề, dựng, tua nhanh vẫn chạy; nhạc thì đưa file có sẵn.
* Phông Pillow (mục 3.H): `examples/tua-nhanh-build-ff.py` tự tìm Segoe UI (Windows) / Arial (macOS) / DejaVu (Linux). Phông trong video HyperFrames tải từ mạng nên không đổi.
* `npx` không cần `shell=True` trên Mac (mã đã xử lý). Quay web dùng `channel="chrome"` → cần Google Chrome; WebGL dùng GPU của Mac (Metal) — chưa đo tốc độ.
* Whisper trên Mac chạy CPU int8, chậm hơn máy 12 nhân RAM lớn; không có lỗi `mkl_malloc` của Windows.
* Tệp `.cmd`/`.ps1` (Lam-video.cmd, restart_*.ps1) chỉ cho Windows; trên Mac chạy thẳng `studio.py ui` hoặc `make`.
* Đường dẫn trong ví dụ lệnh đổi `\` thành `/`, ổ đĩa thành `/Users/<tên>/…`.
* App **Locaith Studio** (`studio-app/`) có bản Mac riêng (`installer/mac/`, đã chạy thử trên máy chủ GitHub Actions, chưa trên Mac thật) — nếu người nhận chỉ muốn "ra video", đưa app này thay vì dựng môi trường tay.
* Nếu người nhận chỉ cần *học quy trình* rồi để Claude trên Mac tự dựng: đưa skill này + tài liệu Word; Claude trên Mac dùng skill `hyperframes` + Gemini API theo bảng mục 9.
