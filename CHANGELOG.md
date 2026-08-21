# Changelog

## 1.2.2 — 2026-08-22

- Reworked Telegram notifications into a structured, easier-to-scan layout with a consistent Guardian header, divider, event-specific visual markers, clearly separated details, and conversation identity.
- Added distinct visual markers for response completion, human-attention, uncertainty, stagnation, provider-error, and extension-error notifications.
- Updated the Telegram test notification to use the same structured presentation while preserving its no-chat-content privacy boundary.
- Preserved existing notification selection, delivery authority, credential handling, 700-character message bound, browser notifications, and ChatGPT automation behavior.
- Added regression coverage for Telegram message structure, event markers, bounds, channel coexistence, and test-notification privacy.

Tracking: [PR #62](https://github.com/ach1992/chat-turn-guardian/pull/62).

## 1.2.1 — 2026-08-20

- Reworked the one-time conversation protocol into a readable multiline prompt that explicitly preserves the current project's direction, scope, priority, and plan.
- Preserved those line breaks when Guardian writes into ChatGPT's contenteditable composer.
- Added exact status-specific automatic replies: autonomous continuation for `CONTINUE`, one bounded recheck for `PLATFORM_ERROR`/`RATE_LIMIT`, one reclassification request for `UNSURE`, and no message for HOLD or `COMPLETE`.
- Prevented recovery and uncertainty replies from repeating within the same human-interaction epoch while retaining identity, OWNER/MIRROR, human-precedence, no-blind-retry, stagnation, and hard-fuse safeguards.

Tracking: [Issue #57](https://github.com/ach1992/chat-turn-guardian/issues/57).

## 1.2.0 — 2026-08-20

- Added the strict terminal `CHAT_TURN_GUARDIAN_STATUS_V1` protocol so a machine-readable final status is consumed directly without an unnecessary self-check.
- Limited the in-chat protocol bootstrap to eligible ambiguous responses that do not already contain a valid terminal status.
- Prevented recursive self-check loops: a missing or malformed activation status fails closed to `UNSURE`.
- Preserved deterministic hard-HOLD precedence, human interaction precedence, OWNER/MIRROR isolation, stale-state cancellation, final synchronous send guards, stagnation detection, and the hard fuse.
- Hardened terminal-status parsing for duplicate keys/markers, extra fields, code-block wrappers, flattened rendered DOM suffixes, and trailing content.
- Added a bounded durable guarded-write journal as negative authority across browser/service-worker restarts, without storing full transcripts.
- Excluded protocol markers and bootstrap control turns from progress/fuse accounting.

Tracking: [Issue #56](https://github.com/ach1992/chat-turn-guardian/issues/56) and [PR #55](https://github.com/ach1992/chat-turn-guardian/pull/55).

## 1.1.0

- Added same-conversation in-chat self-check classification and contextual resume behavior for eligible ambiguous stops.

Tracking: [Issue #51](https://github.com/ach1992/chat-turn-guardian/issues/51).

## 1.0.0

- Established the Manifest V3 guarded-supervision baseline, multi-chat safety model, provider and Telegram integrations, deterministic release packaging, and Chrome Web Store engineering-readiness evidence.
