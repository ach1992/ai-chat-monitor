# In-chat self-check classifier — v1.1.0 implementation

Status: Historical v1.1.0 contract for Issue #51. The v1.2.0 terminal-status protocol in [`CONVERSATION_STATUS_PROTOCOL.md`](CONVERSATION_STATUS_PROTOCOL.md) supersedes the repeated stop-response shape: a valid status on the latest assistant response is consumed directly, and this self-check is now only a bounded fallback when that status is absent.

This document records the v1.1.0 design added to the already validated v1.0 baseline. Issue #51 owns implementation and acceptance.

## 1. Goal

For eligible ambiguous ChatGPT stops, use the **same conversation** as the primary classifier: Guardian sends one short, controlled self-check question, ChatGPT returns a compact machine-readable classification, and Guardian decides locally whether to resume, hold, or stop.

The purpose is to avoid making external AI-provider API quota a normal requirement when the current conversation already has the full task context.

External providers remain optional fallback/diagnostic capability rather than the default dependency if the in-chat path proves reliable.

## 2. Self-check contract

The probe should be short, explicit, and narrowly scoped. It must tell ChatGPT **not to continue the task yet**, only to classify why the current work stopped.

The exact encoding may be compact JSON or another strict format, but it must distinguish at least:

- `CONTINUE`
- `HOLD_APPROVAL`
- `HOLD_DECISION`
- `HOLD_HUMAN_OPERATION`
- `COMPLETE`
- `PLATFORM_ERROR`
- `RATE_LIMIT`
- `UNSURE`

A representative intent is:

```text
Do not continue the task yet. Classify why the work stopped.

Reply only with the requested short machine-readable result.

CONTINUE only if the requested work is still incomplete and you can continue now without approval, a material decision, new information, credentials, or a human-only action.
Use the appropriate HOLD result when human involvement is genuinely required.
Use COMPLETE when the requested work is finished.
Use PLATFORM_ERROR or RATE_LIMIT when the platform is the blocker.
Use UNSURE when you cannot determine this safely.
```

The final prompt should be validated against representative real scenarios. Do not make it long merely to enumerate every possible wording.

Self-check output is **advisory data**, never browser-mutation authority. Malformed, contradictory, missing, stale, or uncertain output fails closed.

## 3. Resume instruction

Do not rely on the bare v1 `Continue.` as the only resume message.

The default should stay simple and should not inject a second project-management prompt. The intended wording is approximately:

```text
Continue the work from where you stopped. If you need approval, a decision, information, or an action from the human, say so; otherwise continue until the requested work is complete.
```

Keep the final text concise. Avoid long autonomy rules, tool instructions, project orchestration instructions, or content that could unexpectedly redirect the task.

## 4. Intended flow

```text
recognized stop episode
  -> local identity / human-precedence / hard-safety checks
  -> deterministic obvious HOLD/COMPLETE when trustworthy
  -> eligible ambiguous episode
  -> exactly one in-chat self-check probe
  -> verify probe write + bind the resulting response to the same episode
  -> strict parse + fresh revalidation
       CONTINUE -> guarded contextual resume message
       HOLD_*   -> HOLD + optional notification
       COMPLETE -> HOLD/complete state
       PLATFORM_ERROR / RATE_LIMIT -> HOLD + optional notification
       UNSURE / malformed / stale -> fail closed
  -> optional external-provider fallback only when explicitly configured/useful
```

A self-check response must never be mistaken for the original task response. The runtime needs an explicit self-check/stop-episode identity or equivalent state-machine distinction.

## 5. Retry and red delivery errors

A visible `Retry`, red delivery error, or `Message delivery timed out` state is not automatically a permanent no-send boundary in the next design.

If the current page still exposes a normal safe composer and every fresh identity/human-precedence guard passes, Guardian may send **one** bounded self-check probe for that exact stop/error episode. This is closer to the common human recovery behavior of asking what happened / whether the work can continue than blindly clicking Retry.

Rules:

- never click ChatGPT `Retry` automatically;
- never blindly retry a failed or ambiguous self-check write;
- bind the probe to the exact current tab/document/content-agent/pageEpoch/route/conversation and stop/error episode;
- user interaction, navigation, ownership change, policy change, response change, or stale episode cancels pending probe/result;
- if the probe cannot be sent safely, HOLD and optionally notify;
- if the probe write outcome is ambiguous, freeze automatic retry.

