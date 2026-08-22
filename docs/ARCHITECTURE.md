# Chat Turn Guardian — Architecture

## Overview

v2.0.0 is a read-only monitoring architecture. The extension observes supported ChatGPT pages, derives normalized runtime and semantic state, and emits deduplicated monitoring events to user-selected notification channels.

There is no ChatGPT write path in the v2 architecture.

```text
ChatGPT DOM
   |
   v
content adapter (observation only)
   |
   v
session registry / stale-document protection
   |
   v
monitoring service
   |-- page-state resolver
   |-- status-marker parser
   |-- deterministic classifier
   |-- optional provider fallback
   |-- response/episode deduplication
   |-- bounded monitoring history
   |
   +--> Browser notifications
   +--> local Sound
   +--> Telegram outbound alerts
   +--> Side Panel status/diagnostics
```

## Trust and authority model

### ChatGPT page

The ChatGPT page and its content are untrusted inputs. The content script may observe supported DOM/runtime signals but must not expose any command that mutates the composer or activates a conversation control.

### Content adapter

`src/content/adapter.ts` normalizes page observations such as:

- generation state;
- latest assistant/user turn identity and bounded normalized text;
- page confidence;
- blocker reasons;
- Retry/action state;
- conversation/route identity inputs.

The adapter has no send/continue/retry authority.

### Content agent

`src/content/index.ts` reports observations and lifecycle identity to the background runtime. It may respond to read/reconnect/status-oriented extension messages, but the v2 protocol must contain no guarded-send or composer-mutation command.

### Background runtime

The service worker owns durable coordination, monitoring policy, optional provider settings, notification routing, Telegram settings, and bounded event history.

No background message may authorize a ChatGPT page mutation.

## Session and stale-observation protection

Exact tab/document/content-agent/page/route/conversation identity remains important even though automatic sending was removed.

The session registry rejects stale observations from replaced documents and keeps duplicate tabs isolated at the document level. Conversation identity is then used by monitoring to deduplicate provider work and notifications.

A service-worker restart requires fresh page observations before current runtime state is trusted again. Restart must never restore any v1 send authority.

## Monitoring domain

Primary v2 domain files:

- `src/monitoring/types.ts`
- `src/monitoring/policy.ts`
- `src/monitoring/history.ts`
- `src/monitoring/service.ts`

### Policy

Monitoring policy schema version is `2`.

Policy contains:

- per-chat Monitoring enabled/disabled;
- Browser event selection;
- Sound event selection;
- generation-stall threshold;
- focused-chat low-priority suppression preference.

Legacy v1 policy is read only for migration. `OFF` becomes disabled; `OBSERVE`, `NOTIFY_ONLY`, and `AUTO` become monitoring enabled. Send-related settings are not restored.

### Runtime status

Runtime separates:

- page state;
- blocker reasons;
- generation state;
- semantic decision;
- semantic source;
- marker health;
- assistant response identity;
- latest monitoring event.

Semantic source values:

- `UI`
- `STATUS_MARKER`
- `RULE`
- `PROVIDER`
- `UNKNOWN`

### Resolution order

`MonitoringService` resolves stable assistant state in this order:

1. high-confidence UI/page blocker state;
2. canonical/legacy terminal status marker;
3. strong deterministic local classifier;
4. optional configured provider fallback;
5. `UNSURE`/unknown.

Known UI blocker evidence cannot be overridden by provider interpretation.

## Status marker parser

Canonical prefix:

```text
CHAT_TURN_GUARDIAN_STATUS=
```

Legacy compatibility prefix:

```text
CHAT_TURN_GUARDIAN_STATUS_V1=
```

The parser accepts exactly one standalone terminal record with one supported `decision` field. It rejects ambiguous/malformed cases, including:

- trailing content;
- multiple markers;
- conflicting canonical/legacy markers;
- unsupported decisions;
- extra JSON fields;
- marker text embedded in Markdown backtick or tilde code fences;
- marker text embedded in block quotes, tables, inline code, or other non-standalone containers.

