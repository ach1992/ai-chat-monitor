# Chat Turn Guardian

Chat Turn Guardian is a standalone Chromium Manifest V3 extension that supervises explicitly selected ChatGPT Web conversations and can request another turn when a finished response is confidently classified as a needless turn boundary.

The extension is deliberately narrow. The chat's own agent, Skill, or workflow remains responsible for **what work should happen**. Chat Turn Guardian only decides whether a generic configured continuation message may be requested without genuine human involvement.

## MVP capabilities

- Supervises multiple ChatGPT tabs/conversations independently.
- Primary current-tab ON/OFF control with bounded one-action reconnect and reactive status.
- Per-chat modes: `OFF`, `OBSERVE`, `AUTO`, and `NOTIFY_ONLY`.
- Global timing defaults with per-chat settle/continue/cooldown overrides.
- Configurable continuation text.
- Conservative deterministic stop rules plus an optional AI classifier.
- OpenRouter, NaraRouter, and generic OpenAI-compatible provider profiles with ordered fallback.
- Provider credentials stored only in trusted extension storage.
- Bounded classification context: at most 4 recent turns, 4,000 characters per turn, and 8,000 characters total after secret redaction/minimization.
- Exact tab/document/conversation/message binding before any automatic action.
- Duplicate-conversation owner/mirror isolation so at most one tab can auto-send.
- Human typing, sending, editing, stopping, navigation, policy changes, and blocking UI cancel or stale pending automation.
- Guarded page mutation with post-send verification and no blind retry after ambiguous writes.
- Browser notifications for response completion, HOLD/attention, UNSURE, provider/extension errors, and stagnation.
- Optional Telegram v1 outbound notifications through the user's own bot, with hidden credential storage, inherited/custom event routing, health state, and Test notification.
- Progress-aware stagnation detection plus a separate configurable hard safety fuse.
- Bounded, redacted, clearable audit history.
- Persistent Side Panel for multi-chat management, Pause All, provider/Telegram configuration, runtime state, privacy disclosure, and diagnostics.
- Toolbar action opens the Side Panel on supported ChatGPT pages while unsupported hosts remain disabled.
- Service-worker restart recovery that requires fresh observation before automation can act.

## Safety model

Chat Turn Guardian is fail-closed by design:

- `UNSURE`, provider failure, malformed provider output, timeout, rate limit, blocking UI, stale state, or storage failure never becomes an automatic continuation.
- AI providers return only advisory `CONTINUE` / `HOLD` / `UNSURE` classifications. They cannot access tabs, DOM mutation, approvals, or browser actions.
- Only the guarded ChatGPT page adapter can perform the narrow configured continuation action, and it revalidates the exact current page/message immediately before mutation.
- Human interaction always has precedence over pending automation.
- Ambiguous writes are journaled and never blindly retried.
- The extension does not bypass platform/account limits, CAPTCHAs, confirmations, approvals, or safety controls.
- Full conversation text is not persisted in audit history. Classifier input is bounded and secret-redacted before provider transport.
- Notification delivery is observational. Browser/Telegram success or failure can never authorize or retry a ChatGPT mutation.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the component boundaries, [`docs/MVP_VALIDATION.md`](docs/MVP_VALIDATION.md) for the validation/evidence matrix, and [`PRIVACY.md`](PRIVACY.md) for current data handling and third-party transfer disclosures.

## Requirements

- Chromium-family browser with Manifest V3 Side Panel support. The manifest currently targets Chrome/Chromium 114+.
- Node.js 22+ for development/building.
- A provider API key only if AI classification is desired. Without a configured provider, ambiguous classifier cases fail closed to `UNSURE`.
- A Telegram bot token and destination only if optional Telegram notifications are desired.

## Fresh-clone validation

```bash
git clone https://github.com/ach1992/chat-turn-guardian.git
cd chat-turn-guardian
npm ci
npm run validate
npm run smoke:extension
npm run package
```

`npm run validate` performs strict TypeScript checks, repository linting, a production-style extension build, and the complete automated test suite.

`npm run smoke:extension` launches Chromium with the generated `dist/` directory as an unpacked extension and fails if Chromium reports extension-load errors or a manifest-referenced icon asset is missing.

`npm run package` rebuilds the extension and creates:

- `artifacts/chat-turn-guardian-<version>.zip`
- `artifacts/SHA256SUMS.txt`
- `artifacts/build-info.json`

The ZIP contains the extension payload without TypeScript sources, source maps, or `.env` files. Packaging also requires the manifest/package versions to match and verifies referenced icon assets. CI retains the package output as a workflow artifact for the validated commit.

## Install as an unpacked extension

1. Run `npm ci && npm run build`, or extract a validated release ZIP so `manifest.json` is at the extracted directory root.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the generated `dist/` directory, or the extracted release-package directory.
6. Open ChatGPT Web in one or more tabs.
7. Click the Chat Turn Guardian toolbar icon on a supported ChatGPT tab to open the Side Panel.

