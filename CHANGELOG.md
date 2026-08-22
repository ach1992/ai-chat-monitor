# Changelog

## 2.0.0 — release candidate

- Pivoted Chat Turn Guardian from guarded automatic continuation to a strictly read-only ChatGPT monitor/notifier.
- Removed ChatGPT composer mutation, guarded-send, automatic Retry/Continue behavior, self-check/bootstrap/recovery turns, continuation timing/cooldown, write-journal authority, and automatic-control OWNER/MIRROR semantics.
- Added monitoring policy schema v2 with safe migration from v1.2.5: old `OFF` stays disabled; `OBSERVE`, `NOTIFY_ONLY`, and `AUTO` migrate to monitoring enabled without restoring send authority.
- Added normalized monitoring page states and transition/episode events for response completion, manual continuation availability, human gates, completion, Retry/error/rate-limit/auth/verification/conversation-limit states, provider failure/unknown state, generation stall, and repeated-response diagnostics.
- Added conversation/response event history and deduplication across DOM churn, service-worker restarts, and duplicate tabs.
- Added independently configurable Browser and local Sound event routing; Sound uses a Manifest V3 offscreen document.
- Preserved outbound-only Telegram notifications and provider fallback while making both strictly observational.
- Replaced the public protocol marker with stable `CHAT_TURN_GUARDIAN_STATUS={"decision":"<VALUE>"}` while retaining `_V1` parsing for compatibility only.
- Hardened marker parsing so the record must be the unique standalone terminal line and is rejected inside backtick/tilde code fences or other non-standalone output containers.
- Added Side Panel status-protocol setup with separate copyable Custom Instructions and per-chat instruction variants; Guardian never sends either instruction itself.
- Added marker health, current page/semantic state and source, monitoring ON/OFF, event controls, provider/Telegram management, and bounded event diagnostics to the Side Panel.
- Updated package/manifest version to `2.0.0` and rewrote README, Project Spec, Architecture, Privacy, Store listing/readiness, and status-protocol documentation for the new single purpose.
- Updated regression coverage to enforce the read-only runtime/protocol boundary and the v2 permission/data-handling model.

Tracking: [Issue #71](https://github.com/ach1992/chat-turn-guardian/issues/71) and [PR #72](https://github.com/ach1992/chat-turn-guardian/pull/72).

## 1.2.5 — 2026-08-22

- Fixed hidden/background-tab status reading when Chromium leaves layout-derived `innerText` stale while the conversation DOM already contains the completed assistant response.
- In hidden tabs, Guardian now recovers a terminal `CHAT_TURN_GUARDIAN_STATUS_V1` marker from structural DOM text only on the latest assistant turn and never from `pre`/`code`.
- Guarded-send reconciliation can match the exact Guardian-owned user turn from background-safe DOM evidence while retaining conversation/route identity, DOM ordering, trusted-human-state checks, fail-closed ambiguity handling, and no blind retry.
- Foreground/visible-tab rendered-text behavior remains unchanged.
- Added focused regression coverage for hidden-tab `HOLD_HUMAN_OPERATION`, exact user-turn verification, code-block rejection, and visible-tab behavior.

Tracking: [PR #68](https://github.com/ach1992/chat-turn-guardian/pull/68).

## 1.2.4 — 2026-08-22

- Fixed the remaining background/inactive-tab guarded-send false positive caused by Chromium timer throttling hiding the transient generation/Stop state.
- Post-send verification now accepts either the observed generation state or a genuinely fresh assistant turn that follows the exact intended Guardian user turn in the same conversation/route.
- Kept trusted human-state checks active during verification so human interaction still invalidates pending automation.
- Preserved fail-closed and no-blind-retry behavior when neither positive send signal can be proven.
- Added a focused regression that completes the assistant response immediately without ever exposing a Stop control, matching the live background-tab failure mode.

Tracking: [PR #66](https://github.com/ach1992/chat-turn-guardian/pull/66).

## 1.2.3 — 2026-08-22

- Fixed a live false-positive guarded-send error that could occur when ChatGPT completed a Guardian-triggered response too quickly for the generation/Stop state to be sampled.
- Preserved fail-closed send verification: fast completion is reconciled only when the exact intended Guardian user turn is present, the same conversation/route remains current, human state is unchanged, the page is high-confidence and idle, no blocker is present, and a fresh assistant response follows that turn.
- Preserved the no-blind-retry invariant; unresolved or stale send evidence remains `AMBIGUOUS_WRITE`.
- Upgraded Telegram notification presentation to Telegram HTML with bold Guardian/event headings, bold Conversation labels, code-formatted conversation IDs, and italicized privacy text in Test notifications.
- Escaped all dynamic Telegram text before HTML formatting so notification content cannot break markup or inject formatting.
- Added regression coverage for rapid completed-send reconciliation, stale/human-changed fail-closed cases, Telegram HTML structure/escaping/bounds, and `parse_mode: HTML` transport behavior.

Tracking: [PR #64](https://github.com/ach1992/chat-turn-guardian/pull/64).

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
