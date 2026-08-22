# Chat Turn Guardian Status Protocol

## Purpose

The status protocol is optional metadata that helps the read-only Guardian classify the semantic state of a ChatGPT conversation without creating another chat turn.

Guardian must continue to work when the marker is absent, malformed, omitted for a strict output format, or ignored by the model.

## Canonical marker

Use exactly:

```text
CHAT_TURN_GUARDIAN_STATUS={"decision":"<VALUE>"}
```

Supported values:

- `CONTINUE`
- `HOLD_APPROVAL`
- `HOLD_DECISION`
- `HOLD_HUMAN_OPERATION`
- `COMPLETE`
- `PLATFORM_ERROR`
- `RATE_LIMIT`
- `UNSURE`

The public marker name is intentionally version-neutral so future protocol revisions do not require users to rewrite persistent instructions.

## Decision semantics

- `CONTINUE` — requested work remains and can proceed without human approval, a material human decision, missing human-provided information/credentials, or a human-only operation.
- `HOLD_APPROVAL` — explicit human approval or authorization is required.
- `HOLD_DECISION` — a material choice should be made by the human rather than selected autonomously.
- `HOLD_HUMAN_OPERATION` — missing human information/credentials or an action only the human can perform is required.
- `COMPLETE` — the requested outcome is actually complete and no further work remains for the current request.
- `PLATFORM_ERROR` — a platform/tool/runtime/service failure blocks progress.
- `RATE_LIMIT` — a usage/quota/rate limit blocks progress.
- `UNSURE` — the model cannot reliably classify the current state.

The status must reflect the actual work state after producing the answer. Do not use `COMPLETE` just because one intermediate step finished, and do not use `CONTINUE` when a real human gate is required.

## Placement rules

When appropriate, the status record must be:

- exactly one record;
- the final standalone line of the same assistant response;
- visually/structurally separate from the answer body;
- outside Markdown code fences, inline code, JSON/code payloads, block quotes, tables, or other requested output containers;
- followed by no text.

Example:

```text
The requested implementation is complete and validated.

CHAT_TURN_GUARDIAN_STATUS={"decision":"COMPLETE"}
```

The marker is **not** a separate second assistant turn.

## Strict-output exception

If the user explicitly asks for an exact, strict, or format-exclusive output where an extra line would invalidate the requested result, omit the marker for that reply.

Examples include an exact JSON payload, a code-only response, or another machine-consumed format that forbids extra text.

Missing marker is a valid fallback condition. Guardian must not treat omission as failure or create a recovery/self-check turn.

## Invalid examples

Inside a code fence:

````text
```json
CHAT_TURN_GUARDIAN_STATUS={"decision":"CONTINUE"}
```
````

Inside a block quote:

```text
> CHAT_TURN_GUARDIAN_STATUS={"decision":"CONTINUE"}
```

Inside a table:

```text
| CHAT_TURN_GUARDIAN_STATUS={"decision":"CONTINUE"} |
```

With trailing content:

```text
CHAT_TURN_GUARDIAN_STATUS={"decision":"CONTINUE"}
more text
```

Multiple markers, conflicting canonical/legacy markers, malformed JSON, unsupported values, or extra fields are also invalid.

## Legacy compatibility

v2 continues to read the shipped v1 marker:

```text
CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"<VALUE>"}
```

This is compatibility input only. v2 Side Panel and current documentation generate/recommend only `CHAT_TURN_GUARDIAN_STATUS`.

## Side Panel setup methods

Guardian exposes two copyable instruction variants.

### Custom Instructions / Personalization

Use when the user wants compatible normal replies across chats. The text explains all decision values, placement rules, the strict-output exception, and that the marker is optional.

### One conversation only

Use when the user prefers not to change account-wide Custom Instructions. The user manually sends the copied instruction once near the start of that conversation.

Guardian never pastes or sends either instruction into ChatGPT.

## Resolution precedence

A valid marker is not the highest authority. Guardian resolves state in this order:

1. high-confidence page/UI blocker evidence;
2. valid terminal marker;
3. deterministic local rules;
4. optional provider fallback;
5. unknown/unsure.

A contradictory marker cannot override a reliable rate-limit, auth, verification, Retry/error, or other authoritative page state.

## Security property

The protocol is observational metadata only. No status value, including `CONTINUE`, authorizes Guardian to write to the ChatGPT composer or activate ChatGPT controls.
