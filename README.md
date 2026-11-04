# Locaith AI Agent for VS Code

English-first VS Code Marketplace release for `LocaithAI.locaith-agent`, version `0.6.1`.

> This repository contains prebuilt release packages and checksums. The original source tree and build scripts are maintained separately.

## What's new in 0.6.1

- **"Bypass all prompts" is in the mode list from the first run.** No more hunting for a setting: the permission picker always lists it, and choosing it for the first time opens ONE confirmation in the chat (what it does, plus an optional "remember for new conversations" box, off by default) and turns it on. While it is on, a reminder strip sits above the input.
- **The Locaith logo on every Locaith model.** The model picker used to show a letter for *Locaith AI Local*; it now shows the Locaith "Lo" mark — next to the input, in the list and in Settings — and so does the Chrome / Edge side panel.
- **Remote is one click, in the chat.** A **Remote** switch with a status dot (grey off · amber connecting · green online) sits in the chat header. Turn it on, open locaith.ai → *Remote VS Code* on the same account, and this machine is there; no code, and each pairing still needs your **Allow**.
- **Chrome connects without a code.** Turn on the **VS Code** switch in the Chrome extension's chat (Chrome / Edge **0.4.4**) and VS Code shows an **Allow / Deny** card in its chat; click Allow and they are connected. Turning the switch off and on again reconnects instantly. The local bridge (127.0.0.1, browser extensions only) is now open by default so Chrome can ask; switch it off with `locaithAgent.chrome.bridge` = false (pairing with a code in Market → Chrome still works).
- **Locaith-v5 uses Bio-Memory by default.** The first time Locaith-v5 is used, Bio-Memory-Locaith is installed into its own Python environment and turned on (a status strip shows progress; if it cannot, it says why and offers **Retry** / **Don't ask again**). With the 1M window nearly full a summary is saved into Bio-Memory before compacting, and the model `recall`s instead of guessing.
- **Market: the tab bar no longer overlaps the list** when you scroll — the tabs are a fixed band and only the list below them scrolls.
- **The video playbook no longer carries any customer or partner name.**
- **Chrome / Edge 0.4.4** adds the Locaith "Lo" logo (header, welcome screen, model picker, busy indicator) and the **VS Code** switch.

See `CHANGELOG.md` for details.

## Install from the Marketplace

Search for **Locaith AI Agent** in VS Code Extensions, or run:

`code --install-extension LocaithAI.locaith-agent`

## Install from the VSIX

Download [`locaith-agent-0.6.1.vsix`](releases/locaith-agent-0.6.1.vsix), then choose **Extensions** → **...** → **Install from VSIX...**. From a terminal, run:

`code --install-extension releases/locaith-agent-0.6.1.vsix`

The package manifest declares VS Code engine `^1.90.0` and publisher `LocaithAI`. The Marketplace README is English-first; the package also includes a Vietnamese guide. The package is about 13 MB because it bundles 835 open-source skills.

## Chrome and Edge extension

**Locaith AI for Chrome and Edge 0.4.4** — the browser edition of the assistant (side panel, page Watcher, and the bridge that lets the VS Code assistant read and control the pages you allow) — is a separate package: [`locaith-agent-browser-0.4.4.zip`](releases/locaith-agent-browser-0.4.4.zip). It is not on a web store: unzip it into a permanent folder, open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode** and choose **Load unpacked**. To update, unzip the new version over the same folder and click **Reload**. To pair it with VS Code (Locaith AI Agent 0.5.1 or later) use **Market → Chrome**. It adds **Locaith AI Local** (Locaith-v5-flash and Locaith-v5-SI, 1M-token context): connect it with a code from `locaith.ai/#ext-browser`. Version 0.4.4 adds a **VS Code** switch in the chat — connect to VS Code with one click and an **Allow** card, no pairing code (needs Locaith AI Agent 0.6.1 or later in VS Code) — and the Locaith "Lo" logo.

SHA-256 of `locaith-agent-browser-0.4.4.zip`:

`B88604383FE97E67B9FD6EAD24AA534305DA2BA68077CA03CBC478B1EEF152D2`

The zip carries its own `LICENSE.txt` (Locaith Freeware License) and `THIRD_PARTY_NOTICES.md` (the third-party components of the browser bundle).

## Package integrity

SHA-256 of `locaith-agent-0.6.1.vsix`:

`3DBAE9E6E4E0F9CF2967B43C50A682E25B8682C91FB15E4FA239DFDFB536675E`

All release checksums are listed in `SHA256SUMS.txt`.

## License

Locaith AI Agent is **free to use**, for personal and commercial purposes, under the **Locaith Freeware License** — see [`LICENSE`](LICENSE). In short: you may install and use it and share the unmodified package; you may not modify, reverse engineer, resell or repackage it without Locaith's written consent. The license covers every published version, including older packages whose metadata says `UNLICENSED`.

Third-party components keep their own licenses: open-source libraries and fonts are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the Market skills are covered by `market/NOTICE.md` and `market/licenses/` inside the package.

## Tiếng Việt

Đây là gói cài đặt VSIX đã biên dịch của extension `LocaithAI.locaith-agent`, phiên bản `0.6.1`. Repo này chứa các gói phát hành, không kèm source code hoặc build scripts.

Cài từ Marketplace bằng cách tìm **Locaith AI Agent** trong Extensions. Hoặc cài từ VSIX: mở **Extensions** trong VS Code → **...** → **Install from VSIX...**, rồi chọn `locaith-agent-0.6.1.vsix`.

`code --install-extension LocaithAI.locaith-agent`

**Giấy phép:** miễn phí sử dụng (cá nhân và kinh doanh) theo **Giấy phép Freeware của Locaith** (xem `LICENSE`, bản tiếng Anh là bản có hiệu lực): được cài đặt, dùng và chia sẻ gói nguyên vẹn; không được sửa đổi, dịch ngược, bán lại hay đóng gói lại khi chưa có đồng ý bằng văn bản của Locaith. Thành phần bên thứ ba giữ giấy phép riêng (`THIRD_PARTY_NOTICES.md`).

**Extension Chrome / Edge:** gói riêng `releases/locaith-agent-browser-0.4.4.zip` (SHA-256 `B88604383FE97E67B9FD6EAD24AA534305DA2BA68077CA03CBC478B1EEF152D2`). Giải nén vào MỘT thư mục cố định, mở `chrome://extensions` (Edge: `edge://extensions`), bật **Chế độ nhà phát triển** rồi chọn **Tải tiện ích đã giải nén**. Cập nhật: giải nén bản mới đè vào cùng thư mục rồi bấm **Tải lại**. Ghép đôi với VS Code (Locaith AI Agent từ 0.5.1) ở **Chợ → Chrome**. Trong gói có sẵn `LICENSE.txt` và `THIRD_PARTY_NOTICES.md`. Bản 0.4.3 thêm nhà cung cấp **Locaith AI Local** (Locaith-v5-flash, Locaith-v5-SI, cửa sổ ngữ cảnh 1 triệu token): kết nối bằng mã lấy ở `locaith.ai/#ext-browser`.
