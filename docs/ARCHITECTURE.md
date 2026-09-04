# AI Chat Monitor — Architecture

## Overview

AI Chat Monitor is a Chromium Manifest V3 extension that observes supported ChatGPT conversations, derives normalized runtime and semantic state, and emits deduplicated monitoring events to user-selected Browser, local Sound, and outbound Telegram channels.

There is no ChatGPT write/control path in the current architecture.

```text
ChatGPT DOM -----------------------> content adapter / content agent
                                         |
ChatGPT SSE lifecycle --> webRequest ----+----> session registry
                                              |
                                              v
                                       monitoring service
                                       |-- page-state resolver
                                       |-- terminal status parser
                                       |-- deterministic classifier
                                       |-- optional provider fallback
                                       |-- response/episode dedupe
                                       |-- bounded history
                                              |
                    +-------------------------+-------------------------+
                    |                         |                         |
               Browser alert             local Sound            Telegram outbound
```

## Trust and authority model

### ChatGPT page

The page, DOM, and chat content are untrusted inputs. Content scripts may observe supported state but expose no command that writes the composer or activates Send, Retry, Continue generating, Regenerate, Stop, confirmation, verification, or other conversation controls.

### Content adapter

`src/content/adapter.ts` normalizes:

- document visibility and observation time;
- generation/Stop-control state;
- latest assistant/user identity and bounded normalized text;
- page confidence and blocker reasons;
- Retry/action state;
- conversation/route identity.

Assistant and user candidates from alternate supported selectors are resolved in actual DOM order. Selector-group order is never treated as conversation chronology.

A hidden exact canonical terminal `AI_CHAT_MONITOR_STATUS={...}` may outrank a stale Stop control because the marker is explicit terminal evidence. Visible tabs retain normal Stop-control semantics; malformed, duplicate, unsupported, or code-rendered markers never take this path.

### Content agent

`src/content/index.ts` reports observations and user-interaction boundaries to the background runtime. A trusted `MANUAL_SEND` opens a local pending-response boundary immediately so the previous assistant cannot be reused before ChatGPT commits the new turn.

While a response is pending and the document is hidden, transient adapter `IDLE` / missing Stop state is observational only. Unless an exact terminal marker, a verified matching response-stream completion, an abort/Stop, or a blocking/retry state ends the hold, the content agent reports the response as `GENERATING`. This prevents semantic classification of partial hidden text.

The content agent contains no `PerformanceObserver`/`PerformanceResourceTiming` completion authority. Owner evidence proved generic resource timing can complete long before the actual assistant response begins changing.

### Browser response transport observer

`src/background/response-transport.ts` uses non-blocking `chrome.webRequest` on the existing ChatGPT host scope. It grants network completion authority only to a request that satisfies all of these conditions:

- supported ChatGPT origin and exact conversation-response path;
- `xmlhttprequest`, top frame, and a document identity;
- `POST`;
- successful `2xx` response;
- response `Content-Type` beginning with `text/event-stream`.

The observer correlates by `requestId`, `tabId`, `documentId`, and timestamps. Bounded in-flight records are kept in `chrome.storage.session` so MV3 worker restart does not turn another request into completion evidence. `onCompleted` completes only the matching request/document. `onErrorOccurred` retires the request without fabricating completion. Terminal events retire their stored identity even when a navigation mismatch prevents delivery.

The observer does not read request bodies, response bodies, cookies, or Authorization headers. It does not request `webRequestBlocking` and cannot block, redirect, cancel, or rewrite ChatGPT requests.

See [Revision 9 browser response lifecycle](REV9_BROWSER_RESPONSE_LIFECYCLE.md).

### Background runtime

The service worker owns session coordination, monitoring policy, browser response correlation, optional provider settings, notification routing, Telegram settings, lifecycle protection, and bounded event history. No background message authorizes ChatGPT mutation.

## Session and stale-observation protection

Exact tab/document/content-agent/page/route/conversation identity rejects observations from replaced documents and keeps duplicate tabs isolated at the document level. Conversation/response identity deduplicates provider work and notification delivery.

A service-worker restart requires fresh page evidence before observation state is trusted again. A still-running content agent self-reannounces after a recoverable rejected/failed observation, independent of Side Panel polling. In-flight response-stream correlation is separately persisted in session storage with exact request/document identity.

## Background-tab lifecycle resilience

When monitoring is enabled, the runtime records the tab's prior `autoDiscardable` value and sets `autoDiscardable: false`. Disabling/resetting monitoring restores the prior value. `frozen` and `discarded` remain explicit lifecycle diagnostics; the product does not claim to bypass Chrome lifecycle suspension.

Hidden DOM observation is independent of throttled page timers. Structural terminal-marker recovery handles hidden `innerText` lag without accepting code-block/ambiguous marker text. These defenses remain useful but are independent from Revision 9 completion authority.

