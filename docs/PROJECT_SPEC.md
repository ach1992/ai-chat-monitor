# AI Chat Monitor — Project Specification

## Product version

Current published stable baseline: **v3.0.2**

Current development source: **v3.0.3 candidate, unreleased**

v3 establishes the AI Chat Monitor product identity and sole `AI_CHAT_MONITOR_STATUS` protocol while preserving the read-only monitoring/notification boundary established by v2. The current v3.0.3 candidate includes Issue #83 Revision 10 page-stream terminal authority. No v3.0.3 release is authorized until the exact integrated candidate passes owner live validation.

## Product goal

AI Chat Monitor helps a user observe selected long-running ChatGPT Web conversations without keeping every tab in focus. It detects response/runtime state, resolves an optional semantic work state, and delivers useful notifications while preserving full human control of the conversation.

## Single purpose

AI Chat Monitor may observe supported ChatGPT pages and notify the user.

AI Chat Monitor must never:

- write to the ChatGPT composer;
- click or programmatically activate Send, Retry, Continue generating, Regenerate, Stop, confirmation, verification, or other ChatGPT conversation controls;
- create or inject protocol bootstrap, self-check, recovery, continuation, or other user turns;
- automatically continue a conversation;
- alter, redirect, cancel, or rewrite ChatGPT requests;
- use Telegram or AI-provider output as browser mutation authority;
- bypass platform limits, authentication, verification, CAPTCHAs, approvals, confirmations, or safety controls.

This invariant applies even when semantic state is `CONTINUE`.

## Supported environment

- Chromium Manifest V3 extension.
- Chrome/Chromium 114+ baseline because the Manifest V3 Side Panel and MAIN-world content-script execution model are required.
- Supported ChatGPT origins:
  - `https://chatgpt.com/*`
  - `https://chat.openai.com/*`
- Node.js 22+ for repository development/building.

## State model

AI Chat Monitor keeps page/runtime state separate from semantic conversation state.

### Page/runtime state

Representative states include `GENERATING`, `IDLE`, `RETRY_AVAILABLE`, platform/network error, rate limit, authentication/verification required, conversation-full, and unknown state.

High-confidence blocker state is authoritative over semantic/provider evidence.

For a hidden response, adapter `IDLE` and absence of the Stop control are observational only while the current response is pending. Owner live evidence proved ChatGPT can keep changing the assistant DOM in a runnable hidden tab while those UI signals look idle.

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

`CONTINUE` means only that a human may manually continue. It never grants automatic-send authority.

## Optional machine-readable status protocol

Canonical public record:

```text
AI_CHAT_MONITOR_STATUS={"decision":"<VALUE>"}
```

Rules:

- optional; monitoring must work without it;
- exactly one terminal record when used;
- final standalone line of the same assistant turn;
- nothing after it;
- outside Markdown/code/quoted/table or other format-specific containers;
- omit it when an exact/exclusive user output format would be invalidated by an extra line.

Multiple markers, malformed JSON, unsupported decisions, or embedded/code-rendered markers are invalid and fall through safely.

A canonical terminal marker on the current hidden assistant is explicit completion evidence and may outrank a stale Stop control. Invalid marker text never does.

## Response episode and completion authority

A trusted user Send opens a response episode against the previous assistant identity in both extension worlds: the MAIN-world observer sees the trusted Enter/Send event in capture phase before ChatGPT starts its request, while the isolated content agent records the corresponding monitoring response episode. This prevents the prior completed assistant/marker from being reprocessed as the new response and removes the asynchronous arm race.

Owner validation has disproved three previously attempted standalone hidden-completion signals:

1. generic content `PerformanceResourceTiming` / resource-end timing;
2. hidden adapter `IDLE` / missing Stop while a response is pending;
3. Revision 9 browser `webRequest.onCompleted` for a same-endpoint SSE request.

Revision 10 therefore derives the response outcome from the actual page response stream. For an armed supported ChatGPT conversation `POST`, the packaged MAIN-world observer delegates the original `fetch` unchanged, consumes a cloned `text/event-stream` response locally, and waits for the real `data: [DONE]` terminator.

At `[DONE]`, the mutually exclusive outcome is:

- if exactly one canonical supported `AI_CHAT_MONITOR_STATUS={...}` is present in the bounded terminal stream tail, emit only that semantic decision;
- otherwise emit only generic `RESPONSE_COMPLETE`;
- if the stream ends without `[DONE]`, emit no completion outcome.

A valid terminal status therefore suppresses generic response-finished notification for that response. Late DOM/foreground marker reconciliation is deduplicated against the already delivered response episode. No stable-text timeout or elapsed-time heuristic may fabricate completion because a hidden renderer can pause mid-response.

