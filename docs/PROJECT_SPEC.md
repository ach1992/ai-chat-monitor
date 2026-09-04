# AI Chat Monitor — Project Specification

## Product version

Current stable baseline: **v3.0.2**

v3 establishes the AI Chat Monitor product identity and the sole `AI_CHAT_MONITOR_STATUS` protocol. It preserves the durable read-only monitoring and notification boundary established by v2. The exact-source publication evidence is recorded in the README and Store readiness document.

## Product goal

AI Chat Monitor helps a user observe selected long-running ChatGPT Web conversations without having to keep each tab in focus. It detects response/runtime state, resolves an optional semantic work state, and delivers useful notifications while preserving full human control of the conversation.

## Single purpose

AI Chat Monitor may observe supported ChatGPT pages and notify the user.

AI Chat Monitor must never:

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

AI Chat Monitor keeps runtime/page state separate from semantic conversation state.

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
AI_CHAT_MONITOR_STATUS={"decision":"<VALUE>"}
```

Rules:

- optional; AI Chat Monitor must work without it;
- exactly one terminal record when used;
- final standalone line of the same assistant turn;
- nothing after it;
- outside Markdown code fences, inline code, JSON/code payloads, block quotes, tables, or other requested output containers;
- omit it when a user requires an exact/exclusive output format that an extra line would invalidate.

Multiple markers, malformed JSON, unsupported decisions, or markers embedded in structured/code output are invalid and fall through safely.

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
- uses the packaged extension icon resolved through `chrome.runtime.getURL()` for notification delivery;
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

The same ChatGPT conversation may be open in multiple tabs. The current architecture uses conversation/response identity for notification/provider deduplication rather than legacy OWNER/MIRROR send authority.

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
- No page mutation authority exists anywhere in the current runtime.
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
- marker health (`Detected`, `Missing`, `Malformed`);
- Browser/Sound event configuration;
- status protocol setup with copyable Custom Instructions and per-chat variants;
- provider settings/readiness;
- Telegram settings/health;
- bounded recent monitoring events/diagnostics.

The Side Panel must not expose AUTO-send, continuation text, send delay/cooldown, guarded-send, write-journal, or hard-fuse controls/claims.

## Status protocol setup UX

The Side Panel must explain that AI Chat Monitor works without the status protocol.

Two copyable variants are supported:

1. **Custom Instructions / Personalization** — for compatible normal replies across chats.
2. **One conversation only** — a message the user manually sends once near the start of a specific chat.

Both variants explain enough decision semantics for a model to choose reliably and explicitly state the strict-format exception. AI Chat Monitor never pastes or sends these instructions itself.

## Development and release requirements

Every future candidate must retain repository-standard validation:

- typecheck;
- lint;
- automated tests;
- extension smoke test that proves the unpacked AI Chat Monitor service worker actually loaded;
- real Chromium background-tab smoke test that keeps the monitored tab hidden, verifies terminal-status boundary preservation, confirms Browser notification creation, and confirms automatic-discard protection;
- deterministic packaging;
- ZIP layout/provenance verification;
- exact candidate SHA identity in build metadata.

A test artifact is not a public release. Any future version publication remains a separate release action after the exact candidate has passed the required validation/review/integration gates.

## v2.0.0 acceptance baseline

The released v2.0.0 outcome satisfied the following acceptance requirements and they remain regression expectations for future development unless intentionally superseded:

- no runtime path writes to the ChatGPT composer or programmatically activates ChatGPT conversation controls;
- no in-chat self-check/bootstrap/status-response/recovery message is generated or sent by AI Chat Monitor;
- stable response completion produces one deduplicated response episode;
- reliable Retry/error/rate-limit/auth/verification/conversation-full states are surfaced observationally;
- canonical status marker parses without creating another chat turn;
- retired product markers are rejected and fall through safely;
- marker parser rejects ambiguous/embedded/structured-output marker situations;
- missing/malformed marker falls through safely to rules/provider/unknown;
- provider failure cannot override known UI state or cause browser action;
- Browser, Sound, and Telegram routing are independently configurable and deduplicated;
- duplicate/background tabs do not duplicate provider classification or notification for the same response episode;
- service-worker restart does not replay notification episodes excessively or restore send authority;
- v1.2.5 settings migrate to monitoring-only behavior;
- Side Panel contains no automatic continuation controls/claims;
- README, Architecture, Privacy, Store readiness/listing, status protocol, and changelog described the v2 release accurately;
- automated regression coverage enforces the read-only protocol/runtime invariant and core monitoring transitions;
- repository validation passes on the exact candidate SHA;
- Owner live Chromium acceptance was completed before integration;
- the deterministic release package was published with checksum/provenance and verified after publication.

## v2.0.1 patch baseline

The v2.0.1 patch preserves all v2.0.0 acceptance requirements and additionally verifies that Browser notification delivery uses the packaged extension icon and the Promise-based Chrome notification API. The fix was validated by automated regression coverage and by live Chromium/Windows delivery before publication.

## v3.0.1 patch baseline

The v3.0.1 patch preserved the v3 read-only product contract and attempted to improve background monitoring by removing a page-timer dependency from hidden DOM observations. Post-release owner validation proved that this was incomplete: background `innerText` could retain/flatten the status prefix without a valid terminal-line boundary, preventing structural recovery, and content-agent recovery still depended too much on later Side Panel/tab activity when the MV3 background session was lost. Therefore v3.0.1 must not be used as evidence that inactive-tab monitoring is fully reliable.

## v3.0.2 patch baseline and post-release correction

The v3.0.2 release retained useful background safeguards: structural terminal-status recovery, content-agent self-reannouncement after recoverable MV3 session loss, automatic-discard protection for monitored tabs, explicit frozen/discarded lifecycle state, and real unpacked-extension identity validation. Its published artifact was verified against exact-main CI.

Post-release owner validation proved the release incomplete. Subsequent investigation isolated several real failure modes, including stale structural text, MV3 session loss, automatic-discard exposure, stale `Stop generating`, and selector-order mistakes, and added regression coverage for each. Owner validation after those corrections still reproduces the inactive-tab failure in the real logged-in Chrome environment, so none of those isolated defects is treated as the complete live root cause. Synthetic browser smoke is regression evidence for the modeled conditions only.

Current corrective invariant (Issue #83 Contract Revision 3): in a hidden runnable tab, an exact canonical terminal status is explicit end-of-response evidence and may outrank a stale Stop control for generation completion. This exception is hidden-only and fail-closed: visible tabs retain normal Stop-control behavior, and malformed, ambiguous, duplicate, code-fenced, or unsupported markers never override `GENERATING`. Missing-marker replies continue to use the normal UI/rule/provider fallback path.

The unreleased `3.0.3` work under Issue #83 Contract Revision 4 separated monitoring authority from Side Panel refresh: Side Panel polling must not be required to reconnect a content agent, and the real Chromium regression closes the panel page and force-restarts the MV3 worker while the monitored tab remains hidden. Revision 4 also changed the Side Panel itself to a global panel; later owner feedback proved that UI change was a regression because established behavior is tab-scoped open/closed state. Revision 6 restores tab-scoped Side Panel availability while keeping background-runtime independence.


Issue #83 Contract Revision 5 added another valid correction: supported assistant/user selector matches must be resolved in actual DOM order. Grouping matches by selector can select an older assistant turn while a newer hidden/streaming turn temporarily uses a different DOM shape. The Chromium regression therefore uses multiple turns with mixed selector shapes and requires the newest assistant/user message identities while the tab remains hidden. Owner validation nevertheless still fails, so this remains an independently valid bug fix rather than a complete root-cause claim.

The Revision 6 regression also exposed a session-ordering race during MV3 recovery: a delayed `content:hello` from the same document/agent could arrive after a fresh observation and rebuild the session without that observation. Same-session reannounce now preserves the current observation and diagnostic, while a changed page epoch/route remains a hard boundary that drops prior page evidence.
Issue #83 Contract Revision 6 restores the established tab-scoped Side Panel behavior and adds a bounded hidden-attempt diagnostic snapshot. The internal diagnostic may retain timing, counts, assistant text lengths and fingerprints, generation/Stop state, and marker health, but never transcript text, credentials, provider payloads, or Telegram secrets; the Side Panel exposes an even narrower redacted view without fingerprints or conversation content. Existing bounded monitoring-event history now also records per-channel `NOT_REQUESTED`/`DELIVERED`/`FAILED` delivery outcome and completion timestamp, allowing the trace to distinguish an event emitted while hidden from delivery failure or delivery that completed only after foreground. It must distinguish at least: no hidden observation, observer alive but assistant snapshot unchanged, assistant changed with missing/malformed marker, marker detected with no event before foreground, event emitted but delivery failed/finished after return, and frozen/discarded lifecycle. The issue remains open until the exact integrated candidate passes owner validation in the real logged-in Chrome environment.

## Historical note

v1.x implemented guarded automatic continuation and in-chat self-check behavior. Those capabilities are intentionally removed from the v2 product contract. Historical v1 documentation may remain only when clearly labeled as historical evidence and must not be presented as current behavior.
