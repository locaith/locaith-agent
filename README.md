# Locaith AI Agent for VS Code

English-first VS Code Marketplace release for `LocaithAI.locaith-agent`, version `0.7.6`.

> This repository contains the **source code** of Locaith AI Agent — the VS Code extension, the Chrome / Edge edition and the `locaith-cli` terminal app — together with the prebuilt release packages and their checksums. The source is published under the [Functional Source License](LICENSE) (FSL-1.1-ALv2); see [License](#license).

## What's new in 0.7.6

- **Approval cards show everything that will run** — a project's MCP server is shown with its whole command (arguments quoted, hidden characters exposed), working folder, environment variable names and header names, and the terminal's command card wraps and shows the whole command; nothing is cut without saying how much.
- **The Chrome / Edge package carries its licence** — `LICENSE.txt` and `THIRD_PARTY_NOTICES.md` are inside the zip (versions 0.7.0 – 0.7.5 shipped without them).
- **Locaith CLI 0.4.7** — reopening a saved session needs no id: **`/sessions`** or **`/resume`** open a picker (↑↓, type to filter by title, Enter), **`locaith -r`** opens the same picker from the command line, and `/resume 2` · `locaith -r "login"` pick by number or by a word of the title. Since 0.4.6 pasting an image works in Windows Terminal (**`Alt+V`** or **`/paste`**). `pip install -U locaith-cli`.
- GitHub **private vulnerability reporting** is on (**Security → Report a vulnerability**, next to the e-mail address in `SECURITY.md`).
- Since 0.7.5 the **source code is public under the Functional Source License (FSL-1.1-ALv2)** — free to use, copy, modify and share except in a competing commercial product; each version also becomes Apache-2.0 two years after release. Versions up to 0.7.4 keep the Locaith Freeware License. See [License](#license) and `CONTRIBUTING.md`.

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

Download [`locaith-agent-0.7.6.vsix`](releases/locaith-agent-0.7.6.vsix), then choose **Extensions** → **...** → **Install from VSIX...**. From a terminal, run:

`code --install-extension releases/locaith-agent-0.7.6.vsix`

The package manifest declares VS Code engine `^1.90.0` and publisher `LocaithAI`. The Marketplace README is English-first; the package also includes a Vietnamese guide. The package is about 13 MB because it bundles 835 open-source skills.

## Chrome and Edge extension

**Locaith AI for Chrome and Edge 0.4.4** — the browser edition of the assistant (side panel, page Watcher, and the bridge that lets the VS Code assistant read and control the pages you allow) — is a separate package: [`locaith-agent-browser-0.4.4.zip`](releases/locaith-agent-browser-0.4.4.zip). It is not on a web store: unzip it into a permanent folder, open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode** and choose **Load unpacked**. To update, unzip the new version over the same folder and click **Reload**. To pair it with VS Code (Locaith AI Agent 0.5.1 or later) use **Market → Chrome**. It adds **Locaith AI Local** (Locaith-v5-flash and Locaith-v5-SI, 1M-token context): connect it with a code from `locaith.ai/#ext-browser`. Version 0.4.4 adds a **VS Code** switch in the chat — connect to VS Code with one click and an **Allow** card, no pairing code (needs Locaith AI Agent 0.6.1 or later in VS Code) — and the Locaith "Lo" logo.

SHA-256 of `locaith-agent-browser-0.4.4.zip`:

`B88604383FE97E67B9FD6EAD24AA534305DA2BA68077CA03CBC478B1EEF152D2`

The zip carries its own `LICENSE.txt` (Locaith Freeware License) and `THIRD_PARTY_NOTICES.md` (the third-party components of the browser bundle).

**Chrome Web Store edition (0.7.6).** A second Chrome/Edge build shares its chat interface with the VS Code extension (same compact timeline): [`locaith-agent-browser-0.7.6.zip`](releases/locaith-agent-browser-0.7.6.zip), built from `extension/src/browser` by `npm run package:browser` and submitted to the Chrome Web Store as “Locaith AI — Trợ lý trình duyệt”. It does **not** (yet) include the page Watcher, the VS Code bridge or the Locaith AI Local models of the 0.4.4 package above. From 0.7.6 the zip carries its own `LICENSE.txt` (FSL-1.1-ALv2) and `THIRD_PARTY_NOTICES.md` (earlier 0.7.x zips did not). SHA-256: `1FE64F5A33EDF38213A320F5D0789BB16A585F24CF9FBF978831F981AFCD56E1`. See `extension/docs/CHROME-STORE.md`.

## Package integrity

SHA-256 of `locaith-agent-0.7.6.vsix`:

`A4FAC7B4B9DEE476E6F1126BBA66EE2D696EDA8CE203D1FD6CA9B7A46A9119CE`

All release checksums are listed in `SHA256SUMS.txt`.

## Source code

| Path | What it is |
|---|---|
| `extension/` | the VS Code extension and the shared agent engine (TypeScript): `src/core` engine and model providers, `src/host` VS Code host, `webview/` chat UI |
| `extension/src/browser/` | the Chrome / Edge edition |
| `extension/src/cli/` | the terminal app (`locaith-cli`) |
| `packages/locaith-cli-py/` | the PyPI package that ships the terminal app |
| `releases/` | prebuilt packages of earlier versions (checksums in `SHA256SUMS.txt`) |

Build and test (Node 20 or later):

```
cd extension
npm ci
npm run typecheck
npm test
npm run build:cli      # writes dist-cli/locaith.cjs, the terminal app
```

The Market skills inside the release packages are generated by `extension/scripts/build-market.mjs` from a separate skills collection and are not stored in this repository. To propose a change see [`CONTRIBUTING.md`](CONTRIBUTING.md); to report a vulnerability see [`SECURITY.md`](SECURITY.md).

## License

The source code in this repository, and every version published after Locaith AI Agent 0.7.4 and locaith-cli 0.4.3, are licensed under the **Functional Source License, Version 1.1, ALv2 Future License** ([FSL-1.1-ALv2](LICENSE)). In short:

- You may use, copy, modify and share it for any purpose **except a Competing Use** — making the software available to others in a commercial product or service that substitutes for it or offers the same or substantially similar functionality.
- Internal use, non-commercial education and research, and professional services you provide to someone who is licensed to use the software are explicitly allowed.
- Two years after each version is published, that version can also be used under the **Apache License 2.0**.
- Keep the license text and copyright notices with anything you share. The Locaith name and logos are not licensed.

This is a summary; the license text governs. Packages published up to and including Locaith AI Agent 0.7.4 and locaith-cli 0.4.3 (the files in `releases/`, and what the Marketplace and PyPI serve today) stay under the **Locaith Freeware License** — see [`LICENSE-FREEWARE.txt`](LICENSE-FREEWARE.txt).

Third-party components keep their own licenses: open-source libraries and fonts are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) (the Chrome / Edge package has its own list, generated from its bundle: [`extension/THIRD_PARTY_NOTICES.browser.md`](extension/THIRD_PARTY_NOTICES.browser.md)); the Market skills are covered by `market/NOTICE.md` and `market/licenses/` inside the package.

## Tiếng Việt

Repo này chứa **mã nguồn** của Locaith AI Agent (extension VS Code `LocaithAI.locaith-agent`, bản Chrome / Edge và ứng dụng terminal `locaith-cli`) cùng các gói phát hành đã biên dịch (VSIX phiên bản `0.7.6`). Mã nguồn công khai theo giấy phép FSL-1.1-ALv2 (xem mục Giấy phép bên dưới). Cách dựng và chạy kiểm thử: mục «Source code» ở trên; đóng góp: `CONTRIBUTING.md`; báo lỗ hổng bảo mật: `SECURITY.md`.

Cài từ Marketplace bằng cách tìm **Locaith AI Agent** trong Extensions. Hoặc cài từ VSIX: mở **Extensions** trong VS Code → **...** → **Install from VSIX...**, rồi chọn `locaith-agent-0.7.6.vsix`.

`code --install-extension LocaithAI.locaith-agent`

**Locaith CLI:** `pip install locaith-cli` rồi gõ `locaith` — cùng trợ lý như extension nhưng ngay trong terminal (thẻ xin quyền, rewind, hooks, MCP, kỹ năng, mở lại phiên cũ…). `locaith -p "việc"` cho script/CI. Hướng dẫn: `extension/docs/CLI.md`.

**Giấy phép:** mã nguồn trong kho này và mọi phiên bản phát hành sau extension 0.7.4 / locaith-cli 0.4.3 theo **Functional Source License 1.1 (FSL-1.1-ALv2)** — xem `LICENSE` (bản tiếng Anh là bản có hiệu lực). Tóm tắt: được dùng, sao chép, sửa đổi và chia sẻ cho mọi mục đích TRỪ «Competing Use» — tức đem phần mềm cho người khác dùng trong một sản phẩm hay dịch vụ thương mại thay thế, hoặc có chức năng giống hệt hay gần giống phần mềm này. Dùng nội bộ, giáo dục và nghiên cứu phi thương mại, dịch vụ chuyên môn cho người đã có giấy phép được cho phép rõ ràng. Hai năm sau khi mỗi phiên bản được phát hành, bản đó còn dùng được theo Apache License 2.0. Các gói đã phát hành tới hết extension 0.7.4 và locaith-cli 0.4.3 (thư mục `releases/`) giữ **Giấy phép Freeware của Locaith** — xem `LICENSE-FREEWARE.txt`. Tên và logo Locaith không nằm trong giấy phép. Thành phần bên thứ ba giữ giấy phép riêng (`THIRD_PARTY_NOTICES.md`).

**Extension Chrome / Edge:** gói riêng `releases/locaith-agent-browser-0.4.4.zip` (SHA-256 `B88604383FE97E67B9FD6EAD24AA534305DA2BA68077CA03CBC478B1EEF152D2`). Giải nén vào MỘT thư mục cố định, mở `chrome://extensions` (Edge: `edge://extensions`), bật **Chế độ nhà phát triển** rồi chọn **Tải tiện ích đã giải nén**. Cập nhật: giải nén bản mới đè vào cùng thư mục rồi bấm **Tải lại**. Ghép đôi với VS Code (Locaith AI Agent từ 0.5.1) ở **Chợ → Chrome**. Trong gói có sẵn `LICENSE.txt` và `THIRD_PARTY_NOTICES.md`. Bản 0.4.3 thêm nhà cung cấp **Locaith AI Local** (Locaith-v5-flash, Locaith-v5-SI, cửa sổ ngữ cảnh 1 triệu token): kết nối bằng mã lấy ở `locaith.ai/#ext-browser`.

**Bản Chrome Web Store (0.7.6):** gói thứ hai dùng chung giao diện với extension VS Code, dựng từ `extension/src/browser` bằng `npm run package:browser` và nộp lên Chrome Web Store với tên «Locaith AI — Trợ lý trình duyệt»: `releases/locaith-agent-browser-0.7.6.zip` (SHA-256 `1FE64F5A33EDF38213A320F5D0789BB16A585F24CF9FBF978831F981AFCD56E1`). Bản này CHƯA có «Theo dõi tin nhắn», cầu nối VS Code và mô hình Locaith AI Local của gói 0.4.4 ở trên. Từ 0.7.6 trong gói có sẵn `LICENSE.txt` (FSL-1.1-ALv2) và `THIRD_PARTY_NOTICES.md` (các gói 0.7.x trước thiếu hai tệp này). Xem `extension/docs/CHROME-STORE.md`.
