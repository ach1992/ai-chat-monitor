# Changelog

## 3.0.3 — Unreleased

- Correct the remaining inactive-tab completion gate: when a hidden runnable ChatGPT tab already exposes an exact canonical terminal `AI_CHAT_MONITOR_STATUS` record, that explicit end-of-response evidence outranks a stale transient Stop control so monitoring can resolve and notify without tab activation.
- Keep the exception deliberately narrow: visible tabs still trust the normal Stop control, while malformed/code-rendered markers remain `GENERATING` and cannot trigger premature classification.
- Replace the misleading background smoke condition that deleted `#stop` with a regression that requires `TASK_COMPLETE` while the stale Stop control is still present and the monitored tab remains hidden.
- Re-audit the v3.0.1/v3.0.2 background changes. Timer-independent hidden observation, structural status recovery, MV3 session self-healing, automatic-discard protection, frozen/discarded lifecycle reporting, and Chrome-for-Testing extension identity validation remain because each protects an independent failure mode; they are not treated as proof of this root cause.
- Decouple the management UI from the active tab: use one global Side Panel across tabs, remove Side Panel polling as a content-agent reconnect authority, refresh current-tab UI promptly on tab/lifecycle changes, and show bounded observer evidence (`hidden`/`visible`, observation age, generation, lifecycle) for each monitored chat.
- Strengthen the real Chromium regression by closing the Side Panel and force-terminating the MV3 service worker while the monitored ChatGPT-origin tab is hidden; the hidden content agent must independently wake a replacement worker and still deliver `TASK_COMPLETE`.
- Preserve actual DOM order when assistant/user candidates match different supported ChatGPT selector shapes, preventing an older turn from being mistaken for the latest response during hidden/streaming DOM reconciliation.
- Extend the hidden Chromium regression to a realistic multi-turn mixed-selector DOM and require the exact newest assistant/user message IDs before accepting `TASK_COMPLETE`.

