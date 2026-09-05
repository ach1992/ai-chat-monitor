# AI Chat Monitor Privacy Policy

Last updated: September 5, 2026

AI Chat Monitor is a Chromium extension whose single purpose is to monitor user-selected ChatGPT Web conversations and notify the user about response completion, attention states, semantic work state, and platform/runtime conditions. It is read-only with respect to ChatGPT: it does not write to the ChatGPT composer, activate ChatGPT conversation controls, or create conversation turns.

AI Chat Monitor does not operate a developer-owned backend, analytics service, advertising service, or data broker.

## Data processed locally

To monitor a selected ChatGPT conversation, the extension may read and process locally:

- the supported ChatGPT page URL/route and conversation identity;
- the latest relevant user and assistant text needed for bounded semantic classification;
- response fingerprints, DOM message identity, generation state, visible blocker/action state, and related monitoring metadata;
- the optional terminal `AI_CHAT_MONITOR_STATUS={...}` marker;
- a bounded rolling in-memory tail of the current user-initiated ChatGPT response stream, used only to recognize the optional terminal status marker or the stream `data: [DONE]` terminator;
- local monitoring policy, notification preferences, provider configuration, Telegram configuration, and bounded diagnostics/history.

Chat content is treated as untrusted input.

## What is stored

Trusted extension storage may contain:

- per-chat monitoring ON/OFF policy and notification preferences;
- optional provider profiles, including API credentials;
- optional Telegram bot token/destination and sanitized delivery health;
- bounded monitoring-event metadata needed for deduplication and diagnostics;
- bounded runtime/cache identity used to avoid duplicate classification or notifications;

Monitoring history does **not** intentionally store full ChatGPT transcripts or credentials. Provider credentials and Telegram bot tokens are not rendered back in ordinary Side Panel status output after saving.

Legacy automatic-send/write-journal authority is not restored or migrated into current monitoring authority.

## Read-only ChatGPT response-stream observation

For a trusted user-initiated Send on a supported ChatGPT page whose conversation monitoring is enabled, a packaged MAIN-world observer delegates the page's original fetch call unchanged. When that exact request returns a ChatGPT conversation `text/event-stream` response, the observer consumes only a cloned copy of the stream while the original response continues unchanged to ChatGPT.

The observer is disabled for unmonitored conversations. When enabled, it keeps at most a bounded rolling tail in page memory (currently 16 KiB, with only the final 4 KiB used for terminal-marker matching). It uses that transient tail only to detect either:

- a canonical `AI_CHAT_MONITOR_STATUS={...}` terminal decision; or
- `data: [DONE]` when no terminal decision was found.

The rolling stream tail is not written to extension storage, monitoring history, logs, Telegram, or a developer-owned service. The observer does not inspect request bodies, cookies, Authorization headers, or credential headers, and it does not modify, redirect, cancel, replay, or rewrite the request or response. Only the minimal terminal decision or response-complete signal crosses from the page observer to the isolated extension runtime.

## Optional AI provider transfer

If the user configures one or more AI classifier providers, AI Chat Monitor uses them only as semantic fallback when high-confidence page/UI evidence, a valid terminal status marker, and strong local deterministic rules do not resolve the work state.

Before provider transfer, AI Chat Monitor bounds/minimizes the recent context and applies secret redaction. Provider output is advisory and cannot control ChatGPT or authorize page mutation.

Depending on the provider chosen by the user, data is sent directly from the extension to that provider's configured HTTPS endpoint. The provider's own privacy, retention, account, billing, and processing policies apply independently.

If no provider is configured, AI Chat Monitor does not send chat context to an AI provider.

## Telegram transfer

Telegram support is outbound notification-only and is disabled until configured by the user.

When enabled, AI Chat Monitor sends bounded notification metadata directly to Telegram's Bot API using the user's bot token and destination. Default notification content is event-oriented metadata such as the event type and conversation identity; AI Chat Monitor does not intentionally send full ChatGPT transcripts to Telegram by default.

Telegram cannot approve decisions, control AI Chat Monitor, or send ChatGPT turns through this extension. There is no inbound Telegram remote-control channel.

Telegram's own privacy and bot-platform policies apply independently.

## Browser notifications and sound

Browser notifications use Chromium's local `chrome.notifications` API. Optional sound uses a Manifest V3 offscreen extension document. These features do not require sending ChatGPT content to a developer-owned service.

## Clipboard

The `clipboardWrite` permission supports explicit user-initiated Copy actions for the status-protocol setup text in the Side Panel. AI Chat Monitor does not use clipboard access to paste or send messages into ChatGPT.

## Host permissions

Persistent host access is limited to supported ChatGPT origins:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

These persistent host permissions cover the read-only page observation scripts and the bounded local response-stream observation described above.

The manifest also declares optional HTTPS host permission so a user can configure an arbitrary HTTPS OpenAI-compatible provider whose origin is not known at install time. AI Chat Monitor requests the exact selected provider origin at runtime where required.

Telegram access is requested for the Telegram Bot API origin only when Telegram is configured.

## Security boundaries

AI Chat Monitor has no ChatGPT mutation authority. The extension runtime must not:

- write to the composer;
- click Send, Retry, Continue generating, Regenerate, Stop, confirmation, verification, or other ChatGPT conversation controls;
- generate or inject self-check/bootstrap/recovery turns;
- alter, redirect, cancel, or rewrite ChatGPT network requests;
- treat provider or Telegram output as browser mutation authority;
- bypass platform/account limits, authentication, verification, CAPTCHAs, confirmations, approvals, or safety controls.

Known page/UI blocker evidence outranks contradictory semantic/provider interpretation.

## Data sale, advertising, and analytics

AI Chat Monitor does not sell user data and does not include advertising or developer-operated behavioral analytics.

## User control

Users choose which conversations are monitored and can turn monitoring off from the Side Panel. Provider fallback, sound, Telegram, and individual notification event selections are configurable. Event history can be cleared from the Side Panel.

Removing the extension removes its browser-managed extension storage according to Chromium behavior.

## Source and verification

The project is developed in the public repository and release packages are generated by the repository build pipeline with source-SHA provenance and checksums. Public release status is separate from development/test builds.

For implementation details see [Architecture](docs/ARCHITECTURE.md), [Project specification](docs/PROJECT_SPEC.md), and [Store readiness](docs/STORE_READINESS.md).