# Chat Turn Guardian — Project Specification

Status: Accepted living specification; v1.0 baseline complete; Issue #51 shipped in v1.1.0; Issue #56 shipped in v1.2.0; Issue #57 shipped in v1.2.1
Repository: `ach1992/chat-turn-guardian`  
Primary target: ChatGPT Web on Chromium-based browsers

## 1. Problem

Long-running chats can stop at a turn boundary even when no genuine human decision, approval, external handoff, safety boundary, or platform blocker requires intervention. Repeatedly inspecting those stops and manually sending a small continuation instruction across several active conversations creates avoidable friction.

Chat Turn Guardian removes that turn-boundary friction without becoming a second project orchestrator and without changing the semantics of the agent, Skill, or workflow running inside the chat.

## 2. Product outcome

Chat Turn Guardian is a standalone Chromium Manifest V3 extension that lets the user explicitly supervise selected ChatGPT conversations. For each managed conversation it observes response completion, decides conservatively whether another turn may safely be requested, and either:

- automatically sends the configured continuation instruction after every local safety gate passes;
- performs no action and reports that human attention is required or the result is uncertain; or
- only notifies the user according to that conversation's notification policy.

The extension safely supervises multiple tabs/conversations concurrently with no cross-tab interference.

The product is intentionally modular. New notification channels, provider adapters, page adapters, and other bounded capabilities must be addable without coupling them to guarded-send authority or weakening the safety model.

## 3. Core product boundary

The chat's own agent/Skill/workflow remains responsible for **what work should happen**. Chat Turn Guardian is responsible only for **whether a finished turn appears to require genuine human involvement before another turn is requested**.

It is not a project manager, GitHub orchestrator, approval authority, general browser agent, CAPTCHA/limit bypass, or autonomous replacement for the workflow running inside the chat.

## 4. v1.0 product requirements

### 4.1 Per-chat opt-in and modes

Only conversations explicitly selected by the user may be managed. Each managed conversation has one of these modes:

- `OFF` — no supervision;
- `OBSERVE` — observe/classify, never auto-send;
- `AUTO` — classify and auto-continue only when every safety gate passes;
- `NOTIFY_ONLY` — never auto-send; deliver configured notifications only.

The user can see managed conversations, control the current tab, change per-chat modes, and use a global Pause All control.

### 4.2 Exact multi-tab and duplicate-conversation isolation

Runtime action identity includes the exact browser tab/document/content-agent/page epoch/route/conversation/assistant-response/response-instance evidence needed to prevent stale or cross-tab action.

If the same conversation is open in multiple tabs, at most one copy may be `OWNER` for automatic control. Other copies are `MIRROR` and never auto-send. Takeover requires fresh valid observation.

A decision produced for one tab/document/response may never be executed against another.

### 4.3 Configurable timing and continuation

Global defaults and per-chat overrides support:

- settle delay;
- continuation delay;
- post-send cooldown;
- configured continuation text;
- notification triggers;
- hard-fuse settings.

Pending timers are cancellable when user interaction, policy, ownership, navigation, response identity, or platform state changes.

### 4.4 Response-completion detection

The ChatGPT page adapter uses bounded DOM/event observation rather than tight polling where practical. It determines generation state and stable assistant-response identity behind a narrow adapter boundary so ChatGPT DOM changes do not spread through the extension core.

A transition to idle is not enough to invent a fresh assistant response. If exact response evidence is absent or ambiguous, Guardian does nothing automatically.

### 4.5 Conservative stop evaluation

Evaluation uses:

1. deterministic/high-confidence rules for obvious human/completion/platform boundaries;
2. an optional AI classifier only where rules cannot safely decide.

Normalized decisions are:

- `CONTINUE` — a needless turn boundary is sufficiently clear;
- `HOLD` — a legitimate completion/human/platform/safety boundary exists;
- `UNSURE` — evidence or confidence is insufficient.

Provider failure, malformed output, timeout, rate limit, missing credentials, or low confidence never degrades to `CONTINUE`. Provider output remains advisory and has no browser mutation authority.

### 4.6 Guarded auto-continue pipeline

A `CONTINUE` decision is only a candidate. Immediately before mutation, the trusted content agent synchronously revalidates that:

