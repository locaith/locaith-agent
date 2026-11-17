# Locaith-v5 models (AI Local) in VS Code and in Chrome / Edge

From **0.6.0** the extension has a model family of its own, **AI Local**: **Locaith-v5-flash** (fast) and **Locaith-v5-SI** (deep reasoning). They work with your Locaith
account — **no API key** — and have a **1-million-token context window**. A new user with no API key starts on `Locaith-v5-flash`; if you already use another provider your
choice is left alone.

**Allowances, the way Anthropic meters Claude (from 17/11/2026).** A **paid plan** (Plus, Pro, Ultra — bought inside locaith.ai) has an allowance per **5-hour session** and per **week**:
a window starts with your first message after the previous one ended, and when either allowance is used up the model waits until THAT window renews (the weekly one first, because it is the longer
wait). A **free account** has a small **one-time credit of free tokens** — enough for a couple of short requests — that never refills; after it, only a plan helps (or any other model with your
own API key). Allowances follow the real use of the model (a long cached agent loop is cheap, one huge uncached prompt is not) and are shown as **percentages and renewal times, never as money**.
The locaith.ai web chat has its own credits and is not affected. Your usage is in **Settings → Locaith model**; `locaith whoami` prints it in the CLI.

**Chrome / Edge (from 0.7.10).** The browser edition has the same two models and the same rules (data notice, queue, allowances, Upgrade / Buy a plan button) — see [In the Chrome / Edge edition](#in-the-chrome--edge-edition) below. The difference: signing in is **optional** there; with your own API key nothing goes to Locaith.

This page is what *you* see and what happens to your data. The service-side contract (headers, error codes, queue protocol, logging) is in
`locaith-ai-v2/docs/LOCAITH-MODELS.md`; account sign-in is in [ACCOUNT.md](ACCOUNT.md).

## What you see

| Where | What |
| --- | --- |
| Model picker (and *Locaith AI: Select model*) | a **Locaith AI Local** group at the top with `Locaith-v5-flash` and `Locaith-v5-SI` (1M tokens). While the data notice is not accepted the group carries a *Data notice not accepted* badge |
| First time you use it | a **data notice card at the end of the conversation** (not a VS Code pop-up). Your message goes back into the input box; nothing is sent until you press **Agree and use** |
| When the service is full | a slim amber strip above the input — **queue**, see below |
| When the service says no | a normal error notice in the service's own words (daily quota, too many requests, maintenance…) |
| When an allowance is used up | an error notice in the service's words — which plan, which window, **how long until it renews**, where to get more — with an **Upgrade** button (**Buy a plan** for a free account) that opens `https://locaith.ai/#upgrade` (the *Plans* tab of your account; it asks you to sign in first if needed). On the top plan there is no button: there is nothing above it |
| Usage | Settings → *Locaith model* shows a bar per allowance (5-hour session and week, or the free tokens), the percentage used and when each renews. It refreshes when you open Settings and after each answer from a Locaith model |
| Settings → *Locaith model* | status of your consent, the notice text, **Withdraw consent**. The Locaith model has no key field because your account is the credential |

## Your data — read this once

* The API keys you enter in Settings are **never sent to Locaith**; they stay in VS Code SecretStorage and go only to the provider they belong to.
* Every other provider works exactly as before: your conversation goes **only to the provider you chose**.
* **The one exception is Locaith-v5.** Choosing it sends what you type, the files and code you attach or let the assistant read, and tool results to **Locaith's own service**. Locaith
  **stores that content** (recognisable API keys, passwords and tokens are masked first) **to fix errors and improve the model**, and the processing may be carried out by Locaith's
  AI infrastructure partners.
* The data notice says exactly that, and you must accept it **before the first request**. The extension never sends a byte to the Locaith gateway until you do — even a background
  summary or a context compaction is blocked at the provider level (`guard`), not just in the UI.
* **Consent is recorded per account on Locaith's server** (account, notice version, time, client name). Accepting once covers all your machines; a machine that has not asked yet
  checks the server and skips the card. The local copy is only a cache keyed by (account, notice version).
* If Locaith changes the notice it bumps the **notice version** and everyone is asked again (the card reappears on the next request). A test pins the notice text to its version, so the text
  cannot change without the number changing.
* **Withdraw** (Settings → *Locaith model*) turns Locaith-v5 off on this machine until you agree again. The earlier record stays on the server as an audit trail; to have stored content
  deleted, contact Locaith support.
* **Don't want to share?** Pick any other provider and use your own API key — none of that goes through Locaith. *Use my own API* on the card does exactly that.
* Remote control (the locaith.ai tab) **cannot** accept the notice for you: consent is a local action in VS Code.
* If you turn on multi-AI orchestration (*Failover* / *Auto*, or the *Locaith Auto* model), Locaith-v5 joins the pool **only after you accepted the notice**; before that no
  router can pick it. Orchestration is off by default.

## The queue

Locaith-v5 serves at most **100 people at once** (counted per account, not per window). When more are using it:

* the request is **not** an error. The chat shows *“Đang có nhiều lượt sử dụng, vui lòng chờ xử lý.”* / *“Many people are using Locaith right now — please wait.”*, **your real position**
  in the line, a **live seconds countdown** to the next automatic try, and a thin progress bar;
* the extension retries by itself with the ticket the service gave it (the service also keeps your place by account), as often as needed — it does **not** count against the normal
  retry limit — and the strip disappears the moment you are let in, before the first token;
* **Cancel** (or Esc / Stop) leaves the line at once and tells the service so;
* nothing goes to VS Code's notification area or status bar;
* the position is the service's honest number (1 = next); there is no estimated waiting time because there is no way to promise one;
* while you wait, other providers and the rest of the chat keep working.

## When the service answers with an error

The service writes the message in Vietnamese; the extension shows it **verbatim**, never replaced by a generic “rate limited, try in a few minutes”:

| Service code | What happens |
| --- | --- |
| `locaith_quota` (daily spend cap, or the service's own balance used up) | shown as is — “come back tomorrow” — the turn stops, **never retried** (the reset may be hours away). In *Failover* mode another provider you configured can take over |
| `locaith_quota` with HTTP **429** and an `entitlement` block (`state: "limit_session"` or `"limit_week"`) — a **paid plan used up its 5-hour or weekly allowance** | the service's message is shown as is (plan, window, wait, moment, where to upgrade) with an **Upgrade** button; the turn stops, **never retried** (`Retry-After` is the time to the end of that window — up to days). Settings → *Locaith model* is refreshed at once. On Ultra there is no button. English shows the extension's own sentence built from the block |
| `locaith_quota` with HTTP **402** and `state: "free_exhausted"` — a **free account used up its one-time free tokens** (or the service has no free credit and requires a plan) | message as is + a **Buy a plan** button; **never retried** and no wait time: it does not refill. The link is only honoured when it is `https` on a Locaith domain, otherwise the standard `https://locaith.ai/#upgrade` is used. Older extensions show the same message as text (clients ≤ 0.7.8 show a **Buy a plan** button on any 402) |
| `locaith_rate_limited` | retried automatically **only if** the service says to wait ≤ 60 s; otherwise the message is shown and the turn stops |
| `locaith_unavailable` (maintenance) | retried **once** after a few seconds, then the service's message |
| `locaith_unauthorized` (401) | your device token was rejected: the token is flagged bad, the extension refreshes it **exactly once** (re-reads the store, then asks the account service) and resends the request **exactly once**; a second 401 stops the turn, locks the session ("Sign in again") and never loops. Parallel 401s cause one refresh. It never tells you to enter an API key |
| `locaith_model_not_found` | the message is shown; pick another model |
| `locaith_consent_required` (403) | the data-notice card reopens (the record on the server is missing or older than the current notice); after you agree press **Retry** |

## Long context

`Locaith-v5-*` report a 1,000,000-token window and up to 393,216 output tokens; the context meter under the input uses it. The same fix applies to the **DeepSeek** presets, which were shown
as 128K by mistake (the 128K default is still used for models whose size is unknown). Automatic compaction still starts at 80 % of the window, so on 1M it is rare.

## Skills and memory for Locaith-v5

Two skills exist **only for this model** (`providers: [locaith]` in their `SKILL.md`; other providers cannot even see them in the catalog, and `load_skill` says they do not exist):

* `soan-thao-van-ban-nd30` — drafting, editing and reviewing Vietnamese administrative documents to **Decree 30/2020/NĐ-CP** (layout, fonts, margins, document number, date, signature,
  recipients, capitalisation, Word export);
* `ghi-nho-memory` — long-term memory when serving you in VS Code: when to `recall`, what to remember and what never to, saving with Bio-Memory (`store_memory`) or a `.locaith/memory` file
  fallback, how to correct and forget.

**Bio-Memory is the default memory for Locaith-v5 (0.6.1).** The first time the model is used the extension installs Bio-Memory-Locaith into its own Python environment (`~/.locaith/bio-memory`; your system Python is
untouched) and turns it on, with a status strip in the chat; if it cannot (no Python 3.10+, no network) the strip says why and offers **Retry** / **Don't ask again**, and the model falls back to a `.locaith/memory`
file. Nearing the context limit (compaction at 80 % of the window) the extension saves a summary into Bio-Memory *before* compacting, and the model is told to `recall` rather than guess afterwards.

A short always-on note in the system prompt (≤ 700 tokens, `src/core/prompts/locaith.addendum.md`, added only when the session uses `locaith`) tells the model when to load each. For every
other provider the system prompt stays byte-for-byte what it was, so their prompt caches are untouched.

## Using it in your own build / testing against a dev gateway

* Provider id `locaith` (label *Locaith AI Local*), `openai-chat` with the DeepSeek flavour (thinking, `reasoning_content`, tool calls pass through the gateway unchanged).
* The gateway address is `https://studio-api.locaith.com/api/llm/v1`; override it with the user setting `locaithAgent.baseUrls` → `{ "locaith": "http://127.0.0.1:8671/api/llm/v1" }`.
* Headers on every request: `X-Locaith-Client: vscode/<version>` (or `browser/…`, `cli/…`), `X-Locaith-Device: <16-hex one-way hash of the device id>`, `X-Locaith-Session: <16-hex one-way hash of the chat session id>` (see docs/GATEWAY-LOGGING.md), `X-Locaith-Queue: ticket` (ask for the 429 + ticket protocol and a countdown instead of
  a held-open request), `X-Locaith-Ticket` while queued. There is **no** consent header: consent is the server-side per-account record (`GET/POST /consent`).
* The browser edition (`src/browser`, shares `src/core`) registers this provider from 0.7.10 — see [In the Chrome / Edge edition](#in-the-chrome--edge-edition). The separate 0.4.x browser package integrates through data only (see the
  service-side doc, section 8b).
* Code: `src/core/providers/locaithGateway.ts` (constants, error classification, consent client), `src/host/locaith.ts` (consent cache + bridge), `src/core/providers/{http,openaiChat,registry,presets}.ts`
  (queue, headers, guard, account credential), `src/core/engine/engine.ts` (`onQueue`, `onConsentRequired`, `onAccountInvalid`), webview `ModelQueue.tsx`, `LocaithConsent.tsx`, `styles/locaith.css`.
* Tests: `test/locaithGateway.test.ts`, `test/providers/locaith.test.ts`, `test/locaithConsent.test.ts`, `test/engineLocaith.test.ts`, `test/orchestrationLocaith.test.ts`,
  `test/skillsLocaith.test.ts`, `test/promptLocaith.test.ts`, `test/privacyCopy.test.ts`, `test/webview/locaithStyles.test.ts`; UI scenarios `locaith-*` in `webview/dev` (`node webview/dev/shoot.mjs locaith`).
* **Changing the data notice?** Edit the `locaith.notice.*` strings, bump `LOCAITH_NOTICE_VERSION` (and the gateway's `LOCAITH_LLM_NOTICE_VERSION`), then add the new hash to `APPROVED` in
  `test/webview/locaithStyles.test.ts`. The test is red until you do.

## In the Chrome / Edge edition

From **0.7.10** the Chrome / Edge extension (`src/browser`) has the Locaith models too. It reuses the same core (provider, gateway client, queue, allowances, data-notice record) and adds what a browser needs:

| | VS Code | Chrome / Edge |
| --- | --- | --- |
| Signing in | required for the whole extension (browser opens, **Allow**, back to VS Code) | **optional** — only to use the Locaith models; your own API keys never need it |
| How | OAuth + PKCE, `vscode://` redirect | a **connection code**: Settings → *Locaith account (optional)* → **Get connection code** opens `https://locaith.ai/#ext-browser` (sign in, read the data notice, **Create connection code**) → paste the code → **Connect** |
| Where the token lives | VS Code SecretStorage | `chrome.storage.local` of the extension — **not encrypted**, the same as API keys (the browser has no OS-bound secret store); revoked by **Sign out** or on locaith.ai → Devices |
| Verification | `ext_auth_whoami` every 30 min | the same RPC when you paste the code, every 30 min, and when you return to the panel (at most every 5 min); 7 days offline grace |
| Data notice | a card in the chat | the same card, worded for web pages ("the content of the web pages and files you let the assistant read or attach"); the server record is per account and notice version, so accepting on the locaith.ai page counts too |
| Header | `X-Locaith-Client: vscode/<ver>` | `X-Locaith-Client: browser/<ver>` (+ the one-way device and session hashes, `X-Locaith-Queue: ticket`) |

* **Nothing leaves the browser before consent.** Not signed in → no request to the gateway; signed in but the data notice not accepted → the provider's guard refuses before any byte is sent; a code pasted into the chat box is caught before it is sent to a model (it would be exposed to the provider).
* **Host permission:** the existing `https://studio-api.locaith.com/*` (it also receives the one-tap rating). The account service (Supabase RPC) answers CORS for any origin, so no other host permission is added. `scripts/verify-browser-package.mjs` checks that the gateway host is in `host_permissions`, that the consent screen says the Locaith models are optional and what is stored, and that the connection-code hint says "not encrypted".
* **Not in the browser edition:** Bio-Memory, the Locaith-only skills (ND30, memory, video) and the VS Code bridge / message Watcher of the 0.4.x package.
* Code: `src/browser/account.ts` (`BrowserAccount`, `extractDeviceToken`, `kvMemento`), `src/browser/controller.ts` (account / consent / queue / usage), `src/browser/panel.tsx` (wiring), webview `AccountGate.tsx` (`AccountConnectCard`), `LocaithConsent.tsx`, `Pickers.tsx`, `Welcome.tsx`. Tests: `test/browser/account.test.ts`, `test/browser/locaith.test.ts` (real HTTP against the mock account server and gateway), `test/browser-e2e/locaith.e2e.test.ts` (real Chrome and Edge), UI scenes `browser-account-*` / `browser-welcome*` / `browser-consent` in `webview/dev`.
