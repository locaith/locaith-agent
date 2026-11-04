# Locaith AI Agent for VS Code

English-first VS Code Marketplace release for `LocaithAI.locaith-agent`, version `0.6.0`.

> This repository contains prebuilt release packages and checksums. The original source tree and build scripts are maintained separately.

## What's new in 0.6.0

- **Locaith-v5-flash and Locaith-v5-SI — Locaith's own AI Local, free with your account.** A new provider, *Locaith AI Local*, sits in the model list next to Claude, ChatGPT, Gemini, DeepSeek and Grok (it is the default for a new user who has no API key). **Locaith-v5-flash** is the fast model; **Locaith-v5-SI** reasons deeper. Both have a **1,000,000-token context window** (the 128K that DeepSeek models showed in earlier versions was wrong; they now report 1M too). No key to type: your Locaith sign-in is the credential. Locaith-v5 loads two skills only for itself — **Vietnamese administrative documents per Nghị định 30/2020/NĐ-CP** (format, layout, templates, .docx export) and **memory** (it remembers your preferences and project decisions across conversations, with Bio-Memory or plain files in `.locaith/memory/`).
- **A data notice you accept once.** The first time you use Locaith-v5 the chat shows what is sent and stored: what you send to the model (questions, files and tool results the assistant reads) goes to Locaith's service, may be processed by partner AI infrastructure, and is stored (recognisable API keys, passwords and tokens masked) so Locaith can find errors and improve the model. Prefer not to share? Pick another provider with your own key — those chats never touch Locaith. Details: `docs/LOCAITH-MODELS.md`.
- **A line, with a countdown, when Locaith-v5 is busy.** When more than 100 people are using it at once, a slim strip appears above the input — *Many people are using Locaith right now — please wait · Your place: 7 · retrying in 8 s* — with a progress bar and **Cancel**. It retries by itself and the strip disappears when you are in. Nothing goes into VS Code's own notifications.
- **Many things at once, shown compactly.** A step with many tool calls collapses into one line (*89 tool calls · 1 failed*, click to expand), and each running sub-agent gets one live row — its task, what it is doing right now, and `461.4k tokens · 12 tools · 5m 18s` — instead of a wall of cards.
- **Send now.** Messages you queue while the assistant works get a **Send now** button: it stops the current step and delivers that message immediately instead of waiting for the next step.
- **`/remote` — one step to Remote.** Type `/remote` in the chat: your browser opens the Remote page on locaith.ai with a one-time pairing link and pairs by itself; you click **Allow** in VS Code once (no QR panel, no dialogs to choose from).
- **A video playbook for every model** — the built-in skill `quy-trinh-video-locaith` (Locaith's way of making any kind of video) is available to every provider and recommended by default to Locaith-v5.
- **Chrome / Edge 0.4.3** adds *Locaith AI Local* to the browser side panel (connect with a code from locaith.ai/#ext-browser) and the correct 1M window for DeepSeek.

See `CHANGELOG.md` for details.

## Install from the Marketplace

Search for **Locaith AI Agent** in VS Code Extensions, or run:

`code --install-extension LocaithAI.locaith-agent`

## Install from the VSIX

Download [`locaith-agent-0.6.0.vsix`](releases/locaith-agent-0.6.0.vsix), then choose **Extensions** → **...** → **Install from VSIX...**. From a terminal, run:

`code --install-extension releases/locaith-agent-0.6.0.vsix`

The package manifest declares VS Code engine `^1.90.0` and publisher `LocaithAI`. The Marketplace README is English-first; the package also includes a Vietnamese guide. The package is about 13 MB because it bundles 835 open-source skills.

## Chrome and Edge extension

**Locaith AI for Chrome and Edge 0.4.3** — the browser edition of the assistant (side panel, page Watcher, and the bridge that lets the VS Code assistant read and control the pages you allow) — is a separate package: [`locaith-agent-browser-0.4.3.zip`](releases/locaith-agent-browser-0.4.3.zip). It is not on a web store: unzip it into a permanent folder, open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode** and choose **Load unpacked**. To update, unzip the new version over the same folder and click **Reload**. To pair it with VS Code (Locaith AI Agent 0.5.1 or later) use **Market → Chrome**. It adds **Locaith AI Local** (Locaith-v5-flash and Locaith-v5-SI, 1M-token context): connect it with a code from `locaith.ai/#ext-browser`.

SHA-256 of `locaith-agent-browser-0.4.3.zip`:

`6A8D550EFE0B2E52669BCFF45945483E6BFE5429AE704C9BBA7C25148F3080F7`

The zip carries its own `LICENSE.txt` (Locaith Freeware License) and `THIRD_PARTY_NOTICES.md` (the third-party components of the browser bundle).

## Package integrity

SHA-256 of `locaith-agent-0.6.0.vsix`:

`D69EF92D5C20DCF0A09C709C396E7E4B82868ACF0B0F5EFE47A74C6CD77E8FB2`

All release checksums are listed in `SHA256SUMS.txt`.

## License

Locaith AI Agent is **free to use**, for personal and commercial purposes, under the **Locaith Freeware License** — see [`LICENSE`](LICENSE). In short: you may install and use it and share the unmodified package; you may not modify, reverse engineer, resell or repackage it without Locaith's written consent. The license covers every published version, including older packages whose metadata says `UNLICENSED`.

Third-party components keep their own licenses: open-source libraries and fonts are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the Market skills are covered by `market/NOTICE.md` and `market/licenses/` inside the package.

## Tiếng Việt

Đây là gói cài đặt VSIX đã biên dịch của extension `LocaithAI.locaith-agent`, phiên bản `0.6.0`. Repo này chứa các gói phát hành, không kèm source code hoặc build scripts.

Cài từ Marketplace bằng cách tìm **Locaith AI Agent** trong Extensions. Hoặc cài từ VSIX: mở **Extensions** trong VS Code → **...** → **Install from VSIX...**, rồi chọn `locaith-agent-0.6.0.vsix`.

`code --install-extension LocaithAI.locaith-agent`

**Giấy phép:** miễn phí sử dụng (cá nhân và kinh doanh) theo **Giấy phép Freeware của Locaith** (xem `LICENSE`, bản tiếng Anh là bản có hiệu lực): được cài đặt, dùng và chia sẻ gói nguyên vẹn; không được sửa đổi, dịch ngược, bán lại hay đóng gói lại khi chưa có đồng ý bằng văn bản của Locaith. Thành phần bên thứ ba giữ giấy phép riêng (`THIRD_PARTY_NOTICES.md`).

**Extension Chrome / Edge:** gói riêng `releases/locaith-agent-browser-0.4.3.zip` (SHA-256 `6A8D550EFE0B2E52669BCFF45945483E6BFE5429AE704C9BBA7C25148F3080F7`). Giải nén vào MỘT thư mục cố định, mở `chrome://extensions` (Edge: `edge://extensions`), bật **Chế độ nhà phát triển** rồi chọn **Tải tiện ích đã giải nén**. Cập nhật: giải nén bản mới đè vào cùng thư mục rồi bấm **Tải lại**. Ghép đôi với VS Code (Locaith AI Agent từ 0.5.1) ở **Chợ → Chrome**. Trong gói có sẵn `LICENSE.txt` và `THIRD_PARTY_NOTICES.md`. Bản 0.4.3 thêm nhà cung cấp **Locaith AI Local** (Locaith-v5-flash, Locaith-v5-SI, cửa sổ ngữ cảnh 1 triệu token): kết nối bằng mã lấy ở `locaith.ai/#ext-browser`.
