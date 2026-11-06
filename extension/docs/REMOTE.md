# Remote — controlling the VS Code chat from a web page

Introduced in 0.5.2. **On by default — but only while you are signed in to your Locaith account** (see [ACCOUNT.md](ACCOUNT.md)). Signing in is enough for the machine to join the end-to-end encrypted relay; it changes nothing else: until you pair a device, nobody can see or control anything, and every pairing needs your explicit **Allow** in VS Code. The local 127.0.0.1 path (`remote.local`) stays **off** unless you turn it on, so no port is opened by default. Turn Remote off with the switch in Settings → Remote (or `locaithAgent.remote.enabled`); the machine then leaves the relay and the account registry. If the relay is overloaded the chat shows a queue with a countdown (see `REMOTE-RELAY.md`).
Source: `src/core/remote/{protocol,sanitize,server,relayHost,relayClient,e2e,phoenix}.ts` (no `vscode` import) and `src/host/{remote,remoteQr}.ts` (wiring to `ChatController`).

## What it is

A paired web page — the **Remote VS Code** tab of locaith.ai, or any client that speaks the protocol — receives the same live view the VS Code chat gets and can send a narrow set of commands back.
There are **two paths to the same hub** (same event stream, same command allow-list, same rate limits, same device list):

| Path | Reach | How it works | Setting |
| --- | --- | --- | --- |
| **Internet** | phone, another computer, anywhere | an **end-to-end encrypted** session through a Supabase Realtime relay; pair by scanning a **QR code** (or opening a link), compare a 6-digit code, click **Allow** in VS Code. Full spec: [REMOTE-RELAY.md](REMOTE-RELAY.md). | `remote.cloud` (default on) |
| **This machine** | the same computer only | an HTTP server bound to `127.0.0.1` (ports 47630–47639, first free); no network involved. | `remote.local` (default on) |

Turn it on with **Locaith AI: Remote: pair a new device** (it asks first, then sets `locaithAgent.remote.enabled`) and choose the path.
*Internet* pairing: a QR/link carrying a one-time 128-bit secret (5 minutes, single use) **plus** an «Allow» dialog in VS Code that shows a 6-digit confirmation code which must equal the one in the browser.
*This machine* pairing: a one-time 8-character code (5 minutes, destroyed after 5 wrong tries) or the link `<webUrl>/#remote?host=<url>&code=<code>` (host and code live in the URL fragment, so they never reach a web server).

## Threat model

A paired device **can do anything the assistant can do on this machine** (read/edit files, run commands — under whatever permission mode is active). So:

| Layer | Rule |
| --- | --- |
| Network (local path) | Listens on 127.0.0.1 only. Exposure beyond the machine over this path is your own HTTPS tunnel (`remote.publicUrl`). |
| Network (Internet path) | Outbound WebSocket only (no port opened). The relay is **untrusted**: it sees channel name, message sizes/timing and your machine id, never content. See [REMOTE-RELAY.md](REMOTE-RELAY.md) §1 for what is and is not protected. |
| Account | Remote does not start unless you are signed in; sign-out, revocation or expiry closes it at once. |
| Host header | Only loopback names (+ the host of `remote.publicUrl`) — blocks DNS rebinding. |
| Origin | Exact match against `remote.allowedOrigins` (+ the origin of `remote.webUrl`). Any other Origin gets 403 on **every** path, including `/v1/hello`. |
| Pairing | One-time code, 5 min, 5 tries. Token = 256 random bits (`lr_…`), returned once; only its SHA-256 is stored (SecretStorage, shared by all windows). |
| Auth | `Authorization: Bearer`, constant-time comparison; `>30` bad attempts/min → 429 (valid tokens are never locked out). |
| Expiry / revoke | Idle devices expire after `remote.idleDays` (30). Revoking closes that device's streams immediately. Max 10 devices, 5 streams per device. |
| Commands | Allow-list only: `send, stop, retry, compact, new_session, load_session, rename_session, queue_remove, set_model, set_mode, set_thinking, permission_response, get_image`. Everything else (delete history, API keys, MCP, plugins, open files, slash commands, backups) is refused. Every field is validated; 3 MB body cap; 120 commands/min/device. |
| Bypass | `set_mode: bypass` is refused unless both `agent.allowBypassPermissions` **and** `remote.allowBypass` are on. |
| Settings | All `locaithAgent.remote.*` are machine-scoped and read from user settings only — a repository's `.vscode/settings.json` cannot switch Remote on or add an origin. |
| Data | Snapshots exclude settings, API keys, skills, trash, editor context, raw images and uploaded-file text; tool output/arguments/diffs are truncated. |
| Visibility | Commands from a remote device show a toast in the VS Code chat; the status bar shows *Remote · n* while connected. |

Stored in the browser: the local-path token (and the Internet-path device key) live in the page's browser storage, so anyone who can run script on that page can use them until you revoke the device. Pair only browsers you trust.

## Protocol v1

All JSON; `GET /v1/hello` and `POST /v1/pair` need no token.

| Request | Response |
| --- | --- |
| `GET /v1/hello` | `{ app:"locaith-agent-remote", v, name, workspace?, vscode, ext, platform, pairing, paired }` |
| `POST /v1/pair` `{ code, label }` | 200 `{ token, deviceId, host }` · 401 `bad_code` (+`triesLeft`) · 409 `no_pairing` |
| `GET /v1/state` | `{ seq, state }` |
| `GET /v1/stream?since=<seq>&epoch=<e>` | Server-sent events. First frame: `snapshot` (or `resume` + the missed frames when `since`/`epoch` still match). Then `events` (same `UiEvent`s as the VS Code webview), `patch`, `toast`, `image`, `bye`. `: hb` every 15 s. |
| `POST /v1/cmd` `{ type, … }` | `{ ok:true }` — long commands (`send`, `retry`, `compact`) return at once; progress arrives on the stream. |
| `POST /v1/unpair` | revokes the calling device |

Every stream frame carries `seq`; a snapshot carries the server `epoch`. A client that reconnects with its last `seq` and `epoch` gets only what it missed; otherwise a fresh snapshot. Snapshots are taken after flushing pending events, so a client joining mid-answer never applies a delta twice.

`RemoteState` is a trimmed `ViewState` (see `protocol.ts`). The web client applies `events` with a copy of `shared/transcript.ts`'s reducer (kept identical; verified step-by-step against the original).

## Not included yet

Push notifications, voice, file attachments other than images, and several simultaneous conversations (the page mirrors the sidebar chat). One relay "host" is one VS Code window (stable per workspace folder); a second window needs its own pairing.
