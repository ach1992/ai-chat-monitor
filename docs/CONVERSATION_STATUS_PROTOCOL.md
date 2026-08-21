# Conversation terminal-status protocol

Status: Implemented for [Issue #56](https://github.com/ach1992/chat-turn-guardian/issues/56) on the next-version draft branch. This contract supersedes the repeated per-stop reply shape from Issue #51 while retaining its guarded in-chat fallback.

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

Parsing is strict. The marker must occur exactly once, start the final line, contain one JSON object with only `decision`, use the exact case-sensitive vocabulary, and have no text after the JSON other than whitespace. Bare JSON, code fences, duplicate markers, extra keys, unknown decisions, trailing prose, or malformed JSON are not valid terminal records.

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
  -> CONTINUE still passes final identity, policy, ownership, human, write,
     stagnation, and hard-fuse guards before one contextual resume send
```

A terminal `CONTINUE` is advisory data, not mutation authority. A local deterministic HOLD, unsafe UI, stale identity, human activity, non-owner tab, ambiguous prior write, stagnation, or fuse boundary still blocks the send.

## Self-check/bootstrap message

The fallback is a structured, readable activation message rather than a terse three-line prompt. It has `ACTIVATION`, `FUTURE REPLIES`, `STATUS RECORD`, and `VALUES` sections. For its immediate reply, the chat classifies the work state before the activation message and returns only the terminal record; it does not continue the task in that reply. For later replies, it answers normally and appends the record.

The prompt is bounded to the existing 1,000-character guarded-send limit.

## Loop and restart safety

- A verified self-check turn is recorded with its exact conversation, response, prompt text, protocol version, and decision identity.
- If the response to that self-check omits or corrupts the marker, the episode becomes `UNSURE`; it cannot recursively create another self-check.
- A later ordinary response without a marker is a new episode and may receive one fallback self-check.
- The guarded-write journal is durable negative authority. Service-worker/browser restart cannot blindly replay a reserved, ambiguous, or verified write against the same assistant response.
- Protocol bootstrap records do not count as verified auto-continuations for the hard fuse.
- Progress signatures exclude the terminal marker so status syntax cannot create fake progress.
- Human interaction cancels pending authority for the currently observed response. A later stable response to a new human turn can be evaluated from its own terminal marker.

## Recoverable platform errors

A visible Retry/red delivery error may receive the bounded protocol self-check only when the normal composer is usable and all exact identity and human-precedence guards pass. Guardian never clicks `Retry`. Conversation-full/new-chat-required, authentication, CAPTCHA, verification, confirmation, unsafe composer, permission, or platform safety boundaries remain hard no-send states.

## Acceptance coverage

Automated coverage includes direct marker parsing without self-check, all decision mappings, missing/malformed/duplicate/non-terminal markers, one bounded fallback, no recursive fallback, activation continuation, repeated marked continuation, deterministic HOLD precedence, deterministic obvious continuation without wasted self-check, human-turn freshness, recoverable/hard error separation, durable journal restore, marker-free progress signatures, OWNER/MIRROR isolation, stale-state cancellation, ambiguous-write freeze, stagnation, and hard fuse behavior.
