# Chat Turn Guardian

Chat Turn Guardian is a standalone Chromium Manifest V3 extension for safely supervising explicitly selected ChatGPT Web conversations. It reads a strict machine-readable status from the end of the latest assistant response when available, uses conservative local rules for obvious cases, and sends a bounded same-conversation self-check only when the status is missing and the stop remains ambiguous.

**Current status: v1.1.0 release-ready.** The extension has **not** been submitted to or published on the Chrome Web Store. Store publication remains a separate human-authorized release action.

The chat's own agent, Skill, or workflow remains responsible for **what work should happen**. Guardian only decides whether another ordinary turn may be requested without genuine human involvement.

## Current capabilities

- Independent supervision of multiple ChatGPT tabs/conversations.
- Current-tab ON/OFF control with bounded reconnect/recovery.
- Per-chat modes: `OFF`, `OBSERVE`, `AUTO`, `NOTIFY_ONLY`.
- Global timing defaults plus per-chat settle/continue/cooldown overrides.
- Configurable continuation text.
- Strict terminal status protocol: normal assistant replies may end with `CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"..."}` so Guardian can decide without another chat turn.
- Conservative local rules handle obvious HOLD or explicitly pre-authorized continuation boundaries without unnecessary self-check traffic.
- When an ambiguous response has no valid terminal status, one structured same-conversation self-check also asks the chat to remember the terminal-status contract for later replies.
- A missing or malformed status in the self-check response fails closed instead of recursively generating another self-check.
- Recoverable red delivery errors may receive one guarded self-check only when the ordinary composer is safe; Guardian never clicks or retries ChatGPT `Retry` automatically.
- OpenRouter, NaraRouter, and generic OpenAI-compatible provider profiles with ordered fallback.
- Provider credentials stored only in trusted extension storage.
- Bounded classifier context: at most 4 recent turns, 4,000 characters per turn, and 8,000 characters total after secret redaction/minimization.
- Exact tab/document/content-agent/page-epoch/route/conversation/assistant-response/response-instance binding before automatic action.
- OWNER/MIRROR duplicate-conversation isolation; MIRROR never auto-sends.
- Human typing/sending/editing/stopping/navigation/policy changes stale pending automation.
- Empty-composer requirement and final synchronous revalidation immediately before mutation.
- Post-send verification, ambiguous-write freeze, and no blind retry.
- Browser notifications for response completion, HOLD/attention, UNSURE, provider/extension errors, and stagnation.
- Optional Telegram v1 outbound notifications through the user's own bot with hidden credential storage, inherited/custom event routing, health state, and Test notification.
- Progress-aware stagnation detection plus a separate configurable hard safety fuse.
- Bounded, redacted, clearable audit history.
- Persistent Side Panel for multi-chat management, providers, Telegram, Pause All, privacy disclosure, runtime state, and diagnostics.
- Toolbar action opens the Side Panel on supported ChatGPT pages; unsupported hosts remain disabled.
- Manifest V3 service-worker restart recovery that requires fresh page evidence before automation can act again.
- Deterministic release package/provenance and Chrome Web Store engineering readiness.

## Safety model

Chat Turn Guardian is fail-closed by design:

- `UNSURE`, malformed/missing protocol output after a self-check, provider failure, timeout, rate limit, blocking UI, stale state, or storage uncertainty never becomes an automatic continuation.
- AI providers return only advisory `CONTINUE` / `HOLD` / `UNSURE` results. They have no DOM/tab/browser mutation authority.
- Only the guarded ChatGPT content adapter can perform the narrow configured continuation action.
- Human interaction always has precedence.
- The composer must still be empty and every mutation-critical identity/safety check is repeated synchronously immediately before mutation.
- Duplicate conversation copies use OWNER/MIRROR isolation; MIRROR never auto-sends.
- Ambiguous writes are never blindly retried.
- Guardian never bypasses platform/account limits, Retry/error blockers, CAPTCHAs, confirmations, approvals, verification, or safety controls.
- Full conversation text is not persisted in audit history. Provider input is bounded/minimized and secret-redacted.
- Browser/Telegram notification delivery is observational and can never authorize or retry ChatGPT mutation.

Durable references:

