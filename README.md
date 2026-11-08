# Locaith AI Agent for VS Code

English-first VS Code Marketplace release for `LocaithAI.locaith-agent`, version `0.7.2`.

> This repository contains prebuilt release packages and checksums. The original source tree and build scripts are maintained separately.

## What's new in 0.7.2

- **The Lo logo comes alive while you wait** — on a long wait it sweeps into a robot dog, a robot, a drone or a rocket and back (switch: `locaithAgent.ui.workingCharacters`); the "working" line now stays visible for the whole run, also while the assistant is thinking or a command runs.
- **Open files outside the workspace, HTML opens in your browser, options at the end of the conversation with an "All" chip, storage cleanup** (pictures shrunk when attached; a "Clean up storage" card in Settings).
- **Locaith CLI 0.4.0 — a full terminal app** on the same engine: `pip install locaith-cli`, then `locaith`.

See `CHANGELOG.md` for details.

## Locaith CLI

```
pip install locaith-cli      # or: pipx install locaith-cli
locaith                      # interactive session (first run: language → sign-in → trust this folder)
locaith -p "summarize this repo"   # print once, for scripts and CI
```

The same coding agent as the extension in your terminal — permission cards, checkpoints and `/rewind`, hooks, MCP, skills, sessions you can resume, custom commands, and your own key or API if you prefer — Anthropic / OpenAI / Gemini / DeepSeek / xAI, or any OpenAI-compatible address such as OpenRouter, Ollama, LM Studio, Groq (`locaith provider add`; keys are never typed on the command line). Python 3.8+; it uses your Node 20+ or a bundled one. Guide: `extension/docs/CLI.md`.

## Install from the Marketplace

Search for **Locaith AI Agent** in VS Code Extensions, or run:

`code --install-extension LocaithAI.locaith-agent`

## Install from the VSIX

Download [`locaith-agent-0.7.2.vsix`](releases/locaith-agent-0.7.2.vsix), then choose **Extensions** → **...** → **Install from VSIX...**. From a terminal, run:

`code --install-extension releases/locaith-agent-0.7.2.vsix`

The package manifest declares VS Code engine `^1.90.0` and publisher `LocaithAI`. The Marketplace README is English-first; the package also includes a Vietnamese guide. The package is about 13 MB because it bundles 835 open-source skills.

## Chrome and Edge extension

**Locaith AI for Chrome and Edge 0.4.4** — the browser edition of the assistant (side panel, page Watcher, and the bridge that lets the VS Code assistant read and control the pages you allow) — is a separate package: [`locaith-agent-browser-0.4.4.zip`](releases/locaith-agent-browser-0.4.4.zip). It is not on a web store: unzip it into a permanent folder, open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode** and choose **Load unpacked**. To update, unzip the new version over the same folder and click **Reload**. To pair it with VS Code (Locaith AI Agent 0.5.1 or later) use **Market → Chrome**. It adds **Locaith AI Local** (Locaith-v5-flash and Locaith-v5-SI, 1M-token context): connect it with a code from `locaith.ai/#ext-browser`. Version 0.4.4 adds a **VS Code** switch in the chat — connect to VS Code with one click and an **Allow** card, no pairing code (needs Locaith AI Agent 0.6.1 or later in VS Code) — and the Locaith "Lo" logo.

SHA-256 of `locaith-agent-browser-0.4.4.zip`:

`B88604383FE97E67B9FD6EAD24AA534305DA2BA68077CA03CBC478B1EEF152D2`

The zip carries its own `LICENSE.txt` (Locaith Freeware License) and `THIRD_PARTY_NOTICES.md` (the third-party components of the browser bundle).

**Chrome Web Store edition (0.7.2).** A second Chrome/Edge build shares its chat interface with the VS Code extension (same compact timeline):[`locaith-agent-browser-0.7.2.zip`](releases/locaith-agent-browser-0.7.2.zip), built from `extension/src/browser` by `npm run package:browser` and submitted to the Chrome Web Store as “Locaith AI — Trợ lý trình duyệt”. It does **not** (yet) include the page Watcher, the VS Code bridge or the Locaith AI Local models of the 0.4.4 package above. SHA-256: `B26DD826ADE2B636F82509D0651154990DF5C4422F84FFDC76ABEC7F6C6A45A7`. See `extension/docs/CHROME-STORE.md`.