Missing marker is a normal fallback condition.

## Deterministic and provider classification

The existing conservative classifier remains useful as a semantic fallback.

Provider classification is optional. Supported profile transport includes OpenRouter, NaraRouter, and generic HTTPS OpenAI-compatible Chat Completions endpoints.

Before provider transfer, context is bounded/minimized and secret-redacted. Provider output is advisory only and can never produce a page action.

Resolution results are cached/deduplicated by conversation/assistant-response identity to avoid duplicate provider work across duplicate/background tabs.

## Monitoring events

Core event types live in `src/monitoring/types.ts` and include response completion, continuation-ready, human gates, task complete, page/runtime blockers, provider failure, generation stall, and repeated response diagnostics.

`MonitoringHistoryRepository` provides bounded durable deduplication. Event identity includes conversation, assistant/route identity, and event type.

The monitoring service selects one primary useful event for a stable response rather than emitting overlapping response-complete + semantic notifications for the same observation.

## Notifications

### Browser

Uses `chrome.notifications`. Browser delivery is event-selectable and observational.

### Sound

Uses `src/offscreen/audio.html` and `src/offscreen/audio.ts` through a Manifest V3 offscreen document. Sound routing is event-selectable and deduplicated with the event.

### Telegram

Telegram is outbound-only. The notification manager sends bounded event-oriented metadata using the user-supplied bot token/destination. Dynamic text is escaped for Telegram HTML. Delivery failures update sanitized health/diagnostic state but do not alter monitoring semantics.

### Failure isolation

Notification-channel failures must not mutate ChatGPT state and must not convert a known monitoring state into another decision.

## Side Panel

The Side Panel is the user-control and observability surface.

Current responsibilities:

- current-tab Monitoring ON/OFF;
- current page/semantic state and source;
- marker health;
- Browser/Sound defaults;
- status-protocol copy text;
- provider profile management/readiness;
- Telegram configuration/health;
- bounded recent event history.

The Side Panel may write extension configuration and the system clipboard only from explicit user actions. It does not write to ChatGPT.

## Storage

Trusted extension storage is namespaced by domain.

Durable examples:

- monitoring policy;
- monitoring history;
- provider profiles/secrets;
- Telegram settings/secrets.

Ephemeral/session-scoped examples:

- semantic-resolution cache used for duplicate-work reduction.

Full chat transcripts are not intentionally stored in monitoring history. Secrets must never be included in event/audit payloads.

## Permissions

Required manifest permissions:

- `storage` — policy, secrets, bounded history/state;
- `sidePanel` — management UI;
- `notifications` — Browser alerts;
- `offscreen` — local sound;
- `clipboardWrite` — explicit copy buttons for status-protocol setup text.

Persistent host permissions are limited to supported ChatGPT origins. Broad HTTPS access is optional so user-selected provider origins can be granted at runtime.

## Removed v1 architecture

The following v1 concepts are not part of v2 runtime authority:

- automation coordinator;
- guarded-send protocol;
- composer mutation;
- send verification;
- continuation text/delay/cooldown;
- protocol bootstrap/self-check turns;
- status-specific automatic response turns;
- automatic control OWNER/MIRROR semantics;
- guarded-write journal authority;
- hard automatic-continuation fuse.

Historical files/tests may remain only as deleted diff/history or clearly historical documentation.

## Validation architecture

Repository validation uses:

```text
npm run typecheck
npm run lint
npm test
npm run smoke:extension
npm run package
```

CI checks out the exact PR candidate SHA, verifies identity, runs validation/smoke/package, validates the extension ZIP structure, checks that no TypeScript/source-map/environment file leaked into the artifact, verifies `build-info.json` source SHA, and uploads the package artifacts.

Static regression coverage must continue to enforce the absence of ChatGPT write commands/runtime mutation paths.