The extension starts fail-closed. Chats are not automatically controlled just because the extension is installed.

For later unpacked-extension updates, overwrite the contents of that same existing unpacked-extension folder and use `chrome://extensions` -> **Reload**. Do not Remove/re-add the extension merely to update a build, because preserving extension/storage identity is part of the validated workflow.

The manifest keeps persistent host access limited to the two supported ChatGPT origins so the extension can supervise supported pages. External provider/Telegram origins remain optional and are requested only for the exact runtime origin involved.

## First-use configuration

### 1. Turn Guardian ON for the current tab

Open a ChatGPT conversation and use **Turn Guardian ON** in the primary current-tab card. If the supported tab has a stale or missing content agent after an extension update/reload, the same action first attempts a safe re-registration and otherwise reloads that tab once, then waits for a fresh exact conversation identity.

Turning ON from `OFF` starts in `OBSERVE`. If the conversation is already in an advanced mode such as `AUTO` or `NOTIFY_ONLY`, turning it ON preserves that mode. **Turn Guardian OFF** always resolves the current exact tab/conversation identity before setting the conversation to `OFF`.

The current-tab card refreshes automatically during normal use and shows connection state, `OWNER`/`MIRROR` eligibility, runtime phase, and the latest classifier decision when available.

### 2. Configure a provider when AI classification is needed

In the Side Panel, add one of:

- **OpenRouter**: profile ID, model, and API key;
- **NaraRouter**: profile ID, model, and API key using its fixed provider endpoint; or
- **OpenAI-compatible**: profile ID, HTTPS base URL, model, and API key.

The browser asks for host access to the exact provider origin at configuration time. Provider profiles can be reordered for fallback priority. Removing or replacing the last profile that uses an origin revokes that now-unused origin permission on a best-effort basis.

Provider API keys are never returned in ordinary management/status responses. When remote classification is needed, Guardian sends only the bounded, minimized, secret-redacted classification context directly to the selected HTTPS provider. Provider output remains advisory.

### 3. Configure Telegram only if outbound alerts are wanted

Expand **Telegram** in the Side Panel, enter the bot token and Chat ID/destination locally, choose inherited or Telegram-specific events, enable Telegram, save, grant the exact Telegram Bot API host permission, then use **Test notification**.

The saved bot token is never rendered back into the Side Panel. A blank token preserves the existing secret only when the destination remains the same; an explicit new token replaces it. Telegram v1 sends bounded Guardian notification metadata and never sends full ChatGPT messages or accepts inbound commands. Browser notifications continue to work independently.

Never paste a real bot token into an issue, chat transcript, screenshot, or support request.

### 4. Use advanced per-chat modes deliberately

Expand **Open ChatGPT chats** for `OBSERVE`, `AUTO`, `NOTIFY_ONLY`, timing, notification, and per-conversation override controls.

Start with `OBSERVE` when validating a workflow. The extension will settle and classify finished assistant turns but cannot enter the automatic send state.

Set a conversation to `AUTO` only when you want guarded continuation for that exact chat. A `CONTINUE` classification is still only a candidate: the extension rechecks session identity, ownership, policy revision, assistant fingerprint, composer state, user interaction state, blocking UI, stagnation/fuse state, and expiration before the content agent is allowed to mutate the page.

### 5. Use `Pause All` whenever needed

`Pause All` immediately prevents new automatic sends while preserving configuration. Resuming requires fresh page evidence before automation can proceed.

## Modes

| Mode | Classification | Automatic send | Notifications |
| --- | --- | --- | --- |
| `OFF` | No supervision | Never | No managed-chat events |
| `OBSERVE` | Yes | Never | Configurable |
| `AUTO` | Yes | Only after every safety gate passes | Configurable |
| `NOTIFY_ONLY` | No auto-send path | Never | Configurable, including response-finished-only |

## Timing and loop protection

Global defaults and per-chat overrides exist for:

- settle delay;
- continuation delay;
- post-send cooldown;
- continuation text;
- notification triggers;
- hard-fuse maximum verified auto-continues.

The hard fuse is a final emergency boundary, not the primary progress detector. Progress-aware protection first compares privacy-preserving signatures of recent **verified auto-continued** assistant outcomes. Repeated materially similar no-progress outcomes are held as stagnation even before the hard fuse is reached. Useful changing outcomes are not stopped merely because an arbitrary small continuation count was reached.

Human interaction resets the relevant verified-auto continuation window used by the fuse/stagnation guard.

## Provider, Telegram, and privacy behavior

