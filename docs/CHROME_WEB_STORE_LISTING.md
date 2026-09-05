# Chrome Web Store Listing — AI Chat Monitor v3.0.3 candidate

> Draft Chrome Web Store listing copy for the current unreleased v3.0.3 source candidate. The latest published GitHub Release remains v3.0.2, and the extension has not been submitted to or published in the Chrome Web Store. Do not treat this draft as a Store submission or release claim.

## Name

AI Chat Monitor

## Short description

Monitor selected ChatGPT conversations and get Browser, sound, or Telegram alerts without sending or controlling chat turns.

## Detailed description

AI Chat Monitor is a read-only ChatGPT conversation monitor for Chromium browsers.

Use it to keep track of selected ChatGPT conversations while working in other tabs. AI Chat Monitor can observe response completion, generation state, Retry/error/rate-limit/auth/verification/conversation-limit conditions, and an optional semantic work status. It can then notify you through Browser notifications, optional local sound, or outbound Telegram alerts.

AI Chat Monitor does **not** write to the ChatGPT composer, click ChatGPT conversation controls, automatically continue chats, or create self-check/recovery turns.

### Main features

- Monitoring ON/OFF per selected conversation.
- Response and platform/runtime state observation.
- Optional terminal semantic status protocol:
  `AI_CHAT_MONITOR_STATUS={"decision":"..."}`.
- Conservative deterministic classification plus optional AI-provider fallback.
- Browser notifications with event selection.
- Optional local sound with event selection.
- Optional outbound-only Telegram notifications through the user's own bot.
- Duplicate-tab/service-worker event deduplication.
- Bounded local event diagnostics.
- Side Panel with marker health, monitoring state, provider settings, Telegram health, and copyable status-protocol setup text.

### Privacy and control

AI Chat Monitor is read-only with respect to ChatGPT. Full chat transcripts are not intentionally stored in monitoring history. Optional provider fallback receives bounded/minimized, secret-redacted recent context only when local evidence is insufficient. Telegram receives bounded notification metadata by default, not full ChatGPT messages.

For reliable response-completion detection while a monitored ChatGPT tab is in the background, the extension observes a narrowly filtered ChatGPT response-request lifecycle at browser level. It accepts only successful top-frame ChatGPT conversation `POST` responses whose `Content-Type` is `text/event-stream`, and retains only bounded request/tab/document identity and timestamps needed to correlate start and completion. It does not read request bodies, response bodies, cookies, or authorization headers, and it cannot block or modify requests.

No inbound Telegram remote control is provided.

## Single purpose statement

The extension's single purpose is to monitor user-selected ChatGPT Web conversations and notify the user about useful response, semantic, attention, and platform/runtime states without controlling or continuing the conversation.

## Permission justifications

- **`storage`** — stores monitoring policy, bounded event history, optional provider configuration/secrets, Telegram configuration/secrets, sanitized health state, and bounded in-flight response-correlation metadata.
- **`sidePanel`** — provides the persistent monitoring/configuration UI.
- **`notifications`** — shows configured Browser notifications for monitored events.
- **`offscreen`** — plays optional local notification sound in a Manifest V3-compatible extension context.
- **`clipboardWrite`** — copies the user-selected status-protocol setup text from explicit Side Panel Copy buttons. It is never used to paste into ChatGPT.
- **Persistent host access: `https://chatgpt.com/*`, `https://chat.openai.com/*`** — reads supported ChatGPT page/runtime state and locally observes the cloned response stream only for a user-initiated response in a conversation the user selected for monitoring so it can recognize an exact terminal status or `data: [DONE]` without depending on foreground DOM rendering.
- **Optional host envelope: `https://*/*`** — allows runtime grant of the exact HTTPS origin for a user-configured OpenAI-compatible provider that cannot be known at install time. AI Chat Monitor does not require arbitrary HTTPS access for normal ChatGPT observation.

Telegram Bot API access is requested only when the user configures Telegram.

## Remote code

**No, this extension does not use remotely hosted executable code.**

All extension JavaScript is packaged with the extension. Network calls to optional AI providers and Telegram exchange data only; they do not download or execute remote extension code.

## User data disclosure summary

The extension processes ChatGPT page state and bounded recent visible chat content locally for monitoring/classification. Full transcripts are not intentionally stored. Optional AI-provider fallback receives minimized, secret-redacted context only when needed. Optional Telegram receives bounded event metadata by default. Provider API keys and Telegram bot tokens are stored in trusted extension storage and are not rendered back in ordinary UI state.

For background response completion, the extension keeps only a bounded rolling tail of the cloned current ChatGPT SSE response in page memory. That transient tail is used only to recognize a canonical terminal status or `data: [DONE]`; it is not persisted or transferred by the observer, and the original request/response is delegated unchanged.

The project does not operate advertising, a developer-owned analytics backend, or a data-broker service, and does not sell user data.

See `PRIVACY.md` for the full policy.

## Store assets

Repository promotional assets:

- `store-assets/small-promo-440x280.png` — 440x280
- `store-assets/marquee-1400x560.png` — 1400x560

Before Store submission, screenshots and final Dashboard/listing declarations must be captured/reviewed against the exact submission build. A future Store submission must revalidate its own exact source and package identity before upload.