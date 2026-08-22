# Chat Turn Guardian

Chat Turn Guardian is a Chromium Manifest V3 extension that **monitors selected ChatGPT conversations without controlling them**. It observes page/runtime state, resolves an optional semantic work status, and sends configurable Browser, local sound, and Telegram notifications.

**Development candidate: v2.0.0.** v2 is a breaking product pivot from guarded auto-continuation to read-only monitoring. It is not released yet.

## v2 single purpose

Guardian may observe ChatGPT state and notify you. Guardian must never:

- write to the ChatGPT composer;
- click Send, Retry, Continue generating, Regenerate, Stop, confirmation, verification, or other conversation controls;
- create self-check/bootstrap/recovery turns;
- automatically continue a conversation;
- use provider or Telegram output as browser-control authority.

A missing or malformed semantic status is normal fallback input, not permission to mutate the page.

## What v2 monitors

Guardian keeps page/runtime state separate from semantic work state.

Page/runtime examples:

- generating / idle;
- Retry available;
- platform or network error;
- rate limit;
- authentication or verification required;
- conversation limit reached;
- generation stall when the configured threshold is exceeded.

Semantic states:

- `CONTINUE` — work remains and can be continued manually without a human gate;
- `HOLD_APPROVAL` — explicit human approval is required;
- `HOLD_DECISION` — a material human decision is required;
- `HOLD_HUMAN_OPERATION` — human information, credentials, or a human-only action is required;
- `COMPLETE` — the requested outcome is actually complete;
- `PLATFORM_ERROR` — a platform/tool/runtime failure blocks progress;
- `RATE_LIMIT` — a usage/quota/rate limit blocks progress;
- `UNSURE` — the semantic state cannot be classified reliably.

`CONTINUE` is notification metadata only. It never grants Guardian permission to send anything to ChatGPT.

## Optional status protocol

For best semantic accuracy, an assistant reply may end with exactly one standalone final line:

```text
CHAT_TURN_GUARDIAN_STATUS={"decision":"<VALUE>"}
```

The marker must be outside code fences, inline code, JSON/code payloads, block quotes, tables, and other format-specific output containers, with nothing after it. If the user requires an exact/exclusive output format, the assistant should omit the marker for that reply.

The legacy `CHAT_TURN_GUARDIAN_STATUS_V1={...}` marker remains readable for compatibility, but v2 UI and documentation generate only the unversioned marker.

The Side Panel contains two copyable setup texts:

1. **Custom Instructions / Personalization** for compatible normal replies across chats.
2. **One conversation only** for a message the user manually sends once near the start of a specific chat.

Guardian never sends either setup text itself.

See [Conversation status protocol](docs/CONVERSATION_STATUS_PROTOCOL.md).

## Resolution order

For a stable monitored response Guardian resolves state in this order:

1. high-confidence page/UI blocker evidence;
2. valid terminal status marker;
3. strong deterministic local rules;
4. optional configured AI provider fallback;
5. `UNKNOWN` / `UNSURE`.

Known page blockers outrank model/provider interpretation.

## Notifications and deduplication

Channels are independently configurable:

- **Browser** — selected Guardian events through `chrome.notifications`;
- **Sound** — optional local Manifest V3-compatible audio;
- **Telegram** — outbound-only alerts through the user's own bot.

Telegram receives bounded Guardian metadata by default, not full ChatGPT transcripts, and accepts no inbound control commands.

Events are episode/transition oriented and deduplicated across DOM churn, service-worker restarts, and duplicate tabs for the same conversation/response identity. Opening the same conversation in multiple tabs must not multiply provider classification or notification delivery for one response episode.

## Side Panel

The Side Panel provides:

- Monitoring ON/OFF for the current conversation;
- current page state and semantic state/source;
- status-marker health (`Detected`, `Legacy`, `Missing`, `Malformed`);
- per-event Browser and Sound defaults;
- copyable status-protocol setup text;
- optional AI provider profiles and readiness testing;
- Telegram settings and health;
- bounded recent monitoring events/diagnostics.

There are no AUTO-send, continuation-text, cooldown, post-send, or hard-fuse controls in v2.