- exact tab/document/content-agent/page epoch/route/conversation/assistant-response identity is unchanged;
- ChatGPT is not already generating;
- the user has not typed, sent, edited, stopped, navigated, or otherwise taken control;
- the composer is empty and safe to mutate;
- no modal, confirmation, Retry/error, rate-limit, verification, CAPTCHA, or other blocking UI is active;
- policy is still `AUTO`, ownership is still valid, and Pause All is not active;
- the decision is current and not stale/expired;
- reliability/stagnation/fuse state still permits the candidate.

After mutation, Guardian verifies the intended user turn/generation evidence. An ambiguous write freezes retry; blind retries are prohibited.

### 4.7 Human interaction always wins

Relevant trusted human interaction invalidates pending automatic decisions for that conversation. Guardian never competes with the user for the composer and never treats automatic browser/platform focus changes as equivalent to deliberate user intent without the required evidence.

### 4.8 Loop and stagnation protection

Progress-aware protection compares privacy-preserving signatures of recent verified auto-continued outcomes and HOLDs on repeated no-progress behavior. A separate configurable hard fuse is a final emergency boundary, not the primary progress detector.

### 4.9 Side Panel and toolbar UX

The persistent Side Panel is the primary management/configuration/status surface. It provides:

- current-tab ON/OFF and bounded reconnect;
- multi-chat mode/policy management;
- runtime/OWNER/MIRROR/decision state;
- timing and notification configuration;
- provider profiles/model catalog/readiness controls;
- Telegram configuration and health;
- bounded audit/reliability diagnostics;
- Pause All;
- a collapsed Privacy & Data disclosure at the bottom.

Clicking the extension toolbar action opens the Side Panel on supported ChatGPT pages through the supported Side Panel API. Unsupported hosts remain disabled/fail-closed.

### 4.10 Notifications

Browser notifications support relevant Guardian events including response completion, HOLD/human attention, UNSURE, stagnation, provider error, and extension/platform error.

Notification routing uses a generic channel boundary; delivery is observational and cannot change classification or chat authority.

Telegram v1 is optional, outbound-only, and configured by the extension user. It supports:

- enable/disable;
- locally entered bot token and destination/Chat ID;
- inherited or Telegram-specific event selection;
- configured/enabled/health state;
- safe Test notification;
- bounded notification metadata.

Telegram v1 has no inbound commands, webhook/long-poll loop, remote AUTO/OFF control, approval answering, message injection, project orchestration, or browser mutation authority. Browser notifications continue independently.

### 4.11 AI-provider architecture

No local daemon, local LLM, backend, database, or companion service is required.

The provider layer is pluggable and supports:

- OpenRouter as a first-class preset;
- NaraRouter as a fixed compatible preset;
- generic OpenAI-compatible HTTPS profiles (`baseUrl`, API key, model);
- ordered provider fallback;
- bounded model catalog/readiness flows.

The README documents currently useful OpenAI-compatible configurations such as OpenAI API, Gemini's compatibility endpoint, DeepSeek, Groq, xAI, and Together AI. Vendor model availability, quotas, compatibility, and pricing are external facts and are not product invariants.

Native APIs that materially differ, such as Anthropic's Messages API, require a dedicated future adapter rather than pretending to be supported by the generic transport.

### 4.12 Context minimization, credentials, and privacy

Classifier context is minimized and bounded: at most 4 recent turns, 4,000 characters per turn, and 8,000 characters total after secret redaction/minimization.

Provider API keys and Telegram bot tokens:

- are stored only in trusted extension storage;
- never enter page/content scripts;
- are never rendered back after storage;
- are absent from ordinary status APIs, audit history, and logs;
- are never committed or packaged as real credentials.

External transfers are purpose-bound: configured AI providers receive only bounded classification context, and Telegram receives bounded notification metadata rather than full ChatGPT messages by default.

### 4.13 Persistence and service-worker resilience

Durable user policy/configuration is separated from ephemeral runtime authority. Manifest V3 service-worker restart/suspension cannot replay old action authority: restored sessions require fresh content-agent/page evidence before automation becomes eligible again.

## 5. Permanent safety invariants

