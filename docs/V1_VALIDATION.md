# v1 Validation and Security Review

Status: v1.0 acceptance and regression-evidence map  
Target: Chromium Manifest V3, ChatGPT Web, one browser profile/session  
Delivery model: repository integration and validated release package; Chrome Web Store publication is a separate human-gated release action

This document records the safety evidence expected for Chat Turn Guardian v1.0 and the live scenarios already exercised against real ChatGPT/Telegram environments. It is a durable maintenance reference, not a requirement to manufacture rare platform failures.

## 1. Release validation commands

From a fresh clone:

```bash
npm ci
npm run validate
npm run smoke:extension
npm run package
```

A release candidate is acceptable only when the exact candidate SHA passes the repository-required validation, including strict TypeScript checks, lint, the full automated test suite, Chromium unpacked-extension smoke, deterministic packaging, ZIP verification, and source/artifact provenance.

Expected package outputs:

- `artifacts/chat-turn-guardian-<version>.zip`;
- `artifacts/SHA256SUMS.txt`;
- `artifacts/build-info.json`.

The release ZIP must contain the built Manifest V3 extension payload and referenced assets, but no TypeScript sources, source maps, `.env` files, credentials, or unrelated development artifacts.

## 2. Permanent safety invariants

The following are product constraints, not temporary v1 implementation details:

1. Human interaction always wins over pending automation.
2. Automatic action is bound to the exact tab/document/content-agent/page epoch/route/conversation/assistant-response/response-instance identity.
3. Duplicate copies of one conversation use OWNER/MIRROR isolation; MIRROR never auto-sends.
4. `CONTINUE` is advisory until final synchronous revalidation immediately before page mutation.
5. The composer must be empty and unchanged at the guarded-send boundary.
6. Stale decisions are cancelled rather than replayed.
7. Ambiguous writes freeze automatic retry; there is no blind send retry.
8. Uncertainty, provider failure, platform blocking UI, rate limits, and storage uncertainty fail closed.
9. AI-provider output never gains DOM/tab/browser mutation authority.
10. Provider credentials and Telegram bot tokens remain in trusted extension contexts and never enter page/content contexts, ordinary status surfaces, audit history, or logs.
11. Notification channels are observational only and can never authorize ChatGPT mutation.
12. New providers, notification channels, page adapters, and other bounded capabilities must use narrow interfaces and must not inherit guarded-send authority.

## 3. Threat and regression evidence

| Threat / race | Required control | Representative evidence |
| --- | --- | --- |
| Cross-tab or cross-conversation action | Exact session/message identity and policy revision binding | session registry, coordinator, background integration tests |
| Duplicate conversation sends | One OWNER; MIRROR observe-only until fresh takeover | session-registry/coordinator tests and live duplicate-tab scenario |
| Human types/sends/edits/stops during automation | Interaction stales/cancels pending action; final checks repeat after waits | guarded-send/coordinator race tests and live human-race scenario |
| Navigation/response changes during provider/timer delay | Immutable decision envelope is re-read; stale result is dropped | delayed-provider/navigation tests |
| Silent terminal exposes an old assistant DOM node | Newer user turn prevents the old assistant from becoming a fresh response | `tests/revision7-regressions.test.mjs` and adapter/coordinator coverage |
| Retry/error/blocking UI appears | Blocking UI prevents evaluation/action; final guarded send rechecks it; Guardian never clicks Retry/dismiss | revision-7 and guarded-send tests |
| Human relay or approval is required | Deterministic HOLD before provider authority; provider contract remains advisory | revision-7/provider classifier contract tests and live relay scenario |
| Service worker restarts | Restored sessions require fresh page evidence; no stale decision replay | restart/recovery tests and live restart scenario |
| Page write result is ambiguous | Write intent is journaled and blind retry is blocked | automation journal/coordinator/guarded-send tests |
| Provider receives prompt injection or malformed output | Fixed system contract, untrusted conversation payload, strict normalized output | classifier/provider tests |
| Credential leaks or redirects | Trusted storage, HTTPS-only endpoints, exact-origin runtime permission, redirect refusal | provider/permission/storage tests |
| Notification delivery affects chat authority | Notification manager is observational; failures remain isolated | reliability/notification-manager/Telegram tests |
| Telegram credential or transport failure leaks details | Secret non-disclosure, bounded/sanitized health, timeout/rate-limit/no-retry | Telegram settings/transport/manager tests |
| Telegram service-worker fetch receiver is wrong | Default native fetch is bound to `globalThis` | receiver-sensitive Telegram transport regression test added with PR #46 |
| ChatGPT selector/DOM drift | Missing or ambiguous evidence fails closed | adapter/guarded-send fixture tests |

