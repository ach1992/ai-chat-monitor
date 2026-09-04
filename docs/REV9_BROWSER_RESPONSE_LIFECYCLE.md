# Revision 9 — Browser response lifecycle correlation

Status: **unreleased integration candidate** under Issue #83. This document records the evidence model for Revision 9; it is not a claim that the real owner environment is fixed until the exact integrated artifact passes live validation.

## Owner evidence that changed the model

Owner validation of the previous integrated `3.0.3` candidate disproved two completion assumptions:

1. A content-side `PerformanceResourceTiming` entry matching a ChatGPT conversation endpoint is not authoritative for the current assistant response. In the live reproduction, the recorded transport completion arrived about 131 ms after the tab was backgrounded, while the first actual assistant DOM change appeared roughly 57 seconds later.
2. Hidden ChatGPT generation UI is not authoritative for response completion. The monitored page remained runnable, produced many hidden observations, and the assistant text changed while diagnostics reported `IDLE` with no Stop control.

Therefore Revision 9 retires both signals as standalone hidden completion authority.

## Completion authority

For a hidden monitored response, completion authority is limited to:

- an exact canonical terminal `AI_CHAT_MONITOR_STATUS={...}` record on the current assistant turn; or
- a browser-level response lifecycle that is positively correlated to the current ChatGPT streaming response.

Absence of the Stop control, adapter `IDLE`, stable partial text, elapsed time, or a generic page resource timing entry does not by itself complete a hidden response.

## Browser-level response correlation

`src/background/response-transport.ts` observes ChatGPT request lifecycle through non-blocking `chrome.webRequest` on the already-supported ChatGPT host permissions.

A request can acquire completion authority only when all of the following are true:

- it belongs to a supported ChatGPT origin and exact conversation-response path;
- resource type is `xmlhttprequest`;
- it belongs to the top frame and has a document identity;
- method is `POST`;
- response status is successful (`2xx`);
- response `Content-Type` starts with `text/event-stream`.

The extension records only bounded request correlation data needed for identity and timing: request ID, tab ID, document ID, and start/completion timestamps. In-flight records are bounded and stored in `chrome.storage.session` so an MV3 service-worker restart cannot turn an unrelated later request into completion evidence.

`onCompleted` grants completion only to the matching request/tab/document. `onErrorOccurred` retires the matching in-flight record without fabricating completion. Terminal events retire their record even if the document has changed, preventing stale in-flight identities from surviving navigation races.

## Privacy and read-only boundary

Revision 9 does not request `webRequestBlocking` and cannot block, redirect, cancel, or rewrite ChatGPT requests.

The response-lifecycle observer does not inspect or persist:

- request bodies;
- response bodies;
- cookies;
- Authorization headers;
- chat transcript payloads.

It reads response headers only far enough to require the SSE `Content-Type` and retains only bounded identity/timestamp metadata.

No ChatGPT composer-write or control-click authority is introduced.

## Hidden response hold

A trusted `MANUAL_SEND` immediately opens a local pending-response boundary before the service worker can report network start. Once hidden, a pending response is conservatively reported as `GENERATING` even if the ChatGPT DOM temporarily exposes no Stop control and the adapter would otherwise report `IDLE`.

The hidden hold is released only by:

- exact canonical terminal status evidence;
- completion of the matching verified ChatGPT SSE request;
- matching request abort / explicit Stop interaction; or
- blocking/retry page state that must remain observable.

This prevents semantic classification of a partial hidden assistant merely because transient UI controls have disappeared.

## Real Chromium regression

The Revision 9 Chrome-for-Testing regression intentionally models the live failures rather than an idealized Stop-button flow:

1. previous assistant is already complete;
2. trusted manual Send starts a new response episode;
3. monitored tab becomes hidden and contains no Stop control;
4. a `POST` to the same conversation endpoint returns JSON and must **not** acquire completion authority;
5. a fresh assistant appears and changes while the page UI still looks idle; the extension must keep it `GENERATING` and emit no response event;
6. a real synthetic SSE response starts and stays open while the hidden assistant changes; no response event may be delivered while the stream is open;
7. only matching SSE completion may release the hidden generation hold and allow one delivered `RESPONSE_COMPLETE` fallback when no semantic event was delivered;
8. the tab must remain hidden through notification delivery.

Exact-head CI run `33927680435` on candidate `36c040a948a920c3a3aa55009bd1db48f4dbdcbb` passed 161 tests, unpacked extension identity, the pre-existing hidden terminal-marker regression, this Revision 9 response-lifecycle regression, package verification, and artifact upload. The Revision 9 smoke reported:

`Rev9 hidden response lifecycle passed: RESPONSE_COMPLETE, browser=DELIVERED, streamStart=1788562738208, transportAt=1788562739409, browserAt=1788562739435`

That synthetic result is regression evidence only. Owner validation of the exact integrated candidate remains the final Issue #83 acceptance gate.

## Release gate

No GitHub Release or Chrome Web Store publication is authorized by this document. Issue #83 remains open until the owner validates the exact integrated Revision 9 artifact in the real logged-in Chrome environment, including the first response immediately after extension reload and a response completed while the ChatGPT tab is never foregrounded.