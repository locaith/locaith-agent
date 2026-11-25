# Locaith AI Agent for VS Code

English-first VS Code Marketplace release for `LocaithAI.locaith-agent`, version `0.7.21`.

> This repository contains the **source code** of Locaith AI Agent — the VS Code extension, the Chrome / Edge edition and the `locaith-cli` terminal app — together with the prebuilt release packages and their checksums. The source is published under the [Functional Source License](LICENSE) (FSL-1.1-ALv2); see [License](#license).

## What's new in 0.7.21

- **Chrome / Edge: the connection texts say where page content goes after the app.** Settings → Connect to desktop apps and the “Connect this browser” window said content goes to the app on this computer and “not to a Locaith server” — true of the extension, but the app may send it on (Locaith Work using a Locaith model sends it to Locaith). Both now say what the window that asks before each page already said: the extension sends content only to that app, and from the app it goes to the AI provider chosen there, which may be a Locaith model.
- Nothing else changes: the connection, its checks and the contract for other hosts are those of 0.7.20. The Chrome / Edge package `locaith-agent-browser-0.7.21.zip` replaces 0.7.20 for the Chrome Web Store (0.7.20 was not submitted). Details: `CHANGELOG.md`.

### Also in 0.7.20

- **Connect your browser from the app.** Market → Chrome now has **Connect this browser**: your default browser opens a one-time link served on this computer (127.0.0.1), the Locaith AI extension shows one small window naming the app, and one click on **Connect** pairs it — no code to type, no card to click in the app. If that browser has no extension 0.7.20 or newer, the page and the Chrome tab say so, with a Chrome Web Store link. The desktop Locaith Work app can use the same pairing.
- **One pairing per app in the Chrome / Edge extension** (VS Code, Locaith Work): pairing one no longer replaces the other, and when one app stops accepting the browser only that one is disconnected. In the extension the switch is now **Settings → Connect to desktop apps** (was “Connect to VS Code”), with one row per app.
- Only pages served from `127.0.0.1` / `localhost` can hand the extension a ticket (`externally_connectable`, a new manifest key — not a permission), and only when you click **Connect**. The old way to pair still works, and older VS Code versions keep working with the new extension.
- **The Chrome / Edge package became 0.7.20**; it goes to the Chrome Web Store as 0.7.21 (see above). Until it is published, the store build (0.7.17) cannot receive the link.

### Also in 0.7.19

- **Installing or updating Bio-Memory works again.** The install button downloaded the source from the `main` branch of the public `bio-memory-ai-locaith` repository, which since 22 November 2026 only holds the README and the licence (Bio-Memory 0.11 ships as a compiled release), so every new install or update failed. The installer now pins the source to a fixed commit (Bio-Agent OS 0.8.2rc1 with its `mcp` extra). Existing installs were not affected. Details: `CHANGELOG.md`.

### Also in 0.7.18

- **The VS Code side now really stops the 0.7.12 browser build from leaking.** 0.7.17 only closed the connection for requests that carried the extension's `Origin`, but Chrome and Edge send no `Origin` on GET requests from an extension, so the old build's ping and poll still received 401 replies and kept leaking (measured after a reboot: 3.9 GB in one extension process of a profile still running 0.7.12). The bridge now recognises browser requests by `Origin` or `Sec-Fetch-*`; an old-style GET with an unknown token is held without an answer and then closed, so the old build gets no reply to leak and Chrome stops its worker — which also lets the pending 0.7.17 browser update install.
- **Correction:** the 0.7.17 notes said the 0.7.12 build left no unread reply against the new VS Code; that was measured with a test client that sent `Origin` on GET, which real Chrome does not. Tests now use the headers Chrome sends, and a real Chrome + Edge test checks the old-style request from the extension's own service worker.
- The Chrome / Edge package stays 0.7.17. Details: `CHANGELOG.md`.

### Also in 0.7.17

- **Chrome / Edge: the VS Code connection no longer leaks memory.** When VS Code refused the browser's pairing token (paired with another profile or browser since, or the pairing was removed), 0.7.12–0.7.16 asked again every 7 seconds forever and never read the error replies; Chrome keeps a 2 MB block for each unread reply (measured on a real machine: 2.7 GB in one extension process). Every reply is now read or cancelled, a refused token stops the connection and Settings says how to pair again, and nothing polls while VS Code is closed.
- **The VS Code side protects the 0.7.12 browser build already in the Chrome Web Store:** for a token it does not know, the bridge closes the connection instead of answering 401, so the old build has no reply to leak. *(0.7.17 missed GET requests, which carry no Origin — fixed in 0.7.18.)*
- Details and measurements: `CHANGELOG.md`.

### Also in 0.7.12

- **Chrome / Edge: the VS Code connection is back.** The Chrome Web Store builds 0.6.27–0.7.11 had lost the link to the VS Code extension that the 0.4.x package had (it only ever existed as a patch on a built bundle). It is now real source code with tests: **Settings → Connect to VS Code** (or right-click the toolbar icon → **Connect to VS Code…**) lets the assistant in VS Code read and control the pages you allow in your own browser. **Off by default**, talks only to VS Code on this computer (127.0.0.1, nothing to a Locaith server), pairs with an **Allow / Deny** card in VS Code (no code to type), and asks you in the browser before acting on each page (**Allow this time** / **Always allow this site** / **Deny**). Needs the 0.7.12 VS Code extension on the other side.
- **Pairing fix on the VS Code side.** Chrome sends no `Origin` header on GET requests from an extension, which the pairing endpoint needed — so no-code pairing could never finish with a real Chrome. `/v1/pair/status` now also answers `POST`, with the same rules.
- **Enter in a form field really submits** (the bridge's type-and-press-Enter), unless the page handles the key itself.
- **New permissions in the Chrome / Edge package:** `alarms` and an optional `tabs` (asked only when you turn the connection on).

### Also in 0.7.11

- **Chrome / Edge: the welcome screen now really invites a new user to connect a Locaith account.** 0.7.10 added the card (*Use the Locaith models — no API key needed*, with a **Connect a Locaith account** button) but showed it only when no provider had a key — and the demo mode, which needs no key, always counts as one that has, so on a real install the card never appeared (Settings and the model picker were the only ways in). It now shows whenever you have no API key of your own and are not connected, above the suggested questions; with your own key, or once connected, it is not shown. The pages the checks used left the demo mode out, which is why 0.7.10's checks missed it; they include it now, and a test on real Chrome and Edge starts from a fresh profile and covers the card, its button and **Cancel**.
- **The welcome screen opens at the top.** With the card it is taller than a short side panel (logo, the card, the suggested questions, the page-access card) and used to open scrolled to the bottom — the same scroll-to-the-end that follows a running conversation — which hid the title and the top of the card on the very first screen. It now starts at the top, in the browser edition and in VS Code alike; a conversation still follows its newest message.

### Also in 0.7.10

- **The Locaith-v5 models are in the Chrome / Edge edition.** Locaith-v5-flash and Locaith-v5-SI (1-million-token context, no API key) are now in the model picker of the browser extension — the Chrome Web Store build shipped without them. Signing in is **optional**: with your own API key nothing changes and nothing goes to Locaith. To use the Locaith models open **Settings → Locaith account (optional)**, click **Get connection code** (locaith.ai opens; sign in, read the data notice, create the code), paste the code and click **Connect**. The code is kept in the extension's own storage on this device (not encrypted, like API keys) and is revoked by **Sign out** or on locaith.ai → Devices; a code pasted into the chat box by mistake is never sent to a model.
- **The same rules as VS Code.** A data notice in the chat (worded for web pages) before the first Locaith message — nothing leaves the browser until you accept; a live queue position when many people are using the models; the 5-hour and weekly allowances (or the free tokens) with the server's message and an **Upgrade** / **Buy a plan** button, and your usage as percentages and renewal times in Settings.
- **Fix (also VS Code).** Opening Settings now reads your Locaith usage again (0.7.9 said it did, but it only refreshed after an answer, on sign-in or at a limit).

### Also in 0.7.9

- Locaith-v5 is metered the way Anthropic meters Claude (VS Code and CLI): a **5-hour session** and a **weekly** allowance per plan (Plus, Pro, Ultra), a small **one-time free-token credit** for free accounts, usage bars in Settings and an **Upgrade** / **Buy a plan** button when a limit is hit — it replaced 0.7.8's one free day.

### Also in 0.7.8

- The opening phase of Locaith-v5 — every locaith.ai account free and unlimited — ended, and a limit message gained the **Buy a plan** button that 0.7.9 keeps. (0.7.8 gave each account a single free day; 0.7.9 replaced that with the allowances above.)

### Also in 0.7.7

- **Swarm has no ceiling any more** — up to 1,000 agents per run, no token budget unless you set one, no 10-minute cut-off, and a script that crashes keeps the reports of the agents that had already finished. The "Agents in this turn" panel is rebuilt like Claude Code's: one row per agent with what it is doing, phases, filters and a progress bar.
- **Long sessions cost much less** — for 1M-token models compaction now waits until 400k and clears old tool results down to ~93 % of that (instead of re-clearing on every turn at the threshold, which threw the prompt cache away), and old images are trimmed in batches. Replayed on the 8 longest recorded sessions: −75 % of the estimated tokens that missed the cache, with the same amount of old context kept.
- **A much bigger MCP catalog (110 entries) and plugin market (501 plugins, 11 sources)** — Google Workspace (Forms, Sheets, Docs, Drive, Apps Script), Microsoft 365, Atlassian, GitLab, cloud, CRM, search and more; a server that needs your key asks for it on **Connect** and keeps it encrypted. Plugin sources now include `anthropics/skills` (Word, Excel, PowerPoint, PDF), Microsoft, AWS Labs and clearly labelled community sources.
- **Fixes** — a long link no longer makes text overlap in the Chrome edition; cancelling a queued message (×) puts it back in the prompt box instead of discarding it.
### Locaith CLI and licence

- **Locaith CLI 0.4.11** — deleting Vietnamese text with Backspace removes one letter at a time again (a Backspace re-sent by the input method as `0x08` is no longer “delete the word”; decomposed-accent input methods that send several Backspaces per letter no longer eat the letters before it). `pip install -U locaith-cli`.
- **Locaith CLI 0.4.10** — Vietnamese typing no longer loses letters with Vietkey/UniKey/EVKey-style input methods in Windows Terminal, VS Code and the old console (Backspace sent as `0x08`, decomposed accents), and `locaith keytest` records what your input method sends so a bug can be reported with data; since 0.4.9, signing in from another machine shows a copyable link and a paste box instead of hanging; the same engine changes as above. `pip install -U locaith-cli`.
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

Download [`locaith-agent-0.7.21.vsix`](releases/locaith-agent-0.7.21.vsix), then choose **Extensions** → **...** → **Install from VSIX...**. From a terminal, run:

`code --install-extension releases/locaith-agent-0.7.21.vsix`

The package manifest declares VS Code engine `^1.90.0` and publisher `LocaithAI`. The Marketplace README is English-first; the package also includes a Vietnamese guide. The package is about 13 MB because it bundles 835 open-source skills.

## Chrome and Edge extension

**Locaith AI for Chrome and Edge 0.4.4** — the browser edition of the assistant (side panel, page Watcher, and the bridge that lets the VS Code assistant read and control the pages you allow) — is a separate package: [`locaith-agent-browser-0.4.4.zip`](releases/locaith-agent-browser-0.4.4.zip). It is not on a web store: unzip it into a permanent folder, open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode** and choose **Load unpacked**. To update, unzip the new version over the same folder and click **Reload**. To pair it with VS Code (Locaith AI Agent 0.5.1 or later) use **Market → Chrome**. It adds **Locaith AI Local** (Locaith-v5-flash and Locaith-v5-SI, 1M-token context): connect it with a code from `locaith.ai/#ext-browser`. Version 0.4.4 adds a **VS Code** switch in the chat — connect to VS Code with one click and an **Allow** card, no pairing code (needs Locaith AI Agent 0.6.1 or later in VS Code) — and the Locaith "Lo" logo.

SHA-256 of `locaith-agent-browser-0.4.4.zip`:

`B88604383FE97E67B9FD6EAD24AA534305DA2BA68077CA03CBC478B1EEF152D2`

The zip carries its own `LICENSE.txt` (Locaith Freeware License) and `THIRD_PARTY_NOTICES.md` (the third-party components of the browser bundle).

**Chrome Web Store edition (0.7.21).** A second Chrome/Edge build shares its chat interface with the VS Code extension (same compact timeline): [`locaith-agent-browser-0.7.21.zip`](releases/locaith-agent-browser-0.7.21.zip), built from `extension/src/browser` by `npm run package:browser` and submitted to the Chrome Web Store as “Locaith AI — Trợ lý trình duyệt”. From 0.7.10 it includes the **Locaith AI Local models** (Locaith-v5-flash / SI) through an optional Locaith account — a connection code from locaith.ai, no API key; from 0.7.12 it has the **VS Code bridge** again (from 0.7.17 without the memory leak of 0.7.12–0.7.16; from 0.7.20 **Settings → Connect to desktop apps**, one pairing per app — VS Code, Locaith Work — and pairing started from the app with **Connect this browser**); it does **not** (yet) include the page Watcher of the 0.4.4 package above. From 0.7.6 the zip carries its own `LICENSE.txt` (FSL-1.1-ALv2) and `THIRD_PARTY_NOTICES.md` (earlier 0.7.x zips did not). SHA-256: `0ADF4AD056B3B9B15ADD313E72830F740B8473AC243BA1E5D17EFFF9454F6AF2`. See `extension/docs/CHROME-STORE.md`.

## Package integrity

SHA-256 of `locaith-agent-0.7.21.vsix`:

`5BAF6DB086371B45775477C3B01B61DEFF9235A8E82C3DDC2D1BACA5E825FEC8`

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

Repo này chứa **mã nguồn** của Locaith AI Agent (extension VS Code `LocaithAI.locaith-agent`, bản Chrome / Edge và ứng dụng terminal `locaith-cli`) cùng các gói phát hành đã biên dịch (VSIX phiên bản `0.7.21`). Mã nguồn công khai theo giấy phép FSL-1.1-ALv2 (xem mục Giấy phép bên dưới). Cách dựng và chạy kiểm thử: mục «Source code» ở trên; đóng góp: `CONTRIBUTING.md`; báo lỗ hổng bảo mật: `SECURITY.md`.

Cài từ Marketplace bằng cách tìm **Locaith AI Agent** trong Extensions. Hoặc cài từ VSIX: mở **Extensions** trong VS Code → **...** → **Install from VSIX...**, rồi chọn `locaith-agent-0.7.21.vsix`.

`code --install-extension LocaithAI.locaith-agent`

**Locaith CLI:** `pip install locaith-cli` rồi gõ `locaith` — cùng trợ lý như extension nhưng ngay trong terminal (thẻ xin quyền, rewind, hooks, MCP, kỹ năng, mở lại phiên cũ…). `locaith -p "việc"` cho script/CI. Hướng dẫn: `extension/docs/CLI.md`.

**Giấy phép:** mã nguồn trong kho này và mọi phiên bản phát hành sau extension 0.7.4 / locaith-cli 0.4.3 theo **Functional Source License 1.1 (FSL-1.1-ALv2)** — xem `LICENSE` (bản tiếng Anh là bản có hiệu lực). Tóm tắt: được dùng, sao chép, sửa đổi và chia sẻ cho mọi mục đích TRỪ «Competing Use» — tức đem phần mềm cho người khác dùng trong một sản phẩm hay dịch vụ thương mại thay thế, hoặc có chức năng giống hệt hay gần giống phần mềm này. Dùng nội bộ, giáo dục và nghiên cứu phi thương mại, dịch vụ chuyên môn cho người đã có giấy phép được cho phép rõ ràng. Hai năm sau khi mỗi phiên bản được phát hành, bản đó còn dùng được theo Apache License 2.0. Các gói đã phát hành tới hết extension 0.7.4 và locaith-cli 0.4.3 (thư mục `releases/`) giữ **Giấy phép Freeware của Locaith** — xem `LICENSE-FREEWARE.txt`. Tên và logo Locaith không nằm trong giấy phép. Thành phần bên thứ ba giữ giấy phép riêng (`THIRD_PARTY_NOTICES.md`).

**Extension Chrome / Edge:** gói riêng `releases/locaith-agent-browser-0.4.4.zip` (SHA-256 `B88604383FE97E67B9FD6EAD24AA534305DA2BA68077CA03CBC478B1EEF152D2`). Giải nén vào MỘT thư mục cố định, mở `chrome://extensions` (Edge: `edge://extensions`), bật **Chế độ nhà phát triển** rồi chọn **Tải tiện ích đã giải nén**. Cập nhật: giải nén bản mới đè vào cùng thư mục rồi bấm **Tải lại**. Ghép đôi với VS Code (Locaith AI Agent từ 0.5.1) ở **Chợ → Chrome**. Trong gói có sẵn `LICENSE.txt` và `THIRD_PARTY_NOTICES.md`. Bản 0.4.3 thêm nhà cung cấp **Locaith AI Local** (Locaith-v5-flash, Locaith-v5-SI, cửa sổ ngữ cảnh 1 triệu token): kết nối bằng mã lấy ở `locaith.ai/#ext-browser`.

**Bản Chrome Web Store (0.7.21):** gói thứ hai dùng chung giao diện với extension VS Code, dựng từ `extension/src/browser` bằng `npm run package:browser` và nộp lên Chrome Web Store với tên «Locaith AI — Trợ lý trình duyệt»: `releases/locaith-agent-browser-0.7.21.zip` (SHA-256 `0ADF4AD056B3B9B15ADD313E72830F740B8473AC243BA1E5D17EFFF9454F6AF2`). Từ 0.7.10 (màn chào mời kết nối từ 0.7.11) bản này CÓ mô hình Locaith AI Local (Locaith-v5-flash / SI) qua tài khoản Locaith tuỳ chọn — «mã kết nối» lấy ở locaith.ai, không cần API key; từ 0.7.12 CÓ lại cầu nối VS Code (tắt mặc định, chỉ nói chuyện với ứng dụng trên máy này; từ 0.7.17 hết lỗi rò bộ nhớ của 0.7.12–0.7.16; từ 0.7.20 là **Cài đặt → Kết nối với ứng dụng trên máy**, mỗi ứng dụng một ghép đôi — VS Code, Locaith Work — và ghép được ngay từ ứng dụng bằng nút **Kết nối trình duyệt này**); CHƯA có «Theo dõi tin nhắn» của gói 0.4.4 ở trên. Từ 0.7.6 trong gói có sẵn `LICENSE.txt` (FSL-1.1-ALv2) và `THIRD_PARTY_NOTICES.md` (các gói 0.7.x trước thiếu hai tệp này). Xem `extension/docs/CHROME-STORE.md`.
