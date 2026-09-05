# Revision 10 — Page-stream terminal authority

Status: **unreleased integration candidate** under Issue #83. This revision exists because owner validation disproved every prior background completion shortcut as sufficient in the real ChatGPT runtime. Synthetic Chromium remains regression evidence only; the exact integrated artifact still requires owner live validation before any v3.0.3 release.

## Owner evidence that changed the model

The owner established two facts on integrated Revision 9:

1. the extra generic **ChatGPT response finished** notification occurred specifically after leaving the ChatGPT tab; it did not occur while remaining on the tab;
2. the recorded transport completion could occur near the beginning of a later response, while the assistant continued changing afterwards and the true terminal marker was not yet available.

That evidence disproved browser `webRequest.onCompleted` as user-visible assistant-response completion authority. It also reaffirmed that hidden DOM `IDLE`, absence of the Stop control, stable partial text, elapsed time, and generic resource timing are not sufficient completion proof.

## Required product semantics

For one user-initiated response episode:

- if the actual response stream contains one valid canonical `AI_CHAT_MONITOR_STATUS={...}` record, the semantic decision is the only completion notification for that episode;
- if there is no valid terminal status record, generic `RESPONSE_COMPLETE` is allowed only when the actual response stream reaches `data: [DONE]`;
- a stream that closes without `[DONE]` produces no completion outcome;
- late DOM rendering, marker catch-up, or foreground activation cannot create a second user notification for an episode that already delivered one.

The generic response-finished event is therefore a true **no-status fallback**, not a parallel notification.

## Synchronous response episode boundary

`src/content/main-stream-observer.ts` is a packaged `document_start` content script running in Chrome's MAIN world on only the supported ChatGPT origins. It starts disabled and trusted extension policy state enables it only while that conversation is selected for monitoring.

It observes the user's trusted Enter/Send event in capture phase. This is intentional: an earlier prototype armed the page observer by asynchronous `window.postMessage` from the isolated content script, and the real Chromium regression proved ChatGPT could start its fetch before that message arrived. MAIN-world capture arming removes that race without clicking or writing anything.

The isolated content agent independently records its trusted `MANUAL_SEND` response episode and accepts a page-stream outcome only while that response is pending and the MAIN-world episode identity matches.

## Read-only stream observation

For an enabled monitored conversation and the armed episode only, the MAIN-world observer:

1. calls the original page `fetch` with the exact original arguments;
2. returns the original `Response` object unchanged to ChatGPT;
3. accepts only `POST` requests to the supported exact ChatGPT conversation endpoints;
4. accepts only responses whose content type is `text/event-stream`;
5. consumes only a cloned response stream locally.

The observer keeps at most a **16 KiB rolling tail** in page memory. Only the final **4 KiB** is used for terminal-marker matching. It does not persist the rolling stream tail to extension storage/history/logs, does not send it to Telegram/providers/developer infrastructure, and does not inspect request bodies, cookies, Authorization headers, or credential headers.

The observer has no request mutation authority. It does not block, redirect, cancel, replay, retry, or rewrite ChatGPT traffic.

## Terminal arbitration

The observer waits for the actual SSE `data: [DONE]` marker before finalizing the response outcome.

At `[DONE]`:

1. normalize the bounded terminal tail for JSON quote escaping;
2. if exactly one supported canonical `AI_CHAT_MONITOR_STATUS={...}` record is present, emit only `terminal-status` with that decision;
3. otherwise emit only `response-complete`.

A stream ending without `[DONE]` fails closed. This deliberately avoids treating connection close, UI `IDLE`, a missing Stop control, text stability, or a browser request lifecycle callback as response completion.

## Isolated-world and monitoring arbitration

The MAIN-world observer transfers only a minimal same-page message:

- response episode timestamp;
- completion timestamp;
- either the terminal decision or generic response-complete outcome.

The isolated content agent converts that into one bounded `PageObservation` evidence field. `MonitoringService` gives terminal stream evidence priority over generic completion, maps terminal decisions through the same semantic event vocabulary as a canonical DOM marker, and uses response-episode history to suppress later DOM/foreground duplicates.

No stream transcript crosses into monitoring history.

## Permissions

Revision 10 removes the Revision 9 required `webRequest` permission and deletes the background response-transport runtime. No new required permission is added.

Persistent host permissions remain limited to:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

The broad HTTPS permission remains optional and exists only for user-selected compatible AI-provider origins.

## Chromium regression contract

The Revision 10 background regression must run with the monitored ChatGPT-origin tab hidden and final assistant DOM intentionally stale.

It performs two consecutive response episodes in the same tab:

1. **No terminal status** — partial hidden DOM remains generating; no event before stream completion; after actual `[DONE]`, exactly one Browser-delivered `RESPONSE_COMPLETE` is allowed.
2. **Terminal COMPLETE status** — no event before the terminal response outcome; at actual `[DONE]`, exactly one Browser-delivered `TASK_COMPLETE` is allowed and `RESPONSE_COMPLETE` is forbidden.

The test then lets the DOM catch up with the same terminal marker and foregrounds the tab. Delivery count must remain one for the second episode.

The older hidden terminal-marker, MV3 recovery, discard-protection, and extension-identity regressions remain independent safeguards.

## Acceptance boundary

Revision 10 is not accepted merely because synthetic Chrome/CI passes. Issue #83 remains open until the owner validates the exact integrated artifact in the real logged-in Chrome environment, including first and subsequent sends and a never-return-to-tab background response.

No v3.0.3 GitHub Release or Chrome Web Store publication is authorized before that gate passes.