## 4. Accepted real-platform v1 evidence

The following high-signal scenarios were exercised during v1 development and accepted:

- manual STOP/OFF: no later automatic continuation;
- normal `OBSERVE`: provider classification occurs without a send path;
- material-decision and project-complete boundaries: HOLD with no automatic continuation;
- provider failure/rate-limit: fail closed with no blind send;
- `NOTIFY_ONLY` response-complete notification, including distinct response instances with identical visible text;
- current-tab OFF/ON controls and bounded reconnect behavior;
- provider/model management: saved profiles survive updates and model filtering/catalog flows work;
- safe OWNER/AUTO continuation: exactly one configured `Continue.` was sent for a valid needless boundary, and completion then HOLDed without a loop;
- trusted human-interaction race: user composer input remained untouched and pending automation was suppressed;
- duplicate OWNER/MIRROR AUTO isolation: only the OWNER sent;
- service-worker/extension restart: no stale continuation replayed and fresh observation was required;
- independent-review/human-relay boundary: Guardian HOLDed and did not relay/paste/send the handoff automatically;
- toolbar action opened the Side Panel on a supported ChatGPT page after the production toolbar/Side Panel work;
- Telegram v1 owner-local acceptance on 2026-08-20: the same existing unpacked extension folder was updated and reloaded, saved configuration remained available, the Side Panel reported `Configured`, `Enabled`, and `Healthy`, and a real **Test notification** was delivered to the owner's Telegram destination without exposing the bot token.

The Telegram live acceptance followed a real defect investigation rather than a mocked success. Direct service-worker probes proved the Telegram Bot API, saved credential, destination, and POST transport were valid; PR #46 then corrected the receiver binding of the default native `fetch`, added a receiver-sensitive regression test, passed exact-head CI, and was integrated before the successful owner retest.

## 5. Opportunistic platform-state evidence

Three rare current-platform states were previously tracked as mandatory MVP closeout items:

- a naturally occurring silent terminal/no-fresh-assistant-response state;
- the real red Retry/error blocker;
- another naturally occurring blocking/platform UI state.

They have **not** been claimed as live-passed. Automated regressions already cover the required fail-closed behavior, and the accepted v1.0 closeout no longer treats the chance occurrence of those external states as a release blocker.

Do not manufacture them, intentionally break ChatGPT, click Retry merely for evidence, or weaken blocker detection. If one occurs naturally during future development or use, preserve the state and capture high-signal evidence; a failure remains a product defect and must be fixed without weakening the safety model.

## 6. Provider and notification acceptance

Provider classification remains optional. Without a usable provider for an ambiguous case, Guardian fails closed to `UNSURE`. Current provider support includes built-in OpenRouter and NaraRouter profiles plus the generic OpenAI-compatible transport documented in the README.

Browser notifications and Telegram coexist independently. Telegram v1 is outbound-only: no Telegram command can inject a ChatGPT message, answer an approval, change a mode, start/stop supervision, or otherwise authorize browser mutation. Telegram payloads are bounded notification metadata; full ChatGPT messages are not exported by default.

## 7. Release and future-development decision

Chat Turn Guardian v1.0 is considered feature-complete and release-ready when:

1. the v1.0 candidate's exact head passes required CI and package verification;
2. review finds no open BLOCKER/REQUIRED correctness, security, privacy, compatibility, or authority issue;
3. the candidate is merged to `main` without material drift;
4. the integrated source is reproducibly tied to the validated package/provenance;
5. durable README/spec/privacy/store-readiness documentation matches actual runtime behavior.

Chrome Web Store upload/submission/publication is deliberately separate. Store engineering readiness is maintained in `STORE_READINESS.md`; immediately before a future submission, current Store policies, Developer Dashboard disclosures, real listing screenshots, and the exact submission ZIP must be re-verified and the production action must receive explicit human authorization.

Future product development should start from the v1.0 invariants above and use normal Issues/PRs for new outcomes. Historical v1 acceptance issues do not need to remain open as pseudo-state; Git history, closed Issues/PRs, CI, this document, `PROJECT_SPEC.md`, and `ARCHITECTURE.md` provide the durable baseline.
