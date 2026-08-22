# Chat Turn Guardian — Project Specification

## Product version

Current target: **v2.0.0**

v2 is a breaking product pivot from guarded automatic continuation to a strictly read-only ChatGPT conversation monitor and notifier.

## Product goal

Chat Turn Guardian helps a user observe selected long-running ChatGPT Web conversations without having to keep each tab in focus. It detects response/runtime state, resolves an optional semantic work state, and delivers useful notifications while preserving full human control of the conversation.

## Single purpose

Guardian may observe supported ChatGPT pages and notify the user.

Guardian must never:

- write to the ChatGPT composer;
- click or programmatically activate Send, Retry, Continue generating, Regenerate, Stop, confirmation, verification, or other ChatGPT conversation controls;
- create or inject protocol bootstrap, self-check, status-recovery, continuation, or other user turns;
- automatically continue a conversation;
- use Telegram or AI-provider output as browser mutation authority;
- bypass platform limits, authentication, verification, CAPTCHAs, approvals, confirmations, or safety controls.

This invariant applies even when semantic state is `CONTINUE`.

## Supported environment

- Chromium Manifest V3 extension.
- Chrome/Chromium 114+ baseline because the Side Panel API is used.
- Supported ChatGPT origins:
  - `https://chatgpt.com/*`
  - `https://chat.openai.com/*`
- Node.js 22+ for repository development/building.

## State model

Guardian keeps runtime/page state separate from semantic conversation state.

### Page/runtime state

Representative states:

- `GENERATING`
- `IDLE`
- `RETRY_AVAILABLE`
- `PLATFORM_ERROR`
- `NETWORK_ERROR`
- `RATE_LIMIT`
- `AUTH_REQUIRED`
- `VERIFICATION_REQUIRED`
- `CONVERSATION_FULL`
- `UNKNOWN`

Page state comes from normalized DOM/runtime observation. High-confidence blocker state is authoritative over semantic/provider evidence.

### Semantic work state

Supported terminal vocabulary:

- `CONTINUE`
- `HOLD_APPROVAL`
- `HOLD_DECISION`
- `HOLD_HUMAN_OPERATION`
- `COMPLETE`
- `PLATFORM_ERROR`
- `RATE_LIMIT`
- `UNSURE`

Meaning:

- `CONTINUE` — requested work remains and can proceed without human approval, a material human decision, missing human information/credentials, or a human-only operation. This only means a human may manually continue.
- `HOLD_APPROVAL` — explicit human approval/authorization is required.
- `HOLD_DECISION` — a material human decision is required.
- `HOLD_HUMAN_OPERATION` — missing human information/credentials or a human-only operation is required.
- `COMPLETE` — the requested outcome is actually complete and no further work remains for the current request.
- `PLATFORM_ERROR` — platform/tool/runtime/service failure blocks progress.
- `RATE_LIMIT` — usage/quota/rate limit blocks progress.
- `UNSURE` — semantic state cannot be classified reliably.

## Optional machine-readable status protocol

Canonical public record:

```text
CHAT_TURN_GUARDIAN_STATUS={"decision":"<VALUE>"}
```

Rules:

- optional; Guardian must work without it;
- exactly one terminal record when used;
- final standalone line of the same assistant turn;
- nothing after it;
- outside Markdown code fences, inline code, JSON/code payloads, block quotes, tables, or other requested output containers;
- omit it when a user requires an exact/exclusive output format that an extra line would invalidate.

Legacy compatibility:

```text
CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"<VALUE>"}
```

The legacy form remains readable during the compatibility window, but v2 UI/docs generate and recommend only the unversioned canonical form.

Multiple markers, conflicting marker forms, malformed JSON, unsupported decisions, or markers embedded in structured/code output are invalid and fall through safely.

## Semantic resolution order

For each stable response/episode:

1. authoritative/high-confidence page/UI blocker evidence;
2. valid terminal status marker;
3. strong deterministic local rules;
4. optional configured AI provider fallback;
5. `UNKNOWN` / `UNSURE`.

Provider fallback is advisory, bounded, secret-redacted, cached/deduplicated per response identity, and cannot cause page mutation.

## Monitoring events

Core events include:

- response complete;
- manual continuation available;
- approval required;
- material decision required;
- human operation/input required;
- task complete;
- Retry available;
- platform/network error;
- rate limit;
- authentication/verification required;
- conversation limit reached;
- semantic state unknown/provider failure;
- generation stalled;
- repeated exact assistant response where useful diagnostically.

Events are transition/episode based and deduplicated. A single response should produce one useful primary notification rather than overlapping spam.

## Notification channels

### Browser

- configurable per event;
- uses `chrome.notifications`;
- may focus/open the known monitored tab when safely resolvable;
- may suppress low-priority alerts while the exact chat is already focused when configured.

