# Locaith AI Agent for VS Code

English-first VS Code Marketplace release for `LocaithAI.locaith-agent`, version `0.5.0`.

> This repository contains prebuilt release packages and checksums. The original source tree and build scripts are maintained separately.

## What's new in 0.5.0

- **Multi-AI orchestration (opt-in):** pick **Locaith Auto** or turn on *Failover* / *Auto* in Settings. A router chooses a model per task from the API keys you entered and switches provider on rate limits or outages. Off by default.
- **Sub-agents and workflows:** independent agents with their own context, and short model-written scripts that fan work out to up to 1,000 agents while only the compact result returns to the chat.
- **MCP servers and plugins:** external tools over the Model Context Protocol; plugins bundle skills, agents, commands and MCP servers.
- **Market:** 835 bundled open-source skills (MIT / Apache-2.0 / MPL-2.0; notices included), an MCP library, plugins and agents. This is why the package is about 12.7 MB.
- **Send while the assistant works:** keep typing — messages queue above the input and reach the assistant at its next step instead of being rejected.
- **UI:** animated Locaith logo, live thinking-token counter, and a layout that adapts from narrow sidebars to wide editor tabs.

See `CHANGELOG.md` for details.

## Install from the Marketplace

Search for **Locaith AI Agent** in VS Code Extensions, or run:

`code --install-extension LocaithAI.locaith-agent`

## Install from the VSIX

Download [`locaith-agent-0.5.0.vsix`](releases/locaith-agent-0.5.0.vsix), then choose **Extensions** → **...** → **Install from VSIX...**. From a terminal, run:

`code --install-extension releases/locaith-agent-0.5.0.vsix`

The package manifest declares VS Code engine `^1.90.0` and publisher `LocaithAI`. The Marketplace README is English-first; the package also includes a Vietnamese guide.

## Package integrity

SHA-256:

`A947DE42483EC5F7DEF2294A0B52FA6A9213BB7A857B779C1013C545BE875B0C`

All release checksums are listed in `SHA256SUMS.txt`.

## License

The bundled package metadata declares `UNLICENSED`. No separate license file is included in this release. Third-party skills bundled in the Market keep their original open-source licences; see `market/NOTICE.md` and `market/licenses/` inside the package.

## Tiếng Việt

Đây là gói cài đặt VSIX đã biên dịch của extension `LocaithAI.locaith-agent`, phiên bản `0.5.0`. Repo này chứa các gói phát hành, không kèm source code hoặc build scripts.

Điểm mới: điều phối nhiều AI theo các khoá API bạn đã nhập (mặc định tắt), agent con và workflow, MCP và plugin, Chợ 835 kỹ năng đóng gói sẵn, bộ đếm token khi suy nghĩ, logo Locaith chuyển động và giao diện co giãn theo bề rộng khung.

Cài từ Marketplace bằng cách tìm **Locaith AI Agent** trong Extensions. Hoặc cài từ VSIX bằng cách mở **Extensions** trong VS Code → **...** → **Install from VSIX...**, rồi chọn `locaith-agent-0.5.0.vsix`.

`code --install-extension LocaithAI.locaith-agent`
