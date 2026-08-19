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

No layer before the guarded content adapter has general browser-action authority. No safe path converts provider failure, uncertainty, policy/storage failure, notification failure, or stale evidence into `CONTINUE`.

## 3. Automated MVP acceptance evidence

### Multi-tab isolation

Automated tests create concurrent tab/session state, duplicate conversations, navigation races, stale documents, and concurrent persistence. Expected result: one tab's events/timers never mutate another chat and duplicate copies have at most one automatic-control owner.

### Mode isolation

Coordinator and Side Panel integration tests cover `OFF`, `OBSERVE`, `AUTO`, and `NOTIFY_ONLY`. Expected result: only `AUTO` can reach the guarded-send path; `NOTIFY_ONLY` supports response-finished notification without a send path.

### Conservative classification

Classifier tests cover approval/material-decision boundaries, explicit stop, provider failure, low confidence, malformed output, prompt-injection-style content, secret redaction, and bounded recent context. Expected result: only a high-confidence, schema-consistent `CONTINUE / NEEDLESS_TURN_BOUNDARY` can become an action candidate.

### Guarded write and race safety

Tests cover user typing during hashing/delays, provider delay, policy changes, ownership loss, emergency pause, response replacement, ambiguous send, exact-document delivery, and intended user-turn + generation-start verification.

### Reliability

Tests cover notification routing/failure isolation, bounded audit history, progress vs repetition, per-chat policy isolation, and the separate hard fuse.

### Release package

`npm run package` creates a deterministic store-only ZIP from the built extension payload, a SHA-256 checksum file, and build metadata. CI uploads the exact candidate's package artifacts.

## 4. High-signal live ChatGPT Web scenario matrix

These scenarios require a Chromium browser profile in which the user can open real ChatGPT conversations. They are intentionally not simulated as proof of the current production ChatGPT DOM.

Record the browser version, extension commit/package SHA, ChatGPT host, provider profile/model, and result for each run.

### Scenario A — OBSERVE, no mutation

1. Load the candidate extension and open a real ChatGPT conversation.
2. Enable the conversation in `OBSERVE`.
3. Submit a normal request and let the assistant finish.
4. Keep the composer untouched while settle/classification completes.

Expected:

- Side Panel shows the exact connected conversation/tab;
- runtime progresses through observation/evaluation as applicable;
- a decision/reason may be recorded;
- no continuation message is inserted or sent.

### Scenario B — safe AUTO continuation

1. Use a selected conversation whose active workflow clearly has bounded remaining work and whose finished assistant turn is a needless turn boundary rather than a human decision/approval boundary.
2. Set the chat to `AUTO` with conservative delays.
3. Leave the page and composer untouched.

Expected:

- only the `OWNER` copy is eligible;
- classifier returns a safe `CONTINUE` candidate;
- the same assistant response remains current through final revalidation;
- exactly one configured continuation user turn appears;
- ChatGPT generation starts;
- Side Panel enters cooldown and audit records the structured continuation outcome.

If the classifier returns `HOLD`/`UNSURE`, that is a safe result, not a reason to weaken the classifier to force Scenario B.

### Scenario C — legitimate human boundary

1. Ask the chat to stop and request a real material choice, approval, credential, external human operation, or other genuine human-only decision before proceeding.
2. Run in `AUTO`.

Expected:

- decision is `HOLD` (or conservatively `UNSURE`);
- no continuation text is inserted;
- configured attention notification may fire;
- audit shows the structured hold/uncertainty reason code without storing full chat text.

### Scenario D — NOTIFY_ONLY response completion

1. Set a chat to `NOTIFY_ONLY`.
2. Enable only the `Response finished` notification trigger.
3. Submit a request and let the assistant finish.

Expected:

- one response-finished notification for the completed response;
- no classifier-driven automatic send state;
- no page mutation.

### Scenario E — human typing race

1. Set a suitable chat to `AUTO` with a visible continuation delay (for example several seconds).
2. Allow a `CONTINUE` candidate to reach the waiting state.
3. Type into or focus the composer before the automatic delay expires.

Expected:

- pending automatic action is cancelled/staled;
- the extension never overwrites or competes with the human composer content;
- no automatic continuation is sent for that response.

### Scenario F — duplicate conversation tabs

1. Open the same ChatGPT conversation in two browser tabs.
2. Observe both in the Side Panel.

Expected:

- one tab is `OWNER`, the other `MIRROR`;
- the mirror cannot auto-send;
- after owner closure/navigation, any takeover requires fresh valid observation before automation eligibility.

### Scenario G — provider/error failure

1. Use an invalid provider key/model or intentionally revoke the provider origin permission.
2. Let an ambiguous stop require AI classification.

Expected:

- provider failure becomes `UNSURE`/error handling, never `CONTINUE`;
- no automatic send;
- configured error/uncertainty notification may fire;
- audit remains secret-free.

### Scenario H — blocking/platform UI

When ChatGPT displays a real rate-limit, error, confirmation, account-verification, or other blocking surface:

Expected:

- automation holds/fails closed;
- no attempt is made to bypass, answer, or dismiss the safeguard automatically.

### Scenario I — service-worker/extension restart

1. With a managed chat open, reload the extension from `chrome://extensions` or otherwise restart the extension service worker.
2. Do not generate new page evidence yet.

Expected:

- no old delayed decision is replayed;
- no stale automatic continuation is sent;
- automation becomes eligible again only after fresh content-agent/session observation.

## 5. Live-run evidence template

Use one row per scenario/candidate:

| Candidate SHA / package SHA-256 | Browser | ChatGPT host | Scenario | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| `<sha>` | `<version>` | `chatgpt.com` | A | PASS/FAIL | `<brief evidence>` |

A failed live scenario should be treated as a current adapter/product defect, not worked around by weakening identity, human-precedence, provider-output, blocking-UI, or no-blind-retry gates.

## 6. Release decision

For this repository's `INTEGRATION_ONLY` MVP, repository delivery is proven when:

1. the final PR's exact head passes required CI including package creation;
2. review finds no open BLOCKER/REQUIRED safety issue;
3. the PR is merged to `main` without base/head drift;
4. the resulting `main` commit is verified and the package/checksum artifact is available for that candidate;
5. the live scenario matrix is run before declaring a particular personal browser installation proven against the then-current ChatGPT Web DOM.

Public Chrome Web Store publication is intentionally outside this MVP delivery requirement.
