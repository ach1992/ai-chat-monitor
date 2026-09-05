# Background Monitoring Investigation: Evidence, Guardrails, and Restart Plan

This is the durable technical context for re-investigating AI Chat Monitor's inactive/background-tab defect from the clean v3.0.0 product baseline. It intentionally records only evidence and engineering constraints that matter to future implementation.

## Current baseline

The owner rejected all post-v3.0.0 background-monitoring implementations and directed a full rollback.

The active runtime/product baseline is v3.0.0:

- released source: `c38eb377c00d692ac739121e85d48c73eacea4d7`;
- released Git tree: `81c6ab29d8bd43ee728f07d477a5a0a3cc2e73ab`;
- rollback integration: PR #103;
- packaged extension: 48 runtime files;
- v3.0.0 ZIP SHA-256: `2771b6cf4fe3e90188af95d989e5f3dcd751b1b29f37b9594f5c36fb28ccc64c`;
- v3.0.1 and v3.0.2 releases/tags were deleted after rollback;
- rejected experiments remain only in Git/PR/Issue history for audit.

Documentation-only commits after rollback do not redefine the runtime baseline. Compare future runtime work against v3.0.0.

## Product outcome that still needs to be solved

A selected ChatGPT conversation must continue to be monitored when its tab is inactive. Returning to or focusing the ChatGPT tab must not be required to trigger recognition or notification.

Required notification semantics:

1. If a completed response contains one valid terminal `AI_CHAT_MONITOR_STATUS={"decision":"..."}` record, use that semantic decision and do not also emit generic `ChatGPT response finished` for the same response.
2. If the completed response has no valid status record, `ChatGPT response finished` is valid only when the response is actually complete.
3. Starting a response must never emit completion from the previous response or unrelated network activity.
4. Returning to the tab must neither be required for delivery nor create a duplicate.
5. First send after extension reload and later sends must behave consistently.

The read-only boundary remains mandatory: no composer writes, button activation, focus stealing, Retry/Continue actions, conversation mutation, or synthetic user input.

## Live evidence that must outrank synthetic tests

### Hidden execution can remain alive while final rendered response state is missing

Real owner tests showed the hidden tab remaining runnable and continuing to produce observations while the assistant DOM stayed tiny/partial and the terminal marker was unavailable until foreground activation. Observed cases included `frozen=false` and `discarded=false`.

Therefore a runnable content script does not prove that ChatGPT committed the completed response to rendered DOM, Chrome suspension is not sufficient to explain the defect, and DOM-only completion/status detection cannot be assumed reliable in the real hidden path.

### Hidden generation UI is not completion authority

Real failures showed `IDLE` / missing Stop while assistant content was still changing or incomplete. Other experiments observed stale Stop after terminal content existed.

In a hidden tab, Stop presence and Stop absence / adapter `IDLE` are observational signals only unless corroborated by stronger response-specific evidence.

### `PerformanceResourceTiming` was a false completion signal

One owner diagnostic recorded:

- `backgroundedAt=1788560973651`;
- `transportCompletedAt=1788560973782` (131 ms later);
- `firstAssistantChangeAt=1788561030857` (roughly 57 seconds after the claimed transport completion).

A matching resource-timing entry was therefore not proven to represent the current assistant response and must not be used as completion authority.

### `webRequest.onCompleted` was also insufficient

A later experiment correlated `POST` / `2xx` / `text/event-stream` requests using `webRequest`. Synthetic Chromium tests passed, but the real owner environment again reported completion timing near response start and background-only generic `ChatGPT response finished` notifications.

Endpoint/method/content-type/request lifecycle correlation was still insufficient proof that the observed request represented the current assistant response lifecycle. Do not restore `webRequest` completion authority without new live evidence proving exact response identity.

### A MAIN-world fetch/SSE observer also failed live acceptance

Revision 10 observed a cloned page response stream and synthetic Chromium tests demonstrated mutually exclusive generic-vs-status outcomes at `data: [DONE]`. The owner's real test still failed: generic `ChatGPT response finished` appeared when semantic status was expected, and the inactive-tab outcome remained unresolved.

This does not prove page-stream observation can never work. It proves the specific request identity/stream assumptions were not established by live evidence before being treated as authoritative. Any future network/stream approach must first be diagnostic-only and prove which exact stream belongs to the real response and what terminal data it actually carries in the owner's environment.

## Real defects found during rejected work

Several defects discovered after v3.0.0 were real in isolation, but owner validation proved that fixing them did not solve the main inactive-tab outcome. They were rolled back and must not be re-applied as a bundle.

Examples:

- hidden `innerText` can lag or flatten terminal-status layout while structural DOM text differs;
- alternate assistant/user selector collection can select an older turn instead of actual DOM-latest order;
- MV3 content/background session races can exist around content-agent registration;
- Chrome discard/freeze lifecycle can matter;
- stale response observations can be reprocessed around a new send unless response identity is explicit;
- notification/event dedupe needs response/turn identity rather than only text fingerprints.

A future implementation may reuse one of these ideas only when current v3.0.0 live tracing shows that exact defect is on the active causal path. Historical validity is not enough.

## Mistakes that must not be repeated

### Do not promote a plausible hypothesis to root cause too early

Timer throttling, stale rendered text, stale Stop state, selector ordering, session recovery, Resource Timing, `webRequest`, and page-stream observation were each treated too strongly at different points. Several exposed valid local defects, but none passed real owner acceptance.

**Rule:** claim root cause only when the candidate explains the real live evidence and the owner test passes without returning to the tab.

