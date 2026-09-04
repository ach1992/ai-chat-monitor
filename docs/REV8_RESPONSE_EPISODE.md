# Revision 8 response-episode correlation

Status: **unreleased; owner live validation required**.

Tracking: Issue #83, Contract Revision 8.

## Why this revision exists

Owner validation of the exact integrated Revision 7 artifact exposed a distinct false-positive boundary: Browser and Telegram could emit the generic `RESPONSE_COMPLETE` notification as soon as a new ChatGPT response began, before that response was complete.

The copied diagnostic for that attempt contained no hidden transport-completion timestamp and retained the previous completed assistant unchanged. Runtime inspection showed the content `MANUAL_SEND` interaction was updating session metadata and then immediately asking monitoring to resolve the session again while the previously accepted assistant observation was still current. ChatGPT had not yet committed the new user/assistant turn to the observed DOM.

A previous assistant observation therefore must not gain fresh completion authority merely because a new response was started.

## Response episode boundary

A trusted manual send establishes a new response episode. The episode retains only bounded correlation metadata:

- start timestamp;
- previous assistant fingerprint, when available;
- previous assistant DOM message identifier, when available.

It does not retain new transcript text or credentials.

User-interaction messages update session metadata but do not directly re-run semantic/completion resolution against the unchanged observation.

## Fresh-turn eligibility

While an episode is pending, AI Chat Monitor distinguishes the previous assistant from a demonstrably fresh assistant turn.

The previous assistant remains historical and cannot generate a fresh semantic/completion notification for the new response. An observation sampled before the manual-send timestamp is also ineligible.

A fresh assistant identity can become current, but a transient `IDLE` UI alone is not completion evidence. A fresh assistant response becomes completion-eligible only through existing explicit evidence such as:

- an exact valid terminal `AI_CHAT_MONITOR_STATUS` record;
- an actually observed generating episode followed by idle completion;
- bounded hidden transport-completion evidence correlated to the current response episode.

Normal page-state events such as Retry, rate limit, network error, authentication, or other blockers remain observable while the response episode is waiting for a fresh assistant.

## Generic response completion

Revision 8 removes the generic `RESPONSE_COMPLETE` fallback from an otherwise ambiguous idle semantic resolution. Generic response-finished notification is reserved for the explicit bounded transport-completion fallback.

A hidden transport completion must belong to the current response episode. When no explicit manual-send episode is available, transport fallback requires an actually observed generating episode. Delivery deduplication is scoped from the response-episode start so a specific semantic event already delivered for that response suppresses the generic fallback.

Transport evidence remains completion authority only. It never fabricates `COMPLETE`, approval, decision, human-operation, provider, or other semantic state.

## Persistence and lifecycle

The bounded response-episode correlation metadata survives a Manifest V3 service-worker restart in session storage, while stale observations themselves continue to lose authority on restore. Navigation to a different page epoch/route does not carry the prior response episode forward.

Existing automatic-discard protection, frozen/discarded reporting, MV3 content-agent self-healing, tab-scoped Side Panel behavior, privacy redaction, Browser/Sound/Telegram routing, and the strict read-only ChatGPT boundary remain unchanged.

## Regression model

The Revision 8 Chrome-for-Testing regression models the newly observed production race in order:

1. a previous assistant turn is fully complete and contains a terminal status marker;
2. a trusted manual send starts the next response episode;
3. the old completed assistant remains in DOM briefly and must not emit a fresh event;
4. the new user turn appears ahead of the old assistant and the old assistant loses current-turn authority;
5. a fresh assistant appears with partial text while the UI transiently reports `IDLE`; no completion event is allowed;
6. the current response is observed as `GENERATING`;
7. the tab becomes hidden;
8. the bounded conversation stream completes while the assistant DOM intentionally remains partial;
9. only then may generic `RESPONSE_COMPLETE` be emitted and delivered before tab activation.

The test also retains the existing hidden-tab requirements: no final assistant DOM is installed, no tab activation occurs before notification, and transport timing must precede Browser delivery.

Synthetic success is regression evidence for the modeled race, not proof that the owner's logged-in ChatGPT environment is fixed.

## Delivery gate

Revision 8 is integration-only. Full validation, exact-head Chrome-for-Testing regression, package verification, effective-diff review, and post-merge CI are required before integration. Issue #83 remains open after integration until the exact integrated artifact passes the owner's real inactive-tab test. No GitHub Release or Chrome Web Store publication follows from integration alone.
