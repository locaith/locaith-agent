# Locaith AI Agent for VS Code

English-first VS Code Marketplace release for `LocaithAI.locaith-agent`, version `0.5.1`.

> This repository contains prebuilt release packages and checksums. The original source tree and build scripts are maintained separately.

## What's new in 0.5.1

- **Send while the assistant works** — type and press Enter instead of Stop; messages queue and reach the assistant at its next step. (0.5.0 as first published did not include this.)
- **Complete history** — conversations from other workspace folders are listed, and conversations that lost displayed turns are rebuilt from the model history when opened (the original is kept as `.healbak.json`).
- **Images** — click a pasted or sent image to view it full size.
- **Connections and memory** — one-click MCP connections (OAuth sign-in), GitHub through your VS Code account, the official plugin market, and **Bio-Memory-Locaith**, a long-term memory shared by every conversation.
- **Swarm** reasoning level for fan-out work across many sub-agents (opt-in, asks for approval, uses many tokens).
- **Chrome bridge** — with the Locaith extension for Chrome 0.4.2, read and control the pages you allow in your own browser.
- **License** — now the Locaith Freeware License (free to use, share the unmodified package), with third-party notices included.

See `CHANGELOG.md` for details.

## Install from the Marketplace

Search for **Locaith AI Agent** in VS Code Extensions, or run:

`code --install-extension LocaithAI.locaith-agent`

## Install from the VSIX

Download [`locaith-agent-0.5.1.vsix`](releases/locaith-agent-0.5.1.vsix), then choose **Extensions** → **...** → **Install from VSIX...**. From a terminal, run:

`code --install-extension releases/locaith-agent-0.5.1.vsix`

The package manifest declares VS Code engine `^1.90.0` and publisher `LocaithAI`. The Marketplace README is English-first; the package also includes a Vietnamese guide. The package is about 13 MB because it bundles 835 open-source skills.

## Chrome and Edge extension

**Locaith AI for Chrome and Edge 0.4.2** — the browser edition of the assistant (side panel, page Watcher, and the bridge that lets the VS Code assistant read and control the pages you allow) — is a separate package: [`locaith-agent-browser-0.4.2.zip`](releases/locaith-agent-browser-0.4.2.zip). It is not on a web store: unzip it into a permanent folder, open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode** and choose **Load unpacked**. To update, unzip the new version over the same folder and click **Reload**. To pair it with VS Code (Locaith AI Agent 0.5.1 or later) use **Market → Chrome**.

SHA-256 of `locaith-agent-browser-0.4.2.zip`:

`F0EC45ACC2E8BCBFED25BEE0F624D50A8491623084D7CA2DC0A5BE7F69A8BBB1`

The zip carries its own `LICENSE.txt` (Locaith Freeware License) and `THIRD_PARTY_NOTICES.md` (the third-party components of the browser bundle).

## Package integrity

SHA-256 of `locaith-agent-0.5.1.vsix`:

`306681AA2D97E8A5A3DFBAA358B877CC21315BE2D991E7E72B6C05B92526B2DA`

All release checksums are listed in `SHA256SUMS.txt`.

## License

Locaith AI Agent is **free to use**, for personal and commercial purposes, under the **Locaith Freeware License** — see [`LICENSE`](LICENSE). In short: you may install and use it and share the unmodified package; you may not modify, reverse engineer, resell or repackage it without Locaith's written consent. The license covers every published version, including older packages whose metadata says `UNLICENSED`.

Third-party components keep their own licenses: open-source libraries and fonts are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the Market skills are covered by `market/NOTICE.md` and `market/licenses/` inside the package.

## Tiếng Việt

Đây là gói cài đặt VSIX đã biên dịch của extension `LocaithAI.locaith-agent`, phiên bản `0.5.1`. Repo này chứa các gói phát hành, không kèm source code hoặc build scripts.

Cài từ Marketplace bằng cách tìm **Locaith AI Agent** trong Extensions. Hoặc cài từ VSIX: mở **Extensions** trong VS Code → **...** → **Install from VSIX...**, rồi chọn `locaith-agent-0.5.1.vsix`.

`code --install-extension LocaithAI.locaith-agent`

**Giấy phép:** miễn phí sử dụng (cá nhân và kinh doanh) theo **Giấy phép Freeware của Locaith** (xem `LICENSE`, bản tiếng Anh là bản có hiệu lực): được cài đặt, dùng và chia sẻ gói nguyên vẹn; không được sửa đổi, dịch ngược, bán lại hay đóng gói lại khi chưa có đồng ý bằng văn bản của Locaith. Thành phần bên thứ ba giữ giấy phép riêng (`THIRD_PARTY_NOTICES.md`).

**Extension Chrome / Edge:** gói riêng `releases/locaith-agent-browser-0.4.2.zip` (SHA-256 `F0EC45ACC2E8BCBFED25BEE0F624D50A8491623084D7CA2DC0A5BE7F69A8BBB1`). Giải nén vào MỘT thư mục cố định, mở `chrome://extensions` (Edge: `edge://extensions`), bật **Chế độ nhà phát triển** rồi chọn **Tải tiện ích đã giải nén**. Cập nhật: giải nén bản mới đè vào cùng thư mục rồi bấm **Tải lại**. Ghép đôi với VS Code (Locaith AI Agent từ 0.5.1) ở **Chợ → Chrome**. Trong gói có sẵn `LICENSE.txt` và `THIRD_PARTY_NOTICES.md`.