### Synthetic success is regression evidence, not product acceptance

Some browser smokes directly installed final assistant DOM or removed a decisive Stop control, manufacturing conditions the real hidden ChatGPT page did not provide. Later synthetic network/SSE fixtures also modeled a cleaner request lifecycle than the owner's runtime.

**Rule:** a synthetic smoke proves only the condition it actually models. A background smoke must not silently:

- focus/activate the monitored tab before the asserted event;
- directly install missing real-world evidence that the candidate is supposed to obtain;
- remove a decisive UI condition merely to make expected state appear;
- count activation-transition catch-up as unattended background success.

### Do not stack speculative runtime fixes on `main`

Repeated integrations accumulated complexity while live behavior still failed. Rejected candidates reached 51-52 packaged runtime files versus 48 in v3.0.0, and the owner observed substantial ZIP growth without a working outcome.

**Rule:** runtime experiments stay on one branch/PR. The owner tests the exact PR-head CI artifact before merge. If live validation fails, do not merge that runtime experiment and do not stack another speculative layer on top.

### Preserve unrelated product behavior

One experiment changed Side Panel behavior from tab-scoped to global, causing opening/closing the panel to affect all tabs.

**Rule:** preserve v3.0.0 tab-scoped Side Panel semantics unless the owner explicitly requests a separate UX change. UI state is not background-monitoring authority.

### Do not broaden permissions or data handling before causal proof

`webRequest` permission and MAIN-world response inspection increased implementation/privacy surface before live response identity was proven.

**Rule:** begin with the smallest diagnostic surface. Any permission or data-handling expansion needs direct necessity evidence and separate privacy/security review. Prefer no new permission.

### Do not infer completion from timing/stability

Text stability, hidden `IDLE`, Stop absence, endpoint timing, or generic request completion can be early or unrelated.

**Rule:** no text-stability timeout or generic network-timing heuristic may create a completion notification.

### Keep semantic and generic notification authority mutually exclusive

A status-bearing response must not also produce `ChatGPT response finished`, and a generic completion signal must never invent semantic state.

**Rule:** one response episode -> at most one primary delivered completion/semantic notification, with explicit precedence and dedupe.

## Required process for the next attempt

### Phase A — diagnostic-only proof from v3.0.0

Start from the current v3.0.0 runtime. Before implementing another background-completion mechanism, build the smallest temporary diagnostic candidate needed to locate the first failing boundary in the owner's real Chrome environment.

Prefer privacy-safe metadata such as:

- response/send episode timestamp and identity;
- document/route identity;
- visibility transitions and whether an observation was sampled before or after activation;
- latest user/assistant stable DOM message IDs when available;
- assistant length/change timestamps and marker health, but not transcript text;
- generation/Stop observations as non-authoritative diagnostics;
- content-agent/service-worker session identity/restarts;
- monitoring event creation and Browser/Sound/Telegram delivery timestamps;
- for network experiments, request/stream identity metadata first, without granting it completion authority.

If deeper stream inspection becomes necessary, use only the minimum bounded in-memory evidence needed to answer a specific question. Do not persist transcripts, credentials, cookies, Authorization headers, provider payloads, or full response bodies.

Diagnostic code does not automatically deserve integration. It may remain experimental and be discarded once the live causal boundary is known.

### Phase B — one causal fix

Only after live evidence identifies one failing boundary:

1. implement the smallest fix for that boundary;
2. do not combine unrelated resilience/UI/permission refactors;
3. add a regression that fails for the proven defect;
4. compare runtime/package surface directly to v3.0.0;
5. build an exact PR-head artifact;
6. have the owner test that artifact in real logged-in Chrome before merge.

### Phase C — integrate only after live pass

Do not merge a background-monitoring runtime candidate until the owner confirms on the exact PR-head artifact that:

- the response is started while the monitored ChatGPT tab is active;
- the user leaves before completion and does not return;
- the correct notification arrives while the tab is still inactive;
- status-bearing response -> semantic notification only;
- no-status response -> generic response-finished only after real completion;
- no notification is emitted at response start;
- returning to the tab does not create a duplicate;
- first send after Reload and later sends behave consistently.

After owner PASS, refresh PR/head/base/CI evidence, integrate through normal protected-branch rules, run exact-main CI, and only then consider release preparation. Release and Chrome Web Store publication remain separate actions.

## Scope and size guardrails

Use v3.0.0 as the comparison baseline for every runtime candidate:

- 48 packaged runtime files;
- exact v3.0.0 ZIP SHA-256 `2771b6cf4fe3e90188af95d989e5f3dcd751b1b29f37b9594f5c36fb28ccc64c`;
- existing Chrome permissions/host scope;
- existing tab-scoped Side Panel behavior;
- existing read-only ChatGPT boundary.

For every runtime candidate, report:

- added/removed packaged runtime files;
- ZIP byte size and delta from v3.0.0;
- permission/host-permission delta;
- changed runtime modules;
- why every runtime addition is necessary for the proven causal boundary.

Unexpected package growth is a review finding, not something to normalize after the fact.

## Historical references

Use history only as evidence, not as the implementation baseline:

- Issue #83: successive live reproductions, rejected hypotheses, diagnostics, and rollback decision;
- PRs #94-#102: post-v3.0.0 experiments rejected by owner live validation;
- PR #103: exact rollback to v3.0.0;
- Issue #104: new active investigation contract from the clean baseline;
- Release `v3.0.0`: authoritative current product release.