## MAIN-world response-stream observation

`src/content/main-stream-observer.ts` is a packaged `document_start` content script in Chrome's MAIN world on only the supported ChatGPT origins. It is disabled by default; trusted extension policy state enables it only for the selected monitored conversation. It observes trusted Enter/Send user input in capture phase and passively wraps `window.fetch`.

For an enabled monitored conversation, the original fetch receives the exact original arguments and the original `Response` object is returned unchanged to ChatGPT. Only an armed `POST` to a supported exact conversation endpoint with `Content-Type: text/event-stream` is cloned for observation. The clone is consumed locally while retaining at most a 16 KiB rolling in-memory tail; only the final 4 KiB is used for terminal-marker matching.

The rolling tail is transient page memory. It is not written to extension storage/history/logs, Telegram, provider payloads, or developer infrastructure. The observer does not inspect request bodies, cookies, Authorization headers, or credential headers and cannot modify, redirect, cancel, retry, replay, or rewrite the request/response. Only the response episode timestamp and one minimal outcome (terminal decision or generic response complete) cross to the isolated extension runtime.

Revision 10 removes the Revision 9 `webRequest` permission and browser response-transport runtime.

See `docs/REV10_PAGE_STREAM_TERMINAL.md`.

## Semantic resolution order

After the current response has legitimate completion/stability authority:

1. authoritative/high-confidence page/UI blocker evidence;
2. valid terminal status marker;
3. strong deterministic local rules;
4. optional configured AI provider fallback;
5. `UNKNOWN` / `UNSURE`.

Provider fallback is advisory, bounded, secret-redacted, cached/deduplicated by response identity, and cannot cause page mutation.

For a completed page response stream, a valid terminal status produces only its semantic event; only the absence of a valid terminal status permits generic `RESPONSE_COMPLETE`. Late DOM/provider reconciliation cannot create a second user notification for the same delivered response episode.

## Monitoring events

Core events include response complete, manual continuation available, human gates, task complete, Retry, platform/network error, rate limit, authentication/verification, conversation-full, semantic unknown/provider failure, generation stall, and repeated-response diagnostics.

Events are response/transition oriented and deduplicated. One response must not create duplicate Browser/Telegram delivery merely because DOM or service-worker state changes repeatedly.

## Notification channels

### Browser

- configurable per event;
- uses `chrome.notifications`;
- uses the packaged extension icon;
- may focus a known monitored tab from an explicit notification interaction when safely resolvable.

### Sound

- optional local channel;
- event-selectable;
- uses a Manifest V3-compatible offscreen context.

### Telegram

- outbound notification-only;
- user supplies bot token and destination;
- bounded metadata by default, not full ChatGPT transcripts;
- no inbound remote control.

## Multi-tab and stale-document behavior

Tab/document/content-agent/page/route identity rejects stale observations and stale network lifecycle delivery. Conversation/response identity provides provider/notification deduplication across duplicate tabs.

No tab owns send authority because send authority does not exist.

## Background lifecycle behavior

- Hidden DOM observations must not depend on throttled page timers.
- Monitored tabs set `autoDiscardable: false` and restore the prior value when monitoring stops.
- `frozen` / `discarded` state is reported honestly; the extension does not claim to execute inside an actually suspended page.
- A still-running content agent self-reannounces after recoverable MV3 session loss without needing Side Panel polling or tab activation.
- Side Panel availability remains tab-scoped, but Side Panel state is never monitoring authority.

## Persistence and migration

Monitoring policy schema version: `2`.

Migration from v1 policy:

- `OFF` -> monitoring disabled;
- `OBSERVE`, `NOTIFY_ONLY`, or `AUTO` -> monitoring enabled;
- compatible notification preferences preserved where practical;
- legacy continuation/send timing/write-journal/self-check state and any pending send authority are discarded/deprecated;
- service-worker restart never restores automatic-send authority.

Durable trusted storage may contain monitoring policy/history, provider credentials, and Telegram configuration. Session/ephemeral state may contain bounded semantic cache and lifecycle/hidden diagnostics.

Full transcripts are not intentionally stored in monitoring history. The Revision 10 MAIN-world observer keeps only a bounded rolling response tail transiently in page memory and does not persist it.

## Privacy and security