1. **Fail closed:** uncertainty/error/provider failure/platform blocker/storage uncertainty => no automatic send.
2. **Exact identity:** a decision/action is valid only for its exact tab/document/content-agent/page epoch/route/conversation/assistant response/response instance.
3. **OWNER/MIRROR isolation:** MIRROR never auto-sends.
4. **Human precedence:** human interaction cancels or supersedes pending automation.
5. **Final synchronous revalidation:** all mutation-critical evidence is rechecked immediately before page mutation.
6. **Empty composer:** automatic continuation never overwrites user content.
7. **No blind retry:** ambiguous write outcome freezes automatic retry until safely reconciled.
8. **No safeguard bypass:** Guardian never evades limits, approvals, confirmations, verification, CAPTCHAs, or platform safety controls.
9. **No approval fabrication:** real approval/material-decision/human-operation boundaries HOLD.
10. **Minimal provider authority:** AI providers classify only; provider output cannot authorize DOM/tab/browser action by itself.
11. **Credential isolation:** provider and notification credentials remain in trusted extension contexts and secret-free status/log/audit surfaces.
12. **Notification isolation:** notification channels are observational only and can never authorize or retry ChatGPT mutation.
13. **Extensible boundaries:** new channels/providers/adapters receive only the narrow authority their interface requires.

## 6. v1.0 supported environment

- Chromium-family browser using Manifest V3 and the Side Panel API; current manifest minimum is Chrome/Chromium 114.
- ChatGPT Web on the supported `chatgpt.com` and legacy `chat.openai.com` origins.
- One browser profile/session at a time.
- Normal operation requires the browser/page environment to be available; Guardian is not a remote server-side supervisor.

Additional chat-site adapters may be added later but are not part of v1.0.

## 7. v1.0 non-goals

- replacing or running the project/engineering orchestration workflow inside the chat;
- independently understanding GitHub/project state outside the conversation;
- automatically moving review prompts/results between chats;
- automatically creating new ChatGPT chats;
- acting as a general autonomous browser agent;
- Telegram/Discord remote control or inbound command handling;
- requiring a local companion service/model;
- bypassing ChatGPT/provider usage limits or platform safeguards;
- treating consumer chat subscriptions or browser-session credentials as provider API credentials;
- Chrome Web Store publication as proof of engineering completeness.

Store **publishability** remains a standing engineering constraint even though actual Store submission/publication is a separate release action.

## 8. Future extension points

Later versions may add, through bounded interfaces and separate security/design review where needed:

- additional notification channels;
- native provider adapters, including APIs that are not OpenAI-compatible;
- additional supported chat-site adapters;
- richer audit/export/diagnostics;
- read-only remote status capabilities;
- carefully authorized inbound/remote commands only after a separate threat/authorization design.

Future features must not weaken v1.0 safety invariants or silently expand guarded-send authority.

## 9. Distribution and Chrome Web Store readiness

The codebase and release process remain suitable for later Chrome Web Store submission:

- narrow and accurately described single purpose;
- Manifest V3 with packaged/self-contained executable logic;
- minimal persistent permissions and exact runtime permission grants where practical;
- secure local credential handling and HTTPS external transports;
- minimized purpose-bound data transfers and synchronized privacy disclosure;
- production-quality icon/listing assets;
- deterministic package/provenance and release validation.

See [`STORE_READINESS.md`](STORE_READINESS.md) for the durable Store engineering/runbook constraints. Actual Developer Dashboard upload, submission, publication, visibility changes, or production listing edits require a current policy review and explicit human authorization.

## 10. v1.0 acceptance

v1.0 is feature-complete and release-ready when repository-required validation/review passes and the integrated product demonstrates the high-signal behaviors recorded in [`V1_VALIDATION.md`](V1_VALIDATION.md), including safe AUTO continuation, human-precedence races, OWNER/MIRROR isolation, restart recovery, provider failure behavior, browser notifications, toolbar/Side Panel behavior, and real outbound Telegram delivery.

Rare platform states that can only occur naturally are not to be manufactured. Their fail-closed behavior remains covered by automated regressions and may collect additional live evidence opportunistically without keeping the completed v1.0 outcome artificially open.

## 11. Product principle

Chat Turn Guardian should make an existing high-quality chat workflow more continuous, not more autonomous than the workflow itself intended to be. When in doubt, preserve the conversation, preserve the user's control, and do nothing automatically.

## 12. v1.1.0 outcome — in-chat self-check classification

Issue #51 is the implemented product outcome after the completed v1.0 baseline.

v1.1.0 changes the **normal ambiguous-stop classifier** from an external-provider-first dependency to an **in-chat self-check** performed in the same ChatGPT conversation:

- local deterministic/high-confidence signals continue to handle obvious safe boundaries first;
- for an eligible ambiguous stop/error episode, Guardian may send exactly one short self-check probe asking the current chat to classify why it stopped;
- the reply must be compact and machine-readable and must distinguish continuation from approval, material-decision, human-operation, completion, platform-error, rate-limit, and uncertainty cases;
- malformed, contradictory, stale, missing, or uncertain self-check output fails closed;
- external AI providers remain optional fallback/diagnostic capability rather than a required normal-path dependency if the in-chat path proves reliable.

