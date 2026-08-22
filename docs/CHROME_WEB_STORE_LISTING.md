# Chrome Web Store Listing — Chat Turn Guardian v2.0.0

> Draft Chrome Web Store listing copy for the released v2.0.0 product baseline. GitHub Release `v2.0.0` is published, but the extension has not been submitted to or published in the Chrome Web Store.

## Name

Chat Turn Guardian

## Short description

Monitor selected ChatGPT conversations and get Browser, sound, or Telegram alerts without sending or controlling chat turns.

## Detailed description

Chat Turn Guardian is a read-only ChatGPT conversation monitor for Chromium browsers.

Use it to keep track of selected ChatGPT conversations while working in other tabs. Guardian can observe response completion, generation state, Retry/error/rate-limit/auth/verification/conversation-limit conditions, and an optional semantic work status. It can then notify you through Browser notifications, optional local sound, or outbound Telegram alerts.

Guardian does **not** write to the ChatGPT composer, click ChatGPT conversation controls, automatically continue chats, or create self-check/recovery turns.

### Main features

- Monitoring ON/OFF per selected conversation.
- Response and platform/runtime state observation.
- Optional terminal semantic status protocol:
  `CHAT_TURN_GUARDIAN_STATUS={"decision":"..."}`.
- Backward-compatible reading of the old `_V1` marker without recommending it for new setup.
- Conservative deterministic classification plus optional AI-provider fallback.
- Browser notifications with event selection.
- Optional local sound with event selection.
- Optional outbound-only Telegram notifications through the user's own bot.
- Duplicate-tab/service-worker event deduplication.
- Bounded local event diagnostics.
- Side Panel with marker health, monitoring state, provider settings, Telegram health, and copyable status-protocol setup text.

### Privacy and control

Guardian is read-only with respect to ChatGPT. Full chat transcripts are not intentionally stored in monitoring history. Optional provider fallback receives bounded/minimized, secret-redacted recent context only when local evidence is insufficient. Telegram receives bounded notification metadata by default, not full ChatGPT messages.

No inbound Telegram remote control is provided.

## Single purpose statement

The extension's single purpose is to monitor user-selected ChatGPT Web conversations and notify the user about useful response, semantic, attention, and platform/runtime states without controlling or continuing the conversation.

## Permission justifications

- **`storage`** — stores monitoring policy, bounded event history, optional provider configuration/secrets, Telegram configuration/secrets, and sanitized health state in trusted extension storage.
- **`sidePanel`** — provides the persistent monitoring/configuration UI.
- **`notifications`** — shows configured Browser notifications for monitored events.
- **`offscreen`** — plays optional local notification sound in a Manifest V3-compatible extension context.
- **`clipboardWrite`** — copies the user-selected status-protocol setup text from explicit Side Panel Copy buttons. It is never used to paste into ChatGPT.
- **Persistent host access: `https://chatgpt.com/*`, `https://chat.openai.com/*`** — reads supported ChatGPT page/runtime state for conversations the user chooses to monitor.
- **Optional host envelope: `https://*/*`** — allows runtime grant of the exact HTTPS origin for a user-configured OpenAI-compatible provider that cannot be known at install time. Guardian does not require arbitrary HTTPS access for normal ChatGPT observation.

Telegram Bot API access is requested only when the user configures Telegram.

## Remote code

**No, this extension does not use remotely hosted executable code.**

All extension JavaScript is packaged with the extension. Network calls to optional AI providers and Telegram exchange data only; they do not download or execute remote extension code.

## User data disclosure summary

The extension processes ChatGPT page state and bounded recent visible chat content locally for monitoring/classification. Full transcripts are not intentionally stored. Optional AI-provider fallback receives minimized, secret-redacted context only when needed. Optional Telegram receives bounded event metadata by default. Provider API keys and Telegram bot tokens are stored in trusted extension storage and are not rendered back in ordinary UI state.

The project does not operate advertising, a developer-owned analytics backend, or a data-broker service, and does not sell user data.

See `PRIVACY.md` for the full policy.

## Store assets

Repository promotional assets:

- `store-assets/small-promo-440x280.png` — 440x280
- `store-assets/marquee-1400x560.png` — 1400x560

Before Store submission, screenshots and final Dashboard/listing declarations must be captured/reviewed against the exact submission build. The current released GitHub baseline is `v2.0.0` at `eb4e90a21cd578620bda855ce2e3ab37aee39027`; a later Store submission must revalidate its own exact source/package identity if development has moved on.