- Durable `chrome.storage.local` data is restricted to trusted extension contexts before policy/provider/Telegram state is restored.
- Persistent page host access is limited to `https://chatgpt.com/*` and `https://chat.openai.com/*`; the broad `tabs` permission is not requested.
- The manifest's optional `https://*/*` envelope supports arbitrary user-configured HTTPS OpenAI-compatible endpoints; the Side Panel requests only the exact origin selected by the user at runtime.
- Provider endpoints must use HTTPS. URL credentials, query strings, fragments, and sensitive header overrides are rejected.
- Automatic redirects are refused for provider requests so credentials are not forwarded to an unexpected origin.
- Provider requests are timeout-bounded and response-size-bounded.
- Context sanitization limits recent turns and minimizes large code/log blocks.
- Common API-key/auth-token forms are redacted before provider transport.
- Telegram v1 requests only `https://api.telegram.org/*`, uses direct HTTPS Bot API delivery from the trusted service worker, is timeout-bounded with no blind retry, and exposes only sanitized health/error state.
- Audit history stores bounded structured metadata, hashes/fingerprints, and local diagnostic reasons; it does not store full assistant/user content, provider secrets, or Telegram bot tokens. Free-form classifier reasons are not persisted in audit history.
- The Side Panel contains a prominent privacy/data disclosure and the public policy is [`PRIVACY.md`](PRIVACY.md).

## What to expect when something is unsafe

The correct behavior is usually **no automatic action**. Typical Side Panel states include:

- `HOLD`: a real boundary, human interaction, blocking UI, ownership issue, or stagnation requires attention.
- `UNSURE`: the classifier/provider could not safely justify continuation.
- `AMBIGUOUS_WRITE`: a page mutation may have started but cannot be safely reconciled; blind retry is blocked.
- `PAUSED`: global Pause All is active.
- `COOLDOWN`: a verified continuation was sent and the per-chat cooldown is active.

## Troubleshooting

### Current ChatGPT tab shows `Reconnect needed`

Use **Reconnect** when Guardian is already ON, or **Turn Guardian ON** when it is OFF. Guardian first tries to re-register a reachable content agent; if none is reachable, it reloads that supported ChatGPT tab once and waits for fresh exact identity/state. A repeated manual reload + Side Panel refresh ritual should not be required for the normal stale-extension case.

If recovery still fails, confirm the active tab is `https://chatgpt.com/...` (or the supported legacy ChatGPT host) and inspect the displayed recovery error rather than repeatedly reloading. Recovery is intentionally bounded and does not blind-retry page mutations.

### `AUTO` never sends

Check the displayed reason/runtime state. Common safe causes are:

- no provider configured for an ambiguous stop;
- provider failure or low-confidence result;
- the tab is a duplicate-conversation `MIRROR`, not `OWNER`;
- the composer is focused or contains user text;
- ChatGPT is still generating;
- blocking/error/rate-limit/confirmation UI is present;
- the response/policy/session changed during a delay;
- stagnation or the hard fuse held the chat;
- a prior ambiguous write guard blocks retry.

### Provider requests fail

Verify the profile model/base URL/API key, confirm the requested exact-origin host permission is still granted, and use an HTTPS endpoint. Provider/model availability and quotas are external service facts and are intentionally not hardcoded into the extension.

### Notifications do not appear

For browser notifications, confirm browser/OS notifications are permitted and the chat's notification trigger is enabled.

For Telegram, confirm **Configured**, **Enabled**, and health state in the Side Panel, then use **Test notification**. Re-enter the token locally if replacing credentials or changing destination. Do not expose the saved token while troubleshooting.

Notification delivery failure is observational only: it cannot trigger a send, retry, or automation state transition.

### ChatGPT changes its DOM

The adapter intentionally fails closed on selector/identity drift. If current ChatGPT markup no longer matches the supported adapter, use `OFF`/`OBSERVE`, capture the failing scenario, and update the adapter/tests rather than weakening the final revalidation gates.

## Development commands

```bash
npm run build
npm run dev
npm run typecheck
npm run lint
npm test
npm run validate
npm run smoke:extension
npm run package
```

## Chrome Web Store preparation

Store-readiness constraints and exact permission/privacy justifications are documented in [`docs/STORE_READINESS.md`](docs/STORE_READINESS.md). The authoritative listing/submission copy is [`docs/CHROME_WEB_STORE_LISTING.md`](docs/CHROME_WEB_STORE_LISTING.md).

Actual Chrome Web Store upload, submission, or publication is not performed as part of ordinary engineering validation and requires an explicit release authorization.

## Project boundary

This MVP is not a general browser agent, project manager, GitHub orchestrator, approval authority, or mechanism for bypassing platform safeguards. It does not create chats, move reviewer prompts between chats, require a local daemon/model, or implement Telegram remote control. Telegram v1 is outbound notification-only; inbound commands, remote mode control, approval answering, arbitrary message injection, and Telegram status/control surfaces require a separate future security/authorization design and remain out of scope.