A visible ChatGPT `Retry`, red delivery error, or `Message delivery timed out` state is **probe-eligible** only when the page still has a safe ordinary composer and all exact identity, ownership, human-precedence, stale-state, and write-safety guards pass. Guardian still never clicks `Retry` automatically and never blindly retries an ambiguous or failed probe write.

Hard no-probe boundaries remain, including conversation/context exhaustion that explicitly requires a **new chat**, unavailable/unsafe composer state, authentication/account verification/CAPTCHA/permission/safety UI that requires human action, human takeover, or unprovable current episode identity. Automatic creation or migration to a new ChatGPT conversation is not authorized by this outcome.

The default resume message remains simple and is:

> Continue the work from where you stopped. If you need approval, a decision, information, or an action from the human, say so; otherwise keep going until the requested work is complete.

The self-check probe is itself a new automatic mutation before the resume decision. It therefore requires explicit stop/self-check episode identity, final synchronous revalidation before each mutation, OWNER/MIRROR isolation, service-worker restart safety, no-blind-retry/ambiguous-write semantics, and loop/stagnation protection. Self-check output remains advisory data and cannot bypass local safety gates.

Issue #51 is integrated and exact-head CI validated. This section describes the shipped v1.1.0 runtime behavior; live ChatGPT smoke evidence remains pending. See [`IN_CHAT_SELF_CHECK.md`](IN_CHAT_SELF_CHECK.md) for the bounded design and validation boundary.

## 13. v1.2.0 outcome — status-first conversation protocol (Issue #56)

v1.2.0 refines Issue #51 to avoid unnecessary control traffic:

- a valid `CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"..."}` record at the exact end of the latest assistant response is parsed directly;
- deterministic hard HOLD remains authoritative, while an obvious deterministic continuation may avoid an unnecessary self-check when no marker exists;
- only an eligible ambiguous response with no valid marker receives the guarded same-conversation self-check;
- that structured self-check asks the chat to remember the terminal-status contract for future replies and classifies the immediately preceding work state in its activation response;
- a missing or malformed activation status fails closed and cannot recursively trigger another self-check;
- if the chat later omits the remembered marker on an ordinary response, one new bounded self-check may be sent for that exact missing-status episode;
- valid marked continuation responses can continue across multiple turns without a self-check between them, subject to progress/stagnation and the hard fuse;
- the write journal is durable negative authority so restart cannot blindly replay a prior mutation; it stores guarded-send metadata, not transcript text;
- terminal marker syntax is removed before deterministic body classification and progress-signature calculation.

This protocol does not claim account-level or cross-conversation model memory. It relies on the current conversation context, checks every response independently, and falls back safely when the contract is absent. All permanent identity, OWNER/MIRROR, human-precedence, empty-composer, final revalidation, no-blind-retry, platform-boundary, and advisory-output invariants remain unchanged.

[`CONVERSATION_STATUS_PROTOCOL.md`](CONVERSATION_STATUS_PROTOCOL.md) is authoritative for the exact encoding, state order, fallback rule, and acceptance coverage. Section 12 remains the historical v1.1.0 outcome. GitHub PR, CI, and Release records own the immutable integration, validation, and delivery evidence for v1.2.0.

## 14. v1.2.1 outcome — formatted protocol and status-specific replies (Issue #57)

v1.2.1 preserves the v1.2.0 status-first contract while making its visible control traffic deterministic and decision-specific:

- the one-time bootstrap has stable readable sections and explicitly cannot redirect or continue the existing task;
- contenteditable composer insertion preserves its exact newline structure;
- `CONTINUE` requests continued autonomous completion;
- `PLATFORM_ERROR` and `RATE_LIMIT` request one blocker recheck and resume only if resolved;
- `UNSURE` requests one fresh status classification;
- human-approval, human-decision, human-operation, and completion statuses cause no automatic message;
- recovery and uncertainty responses do not repeat within the same human-interaction epoch.

All responses remain advisory candidates until the existing final guarded-send path revalidates exact conversation/response identity, ownership, human precedence, composer safety, policy, stagnation, and the hard fuse. GitHub PR, CI, and Release records own the immutable integration, validation, and delivery evidence for v1.2.1.
