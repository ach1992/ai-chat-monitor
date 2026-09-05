# Changelog

## 3.0.3 — Unreleased

- Correct one independently reproduced inactive-tab completion gate: when a hidden runnable ChatGPT tab already exposes an exact canonical terminal `AI_CHAT_MONITOR_STATUS` record, that explicit end-of-response evidence outranks a stale transient Stop control so monitoring can resolve without waiting for foreground UI reconciliation. Later owner validation shows this was not the complete live root cause.
- Keep the exception deliberately narrow: visible tabs still trust the normal Stop control, while malformed/code-rendered markers remain `GENERATING` and cannot trigger premature classification.
- Replace the misleading background smoke condition that deleted `#stop` with a regression that requires `TASK_COMPLETE` while the stale Stop control is still present and the monitored tab remains hidden.
- Re-audit the v3.0.1/v3.0.2 background changes. Timer-independent hidden observation, structural status recovery, MV3 session self-healing, automatic-discard protection, frozen/discarded lifecycle reporting, and Chrome-for-Testing extension identity validation remain because each protects an independent failure mode; they are not treated as proof of this root cause.
- Keep background monitoring independent from Side Panel polling/reconnect authority while preserving the original tab-scoped Side Panel behavior: supported ChatGPT tabs get their own panel option, unsupported tabs remain disabled, and no global enabled panel is created.
- Strengthen the real Chromium regression by closing the Side Panel and force-terminating the MV3 service worker while the monitored ChatGPT-origin tab is hidden; the hidden content agent must independently wake a replacement worker and still deliver `TASK_COMPLETE`.
- Preserve actual DOM order when assistant/user candidates match different supported ChatGPT selector shapes, preventing an older turn from being mistaken for the latest response during hidden/streaming DOM reconciliation.
- Extend the hidden Chromium regression to a realistic multi-turn mixed-selector DOM and require the exact newest assistant/user message IDs before accepting `TASK_COMPLETE`.
- After further owner reproduction proved the live issue still unresolved, add bounded hidden-path diagnostics that retain timing, counts, assistant-change evidence, text lengths, generation/Stop/marker state, lifecycle, hidden event timing, and per-channel delivery outcome/timestamp without transcript text, credentials, or provider payloads. Synthetic Chrome tests are regression evidence only, not proof that the logged-in owner environment is fixed.
- Prevent a same-document/same-epoch content-agent reannounce from erasing a newer accepted observation during MV3 recovery; a genuine page-epoch/route change still drops the prior observation and hidden diagnostic.
- After owner validation of the integrated transport-completion candidate exposed an early false `RESPONSE_COMPLETE`, establish a persisted response-episode boundary at trusted `MANUAL_SEND` so the previous completed assistant/marker cannot be reprocessed as the new response's completion evidence before ChatGPT commits the next turn.
- Stop user-interaction messages from directly running semantic/completion resolution against the unchanged prior observation, while preserving page-state blocker/error notifications and the strictly read-only ChatGPT boundary.
- Require a demonstrably fresh assistant after a response starts; a fresh assistant observed in a transient `IDLE` state is not treated as complete unless it carries exact terminal semantic evidence, the current episode was actually observed generating, or bounded transport-completion evidence is correlated to that response episode.
- Reserve generic `RESPONSE_COMPLETE` for explicit completion fallback instead of using it as the default result of an otherwise ambiguous idle semantic resolution. Correlate hidden completion and deduplication to the current response episode.
- Strengthen the Chrome-for-Testing response regression to model the live race: previous completed assistant, trusted manual send, unchanged old assistant, new user ahead of the old assistant, fresh partial assistant with transient `IDLE`, current-response `GENERATING`, then hidden completion while final assistant DOM remains intentionally stale. No early completion notification is allowed.
- After the next owner reproduction, retire content-side `PerformanceResourceTiming` as response-completion authority: a live diagnostic recorded transport completion only 131 ms after backgrounding but roughly 57 seconds before the first assistant DOM change, proving that a same-endpoint page resource can be unrelated to the assistant response being generated.
- Treat hidden `IDLE` / missing Stop as non-authoritative while the current response is pending. Owner diagnostics showed the tab remained runnable and produced 93/13 hidden observations while assistant text changed and ChatGPT still exposed `IDLE` with no Stop control.
- Add non-blocking `chrome.webRequest` response-lifecycle correlation on the existing ChatGPT host scope. Only supported top-frame `POST` conversation requests with `2xx` status and `Content-Type: text/event-stream` acquire completion authority, correlated by request/tab/document identity and timestamps.
- Persist only bounded in-flight request identity/timing in `chrome.storage.session`. Do not read request bodies, response bodies, cookies, Authorization headers, or transcript payloads; do not request `webRequestBlocking` or any network mutation authority.
- Hold a pending hidden response as `GENERATING` from trusted `MANUAL_SEND` / verified stream start until exact terminal marker, matching SSE completion, matching abort/explicit Stop, or blocking/retry state. This prevents early semantic classification of partial hidden assistant text.
- Replace the prior background response smoke with a real Chromium Revision 9 regression that rejects a same-endpoint JSON `POST`, keeps a changing hidden assistant unresolved without any Stop control while SSE is open, and permits delivery only after matching SSE completion while the tab remains hidden.
- Revision 9 pre-documentation candidate `36c040a948a920c3a3aa55009bd1db48f4dbdcbb` passed CI `33927680435`: 161/161 tests, unpacked extension identity, existing hidden terminal-marker regression, Revision 9 hidden response-lifecycle regression, package verification, and artifact upload. The modeled response produced exactly one delivered Browser notification after verified SSE completion.
- Document Revision 9 completion authority, privacy, Store permission rationale, and the continued owner-validation gate. Synthetic Chrome remains regression evidence only; Issue #83 stays open until the exact integrated artifact passes the real first-after-Reload and never-return-to-tab tests.
- Owner validation of integrated Revision 9 disproved browser `webRequest.onCompleted` as response-completion authority: the generic `ChatGPT response finished` alert occurred only after leaving the tab and could be recorded near the start of a later response rather than its real end. Retire that user-visible transport fallback and remove the required `webRequest` permission/runtime.
- Add a packaged MAIN-world `document_start` observer that synchronously arms from the user's trusted Enter/Send event before ChatGPT starts its request, eliminating the isolated-world arm race seen by the strengthened Chromium regression.
- Delegate ChatGPT's original `fetch` unchanged and observe only a cloned supported conversation SSE. Keep a bounded rolling tail in page memory, persist no stream payload, and emit no outcome unless the actual stream reaches `data: [DONE]`.
- At real `[DONE]`, make outcomes mutually exclusive: a valid canonical `AI_CHAT_MONITOR_STATUS` produces only its semantic event; otherwise emit only `RESPONSE_COMPLETE`. A stream ending without `[DONE]` fails closed, and late DOM/foreground marker reconciliation is deduplicated against the response episode.
- Replace the Revision 9 response smoke with a two-response Revision 10 Chromium regression: a hidden stale-DOM response without a marker must deliver one generic completion only after `[DONE]`; the next hidden response with a terminal marker must deliver only `TASK_COMPLETE`, with no generic or late DOM/foreground duplicate.

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
- Prevented recovery and uncertainty replies from repeating within the same human-interaction epoch while retaining identity, OWNER/MIRROR, human-precedence, no-blind-retry, stagnation detection, and hard-fuse safeguards.

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