## Package integrity

SHA-256 of `locaith-agent-0.7.2.vsix`:

`971A71F4449B643EC4A82B8291AD82F293F73798703A3CFA9258C41C193F68AC`

All release checksums are listed in `SHA256SUMS.txt`.

## License

Locaith AI Agent is **free to use**, for personal and commercial purposes, under the **Locaith Freeware License** — see [`LICENSE`](LICENSE). In short: you may install and use it and share the unmodified package; you may not modify, reverse engineer, resell or repackage it without Locaith's written consent. The license covers every published version, including older packages whose metadata says `UNLICENSED`.

Third-party components keep their own licenses: open-source libraries and fonts are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the Market skills are covered by `market/NOTICE.md` and `market/licenses/` inside the package.

## Tiếng Việt

Đây là gói cài đặt VSIX đã biên dịch của extension `LocaithAI.locaith-agent`, phiên bản `0.7.2`. Repo này chứa các gói phát hành, không kèm source code hoặc build scripts.

Cài từ Marketplace bằng cách tìm **Locaith AI Agent** trong Extensions. Hoặc cài từ VSIX: mở **Extensions** trong VS Code → **...** → **Install from VSIX...**, rồi chọn `locaith-agent-0.7.2.vsix`.

`code --install-extension LocaithAI.locaith-agent`

**Locaith CLI:** `pip install locaith-cli` rồi gõ `locaith` — cùng trợ lý như extension nhưng ngay trong terminal (thẻ xin quyền, rewind, hooks, MCP, kỹ năng, mở lại phiên cũ…). `locaith -p "việc"` cho script/CI. Hướng dẫn: `extension/docs/CLI.md`.

**Giấy phép:** miễn phí sử dụng (cá nhân và kinh doanh) theo **Giấy phép Freeware của Locaith** (xem `LICENSE`, bản tiếng Anh là bản có hiệu lực): được cài đặt, dùng và chia sẻ gói nguyên vẹn; không được sửa đổi, dịch ngược, bán lại hay đóng gói lại khi chưa có đồng ý bằng văn bản của Locaith. Thành phần bên thứ ba giữ giấy phép riêng (`THIRD_PARTY_NOTICES.md`).

**Extension Chrome / Edge:** gói riêng `releases/locaith-agent-browser-0.4.4.zip` (SHA-256 `B88604383FE97E67B9FD6EAD24AA534305DA2BA68077CA03CBC478B1EEF152D2`). Giải nén vào MỘT thư mục cố định, mở `chrome://extensions` (Edge: `edge://extensions`), bật **Chế độ nhà phát triển** rồi chọn **Tải tiện ích đã giải nén**. Cập nhật: giải nén bản mới đè vào cùng thư mục rồi bấm **Tải lại**. Ghép đôi với VS Code (Locaith AI Agent từ 0.5.1) ở **Chợ → Chrome**. Trong gói có sẵn `LICENSE.txt` và `THIRD_PARTY_NOTICES.md`. Bản 0.4.3 thêm nhà cung cấp **Locaith AI Local** (Locaith-v5-flash, Locaith-v5-SI, cửa sổ ngữ cảnh 1 triệu token): kết nối bằng mã lấy ở `locaith.ai/#ext-browser`.

**Bản Chrome Web Store (0.7.2):** gói thứ hai dùng chung giao diện với extension VS Code, dựng từ `extension/src/browser` bằng `npm run package:browser` và nộp lên Chrome Web Store với tên «Locaith AI — Trợ lý trình duyệt»: `releases/locaith-agent-browser-0.7.2.zip` (SHA-256 `B26DD826ADE2B636F82509D0651154990DF5C4422F84FFDC76ABEC7F6C6A45A7`). Bản này CHƯA có «Theo dõi tin nhắn», cầu nối VS Code và mô hình Locaith AI Local của gói 0.4.4 ở trên. Xem `extension/docs/CHROME-STORE.md`.
