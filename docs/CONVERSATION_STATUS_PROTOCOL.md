# Conversation terminal-status protocol

Status: Shipped in v1.2.0 for [Issue #56](https://github.com/ach1992/chat-turn-guardian/issues/56) and refined in v1.2.1 for [Issue #57](https://github.com/ach1992/chat-turn-guardian/issues/57). This contract supersedes the repeated per-stop reply shape from Issue #51 while retaining its guarded in-chat fallback.

## Goal

Avoid unnecessary control turns. When the latest assistant response already ends with a valid machine-readable status, Guardian decides directly from that status. Only an ambiguous response without a valid status receives a bounded same-conversation self-check.

The self-check also asks the current chat to remember the protocol for the rest of that conversation. This is conversation-context behavior, not a claim about account-level OpenAI memory. If a later response omits the marker, Guardian may send one new self-check for that exact missing-status episode.

## Terminal record

Normal future replies remain human-readable and end with exactly one final line:

```text
CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"CONTINUE"}
```

The only accepted decisions are:

- `CONTINUE`
- `HOLD_APPROVAL`
- `HOLD_DECISION`
- `HOLD_HUMAN_OPERATION`
- `COMPLETE`
- `PLATFORM_ERROR`
- `RATE_LIMIT`
- `UNSURE`

Parsing is strict. The marker must occur exactly once as the terminal suffix, contain one JSON object with exactly one `decision` member, use the exact case-sensitive vocabulary, and have no text after the JSON other than whitespace. Bare JSON, duplicate JSON members, Markdown fence wrappers, duplicate markers, extra keys, unknown decisions, trailing prose, or malformed JSON are not valid terminal records.

ChatGPT's rendered DOM may flatten adjacent block elements in `textContent`. The content adapter therefore prefers rendered `innerText` boundaries, and the parser also accepts the unique marker as a flattened terminal suffix. A marker rendered inside a detected `pre`/`code` block is annotated as non-terminal and rejected.

## Decision order

```text
stable latest assistant response
  -> exact identity / OWNER / composer / human-precedence / UI gates
  -> strip a valid terminal record from the human-readable body
  -> deterministic hard HOLD on the body wins
  -> valid terminal record?
       yes -> map status locally; do not self-check
       no  -> deterministic obvious CONTINUE available?
                yes -> use it; do not self-check
                no  -> AUTO and eligible?
                         yes -> send one guarded protocol self-check
                         no  -> provider/UNSURE according to mode
  -> response to that self-check has a valid terminal record?
       yes -> map it
       no  -> UNSURE/HOLD; never self-check the self-check response
  -> map the terminal decision to its exact local response policy
       CONTINUE                         -> send the autonomous continuation response
       PLATFORM_ERROR / RATE_LIMIT      -> send one recovery/recheck response
       UNSURE                           -> send one reclassification response
       HOLD_* / COMPLETE                -> send nothing
  -> every permitted response still passes final identity, policy, ownership,
     human, write, stagnation, and hard-fuse guards before one send
```

A terminal `CONTINUE` is advisory data, not mutation authority. A local deterministic HOLD, unsafe UI, stale identity, human activity, non-owner tab, ambiguous prior write, stagnation, or fuse boundary still blocks the send.

## Self-check/bootstrap message

The fallback is a structured, readable activation message with `Purpose`, `This reply`, `Future replies`, and `Values` sections. It explicitly says that the protocol must not change, restart, reframe, summarize, reprioritize, or continue the current task or project. For its immediate reply, the chat remembers the conversation-local contract, classifies the work state before the activation message, and returns only the terminal record. For later replies, it answers normally without changing project direction, scope, priority, or plan, then appends the record.

The content adapter constructs contenteditable composer text with text nodes and explicit `br` boundaries. The message therefore retains the same line and section layout seen in this document instead of collapsing into a visually disordered paragraph.

The prompt is bounded to the existing 1,000-character guarded-send limit.

## Status-specific response policy

The protocol decision selects a fixed response; it does not reuse one generic configurable continuation string for every state.

| Terminal decision | Guardian response |
|---|---|
| `CONTINUE` | `All right. Continue and complete the project. Do not stop unless you genuinely need human approval, a material decision, missing information or credentials, or a human-only action.` |
| `PLATFORM_ERROR` or `RATE_LIMIT` | `Check again to see whether the blocker has been resolved. If it has, continue and complete the project. Do not stop unless you genuinely need human approval, a material decision, missing information or credentials, or a human-only action.` |
| `UNSURE` | `Check the work state again and return the status record once more.` |
| `HOLD_APPROVAL`, `HOLD_DECISION`, `HOLD_HUMAN_OPERATION`, or `COMPLETE` | No message. |

Recovery and uncertainty responses are recorded as durable `STATUS_RESPONSE` writes and are emitted at most once until a later human-interaction epoch. A marked `CONTINUE` may continue again only after the chat produces a new assistant response and every progress/stagnation/fuse guard still passes.

## Loop and restart safety

- A verified self-check turn is recorded with its exact conversation, response, prompt text, protocol version, and decision identity.
- If the response to that self-check omits or corrupts the marker, the episode becomes `UNSURE`; it cannot recursively create another self-check.
- A valid `UNSURE`, `PLATFORM_ERROR`, or `RATE_LIMIT` status can produce only its single fixed response for the current human-interaction epoch; the same response is not replayed repeatedly.
- A later ordinary response without a marker is a new episode and may receive one fallback self-check.
- The guarded-write journal is durable negative authority. It compacts records made obsolete by a fresh human-interaction epoch and has a hard 4,096-record capacity that fails closed before storage quota exhaustion. Service-worker/browser restart cannot blindly replay a retained reserved, ambiguous, or verified write against the same assistant response.
- Protocol bootstrap records do not count as verified auto-continuations for the hard fuse.
- Progress signatures exclude the terminal marker so status syntax cannot create fake progress.
- Human interaction cancels pending authority for the currently observed response. A later stable response to a new human turn can be evaluated from its own terminal marker.

## Recoverable platform errors

A visible Retry/red delivery error may receive the bounded protocol bootstrap or a status-specific recovery response only when the normal composer is usable and all exact identity and human-precedence guards pass. Guardian never clicks `Retry`. Conversation-full/new-chat-required, authentication, CAPTCHA, verification, confirmation, unsafe composer, permission, or platform safety boundaries remain hard no-send states.

## Acceptance coverage

Automated coverage includes exact multiline bootstrap insertion, direct marker parsing without self-check, every decision-to-response mapping, no-send HOLD/completion states, missing/malformed/duplicate/non-terminal markers, one bounded fallback, no recursive fallback, once-per-human-epoch recovery/uncertainty responses, activation continuation, repeated marked continuation, deterministic HOLD precedence, deterministic obvious continuation without wasted self-check, human-turn freshness, recoverable/hard error separation, durable journal restore, marker-free progress signatures, OWNER/MIRROR isolation, stale-state cancellation, ambiguous-write freeze, stagnation, and hard fuse behavior.
