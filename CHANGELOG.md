# Changelog

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
