# Locaith account — sign-in and privacy

From **0.5.2** the extension needs a locaith.ai account. Until you sign in, the chat shows only the sign-in screen and the extension host refuses everything else
(sending messages, saving API keys, Remote, queued work). The check lives in the extension host (`ChatController`, `RemoteService`), not only in the UI.

## Why

* **Remote control** lets a browser do anything the assistant can do on your machine. Your account is the first gate: only signed-in installs can open Remote, and you can see and revoke every signed-in machine on locaith.ai. Since **0.6.5 the account is also the key**: a browser signed in to the SAME Locaith account opens your machine from locaith.ai with no pairing (the machine keeps a random key in your account's machine list that only you can read back while signed in), so anyone who can sign in to your account can control it — keep the account safe. Turn it off with `locaithAgent.remote.trustAccount`; see `docs/REMOTE-RELAY.md` §2b.
* One account across devices: the **VS Code remote** tab of locaith.ai lists «Your machines» (the VS Code windows that turned Remote on).

## How sign-in works (OAuth authorization-code + PKCE, like other developer tools)

1. **Locaith AI: Account: sign in to Locaith** (or the button in the chat) generates a random `code_verifier` and `state` on your machine and opens
   `https://locaith.ai/#ext-auth?client=vscode&challenge=<sha256(verifier)>&state=…&redirect=vscode://locaithai.locaith-agent/auth&label=<this machine>`.
   The part after `#` is never sent to the web server.
2. On locaith.ai you sign in as usual (Google, GitHub or email), see which machine is asking, and click **Allow**.
3. The browser returns to VS Code (`vscode://locaithai.locaith-agent/auth?code=…&state=…`). The extension checks `state`, then exchanges `code` + `verifier` for a **device token** (`lat_…`, 256 random bits).
   A stolen code is useless without the verifier, a code works once and for 5 minutes, and it is destroyed even by a wrong attempt.
4. The device token is kept in VS Code's **SecretStorage** (your OS keychain). Only its SHA-256 is stored on the server.
5. The token is re-checked every 30 minutes (and when the window regains focus, at most every 5 minutes). It expires after 90 idle days. **Offline?** You can keep working for up to **7 days** after the last successful check; after that, sign in again.

**Remote / SSH / WSL / web VS Code:** if the browser cannot return to VS Code, use **Account: paste sign-in code** — locaith.ai shows the code after you click Allow.

## What the server learns

| Data | Where | Why |
| --- | --- | --- |
| Account id, e-mail, display name | returned to the extension | to show who is signed in |
| Machine label (`hostname · VS Code`), OS, VS Code and extension versions (self-reported) | stored with the device | so you can recognise it in the device list |
| When the device was last seen | stored | expiry and the device list |
| Machine/workspace names + a random machine id, for every window while Remote is on (**the default once you sign in**; turn it off in Settings → Remote) | stored (account-private; removed when Remote is turned off or you sign out) | the tab «Your machines» |
| **API keys** you enter in Settings | **never sent to Locaith** | they stay in VS Code SecretStorage and go only to the provider they belong to |
| **Conversation content, files, tool output** | **not sent to Locaith — except when you choose the Locaith-v5 model** | they go only to the model provider you chose |
| **Locaith-v5 requests** (conversation content, attached files, tool output) | sent to Locaith's gateway **only after you accept the data notice**, and only while a Locaith-v5 model is selected | the model runs through Locaith's service; Locaith stores the content (recognisable API keys, passwords and tokens masked) to fix errors and improve the model, and may have it processed by AI infrastructure partners. Use another provider with your own API key to avoid it entirely |
| Your **acceptance of the data notice** (account, notice version, time, client name) | stored on Locaith's server, per account | the audit trail of who agreed to what; nothing is sent to the gateway before it exists |
| Remote-over-Internet traffic | relay (Supabase Realtime) | **end-to-end encrypted** — the relay sees ciphertext sizes and timing only |

**Locaith-v5 and your data.** The Locaith-v5 model (new in 0.6.0) is the only place where conversation content reaches Locaith: choosing it sends your requests to Locaith's own gateway, and
the extension asks you to accept a data notice first (what is sent, that it is stored with recognisable keys masked to fix errors and improve the model, that partner AI infrastructure may
process it). Your acceptance is recorded **per account on the server**, so the device token above is also what lets the gateway tell which account agreed. Withdraw it in Settings →
*Locaith model*; to avoid it entirely use another provider with your own API key. See [LOCAITH-MODELS.md](LOCAITH-MODELS.md).

## Managing and revoking

* **Sign out:** Settings → *Locaith account* → Sign out (or the command). The device token is revoked on the server.
* **Revoke any machine:** locaith.ai → *VS Code remote* → «Devices signed in to the extension». That machine is locked the next time it checks (within 30 minutes, or immediately when you return to its window).
* Deleting your Locaith account removes all of its devices.

## Developer notes

* Code: `src/core/account/{pkce,client,session,config}.ts` (no `vscode` import), `src/host/account.ts` (URI handler, status bar, commands, SecretStorage).
* Server contract: the `ext_*` RPCs in `locaith-ai-v2/supabase/migrations/20261104_extension_account_and_remote_registry.sql`; see also [REMOTE-RELAY.md](REMOTE-RELAY.md) §4.
* The server address can be overridden **only** when `ND_AGENT_TEST=1` (tests) — there is no setting or environment variable for normal users to redirect sign-in elsewhere.
* Tests: `test/account.test.ts` (PKCE vector from RFC 7636, state machine, offline grace, revocation, multi-window) and the real-VS-Code suite (`test/vscode/suite.cjs`: gate → OAuth round trip through the OS URI handler → revoke → re-login).
