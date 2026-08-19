# MVP Validation and Security Review

Status: release-candidate validation plan and automated evidence map  
Target: Chromium Manifest V3, ChatGPT Web, one browser profile/session  
Delivery model: integration-only; Chrome Web Store publication is not an MVP prerequisite

This document is the final MVP acceptance map. It separates evidence that CI can prove from the logged-in live-browser scenarios that must be exercised against the current ChatGPT Web UI before a specific local installation is treated as proven on that UI build.

## 1. Release-candidate validation commands

From a fresh clone:

```bash
npm ci
npm run validate
npm run smoke:extension
npm run package
```

Expected results:

- `npm ci` completes without dependency audit vulnerabilities;
- strict TypeScript checks pass for background/Side Panel and content-script compiler targets;
- repository lint passes;
- all automated tests pass;
- Chromium accepts `dist/` as an unpacked extension without load errors;
- `artifacts/chat-turn-guardian-<version>.zip`, `SHA256SUMS.txt`, and `build-info.json` are produced;
- the packaged ZIP contains `manifest.json` and extension runtime assets but no `.ts`, `.map`, or `.env` files.

CI performs the same validation and retains the package as an artifact for the exact candidate SHA.

## 2. Threat model and final review

The MVP intentionally has one narrow write capability: after a conservative classification and local safety gates, the content agent may insert the configured continuation text into the exact current ChatGPT conversation and invoke the current send control.

| Threat / race | Required control | Evidence |
| --- | --- | --- |
| Cross-tab or cross-conversation action | Exact `tabId`, `documentId`, content-agent identity, page epoch, conversation ID, route, assistant fingerprint, and policy revision binding | `tests/session-registry.test.mjs`, `tests/automation-coordinator.test.mjs`, `tests/background-integration.test.mjs` |
| Two copies of one conversation both sending | One `OWNER`; other copies are `MIRROR`/observe-only until fresh takeover | `tests/session-registry.test.mjs`, coordinator tests |
| User types/sends/edits/stops while automation waits | Human interaction cancels or stales pending automation; final pre-mutation checks repeat after asynchronous waits | coordinator and guarded-send race tests |
| Navigation/response replacement during provider or timer delay | Evidence key and immutable decision envelope are re-read; stale result is dropped | coordinator delayed-provider/navigation tests |
| Silent terminal leaves the prior assistant in the DOM | A user turn newer than the last assistant suppresses that assistant as a response candidate; idle state alone cannot create classifier or send authority | `tests/revision7-regressions.test.mjs`, adapter/coordinator tests |
| Red Retry/platform error appears | Existing blocking-surface detection holds before classification/action; guarded send rechecks blocking UI immediately before mutation and never clicks Retry/dismiss controls | `tests/revision7-regressions.test.mjs`, adapter/guarded-send tests |
| Independent-review or external human relay is required | Deterministic human-operation rules HOLD before provider classification; provider contract independently requires human-relay HOLD and has no DOM authority | `tests/revision7-regressions.test.mjs`, `tests/provider-classifier-contract.test.mjs` |
| Service-worker restart revives stale action | Restored sessions lose observation authority and must produce fresh evidence | session-registry restart tests, automation-service startup tests |
| Ambiguous page write produces duplicate continuation | Write intent reserved before mutation; ambiguous/unknown outcome remains a no-retry guard | automation journal/coordinator/guarded-send tests |
| AI/provider gains browser authority | Provider receives bounded data and returns normalized advisory result only; no provider API has DOM/tab mutation authority | classification/provider modules and protocol boundaries |
| Prompt injection in chat text changes classifier instruction | Conversation text is untrusted user payload under a fixed classifier system contract; output is strict-schema validated | `tests/classifier.test.mjs`, provider tests |
| Credential exfiltration to page/content script | Durable provider/policy storage is restricted to trusted extension contexts before restore | storage/provider startup tests |
| Credential forwarding to unexpected provider origin | HTTPS-only endpoint validation, sensitive-header restrictions, exact-origin host permission, redirects refused | provider tests |
| Stale provider host access remains after profile replacement/removal | Provider mutations serialize; exact origin is revoked when no saved profile still requires it | `tests/provider-permissions.test.mjs` |
| Infinite useful-work counter stops legitimate progress | Stagnation is driven by recent verified outcome similarity; hard count is a separate high emergency fuse | `tests/reliability-progress.test.mjs` |
| Notification failure changes automation behavior | Notification/audit are read-only observers; delivery failures are swallowed and audited generically | `tests/reliability-service.test.mjs` |
| Audit log leaks chat/provider secrets | Bounded structured metadata; secret redaction; no full chat content; free-form classifier reasons are not persisted | `tests/audit-history.test.mjs`, Side Panel tests |
| Side Panel/content script can forge privileged config writes | Management reads/writes require trusted extension-page sender; content sender uses exact tab/document identity | background/protocol integration tests |
| ChatGPT DOM selector drift causes unsafe guess | Missing/changed identity, composer, send, generation, or blocking evidence fails closed | adapter/guarded-send fixture tests |

