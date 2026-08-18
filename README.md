# Chat Turn Guardian

A standalone Chromium browser extension that safely supervises explicitly selected ChatGPT conversations, detects needless turn-boundary stops, auto-continues only when appropriate, and notifies when human attention is required.

## Status

Project bootstrap is complete. The accepted MVP outcome and implementation work are tracked in [Issue #1](../../issues/1). The first implementation task is [Issue #2](../../issues/2).

No local daemon, local model, or companion application is required by the MVP design.

## Project map

- **Canonical product requirements:** [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md)
- **Architecture and safety invariants:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **MVP outcome / authoritative work plan:** [Issue #1](../../issues/1)
- **Foundation:** [Issue #2](../../issues/2)
- **ChatGPT adapter + multi-tab isolation:** [Issue #3](../../issues/3)
- **AI provider abstraction + stop classifier:** [Issue #4](../../issues/4)
- **Guarded auto-continue state machine:** [Issue #5](../../issues/5)
- **Side Panel + per-chat controls/timing:** [Issue #6](../../issues/6)
- **Notifications + stagnation protection:** [Issue #7](../../issues/7)
- **MVP hardening / final validation:** [Issue #8](../../issues/8)
- **Post-MVP Telegram notification/status channel:** [Issue #9](../../issues/9)

## Core behavior

Each ChatGPT conversation is explicitly opt-in and independently configurable as:

- `OFF` — unmanaged;
- `OBSERVE` — classify/observe only, never send automatically;
- `AUTO` — safely auto-continue only after conservative classification and fresh revalidation;
- `NOTIFY_ONLY` — never send; notify on configured events such as response completion.

Global timing defaults and per-chat overrides cover response settling, continuation delay, and post-send cooldown. Multiple tabs are isolated by tab/document/conversation/message identity, and duplicate tabs for the same conversation cannot both control automatic sends.

## Safety posture

The extension is deliberately fail-closed:

- human interaction always supersedes pending automation;
- uncertainty/provider failure/platform errors never authorize continuation;
- every continuation decision is bound to the exact current conversation/message and revalidated immediately before send;
- ambiguous send outcomes are never blind-retried;
- repetitive/no-progress loops are held instead of continued indefinitely;
- the extension never fabricates approvals or attempts to bypass account/model/platform limits or safeguards.

The chat's own agent/Skill remains responsible for **what work should happen**. Chat Turn Guardian only decides whether a finished turn appears to need genuine human involvement before requesting another turn.

## Provider direction

The classifier layer is provider-agnostic. The MVP requires OpenRouter plus a generic OpenAI-compatible provider configuration and is designed to add other hosted/free-tier providers without coupling them to chat-management logic. Free quotas/model availability are treated as variable provider facts rather than permanent product assumptions.

## Resume development in a new Master chat

Use this repository as the authoritative source and recover before acting. The persisted operating baseline is in Issue #1.

A concise handoff instruction is:

```text
Repository: https://github.com/ach1992/chat-turn-guardian
Role: MASTER
RECOVER from authoritative repository/GitHub state, then continue end-to-end from the highest-value READY work under the persisted project authority and coordination baseline. Do not rely on previous chat history.
```

Start from Issue #1, then follow its current dependency/work plan rather than rebuilding project intent from memory.