## 6. Hard no-probe boundaries

Self-check must not become a generic mechanism for bypassing real platform or account controls.

At minimum, do not automatically probe when:

- ChatGPT says the conversation/context is full and a **new chat is required**;
- the composer is unavailable/disabled such that an ordinary safe user message cannot be sent;
- authentication, account verification, CAPTCHA, permission, or platform safety UI requires human action;
- human interaction has already taken control;
- exact current session/episode identity cannot be established.

Conversation-capacity/new-chat exhaustion is a separate product outcome. This design does not authorize automatic creation/migration to a new ChatGPT conversation.

## 7. Permanent safety requirements

The next implementation must preserve the v1 safety model while explicitly adding the probe as a new mutation type:

- human interaction always wins;
- exact tab/document/content-agent/pageEpoch/route/conversation identity;
- exact stop/self-check episode binding;
- OWNER/MIRROR isolation; MIRROR never probes or resumes automatically;
- empty/unchanged composer before every automatic mutation;
- final synchronous revalidation immediately before the probe and before any resume message;
- stale probe/decision cancellation;
- no blind retry;
- ambiguous-write freeze;
- no automatic Retry click;
- hard platform/account/safety boundaries remain fail closed;
- self-check output and external-provider output remain advisory;
- notification transports remain observational only;
- service-worker restart must not replay stale probe or resume authority.

Because the self-check is itself a mutation before the resume decision, it must have explicit authority/state/journal semantics instead of being hidden inside the old continuation path.

## 8. Reliability and loop protection

The implementation must prevent loops such as:

```text
self-check -> self-check response -> self-check -> ...
```

and:

```text
resume -> no progress -> self-check -> resume -> no progress -> ...
```

At most one self-check probe should be allowed for one exact stop/error episode. Existing stagnation protection and the hard fuse remain defense in depth and should account for self-check/resume cycles.

## 9. External provider role

OpenRouter, NaraRouter, and generic OpenAI-compatible providers remain supported capabilities unless a later outcome intentionally removes them.

For this outcome:

- normal classification should not require an external provider when a reliable in-chat self-check is available;
- provider fallback must never override hard local blockers or human precedence;
- provider failure/rate limit must never turn into `CONTINUE`;
- provider configuration remains useful for optional fallback, diagnostics, and environments where in-chat self-check is unavailable or intentionally disabled.

## 10. Acceptance scenarios

Issue #51 should add focused automated and live coverage for at least:

1. ambiguous normal stop -> one self-check -> `CONTINUE` -> one guarded resume;
2. approval/decision/human-operation -> HOLD, no resume;
3. complete task -> COMPLETE, no resume;
4. malformed/extra/contradictory self-check output -> UNSURE/HOLD;
5. stale self-check response after navigation/user typing/new response -> ignored;
6. OWNER/MIRROR duplicate -> only OWNER may probe/resume;
7. service-worker restart -> no stale probe/resume replay;
8. Retry/red delivery error + safe composer -> one self-check allowed, no Retry click;
9. Retry/error + unsafe/unavailable composer -> HOLD;
10. ambiguous self-check write -> freeze/no retry;
11. conversation/context full + new-chat-required -> no probe, explicit human/new-chat boundary;
12. authentication/CAPTCHA/account/safety blocker -> no probe;
13. optional external-provider fallback cannot override hard blockers;
14. simple resume wording does not create unexpected task redirection;
15. stagnation/fuse stops repeated self-check/resume no-progress cycles.

## 11. Documentation truth

After Issue #51 integration and its v1.2.0 supersession:

- this document remains the historical v1.1.0 self-check contract;
- `README.md`, `docs/ARCHITECTURE.md`, and `docs/CONVERSATION_STATUS_PROTOCOL.md` describe the shipped v1.2.0 status-first runtime;
- `docs/V1_VALIDATION.md` remains the historical v1.0 acceptance record;
- exact-head CI validates the implementation; live ChatGPT smoke evidence must not be claimed until it exists.