## Migration from v1.2.5

v2 migrates legacy chat policy to monitoring-only behavior:

- old `OFF` -> monitoring disabled;
- old `OBSERVE`, `NOTIFY_ONLY`, or `AUTO` -> monitoring enabled;
- compatible notification preferences are preserved where possible;
- continuation text, send delay/cooldown, write journal, protocol bootstrap, and historical send authority are not migrated.

No pending v1 automatic action is restored after upgrade.

Because v2 changes the product contract, the version is `2.0.0` rather than another `1.x` patch/minor release.

## Requirements

- Chrome/Chromium 114+ or a compatible Chromium browser with Manifest V3 Side Panel support.
- Node.js 22+ for development/building.
- An API key only when optional provider fallback is configured.
- A Telegram bot token/destination only when Telegram alerts are configured.

## Build and validate

```bash
git clone https://github.com/ach1992/chat-turn-guardian.git
cd chat-turn-guardian
npm ci
npm run validate
npm run smoke:extension
npm run package
```

`npm run package` creates:

- `artifacts/chat-turn-guardian-<version>.zip`
- `artifacts/SHA256SUMS.txt`
- `artifacts/build-info.json`

The CI workflow validates the exact candidate SHA, runs the extension smoke check, verifies the ZIP layout/provenance, and uploads the `artifacts/` directory as a GitHub Actions artifact.

## Load an unpacked test build

1. Extract the validated ZIP so `manifest.json` is at the extracted directory root.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the extracted directory.
6. Open a ChatGPT conversation.
7. Click the Chat Turn Guardian toolbar icon to open the Side Panel.
8. Enable Monitoring for only the chats you want Guardian to observe.

### Updating an existing unpacked installation

To preserve extension/storage identity, replace the files in the same unpacked folder, then use **Reload** in `chrome://extensions`. Do not remove/re-add the extension unless you intentionally want a fresh extension identity/storage state.

## Optional AI providers

Provider fallback is used only when page evidence, a valid marker, and deterministic rules do not resolve semantic state.

Supported provider profile types:

- OpenRouter preset;
- NaraRouter preset;
- Generic OpenAI-compatible HTTPS endpoint using Bearer authentication and Chat Completions.

Provider context is bounded/minimized and secret-redacted. Provider output is advisory only and cannot control ChatGPT.

## Telegram

Telegram is outbound notification-only.

1. Create a bot with `@BotFather`.
2. Start/contact the bot or add it to the intended destination.
3. Enter the bot token and Chat ID/destination in Guardian.
4. Choose inherited Browser events or a Telegram-specific event selection.
5. Save and grant the exact Telegram origin permission when requested.
6. Use **Test notification** and verify healthy delivery.

Saved bot tokens are not rendered back by the Side Panel.

## Privacy and permissions

- Persistent page access is limited to supported ChatGPT origins.
- Broad optional HTTPS host permission exists only so a user can configure an arbitrary HTTPS OpenAI-compatible provider; Guardian requests the selected origin at runtime.
- Provider API keys and Telegram bot tokens remain in trusted extension storage.
- Monitoring history stores bounded metadata/fingerprints/diagnostics, not full chat transcripts or credentials.
- Telegram receives bounded event metadata by default.
- `offscreen` is used for optional local audio; `clipboardWrite` supports explicit user copy actions in the Side Panel.

See [PRIVACY.md](PRIVACY.md) for the complete current policy.

## Development references

- [Architecture](docs/ARCHITECTURE.md)
- [Project specification](docs/PROJECT_SPEC.md)
- [Conversation status protocol](docs/CONVERSATION_STATUS_PROTOCOL.md)
- [Privacy policy](PRIVACY.md)
- [Chrome Web Store listing copy](docs/CHROME_WEB_STORE_LISTING.md)
- [Store readiness](docs/STORE_READINESS.md)
- [Changelog](CHANGELOG.md)
- [Historical v1 validation](docs/V1_VALIDATION.md)

## Release state

v2.0.0 remains a development candidate until the exact candidate passes required validation, receives the required review/integration decision, is merged, and the release artifact is explicitly published. A successful test ZIP by itself is not a public release.