### Review conclusion

The architecture preserves the intended authority boundary:

```text
ChatGPT DOM observation
  -> exact session registry
  -> bounded user+assistant classification context
  -> deterministic rules / advisory AI classification
  -> per-chat state machine and policy
  -> progress/reliability guard
  -> final exact content-agent revalidation
  -> configured continuation only
```

No layer before the guarded content adapter has general browser-action authority. No safe path converts provider failure, uncertainty, policy/storage failure, notification failure, stale/nonexistent response evidence, or blocking UI into `CONTINUE`.

## 3. Automated MVP acceptance evidence

### Multi-tab isolation

Automated tests create concurrent tab/session state, duplicate conversations, navigation races, stale documents, and concurrent persistence. Expected result: one tab's events/timers never mutate another chat and duplicate copies have at most one automatic-control owner.

### Mode isolation

Coordinator and Side Panel integration tests cover `OFF`, `OBSERVE`, `AUTO`, and `NOTIFY_ONLY`. Expected result: only `AUTO` can reach the guarded-send path; `NOTIFY_ONLY` supports response-finished notification without a send path.

### Conservative classification

Classifier tests cover approval/material-decision boundaries, human relay/external-operation boundaries, explicit stop, provider failure, low confidence, malformed output, prompt-injection-style content, secret redaction, and bounded recent context. Expected result: only a high-confidence, schema-consistent `CONTINUE / NEEDLESS_TURN_BOUNDARY` can become an action candidate. A required relay to another chat/person/tool is a deterministic `HOLD / HUMAN_OPERATION_REQUIRED` before provider classification.

### Fresh response and blocking UI

Revision-7 regressions cover an idle page with a newer user turn but no new assistant response, plus a red Retry/error surface. Expected result: no stale assistant is promoted to a new response instance, no classifier runs for a nonexistent response, blocking UI prevents evaluation/action, and neither Retry nor the configured continuation is clicked/sent.

### Guarded write and race safety

Tests cover user typing during hashing/delays, provider delay, policy changes, ownership loss, emergency pause, response replacement, ambiguous send, exact-document delivery, and intended user-turn + generation-start verification.

### Reliability

Tests cover notification routing/failure isolation, bounded audit history, progress vs repetition, per-chat policy isolation, and the separate hard fuse.

### Release package

`npm run package` creates a deterministic store-only ZIP from the built extension payload, a SHA-256 checksum file, and build metadata. CI uploads the exact candidate's package artifacts.

## 4. High-signal live ChatGPT Web scenario matrix

These scenarios require a Chromium browser profile in which the user can open real ChatGPT conversations. They are intentionally not simulated as proof of the current production ChatGPT DOM.

Record the browser version, extension commit/package SHA, ChatGPT host, provider profile/model, and result for each run. Run one high-signal scenario at a time; a failure is evidence to inspect, not a reason for blind retry or weaker guards.

### Scenario A — first-use / recovery

Load or reload the unpacked extension and verify the Side Panel reconnects to the current logged-in ChatGPT tab without stale action replay.

Expected:

- current tab/conversation becomes visible after fresh content-agent evidence;
- no old delayed decision is replayed;
- saved extension identity/state is preserved when upgrading in place.

### Scenario B — clean OBSERVE

1. Enable a real ChatGPT conversation in `OBSERVE`.
2. Submit a normal request and let the assistant finish.
3. Keep the composer untouched while settle/classification completes.

Expected:

- Side Panel shows the exact connected conversation/tab;
- a real bounded provider classification may be recorded;
- no continuation message is inserted or sent.

### Scenario C — safe AUTO continuation

1. Use a selected OWNER conversation whose active workflow clearly has bounded remaining executable work and whose finished assistant turn is a needless turn boundary rather than a human boundary.
2. Set the chat to `AUTO` with configured continuation text `Continue.` and leave the page/composer untouched.

Expected:

- classifier returns valid `CONTINUE / NEEDLESS_TURN_BOUNDARY`;
- exact tab/document/content-agent/page epoch/route/conversation/assistant-response identity remains current through final synchronous revalidation;
- exactly one configured `Continue.` user turn appears and ChatGPT generation starts;
- the next response that completes the requested outcome HOLDs/stops;
- no second send or loop occurs.

