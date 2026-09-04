# Revision 7 background monitoring

Status: **unreleased; owner live validation required**.

Tracking: Issue #83, Contract Revision 7.

## Why this revision exists

Owner diagnostics from the real logged-in Chrome environment proved that a monitored ChatGPT tab can remain runnable and continue emitting hidden observations while the rendered assistant DOM stays partial/stale until the tab is activated. A hidden content script therefore does not imply that the final rendered assistant text or terminal status marker is available.

This means rendered assistant DOM cannot be the only completion authority for unattended background notification.

## Read-only completion evidence

Revision 7 observes same-origin ChatGPT conversation-stream **resource timing metadata** with `PerformanceObserver` / `PerformanceResourceTiming` in the existing content script. It does not intercept or modify requests, read response bodies, store response content, or add Chrome permissions.

A resource is eligible only when all applicable checks pass:

- initiator is `fetch` or `xmlhttprequest`;
- origin is the current ChatGPT origin;
- pathname is one of the bounded conversation response-stream paths known to this build;
- response status, when exposed, is successful;
- content type, when exposed by Chromium, is `text/event-stream`;
- `responseEnd` is finite and positive.

The retained completion evidence contains only:

- a document-local serial number;
- the fixed transport identifier `CHATGPT_CONVERSATION_STREAM`;
- hidden/visible state at transport completion;
- completion timestamp derived from `performance.timeOrigin + responseEnd`.

No request body, response body, assistant text, user text, credential, provider payload, Telegram secret, or arbitrary resource URL is added to the diagnostic evidence.

## Semantic boundary

Transport completion proves only **"the ChatGPT response transport finished"**. It does not prove that the requested project/work is complete.

Therefore:

- a valid terminal `AI_CHAT_MONITOR_STATUS` marker or other existing semantic evidence may still emit the specific semantic event such as `TASK_COMPLETE`;
- if a specific event was already delivered for the completed response, the transport fallback does not send a duplicate generic notification;
- if the rendered assistant DOM is still stale/partial and no specific event was delivered, hidden transport completion may emit the generic `RESPONSE_COMPLETE` event;
- transport completion never fabricates `COMPLETE`, approval, decision, human-operation, provider, or other semantic state.

## Event identity correction

Monitoring event identity now prefers a stable assistant `domMessageId` over the assistant text fingerprint. Fingerprint remains the fallback only when a stable DOM message identity is unavailable. This prevents a fresh assistant turn whose temporary partial text matches an earlier turn from being suppressed as a duplicate.

## Activation and delivery diagnostics

Revision 7 separates:

- tab activation time;
- first visible observation time;
- first hidden observation time;
- first detected assistant change;
- first detected terminal marker;
- hidden response-transport completion time;
- Browser, Sound, and Telegram delivery outcome and per-channel completion time.

This prevents an event produced during foreground reconciliation from being presented as strong evidence of normal unattended background completion.

The Side Panel copy surface remains redacted and does not expose transcript text or internal fingerprints.

## Side Panel containment

Long background-trace badges in managed-chat cards are allowed to wrap within the card at narrow Side Panel widths instead of overflowing horizontally. This does not alter the restored tab-scoped Side Panel availability model.

## Regression evidence

The Revision 7 Chrome-for-Testing smoke deliberately keeps the monitored assistant DOM at `...` and retains a stale Stop control. It then completes a same-origin synthetic ChatGPT conversation stream while the tab remains hidden and never activates the monitored tab.

The regression passes only when all of the following are true before activation:

- transport completion is observed;
- the assistant DOM is still `...`;
- generation/Stop UI remains intentionally stale;
- `RESPONSE_COMPLETE` is recorded;
- Browser delivery resolves successfully;
- diagnostic transport completion exists;
- no visible-observation or tab-activation boundary has occurred.

Synthetic success is regression evidence for this modeled failure mode, not proof that the owner's real ChatGPT environment is fixed. Issue #83 remains open until the exact integrated artifact passes the owner's real inactive-tab test.

## Delivery gate

No GitHub Release or Chrome Web Store publication is authorized by this revision. Integration remains gated by full validation, exact-head CI, effective-diff review, and post-merge CI. Release remains gated by owner live validation.