Most importantly, hidden UI `IDLE` and absence of the Stop control are not completion proof. A runnable hidden tab can keep producing assistant changes while those UI signals look idle. Response completion instead uses an exact marker or the correlated browser SSE lifecycle described above.

## Monitoring domain

Primary files:

- `src/monitoring/types.ts`
- `src/monitoring/policy.ts`
- `src/monitoring/history.ts`
- `src/monitoring/service.ts`

Monitoring policy schema version is `2`. It contains per-chat enablement, Browser/Sound event selection, generation-stall threshold, and focused-chat low-priority suppression. Legacy v1 send-related settings are never restored.

Runtime state separates page state, blocker reasons, generation state, semantic decision/source, marker health, assistant identity, and latest event.

Semantic source values are `UI`, `STATUS_MARKER`, `RULE`, `PROVIDER`, and `UNKNOWN`.

### Stable-response resolution order

Once the current response has legitimate completion/stability authority, `MonitoringService` resolves:

1. high-confidence UI/page blocker evidence;
2. canonical terminal status marker;
3. strong deterministic local rules;
4. optional configured provider fallback;
5. `UNSURE` / unknown.

Known blocker evidence cannot be overridden by provider interpretation.

For verified hidden network completion, a meaningful configured semantic event may be retained/delivered normally. If semantic resolution is uncertain and no semantic event was delivered, one generic `RESPONSE_COMPLETE` fallback may be delivered for that response episode. Non-delivered diagnostic history does not constitute a second user notification.

## Status marker parser

Canonical prefix:

```text
AI_CHAT_MONITOR_STATUS=
```

The parser accepts exactly one standalone terminal record with one supported `decision` field. It rejects trailing content, multiple markers, unsupported decisions, extra JSON fields, and marker text embedded in code fences, block quotes, tables, inline code, or other non-standalone containers. Missing marker is a normal fallback condition.

## Deterministic and provider classification

The conservative local classifier remains semantic fallback. Optional providers include OpenRouter, NaraRouter, and generic HTTPS OpenAI-compatible Chat Completions endpoints.

Before provider transfer, context is bounded/minimized and secret-redacted. Provider output is advisory only and cannot produce a page action. Results are cached/deduplicated by conversation/assistant identity.

## Monitoring events and notifications

`MonitoringHistoryRepository` provides bounded durable event identity/deduplication. Channels are independently configurable:

- Browser: `chrome.notifications`;
- Sound: Manifest V3 offscreen document;
- Telegram: outbound-only Bot API delivery with bounded event metadata.

Notification failures never mutate ChatGPT state or semantic authority.

## Side Panel

Side Panel availability is tab-scoped for supported ChatGPT tabs. It exposes monitoring ON/OFF, page/semantic state, marker health, Browser/Sound defaults, protocol copy text, provider and Telegram settings, bounded history, lifecycle state, and privacy-safe hidden-attempt diagnostics.

Side Panel polling is not monitoring/reconnect authority. The panel may change extension configuration and copy text only from explicit user actions; it never writes to ChatGPT.

## Storage

Durable trusted storage includes monitoring policy/history, provider profiles/secrets, and Telegram settings/secrets.

Session/ephemeral state includes semantic-resolution cache, hidden diagnostics, lifecycle restoration metadata, and bounded in-flight response-request correlation. Full chat transcripts are not intentionally stored in monitoring history, and network payloads/credential headers are not stored by response correlation.

## Permissions

Required manifest permissions:

- `storage` — policy, secrets, bounded history/state, and session response correlation;
- `sidePanel` — management UI;
- `notifications` — Browser alerts;
- `offscreen` — local sound;
- `clipboardWrite` — explicit protocol Copy buttons;
- `webRequest` — non-blocking lifecycle observation of narrowly filtered ChatGPT SSE responses.

`webRequestBlocking` is not requested. Persistent host permissions remain limited to `https://chatgpt.com/*` and `https://chat.openai.com/*`. Broad HTTPS host permission remains optional for user-selected provider origins.

## Removed v1 architecture

Current runtime has no automation coordinator, guarded-send protocol, composer mutation, send verification, automatic Retry/Continue, continuation text/delay/cooldown, protocol bootstrap/self-check turns, automatic control OWNER/MIRROR semantics, write-journal authority, or hard auto-continuation fuse.

## Validation architecture

Repository validation uses:

```text
npm run typecheck
npm run lint
npm test
npm run smoke:extension
npm run smoke:background
npm run package
```

CI checks out the exact candidate SHA, validates identity, runs source tests, verifies the unpacked service worker, runs real Chromium hidden-tab regressions, packages deterministically, validates ZIP structure/provenance, and uploads artifacts.

Revision 9's Chromium regression explicitly rejects a same-endpoint non-SSE request, keeps a hidden changing assistant `GENERATING` without a Stop control, keeps the response unresolved while the SSE is open, and accepts completion only from the matching SSE terminal lifecycle while the tab remains hidden.

Static regression coverage must continue enforcing the absence of ChatGPT write/control paths and `webRequestBlocking`.