If classification is `HOLD`/`UNSURE`, treat it as evidence and inspect the current audit/runtime state; do not retry blindly or weaken the classifier.

### Scenario D — legitimate human boundary

Ask the chat to stop for a real material choice, approval, credential, confirmation, or other human-only decision.

Expected:

- decision is `HOLD` (or conservatively `UNSURE`);
- no continuation is inserted/sent;
- audit/notification remains bounded and secret-free.

### Scenario D2 — independent-review / human relay

Use a real response whose correct next step explicitly requires the user to carry a prompt/result to a separate independent chat, reviewer, person, or external tool. Do not manufacture an AUTO send merely to exercise this case.

Expected:

- response is `HOLD / HUMAN_OPERATION_REQUIRED` (or conservatively `UNSURE`), never `CONTINUE`;
- Guardian does not paste the generated handoff prompt back into the same chat;
- if the prompt/handoff itself was the requested final deliverable, completion still stops rather than continuing automatically.

### Scenario E — NOTIFY_ONLY distinct response instances

Use `NOTIFY_ONLY` with the `Response finished` notification trigger and produce two distinct assistant response instances, including a case where their visible text is identical when practical.

Expected:

- each distinct completed response instance can produce its own notification;
- no classifier-driven send state and no page mutation occurs.

### Scenario F — human interaction race

1. Let a suitable `AUTO` conversation reach the visible continuation delay.
2. Perform a real trusted composer interaction before the delay expires.

Expected:

- pending automation is cancelled/staled for that exact response;
- Guardian never overwrites or competes with human composer state;
- automatic platform/browser refocus without matching human intent does not falsely cancel supervision.

### Scenario G — duplicate conversation OWNER/MIRROR isolation

Open the same conversation in two tabs and exercise a safe AUTO candidate only on the exact OWNER copy.

Expected:

- exactly one tab is `OWNER`; duplicate copy is `MIRROR`;
- MIRROR never auto-sends;
- takeover after owner loss requires fresh valid observation before automation eligibility.

### Scenario H — provider readiness / failure

Exercise the configured provider readiness path and a real provider failure such as rate limit, timeout, invalid output, or invalid configuration when available.

Expected:

- successful readiness uses bounded synthetic context;
- provider failures remain fail-closed and never become `CONTINUE`;
- no automatic send occurs because of provider failure.

### Scenario I1 — silent terminal / no assistant output

Use a real occurrence where ChatGPT leaves working/generating state and returns to idle without creating a fresh assistant response.

Expected:

- no assistant response instance is invented from the UI transition;
- classifier is not called for the nonexistent response;
- no continuation is inserted/sent;
- Guardian remains fail-closed until a fresh exact assistant response actually exists.

### Scenario I2 — red Retry/error blocker

When ChatGPT shows its real red Retry/error surface:

Expected:

- the surface is treated as blocking/platform UI and supervision HOLDs/fails closed;
- provider output cannot authorize a continuation through the blocker;
- Guardian never clicks Retry or dismisses the error;
- no automatic continuation is sent until the user/platform resolves the condition and fresh valid evidence exists.

### Scenario I — other blocking/platform UI

When ChatGPT displays another real rate-limit, confirmation, account-verification, modal, CAPTCHA, network, or blocking error surface:

Expected:

- automation holds/fails closed;
- no attempt is made to bypass, answer, or dismiss the safeguard automatically.

### Scenario J — service-worker / extension restart

1. With a managed chat open, reload the extension from `chrome://extensions` or otherwise restart the extension service worker.
2. Do not rely on pre-restart observations as action authority.

Expected:

- no old delayed decision is replayed;
- no stale automatic continuation is sent;
- automation becomes eligible again only after fresh content-agent/session observation.

## 5. Live-run evidence template

Use one row per scenario/candidate:

| Candidate SHA / package SHA-256 | Browser | ChatGPT host | Scenario | Result | Notes |
| --- | --- | --- | --- | --- |
| `<sha>` | `<version>` | `chatgpt.com` | C | PASS/FAIL | `<brief evidence>` |

A failed live scenario should be treated as a current adapter/product defect, not worked around by weakening identity, human-precedence, provider-output, blocking-UI, or no-blind-retry gates.

## 6. Release decision

For this repository's `INTEGRATION_ONLY` MVP, repository delivery is proven when:

1. the final PR's exact head passes required CI including package creation;
2. review finds no open BLOCKER/REQUIRED safety issue;
3. the PR is merged to `main` without base/head drift;
4. the resulting `main` commit is verified and the package/checksum artifact is available for that candidate;
5. the live scenario matrix is run before declaring a particular personal browser installation proven against the then-current ChatGPT Web DOM.

Public Chrome Web Store publication is intentionally outside this MVP delivery requirement.