- [Architecture](docs/ARCHITECTURE.md)
- [Conversation status protocol](docs/CONVERSATION_STATUS_PROTOCOL.md)
- [v1 validation and security evidence](docs/V1_VALIDATION.md)
- [Project specification](docs/PROJECT_SPEC.md)
- [Privacy policy](PRIVACY.md)
- [Chrome Web Store readiness](docs/STORE_READINESS.md)

## Requirements

- Chromium-family browser with Manifest V3 Side Panel support; current minimum is Chrome/Chromium 114.
- Node.js 22+ for development/building.
- A provider API key only if optional external AI classification is desired. Normal AUTO operation can use the in-chat terminal status/self-check path without one.
- A Telegram bot token and destination only if optional Telegram notifications are desired.

## Install from source / validated ZIP

From a fresh clone:

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

To load locally:

1. Run `npm ci && npm run build`, or extract a validated release ZIP so `manifest.json` is at the extracted directory root.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select `dist/` or the extracted release-package directory.
6. Open a supported ChatGPT conversation.
7. Click the Chat Turn Guardian toolbar icon to open the Side Panel.

Guardian starts fail-closed; installation alone does not enable automatic control for any conversation.

### Updating an existing unpacked installation

Preserve extension/storage identity:

1. Back up the currently loaded unpacked extension folder if desired.
2. Overwrite the contents of that **same folder** with the newer validated build.
3. Open `chrome://extensions` and click **Reload** for Chat Turn Guardian.

Do **not** Remove/re-add the extension merely to update a build unless an unavoidable identity-breaking reason has been proven.

## First-use configuration

### 1. Turn Guardian ON

Open a ChatGPT conversation and use **Turn Guardian ON** in the current-tab card. Turning ON from `OFF` starts in `OBSERVE`; an already selected advanced mode is preserved. **Turn Guardian OFF** resolves the exact current tab/conversation before setting it to `OFF`.

Start with `OBSERVE` while validating a workflow. Use `AUTO` only for conversations where guarded continuation is actually wanted.

### 2. Configure an AI provider

Provider classification is optional. In the Side Panel choose:

- **OpenRouter** — built-in preset;
- **NaraRouter** — built-in fixed-endpoint preset; or
- **Generic OpenAI-compatible** — custom HTTPS base URL + API key + model.

`Profile ID` is only a local Guardian label. You create it yourself, for example `openai`, `gemini-main`, `deepseek`, or `groq-fast`.

The current Generic transport expects:

- Bearer-token authentication;
- `GET <base-url>/models` for catalog discovery when available;
- `POST <base-url>/chat/completions` for classification.

`Try loading models` queries `/models`. A compatible service may still require manual model entry if its catalog is unavailable or differs. Always run **Test classifier** after saving before relying on the profile for `AUTO`.

### Known OpenAI-compatible configurations

These services matched Guardian's current transport when this v1.0 documentation was finalized. Provider endpoints/model IDs/quotas/pricing can change, so verify current vendor documentation when configuring them.

