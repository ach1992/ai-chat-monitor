# In-Chat Self-Check — Historical v1 Feature

> **Removed in v2.0.0.** This document exists only to preserve project history.

v1.x could inject a bounded same-conversation self-check/status-recovery turn when semantic state was ambiguous. v2 intentionally removes that capability as part of the product pivot to read-only monitoring.

Current v2 invariants:

- AI Chat Monitor never writes to the ChatGPT composer.
- AI Chat Monitor never sends a self-check, protocol bootstrap, status-recovery, continuation, Retry, or other conversation turn.
- Missing or malformed `AI_CHAT_MONITOR_STATUS` is a normal fallback condition.
- AI Chat Monitor resolves semantic state from page/UI evidence, a valid optional marker, deterministic local rules, optional provider fallback, then unknown/unsure.
- `CONTINUE` means only that the human may manually continue; it grants no browser mutation authority.

For current behavior see:

- [Project specification](PROJECT_SPEC.md)
- [Architecture](ARCHITECTURE.md)
- [Conversation status protocol](CONVERSATION_STATUS_PROTOCOL.md)
- [README](../README.md)