### Sound

- optional local channel;
- configurable per event;
- uses a Manifest V3-compatible offscreen extension context;
- no repeated playback for the same deduplicated event episode.

### Telegram

- outbound notification-only;
- user supplies bot token and destination;
- bounded metadata by default, not full ChatGPT transcripts;
- inherited or Telegram-specific event selection;
- sanitized delivery health;
- no inbound remote control.

## Multi-tab behavior

The same ChatGPT conversation may be open in multiple tabs. v2 uses conversation/response identity for notification/provider deduplication rather than v1 OWNER/MIRROR send authority.

Tab/document identity remains useful to reject stale observations and focus a known tab, but no tab owns send authority because send authority no longer exists.

## Persistence and migration

Monitoring policy schema version: `2`.

Migration from v1 policy:

- `OFF` -> monitoring disabled;
- `OBSERVE`, `NOTIFY_ONLY`, or `AUTO` -> monitoring enabled;
- compatible notification preferences preserved where practical;
- continuation text, continuation delay, cooldown, hard auto-continue fuse, write journal, self-check/bootstrap state, and any pending send authority are discarded/deprecated;
- service-worker restart must never restore old automatic-send authority.

## Privacy and security

- ChatGPT content is untrusted input.
- No page mutation authority exists anywhere in v2 runtime.
- Full transcripts are not intentionally stored in monitoring history.
- Provider input is bounded/minimized and secret-redacted.
- Provider API keys and Telegram bot tokens stay in trusted extension storage.
- Telegram receives bounded monitoring metadata by default.
- Notification delivery failure cannot change semantic state or create browser-control authority.
- Broad optional HTTPS host permission is used only for user-configured HTTPS provider origins.

## Side Panel requirements

The Side Panel provides:

- Monitoring ON/OFF;
- current page state;
- current semantic state and source (`UI`, `STATUS_MARKER`, `RULE`, `PROVIDER`, `UNKNOWN`);
- marker health (`Detected`, `Legacy`, `Missing`, `Malformed`);
- Browser/Sound event configuration;
- status protocol setup with copyable Custom Instructions and per-chat variants;
- provider settings/readiness;
- Telegram settings/health;
- bounded recent monitoring events/diagnostics.

The Side Panel must not expose AUTO-send, continuation text, send delay/cooldown, guarded-send, write-journal, or hard-fuse controls/claims.

## Status protocol setup UX

The Side Panel must explain that Guardian works without the status protocol.

Two copyable variants are supported:

1. **Custom Instructions / Personalization** — for compatible normal replies across chats.
2. **One conversation only** — a message the user manually sends once near the start of a specific chat.

Both variants explain enough decision semantics for a model to choose reliably and explicitly state the strict-format exception. Guardian never pastes or sends these instructions itself.

## Development and release requirements

Required repository validation for a candidate:

- typecheck;
- lint;
- automated tests;
- extension smoke test;
- deterministic packaging;
- ZIP layout/provenance verification;
- exact candidate SHA identity in build metadata.

A v2 test artifact is not a public release. Public publication requires explicit release/integration authorization after the exact candidate has passed required validation/review.

## v2 acceptance

The v2 outcome is complete only when all of the following are true:

- no runtime path writes to the ChatGPT composer or programmatically activates ChatGPT conversation controls;
- no in-chat self-check/bootstrap/status-response/recovery message is generated or sent by Guardian;
- stable response completion produces one deduplicated response episode;
- reliable Retry/error/rate-limit/auth/verification/conversation-full states are surfaced observationally;
- canonical status marker parses without creating another chat turn;
- legacy `_V1` marker remains readable but is not generated/recommended;
- marker parser rejects ambiguous/embedded/structured-output marker situations;
- missing/malformed marker falls through safely to rules/provider/unknown;
- provider failure cannot override known UI state or cause browser action;
- Browser, Sound, and Telegram routing are independently configurable and deduplicated;
- duplicate/background tabs do not duplicate provider classification or notification for the same response episode;
- service-worker restart does not replay notification episodes excessively or restore send authority;
- v1.2.5 settings migrate to monitoring-only behavior;
- Side Panel contains no automatic continuation controls/claims;
- README, Architecture, Privacy, Store readiness/listing, status protocol, and changelog describe v2 accurately;
- automated regression coverage enforces the read-only protocol/runtime invariant and core monitoring transitions;
- repository validation passes on the exact candidate SHA;
- a deterministic test ZIP with provenance is available for user validation before public release.

## Historical note

v1.x implemented guarded automatic continuation and in-chat self-check behavior. Those capabilities are intentionally removed from the v2 product contract. Historical v1 documentation may remain only when clearly labeled as historical evidence and must not be presented as current behavior.
