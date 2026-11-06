# Locaith AI Agent

An AI coding assistant for VS Code that helps you plan and complete multi-step work in your workspace. Connect Claude, OpenAI, Gemini, DeepSeek, Grok, or an OpenAI-compatible endpoint such as OpenRouter, Ollama, LM Studio, or Groq.

## What it does

- **Works through tools:** plan tasks, inspect and edit workspace files, run terminal commands, search the web, and review results as work progresses.
- **Loads skills on demand:** bring task-specific guidance into context only when it is needed. The **Market** bundles 835 ready-made skills (open-source licences only) — click **Add** and every model can use them.
- **Orchestrates several AI providers (opt-in):** pick **Locaith Auto** and a router chooses a model per task from the API keys *you* entered, switching provider automatically when one is rate-limited or down. Off by default.
- **Runs sub-agents and workflows:** delegate searches and reviews to independent agents with their own context, or let the model write a short script that fans work out to dozens of agents — only the compact result returns to the conversation.
- **Connects MCP servers and plugins:** add external tools over the Model Context Protocol, and bundle skills, agents, commands and MCP servers as plugins (same layout as Claude Code plugins). Services and plugins show their brand logo so you can tell them apart at a glance.
- **Lets you keep typing while it works:** press Enter instead of Stop — your messages queue above the input and reach the assistant at its next step (between tool calls) or right after its reply, so it can change course without restarting. Stop moves unsent messages back to the input box.
- **Results you can see, answers you can find (new in 0.6.3):** images, GIFs, video and audio the assistant made appear right under the paragraph that mentions them — pictures inline, video and audio with a player, HTML / PDF / Office files as a card with *Open* and *Reveal in folder*. Once a turn is finished, its thinking and tool calls fold into one line (*Worked for 2m 13s · 14 actions · 3 files changed*) so the answer is not buried; click it to see every step.
- **Easier switches in the chat (new in 0.6.1):** *Bypass all prompts* is always in the permission picker (one confirmation turns it on — no Settings trip); a **Remote** switch in the header turns Remote on/off in one click; Locaith-v5 turns on **Bio-Memory** by itself; every Locaith model shows the Locaith logo in the picker; and the Chrome / Edge extension (0.4.4) connects to VS Code with a **VS Code** switch and an **Allow** card — no code to type.
- **Send now, and a compact view of parallel work (new in 0.6.0):** queued messages have a **Send now** button (stop the current step, deliver that message next); a step with many tool calls collapses into one line (*89 tool calls · 1 failed*) and every running sub-agent gets one live row with its task, current activity and `461.4k tokens · 12 tools · 5m 18s`.
- **`/remote`:** type it in the chat and the Remote page opens on locaith.ai. Since 0.6.5 it signs in to this machine through the same Locaith account — no code, no pairing, no Allow (with `locaithAgent.remote.trustAccount` off, or when the machine list cannot be reached, it falls back to a one-time pairing link where you click **Allow** once).
- **A video playbook for every model (new in 0.6.0):** the built-in skill `quy-trinh-video-locaith` — Locaith's way of making any kind of video — works with any provider and is recommended by default to Locaith-v5.
- **Connects your tools and your Chrome:** one-click MCP connections (GitHub, Notion, Sentry, Linear, Stripe, Supabase…), the official plugin market, a shared long-term memory (Bio-Memory-Locaith), and — with the Locaith extension for Chrome — reading and controlling the pages you allow in your own browser.
- **Sign in with your Locaith account (new in 0.5.2):** a locaith.ai account is required — the browser opens, you click **Allow**, you are back in VS Code. No password is typed into VS Code; the API keys you enter are never sent to Locaith, and your conversations go only to the provider you choose — **except the Locaith-v5 model** (next bullet), whose requests go to Locaith's own service after you accept a data notice (see `docs/ACCOUNT.md` and `docs/LOCAITH-MODELS.md`).
- **Locaith-v5 models, no API key needed (new in 0.6.0):** Locaith's own AI Local family — **Locaith-v5-flash** (fast) and **Locaith-v5-SI** (deep reasoning) — works with your Locaith account and has a **1-million-token context window**. Two skills are built in for it: **drafting Vietnamese administrative documents to Decree 30/2020/NĐ-CP** and **long-term memory** for the people it works with. Because these requests go to Locaith's service, the chat first shows a short **data notice** (what is sent; that it is stored — recognisable keys and passwords masked — to fix errors and improve the model; that Locaith's AI infrastructure partners may process it). Nothing leaves your machine until you accept, and any other provider with your own API key avoids it entirely. When more than 100 people are using the service, the chat shows a **queue** — your position and a live seconds countdown — instead of an error. See `docs/LOCAITH-MODELS.md`.
- **Remote control (on by default once you sign in):** watch and drive this chat from the *Remote VS Code* tab on locaith.ai — **from your phone or another computer over an end-to-end encrypted relay** (sign in to locaith.ai with the **same account** and pick the machine — **no pairing since 0.6.5**; a browser that is not signed in to your account is paired with a link/QR, a 6-digit code and your Allow), or on the same machine over 127.0.0.1 (off by default: no port is opened unless you turn it on). Live messages, tool calls and diffs, approve permissions, stop, queue messages. The machine joins the relay by itself after you sign in. **What you are trusting:** anyone who can sign in to your Locaith account can control the machines that have this on (the machine keeps a random key in your account's machine list) — keep the account safe; the first time it becomes active VS Code tells you once, a line appears in the chat whenever a browser opens a session, **Remote: paired devices → Change the account key** cuts every browser that is in, and `locaithAgent.remote.trustAccount` = false goes back to pairing each device. Turn Remote off in Settings → Remote. If the relay is overloaded the chat shows a countdown instead of an error. A browser that gets in can do anything the assistant can do on this machine (see `docs/REMOTE-RELAY.md`).
- **Swarm mode:** a reasoning level that fans work out to many sub-agents and cross-checks the result. Uses many tokens; every run asks for approval.
- **Shows live progress:** concise status summaries while it works, plus a running token count while the model is thinking.
- **Handles common project files:** attach PDF, DOCX, XLSX, HTML, CSV/TSV, Markdown, and text files for analysis.
- **Previews artifacts:** create Markdown, SVG, and HTML artifacts in the chat preview.
- **Offers permission modes:** ask before changes, plan-only, automatic workspace edits, and configurable full access. Untrusted workspaces remain read-only.

## Get started

1. In VS Code, open **Extensions**, search for **Locaith AI Agent**, and select **Install**.
2. Open the **L** icon in the Activity Bar and **sign in with your Locaith account** (a browser tab opens; click **Allow**). Until you sign in, the extension stays locked.
3. The extension starts in demo mode when no provider key is configured. To use a real provider, open Settings from the chat and add its API key, or configure a supported environment variable.
4. Choose a model and permission mode, then describe the task.

Install from a terminal with <code>code --install-extension LocaithAI.locaith-agent</code>.

## Providers

Built-in providers include Anthropic Claude, OpenAI, Google Gemini, DeepSeek, and xAI Grok. OpenAI-compatible endpoints include services such as OpenRouter, Ollama, LM Studio, and Groq. Model lists are retrieved from the configured provider.

## Market, plugins, MCP and agents

Open the store icon in the chat header (or run **Locaith AI: Open the Market (skills, plugins, MCP, agents)**):

- **Skills** — search and add packaged skills; they are copied to <code>~/.locaith/skills</code> and removed only if the Market installed them.
- **Plugins** — install from a folder or a Git URL; new plugins stay off until you enable them.
- **MCP** — servers from your user settings start automatically; servers from a workspace <code>.mcp.json</code> or a plugin run only after you switch them on. Every tool call still asks for approval.
- **Agents** — built-in <code>explore</code>, <code>plan</code>, <code>researcher</code>, <code>reviewer</code>, <code>general</code>, plus your own <code>.md</code> agents.

## Privacy and permissions

The VS Code edition stores provider keys in VS Code SecretStorage and never sends them to Locaith. Requests go to the provider you select. **The one exception is the Locaith-v5 model:** choosing it sends your requests to Locaith's own service (a gateway Locaith operates), so the extension asks you to accept a **data notice** first. What you send to Locaith-v5 is stored (recognisable API keys, passwords and tokens masked) to fix errors and improve the model, and may be processed by Locaith's AI infrastructure partners. Prefer not to share? Pick any other provider and use your own API key — none of that goes through Locaith. You can withdraw your consent in Settings → *Locaith model*. The default permission mode asks before sensitive actions, and an untrusted VS Code workspace is read-only. Review the permission mode before asking the agent to edit files or run commands.

Multi-AI orchestration is **off by default**. When you turn on *Failover* or *Auto*, or choose *Locaith Auto*, your prompts can be sent to any provider whose API key you have entered — and to the Locaith-v5 model if you accepted its data notice — and you are told whenever the router switches. Workflows run in an isolated worker and always ask for your approval; MCP servers run local programs, so enable only servers you trust.

## Language

The interface and default response language can be set to English or Vietnamese with <code>locaithAgent.language</code>. The full Vietnamese guide is included as <code>README.vi.md</code>.

## Browser edition

A companion Chrome / Microsoft Edge edition is maintained separately and is not included in this VS Code package.

## Distribution and license

Locaith AI Agent is **free to use** — personal or commercial — under the **Locaith Freeware License** (see <code>LICENSE.txt</code>). You may install it and share the unmodified package; modifying, reverse engineering, reselling or repackaging it is not permitted without Locaith's written consent. Third-party components keep their own licenses: open-source libraries and fonts are listed in <code>THIRD_PARTY_NOTICES.md</code>, and the skills bundled in the Market in <code>market/NOTICE.md</code> and <code>market/licenses/</code>. This Marketplace release is a prebuilt VSIX.