| Service | Guardian provider type | Base URL | Credential / docs | Notes |
| --- | --- | --- | --- | --- |
| OpenAI API | `Generic OpenAI-compatible` | `https://api.openai.com/v1` | [API Platform](https://platform.openai.com/) / [API keys](https://platform.openai.com/api-keys) | ChatGPT web subscriptions and API service/billing are separate. ChatGPT Business does not itself include API usage. |
| Google Gemini API | `Generic OpenAI-compatible` | `https://generativelanguage.googleapis.com/v1beta/openai` | [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) / [AI Studio API keys](https://aistudio.google.com/apikey) | Google's compatibility layer is version-sensitive; verify current docs/model IDs. |
| DeepSeek API | `Generic OpenAI-compatible` | `https://api.deepseek.com` | [API docs](https://api-docs.deepseek.com/) / [Platform](https://platform.deepseek.com/) | Prefer live catalog/current documentation for model IDs. |
| Groq | `Generic OpenAI-compatible` | `https://api.groq.com/openai/v1` | [OpenAI compatibility](https://console.groq.com/docs/openai) / [Console](https://console.groq.com/) | Supports OpenAI-style Chat Completions for compatible models. |
| xAI | `Generic OpenAI-compatible` | `https://api.x.ai/v1` | [API docs](https://docs.x.ai/developers/rest-api-reference/inference) / [Console](https://console.x.ai/) | Re-check Chat Completions compatibility over time. |
| Together AI | `Generic OpenAI-compatible` | `https://api.together.ai/v1` | [OpenAI compatibility](https://docs.together.ai/docs/inference/openai-compatibility) / [Quickstart](https://docs.together.ai/docs/quickstart) | Supports compatible model listing and Chat Completions. |
| OpenRouter | `OpenRouter` preset | Managed by Guardian | [OpenRouter](https://openrouter.ai/) / [API keys](https://openrouter.ai/keys) | Prefer the built-in Guardian preset. |

For **OpenAI**, you may sign into ChatGPT and the API Platform with the same OpenAI identity, but ChatGPT Free/Plus/Pro/Business access is not an API key and does not itself provide Guardian API usage. Create an API project/key through the API Platform and use its separate billing/credits as applicable.

For **Claude / Anthropic**, do not enter `https://api.anthropic.com` as Generic OpenAI-compatible. Guardian v1.0's generic adapter uses OpenAI-style `/chat/completions` + Bearer authentication; Anthropic's native Messages API uses a different protocol/authentication contract. Native Claude support requires a dedicated future Guardian adapter.

Recommended setup flow:

1. Create an API credential in the provider's developer/API console; never use browser-session cookies.
2. Choose a built-in preset when available; otherwise choose **Generic OpenAI-compatible**.
3. Set a unique local `Profile ID`.
4. For Generic, enter the provider's exact HTTPS Base URL.
5. Paste the API key locally into Guardian.
6. Use **Try loading models** or enter the exact documented model ID manually.
7. Optionally make it the primary provider.
8. Save, grant the exact requested provider-origin permission, and run **Test classifier**.
9. Add/reorder additional profiles only if ordered fallback is wanted.

Provider API keys are never returned in ordinary management/status responses. Provider usage may incur independent vendor charges.

### 3. Configure Telegram notifications

Telegram v1 is **outbound notification-only**.

1. Create your bot with Telegram's `@BotFather` and start/contact the bot (or add it to the intended destination) so it can deliver there.
2. In Guardian's **Telegram** section, enter the destination/Chat ID and Bot Token locally.
3. Enable Telegram.
4. Choose inherited Guardian events or a Telegram-specific event selection.
5. Save settings and allow the exact `https://api.telegram.org/*` host permission when requested.
6. Use **Test notification** and confirm the health state becomes `Healthy` after successful delivery.

Saved bot tokens are never rendered back. Leaving the token blank can retain the existing saved secret only under the safe same-configuration rule; entering a new token replaces it.

Telegram receives only bounded Guardian notification metadata. v1.0 does not send full ChatGPT messages by default and accepts no inbound commands. It cannot approve decisions, change `AUTO`, start/stop Guardian, inject ChatGPT messages, or otherwise authorize browser mutation.

Never paste a real bot token into GitHub, chat, logs, screenshots, or support messages.

### 4. Use `Pause All` when needed

`Pause All` immediately prevents new automatic sends while preserving configuration. Resuming does not restore stale action authority; fresh page evidence is required.

## Modes

| Mode | Classification | Automatic send | Notifications |
| --- | --- | --- | --- |
| `OFF` | No supervision | Never | No managed-chat events |
| `OBSERVE` | Yes | Never | Configurable |
| `AUTO` | Yes | Only after every safety gate passes | Configurable |
| `NOTIFY_ONLY` | No auto-send path | Never | Configurable, including response completion |

## Timing and loop protection

Global defaults and per-chat overrides exist for settle delay, continuation delay, post-send cooldown, continuation text, notification triggers, and hard-fuse settings.

The hard fuse is a final emergency boundary. Progress-aware stagnation protection first compares privacy-preserving signatures of recent **verified auto-continued** outcomes. Repeated materially similar no-progress outcomes HOLD; useful changing outcomes are not stopped merely by an arbitrary small count.

## Permission, privacy, and credential behavior

- Persistent page host access is limited to `https://chatgpt.com/*` and `https://chat.openai.com/*`.
- The broad optional `https://*/*` manifest envelope exists because a user may configure an arbitrary HTTPS OpenAI-compatible provider whose origin is not known at install time. Guardian requests only the exact selected origin at runtime.
- Provider endpoints must be HTTPS; URL credentials/query strings/fragments and sensitive auth-header overrides are rejected.
- Provider redirects are refused so credentials are not forwarded to unexpected origins.
- Provider requests have bounded timeouts/responses and bounded secret-redacted context.
- Telegram requests only `https://api.telegram.org/*` and delivers directly from the trusted service worker with bounded timeout, sanitized health/error state, and no blind retry.
- `chrome.storage.local` access for durable policy/provider/Telegram and guarded-write journal state is restricted to trusted extension contexts before restore.
- Audit history stores bounded structured metadata/fingerprints/diagnostics, not full chat content or credentials.

See [PRIVACY.md](PRIVACY.md) for the current data-handling and third-party-transfer policy.

## What unsafe states look like

The expected safe outcome is usually **no automatic action**:

- `HOLD` — a real boundary, human interaction, blocking UI, ownership issue, completion, or stagnation requires stopping.
- `UNSURE` — the evidence/provider could not safely justify continuation.
- `AMBIGUOUS_WRITE` — a mutation outcome cannot be safely reconciled; blind retry is blocked.
- `PAUSED` — Pause All is active.
- `COOLDOWN` — a verified continuation was sent and the per-chat cooldown is active.

## Troubleshooting

### Current tab shows `Reconnect needed`

Use **Reconnect** or **Turn Guardian ON**. Guardian first attempts bounded re-registration; if a supported tab's stale extension context cannot be reached, it may reload that tab once and waits for fresh exact identity/state. Do not use repeated blind reload rituals.

### `AUTO` never sends

Inspect the displayed reason/runtime state. Safe causes include a missing/malformed terminal status after the bounded self-check, `HOLD`/`UNSURE`, MIRROR ownership, non-empty composer, generation still running, blocking UI, stale response/session/policy, Pause All, stagnation/hard fuse, or an ambiguous-write guard.

Do not weaken the guard simply to increase the AUTO rate.

### Provider fails

Verify Base URL/model/API key and exact-origin permission. For Generic profiles confirm the service actually supports Bearer auth plus the `/models` and `/chat/completions` contract above. Run **Try loading models** followed by **Test classifier**. Re-check current vendor documentation if an external API/model changed.

### Telegram fails

Confirm `Configured`, `Enabled`, and health state, then run **Test notification**. Re-enter a token locally only when replacing it. Do not expose the saved secret while troubleshooting.

Telegram delivery failure cannot trigger a ChatGPT send/retry/state transition.

### ChatGPT changes its DOM

The adapter intentionally fails closed. Capture the failing state and update adapter/tests instead of loosening exact identity, blocker, composer, or final revalidation requirements.

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

## Validation status and rare platform states

High-signal real-browser scenarios for safe AUTO, human interaction, duplicate OWNER/MIRROR tabs, provider failure, restart recovery, notifications, toolbar/Side Panel behavior, and real Telegram delivery have been exercised and are recorded in [docs/V1_VALIDATION.md](docs/V1_VALIDATION.md).

Rare platform states such as a naturally occurring silent terminal/no fresh assistant response or a real Retry/error blocker are covered by automated fail-closed regressions but are not claimed as live-passed if they did not naturally occur. Do not manufacture those states merely for evidence; capture them opportunistically if they occur in future use.

## Chrome Web Store status

The v1.0 codebase is engineered to be Chrome Web Store ready: Manifest V3, production icons/assets, deterministic package/provenance, no remotely hosted executable code, permission/privacy justifications, public privacy policy, and listing copy are maintained in the repository.

See [docs/STORE_READINESS.md](docs/STORE_READINESS.md) and [docs/CHROME_WEB_STORE_LISTING.md](docs/CHROME_WEB_STORE_LISTING.md).

**Chat Turn Guardian is not currently claimed to be published or approved in the Chrome Web Store.** Immediately before a future submission, current Store policies/Developer Dashboard disclosures/assets and the exact submission ZIP must be re-verified. Upload/submission/publication/visibility changes require explicit human authorization.

## Project boundary and future development

Chat Turn Guardian v1.0 is a focused supervision product, not a general browser agent, project manager, GitHub orchestrator, approval authority, or safeguard-bypass mechanism. Telegram v1 is outbound-only; inbound commands/remote control require a separate future security/authorization design.

The v1.0 baseline is intentionally modular so future work can add notification channels, native provider adapters, page adapters, or other bounded capabilities through normal Issues/PRs without changing guarded-send authority. Permanent product invariants live in [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