Tracking: [Issue #83](https://github.com/ach1992/ai-chat-monitor/issues/83).

## 3.0.2 — 2026-09-04

- Correct hidden/background terminal-status extraction when Chromium exposes a stale/flattened rendered status prefix: structural terminal evidence now restores the final-line boundary before the existing fail-closed parser runs.
- Make a still-running content agent self-reannounce after recoverable MV3 background-session loss instead of waiting for active-tab/Side Panel reconnect behavior.
- Protect monitored tabs from Chrome automatic discard while monitoring is enabled, restore the prior tab setting when monitoring stops, and surface frozen/discarded lifecycle state explicitly.
- Replace the previous false-positive unpacked-extension smoke check with service-worker identity verification and add a real Chrome for Testing background-tab regression that proves hidden `TASK_COMPLETE` detection, lifecycle protection, and Browser-channel behavior where the test desktop retains notifications; deterministic notification-manager regressions cover Browser/Telegram routing independently of desktop-daemon availability.

Tracking: [Issue #91](https://github.com/ach1992/ai-chat-monitor/issues/91), [Issue #83](https://github.com/ach1992/ai-chat-monitor/issues/83), [PR #90](https://github.com/ach1992/ai-chat-monitor/pull/90), [PR #92](https://github.com/ach1992/ai-chat-monitor/pull/92), and [Release v3.0.2](https://github.com/ach1992/ai-chat-monitor/releases/tag/v3.0.2).

## 3.0.1 — 2026-09-04

- Attempted to restore reliable read-only monitoring for hidden/background ChatGPT tabs by making DOM-triggered observations independent of throttled page timers while the page remains runnable. A post-release owner reproduction later proved this fix incomplete; see the v3.0.2 corrective release above.
- Added immediate observation catch-up on tab visibility changes while preserving the existing foreground debounce behavior.
- Replaced the packaged 16/32/48/128 extension icons with the owner-provided AI Chat Monitor icon set.
- Added regression coverage for hidden-tab scheduling, foreground debounce, and visibility catch-up; Browser and Telegram notification routing remain unchanged downstream of monitoring.
- Preserved the strictly read-only ChatGPT boundary, permissions, provider behavior, Browser/sound notifications, and outbound-only Telegram behavior.

Tracking: [Issue #85](https://github.com/ach1992/ai-chat-monitor/issues/85), [Issue #83](https://github.com/ach1992/ai-chat-monitor/issues/83), [PR #84](https://github.com/ach1992/ai-chat-monitor/pull/84), [PR #86](https://github.com/ach1992/ai-chat-monitor/pull/86), and [Release v3.0.1](https://github.com/ach1992/ai-chat-monitor/releases/tag/v3.0.1).

## 3.0.0 — 2026-08-30

- Renamed the repository, extension, package, release artifact, UI, notifications, privacy policy, and current documentation to AI Chat Monitor / `ai-chat-monitor`.
- Replaced the public status protocol with the sole `AI_CHAT_MONITOR_STATUS={"decision":"<VALUE>"}` marker and removed all legacy marker parsing and UI states.
- Preserved the strictly read-only ChatGPT monitoring, provider, Browser/sound, Telegram, permission, and safety boundaries.
- Added regression coverage proving retired product markers are not recognized and background-tab recovery responds only to the new marker.

Tracking: [Issue #80](https://github.com/ach1992/ai-chat-monitor/issues/80).


## 2.0.1 — 2026-08-23

- Fixed Browser notifications in the v2 runtime by using the packaged extension icon through `chrome.runtime.getURL()` and the Promise-based `chrome.notifications.create()` API.
- Added direct regression coverage for the real Browser notification wrapper, including exact notification options and delivery-failure propagation.
- Completed live Chromium/Windows validation with real monitored events after the fix; Browser notifications now display as expected.
- Preserved the v2 read-only contract, monitoring/classification behavior, Telegram/provider boundaries, event selection, and deduplication semantics.

Tracking: [Issue #74](https://github.com/ach1992/ai-chat-monitor/issues/74), [PR #75](https://github.com/ach1992/ai-chat-monitor/pull/75), and [Release v2.0.1](https://github.com/ach1992/ai-chat-monitor/releases/tag/v2.0.1).

## 2.0.0 — 2026-08-22

- Pivoted AI Chat Monitor from guarded automatic continuation to a strictly read-only ChatGPT monitor/notifier.
- Removed ChatGPT composer mutation, guarded-send, automatic Retry/Continue behavior, self-check/bootstrap/recovery turns, continuation timing/cooldown, write-journal authority, and automatic-control OWNER/MIRROR semantics.
- Added monitoring policy schema v2 with safe migration from v1.2.5: old `OFF` stays disabled; `OBSERVE`, `NOTIFY_ONLY`, and `AUTO` migrate to monitoring enabled without restoring send authority.
- Added normalized monitoring page states and transition/episode events for response completion, manual continuation availability, human gates, completion, Retry/error/rate-limit/auth/verification/conversation-limit states, provider failure/unknown state, generation stall, and repeated-response diagnostics.
- Added conversation/response event history and deduplication across DOM churn, service-worker restarts, and duplicate tabs.
- Added independently configurable Browser and local Sound event routing; Sound uses a Manifest V3 offscreen document.
- Preserved outbound-only Telegram notifications and provider fallback while making both strictly observational.
- Replaced the public protocol marker with stable `AI_CHAT_MONITOR_STATUS={"decision":"<VALUE>"}` as the sole supported public protocol marker.
- Hardened marker parsing so the record must be the unique standalone terminal line and is rejected inside backtick/tilde code fences or other non-standalone output containers.
- Added Side Panel status-protocol setup with separate copyable Custom Instructions and per-chat instruction variants; AI Chat Monitor never sends either instruction itself.
- Added marker health, current page/semantic state and source, monitoring ON/OFF, event controls, provider/Telegram management, and bounded event diagnostics to the Side Panel.
- Updated package/manifest version to `2.0.0` and rewrote README, Project Spec, Architecture, Privacy, Store listing/readiness, and status-protocol documentation for the new single purpose.
- Updated regression coverage to enforce the read-only runtime/protocol boundary and the v2 permission/data-handling model.
- Completed Owner live Chromium acceptance and integrated PR #72 into `main` at `eb4e90a21cd578620bda855ce2e3ab37aee39027`.
- Published GitHub Release `v2.0.0` with a 48-file extension ZIP; SHA-256 `800d76293a867e3ba0c8780dfb932788b55bc9393f03112d2b73801f10c70c2f`.

Tracking: [Issue #71](https://github.com/ach1992/ai-chat-monitor/issues/71), [PR #72](https://github.com/ach1992/ai-chat-monitor/pull/72), and [Release v2.0.0](https://github.com/ach1992/ai-chat-monitor/releases/tag/v2.0.0).

## 1.2.5 — 2026-08-22

- Fixed hidden/background-tab status reading when Chromium leaves layout-derived `innerText` stale while the conversation DOM already contains the completed assistant response.
- In hidden tabs, AI Chat Monitor now recovers a terminal status marker from structural DOM text only on the latest assistant turn and never from `pre`/`code`.
- Guarded-send reconciliation can match the exact AI Chat Monitor-owned user turn from background-safe DOM evidence while retaining conversation/route identity, DOM ordering, trusted-human-state checks, fail-closed ambiguity handling, and no blind retry.
- Foreground/visible-tab rendered-text behavior remains unchanged.
- Added focused regression coverage for hidden-tab `HOLD_HUMAN_OPERATION`, exact user-turn verification, code-block rejection, and visible-tab behavior.

Tracking: [PR #68](https://github.com/ach1992/ai-chat-monitor/pull/68).

## 1.2.4 — 2026-08-22

- Fixed the remaining background/inactive-tab guarded-send false positive caused by Chromium timer throttling hiding the transient generation/Stop state.
- Post-send verification now accepts either the observed generation state or a genuinely fresh assistant turn that follows the exact intended AI Chat Monitor user turn in the same conversation/route.
- Kept trusted human-state checks active during verification so human interaction still invalidates pending automation.
- Preserved fail-closed and no-blind-retry behavior when neither positive send signal can be proven.
- Added a focused regression that completes the assistant response immediately without ever exposing a Stop control, matching the live background-tab failure mode.

Tracking: [PR #66](https://github.com/ach1992/ai-chat-monitor/pull/66).

## 1.2.3 — 2026-08-22

- Fixed a live false-positive guarded-send error that could occur when ChatGPT completed a AI Chat Monitor-triggered response too quickly for the generation/Stop state to be sampled.
- Preserved fail-closed send verification: fast completion is reconciled only when the exact intended AI Chat Monitor user turn is present, the same conversation/route remains current, human state is unchanged, the page is high-confidence and idle, no blocker is present, and a fresh assistant response follows that turn.
- Preserved the no-blind-retry invariant; unresolved or stale send evidence remains `AMBIGUOUS_WRITE`.
- Upgraded Telegram notification presentation to Telegram HTML with bold AI Chat Monitor/event headings, bold Conversation labels, code-formatted conversation IDs, and italicized privacy text in Test notifications.
- Escaped all dynamic Telegram text before HTML formatting so notification content cannot break markup or inject formatting.
- Added regression coverage for rapid completed-send reconciliation, stale/human-changed fail-closed cases, Telegram HTML structure/escaping/bounds, and `parse_mode: HTML` transport behavior.

Tracking: [PR #64](https://github.com/ach1992/ai-chat-monitor/pull/64).

## 1.2.2 — 2026-08-22

- Reworked Telegram notifications into a structured, easier-to-scan layout with a consistent AI Chat Monitor header, divider, event-specific visual markers, clearly separated details, and conversation identity.
- Added distinct visual markers for response completion, human-attention, uncertainty, stagnation, provider-error, and extension-error notifications.
- Updated the Telegram test notification to use the same structured presentation while preserving its no-chat-content privacy boundary.
- Preserved existing notification selection, delivery authority, credential handling, 700-character message bound, browser notifications, and ChatGPT automation behavior.
- Added regression coverage for Telegram message structure, event markers, bounds, channel coexistence, and test-notification privacy.

Tracking: [PR #62](https://github.com/ach1992/ai-chat-monitor/pull/62).

## 1.2.1 — 2026-08-20

- Reworked the one-time conversation protocol into a readable multiline prompt that explicitly preserves the current project's direction, scope, priority, and plan.
- Preserved those line breaks when AI Chat Monitor writes into ChatGPT's contenteditable composer.
- Added exact status-specific automatic replies: autonomous continuation for `CONTINUE`, one bounded recheck for `PLATFORM_ERROR`/`RATE_LIMIT`, one reclassification request for `UNSURE`, and no message for HOLD or `COMPLETE`.
- Prevented recovery and uncertainty replies from repeating within the same human-interaction epoch while retaining identity, OWNER/MIRROR, human-precedence, no-blind-retry, stagnation, and hard-fuse safeguards.

Tracking: [Issue #57](https://github.com/ach1992/ai-chat-monitor/issues/57).

## 1.2.0 — 2026-08-20

- Added the strict terminal status protocol so a machine-readable final status is consumed directly without an unnecessary self-check.
- Limited the in-chat protocol bootstrap to eligible ambiguous responses that do not already contain a valid terminal status.
- Prevented recursive self-check loops: a missing or malformed activation status fails closed to `UNSURE`.
- Preserved deterministic hard-HOLD precedence, human interaction precedence, OWNER/MIRROR isolation, stale-state cancellation, final synchronous send guards, stagnation detection, and the hard fuse.
- Hardened terminal-status parsing for duplicate keys/markers, extra fields, code-block wrappers, flattened rendered DOM suffixes, and trailing content.
- Added a bounded durable guarded-write journal as negative authority across browser/service-worker restarts, without storing full transcripts.
- Excluded protocol markers and bootstrap control turns from progress/fuse accounting.

Tracking: [Issue #56](https://github.com/ach1992/ai-chat-monitor/issues/56) and [PR #55](https://github.com/ach1992/ai-chat-monitor/pull/55).

## 1.1.0

- Added same-conversation in-chat self-check classification and contextual resume behavior for eligible ambiguous stops.

Tracking: [Issue #51](https://github.com/ach1992/ai-chat-monitor/issues/51).

## 1.0.0

- Established the Manifest V3 guarded-supervision baseline, multi-chat safety model, provider and Telegram integrations, deterministic release packaging, and Chrome Web Store engineering-readiness evidence.
