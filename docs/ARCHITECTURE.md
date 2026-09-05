# AI Chat Monitor — Architecture

## Overview

AI Chat Monitor is a Chromium Manifest V3 extension that observes supported ChatGPT conversations, derives normalized runtime and semantic state, and emits deduplicated monitoring events to user-selected Browser, local Sound, and outbound Telegram channels.

There is no ChatGPT write/control path in the current architecture.

```text
ChatGPT DOM -----------------------> content adapter / content agent
                                         ^                 |
ChatGPT response SSE --> MAIN-world observer --------------+----> session registry
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

While a response is pending and the document is hidden, transient adapter `IDLE` / missing Stop state is observational only. Until the current page response stream reports a canonical terminal status or `data: [DONE]`, or an explicit Stop/blocking/retry boundary intervenes, the content agent reports the response as `GENERATING`. This prevents semantic classification of partial hidden text.

The content agent contains no `PerformanceObserver`/`PerformanceResourceTiming` completion authority. Owner evidence proved generic resource timing can complete long before the actual assistant response begins changing.

### MAIN-world response-stream observer

`src/content/main-stream-observer.ts` runs as a packaged `document_start` content script in Chrome's MAIN world on the two supported ChatGPT origins, but its response observation is disabled by default. The trusted extension runtime enables it only for the currently selected monitored conversation and disables it again when monitoring is turned off/reset or the route changes. It installs capture-phase observation for the user's real Enter/Send action before ChatGPT's own handler can start the response request. That synchronously opens a response episode and eliminates the asynchronous cross-world arming race.

For an enabled monitored conversation and the armed response only, the observer delegates the original page `fetch` unchanged. A supported conversation `POST` whose response is `text/event-stream` is cloned locally; the original `Response` object is returned unchanged to ChatGPT. The clone is consumed immediately while retaining only a bounded rolling tail (16 KiB, with a 4 KiB terminal-match window).

The observer recognizes two mutually exclusive outcomes:

1. a canonical `AI_CHAT_MONITOR_STATUS={...}` decision in the stream -> emit only that terminal semantic decision;
2. `data: [DONE]` with no terminal decision seen -> emit only generic response-complete evidence.

A stream that ends without either outcome fails closed. The observer does not inspect the request body, cookies, Authorization headers, or credential headers; it does not persist or remotely transfer the rolling stream tail; and it never modifies, redirects, cancels, retries, or rewrites the request/response. Only a minimal episode/timestamp plus terminal decision or generic completion signal crosses to the isolated content agent.

Revision 9's `chrome.webRequest` completion authority is retired because owner diagnostics showed `onCompleted` could precede meaningful assistant progress in the real ChatGPT runtime. The Revision 10 design therefore no longer requests `webRequest`.

See [Revision 10 page-stream terminal authority](REV10_PAGE_STREAM_TERMINAL.md).

### Background runtime

The service worker owns session coordination, monitoring policy, optional provider settings, notification routing, Telegram settings, lifecycle protection, and bounded event history. No background message authorizes ChatGPT mutation.

## Session and stale-observation protection

Exact tab/document/content-agent/page/route/conversation identity rejects observations from replaced documents and keeps duplicate tabs isolated at the document level. Conversation/response identity deduplicates provider work and notification delivery.

A service-worker restart requires fresh page evidence before observation state is trusted again. A still-running content agent self-reannounces after a recoverable rejected/failed observation, independent of Side Panel polling. Response-stream payload observation remains page-local and is not persisted in service-worker/session storage.

## Background-tab lifecycle resilience

When monitoring is enabled, the runtime records the tab's prior `autoDiscardable` value and sets `autoDiscardable: false`. Disabling/resetting monitoring restores the prior value. `frozen` and `discarded` remain explicit lifecycle diagnostics; the product does not claim to bypass Chrome lifecycle suspension.

Hidden DOM observation is independent of throttled page timers. Structural terminal-marker recovery handles hidden `innerText` lag without accepting code-block/ambiguous marker text. These defenses remain useful but are independent from Revision 10 page-stream terminal authority.

Most importantly, hidden UI `IDLE` and absence of the Stop control are not completion proof. A runnable hidden tab can keep producing assistant changes while those UI signals look idle. Response outcome instead comes from a canonical status marker or the actual armed page response stream described above.

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

For an armed page response stream, terminal status has strict priority: a valid `AI_CHAT_MONITOR_STATUS` produces only its semantic event. If no terminal status is present, `data: [DONE]` produces only `RESPONSE_COMPLETE`. Late DOM/foreground reconciliation is deduplicated against the already delivered response episode.

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

Session/ephemeral state includes semantic-resolution cache, hidden diagnostics, and lifecycle restoration metadata. Full chat transcripts are not intentionally stored in monitoring history. The MAIN-world response observer keeps only a bounded rolling SSE tail transiently in page memory and does not persist it.

## Permissions

Required manifest permissions:

- `storage` — policy, secrets, bounded history/state, and lifecycle/session metadata;
- `sidePanel` — management UI;
- `notifications` — Browser alerts;
- `offscreen` — local sound;
- `clipboardWrite` — explicit protocol Copy buttons.

`webRequest` and `webRequestBlocking` are not requested. Persistent host permissions remain limited to `https://chatgpt.com/*` and `https://chat.openai.com/*`. Broad HTTPS host permission remains optional for user-selected provider origins.

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

Revision 10's Chromium regression runs two consecutive hidden responses with stale DOM: the no-marker response must deliver `RESPONSE_COMPLETE` only after page-stream `[DONE]`; the status-bearing response must deliver only its semantic event, never generic completion, and late DOM/foreground catch-up must not duplicate delivery.

Static regression coverage must continue enforcing the absence of ChatGPT write/control paths and the absence of required `webRequest`/`webRequestBlocking` authority.