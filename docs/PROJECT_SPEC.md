# AI Chat Monitor — Project Specification

## Product version

Current published stable baseline: **v3.0.2**

Current development source: **v3.0.3 candidate, unreleased**

v3 establishes the AI Chat Monitor product identity and sole `AI_CHAT_MONITOR_STATUS` protocol while preserving the read-only monitoring/notification boundary established by v2. The current v3.0.3 candidate includes Issue #83 Revision 9 browser-response lifecycle correlation. No v3.0.3 release is authorized until the exact integrated candidate passes owner live validation.

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
- Chrome/Chromium 114+ baseline because Side Panel and document-scoped request identity are required.
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

A trusted `MANUAL_SEND` immediately opens a new response episode against the previous assistant identity. This prevents the prior completed assistant/marker from being reprocessed as the new response.

Revision 9 removes two previously attempted hidden completion assumptions:

1. generic content `PerformanceResourceTiming` / resource-end timing is not completion authority;
2. hidden adapter `IDLE` / missing Stop is not completion authority while a response is pending.

For a hidden response, completion authority is limited to:

- an exact canonical terminal status on the current assistant turn; or
- successful completion of the exact current ChatGPT SSE response observed at browser level.

No stable-text timeout or elapsed-time heuristic is allowed to fabricate completion because a hidden renderer may pause mid-response.

## Browser response lifecycle correlation

The service worker uses non-blocking `chrome.webRequest` on the existing ChatGPT hosts. A request may acquire response-completion authority only when it is:

- on a supported exact ChatGPT conversation-response path;
- `xmlhttprequest` in the top frame with document identity;
- `POST`;
- successful (`2xx`);
- returned as `Content-Type: text/event-stream`.

The request is correlated by request ID, tab ID, document ID, and timestamps. Bounded in-flight identity is stored in `chrome.storage.session` so service-worker restart cannot confuse an unrelated request with the current response.

Matching `onCompleted` may release the hidden response hold. Matching `onErrorOccurred` retires the request without completion. Mismatched/terminal request records are removed rather than left as stale completion authority.

The network observer does not read request bodies, response bodies, cookies, or Authorization headers. `webRequestBlocking` is not requested.

See `docs/REV9_BROWSER_RESPONSE_LIFECYCLE.md`.

## Semantic resolution order

After the current response has legitimate completion/stability authority:

1. authoritative/high-confidence page/UI blocker evidence;
2. valid terminal status marker;
3. strong deterministic local rules;
4. optional configured AI provider fallback;
5. `UNKNOWN` / `UNSURE`.

Provider fallback is advisory, bounded, secret-redacted, cached/deduplicated by response identity, and cannot cause page mutation.

For verified hidden SSE completion, semantic diagnostics may still be retained. If no semantic event was actually delivered for that episode, one generic `RESPONSE_COMPLETE` fallback may be delivered. A non-delivered diagnostic entry does not count as a second user notification.

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

Durable trusted storage may contain monitoring policy/history, provider credentials, and Telegram configuration. Session/ephemeral state may contain bounded semantic cache, lifecycle/hidden diagnostics, and current request correlation metadata.

Full transcripts are not intentionally stored in monitoring history. Network payloads and credential headers are not persisted for response correlation.

## Privacy and security

- ChatGPT DOM/content is untrusted input.
- No page mutation authority exists in current runtime.
- Provider input is bounded/minimized and secret-redacted.
- Provider API keys and Telegram bot tokens stay in trusted extension storage.
- Telegram receives bounded monitoring metadata by default.
- `webRequest` is non-blocking and restricted to the supported ChatGPT host scope for response lifecycle correlation.
- Request bodies, response bodies, cookies, and Authorization headers are outside the Revision 9 network-correlation data model.
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
- static regression enforcing the absence of ChatGPT write/control and `webRequestBlocking` paths.

Revision 9's browser regression must additionally prove:

1. same-endpoint non-SSE traffic cannot complete a response;
2. a hidden partial assistant with no Stop remains `GENERATING` while the current response is pending;
3. no response notification is delivered while the verified SSE remains open;
4. matching SSE completion can complete/deliver while the tab remains hidden;
5. only one user notification delivery occurs for the modeled response episode.

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

Owner diagnostics finally showed the monitored tab remained runnable and assistant DOM changed while hidden UI reported `IDLE` with no Stop. They also showed the prior ResourceTiming completion arriving about 57 seconds before the first assistant change. Revision 9 therefore moves hidden completion authority to exact terminal marker or positively identified browser SSE lifecycle and conservatively holds partial hidden responses as generating.

Pre-documentation candidate `36c040a948a920c3a3aa55009bd1db48f4dbdcbb` passed CI `33927680435`, 161/161 tests, extension identity, both hidden/background Chromium regressions, packaging, and artifact verification. Documentation changes after that candidate require fresh exact-head CI. Owner validation of the exact integrated artifact remains mandatory; Issue #83 stays open until that outcome passes.

## Historical v1 note

v1.x implemented guarded automatic continuation and in-chat self-check behavior. Those capabilities are intentionally removed from the current product contract and may appear only as historical evidence.