- ChatGPT DOM/content is untrusted input.
- No page mutation authority exists in current runtime.
- Provider input is bounded/minimized and secret-redacted.
- Provider API keys and Telegram bot tokens stay in trusted extension storage.
- Telegram receives bounded monitoring metadata by default.
- `webRequest` and `webRequestBlocking` are not required by Revision 10.
- The MAIN-world response observer delegates the original fetch unchanged, retains only a bounded rolling SSE tail in memory, and does not inspect request bodies, cookies, Authorization headers, or credential headers.
- Broad optional HTTPS host permission is used only for user-configured HTTPS provider origins.
- Notification failure cannot change semantic state or create browser-control authority.

## Side Panel requirements

The Side Panel provides Monitoring ON/OFF, page and semantic state/source, marker health, Browser/Sound event configuration, copyable status-protocol setup, provider readiness/settings, Telegram settings/health, lifecycle state, and bounded privacy-safe diagnostics/history.

It must not expose AUTO-send, continuation text, send delay/cooldown, guarded-send, write-journal, or hard-fuse controls/claims.

## Development and release requirements

Every future candidate must retain:

- typecheck;
- lint;
- automated tests;
- real unpacked service-worker identity smoke;
- real Chromium hidden/background regression;
- deterministic package generation;
- ZIP layout/provenance verification;
- exact candidate SHA in build metadata;
- static regression enforcing the absence of ChatGPT write/control paths and required `webRequest`/`webRequestBlocking` authority.

Revision 10's browser regression must additionally prove:

1. the monitored tab remains hidden and runnable while final assistant DOM stays stale/partial;
2. no completion/semantic notification is delivered before the actual response stream outcome;
3. a response with no valid terminal status delivers exactly one `RESPONSE_COMPLETE` only after `data: [DONE]`;
4. a response with a valid terminal status delivers only the matching semantic event and never generic `RESPONSE_COMPLETE`;
5. late DOM terminal-marker catch-up and subsequent foreground activation do not duplicate user delivery.


A test artifact is not a public release. Any version publication remains a separate action after exact candidate validation/review/integration and the required owner gate.

## Historical baselines

### v2.0.0 / v2.0.1

v2 removed automatic continuation and established the durable read-only monitoring contract. v2.0.1 additionally fixed Browser notification API/icon delivery and received live Chromium validation before publication. These read-only invariants remain regression requirements.

### v3.0.1

v3.0.1 removed a hidden page-timer observation dependency, but post-release owner validation proved that change alone did not solve inactive-tab monitoring.

### v3.0.2

v3.0.2 retained independently useful structural marker recovery, content-agent MV3 self-reannouncement, automatic-discard protection, explicit frozen/discarded lifecycle state, and real unpacked-extension identity validation. Post-release owner testing still reproduced inactive-tab failure, so the release must not be presented as fully resolved.

### Issue #83 Revisions 3–8

Subsequent work corrected stale Stop handling for exact markers, restored tab-scoped Side Panel behavior, fixed mixed-selector DOM ordering, preserved fresh observations across same-session MV3 reannounce, added bounded hidden diagnostics/delivery timing, and established trusted response-episode identity after `MANUAL_SEND`. Each remains an independent reliability safeguard, but owner validation showed none was the complete remaining root cause.

### Issue #83 Revision 9

Owner diagnostics showed the monitored tab remained runnable and assistant DOM changed while hidden UI reported `IDLE` with no Stop. They also showed the prior ResourceTiming completion arriving about 57 seconds before the first assistant change. Revision 9 replaced those signals with non-blocking browser `webRequest` SSE lifecycle correlation and passed synthetic Chromium/CI evidence, but owner validation of integrated `main@920937ad36b336b4e9c352f74047c600c40373a8` disproved that completion authority as well: generic response-finished delivery remained background-only/early and inactive-tab semantic completion still depended on foreground reconciliation. Revision 9 is retained as historical evidence, not current authority.

### Issue #83 Revision 10

Revision 10 moves response outcome authority to the actual user-initiated page response stream. A packaged MAIN-world observer arms synchronously from trusted Enter/Send, delegates ChatGPT's original fetch unchanged, reads only a cloned bounded rolling SSE tail locally, and resolves the response only at real `data: [DONE]`. A valid terminal `AI_CHAT_MONITOR_STATUS` suppresses generic response completion; without a valid marker, `[DONE]` produces one generic `RESPONSE_COMPLETE`. Late DOM/foreground catch-up is deduplicated against that episode. Revision 10 removes the Revision 9 `webRequest` permission/runtime. Owner validation of the exact integrated artifact remains mandatory; Issue #83 stays open until that outcome passes.

## Historical v1 note

v1.x implemented guarded automatic continuation and in-chat self-check behavior. Those capabilities are intentionally removed from the current product contract and may appear only as historical evidence.