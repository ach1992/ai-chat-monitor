# Chat Turn Guardian — Project Specification

Status: Accepted living specification  
Repository: `ach1992/chat-turn-guardian`  
Initial target: ChatGPT Web on Chromium-based browsers

## 1. Problem

Long-running engineering chats can end a response even when no genuine human decision, approval, external handoff, or safety boundary is required. A human can inspect the stopped conversation, recognize that the stop was needless, and send a small continuation instruction such as `continue` / `ادامه بده`. Repeating that manually across several active chats creates avoidable friction and can interrupt otherwise autonomous workflows.

Chat Turn Guardian should remove that turn-boundary friction without becoming a second project orchestrator and without changing the semantics of the agent or Skill running inside the chat.

## 2. Product outcome

Build a standalone browser extension that lets the user explicitly supervise selected ChatGPT conversations/tabs. For each managed conversation it observes response completion, decides conservatively whether another turn may safely be requested, and either:

- automatically sends the configured continuation instruction;
- performs no action and records/indicates that human attention is required or the decision is uncertain; or
- only notifies the user according to that chat's notification policy.

The extension must safely supervise multiple tabs/conversations concurrently with no cross-tab interference.

The product should remain modular and evolvable: additional notification channels, provider adapters, page adapters, and release/distribution surfaces must be addable without coupling them to guarded-send authority or weakening the core safety model.

## 3. Core product boundary

The chat's own agent/Skill remains responsible for **what work should happen**. Chat Turn Guardian is responsible only for **whether the finished turn appears to require genuine human involvement before another turn is requested**.

It must not become a project manager, GitHub orchestrator, reviewer relay, approval authority, or autonomous replacement for the workflow running inside the chat.

## 4. MVP requirements

### 4.1 Per-chat opt-in and modes

Only conversations explicitly selected by the user may be managed. Each managed conversation has its own policy and one of these modes:

- `OFF` — ignore the conversation completely;
- `OBSERVE` — detect and classify finished turns, but never send messages automatically;
- `AUTO` — classify finished turns and auto-continue only when all safety gates pass;
- `NOTIFY_ONLY` — never send messages; notify on the user-selected events.

The user must be able to see exactly which tabs/conversations are managed and change their mode independently.

### 4.2 Multi-tab and duplicate-conversation isolation

The extension must safely handle many ChatGPT tabs at the same time.

A runtime session identity must include enough evidence to prevent stale/cross-tab actions, including where available:

- browser `tabId`;
- document identity/generation;
- ChatGPT conversation identity derived from the current page/URL;
- fingerprint of the last assistant response being evaluated.

If the same conversation is open in multiple tabs, at most one tab may hold automatic-control ownership. Other copies are observe-only until ownership is safely transferred/revalidated.

No decision produced for one tab/document/message may ever be executed against another.

### 4.3 Configurable timing

Timing must be configurable globally and overridable per managed chat.

At minimum support:

- **settle delay**: how long a finished assistant response must remain stable before evaluation;
- **continue delay**: how long to wait after a `CONTINUE` decision before sending the continuation instruction;
- **post-send cooldown**: minimum interval before a new automatic action can be considered for that chat.

Reasonable defaults may be supplied, but users must be able to set these manually. Delays must be cancellable when the page/chat state changes or the user interacts.

### 4.4 Response-completion detection

Use event/DOM observation rather than tight polling where practical. The ChatGPT page adapter must determine when generation is active and when the assistant response has stabilized enough to evaluate.

The adapter must be isolated behind a small interface so changes to ChatGPT's DOM do not spread through the extension core.

### 4.5 Conservative stop evaluation

Evaluation uses two layers:

1. deterministic/high-confidence rules for obvious cases;
2. an AI classifier only when rules cannot decide safely.

The normalized classifier result is:

- `CONTINUE` — another normal turn appears safe and no genuine human action is required;
- `HOLD` — do not auto-send; a legitimate boundary, completion state, user action, or other non-continuable condition exists;
- `UNSURE` — insufficient confidence; do not auto-send.

`HOLD` should include a structured reason when possible (for example human approval required, material decision required, explicit human operation, project complete, user stop, stagnation, error/rate limit, or other safety boundary).

Provider failure, malformed model output, timeout, missing credentials, or low confidence must never degrade to `CONTINUE`.

### 4.6 Guarded auto-continue pipeline

A `CONTINUE` classification is only a candidate action. Immediately before sending, the content agent must revalidate that:

- it is still the same conversation and document;
- the same assistant response is still current;
- ChatGPT is not already generating;
- the user has not sent a new message or started editing/typing;
- no modal, confirmation, error, rate-limit, or other blocking UI is active;
- the chat is still in `AUTO` mode and automatic-control ownership is still valid;
- the decision has not expired or become stale.

After sending, verify that the user message was actually appended and that generation started. Ambiguous write state must not trigger blind retries.

The continuation text must be configurable, with a minimal default such as `Continue.`

### 4.7 Human interaction always wins

Any relevant human interaction invalidates pending automatic decisions for that chat. Examples include typing in the composer, sending a message, editing a turn, stopping generation, navigating the tab to another conversation, changing mode/policy, or interacting with a blocking confirmation.

The extension must never compete with the user for control of the composer.

### 4.8 Loop and stagnation protection

Do not cap useful progress merely by a fixed number of auto-continues. Instead detect likely stagnation/repetition across recent assistant outcomes and hold when the extension appears to be creating a no-progress loop.

Repeated materially similar stop messages, repeated unchanged waiting states, duplicate response fingerprints, or repeated continuation with no meaningful state change are examples of stagnation signals.

A small hard emergency cap may exist as a final safety fuse, but progress-aware protection is the primary mechanism.

### 4.9 Chat management UI

Provide a persistent management surface suitable for multiple chats, preferably a Chromium Side Panel.

It should show at least:

- conversation/tab identity/title;
- current mode (`OFF`, `OBSERVE`, `AUTO`, `NOTIFY_ONLY`);
- runtime state (generating, settling, evaluating, waiting to continue, hold, error, etc.);
- selected provider/model when AI classification is used;
- active timing overrides;
- last decision/reason;
- notification policy;
- whether this tab owns automatic control for a duplicated conversation.

Useful controls include enable/disable for the current chat, pause all, per-chat mode, timing overrides, continuation text, notification triggers, and open/focus chat.

### 4.10 Notifications

Browser notifications are part of the MVP management layer. Per-chat notification triggers should be configurable, including at least:

- assistant response finished;
- `HOLD` / human attention required;
- `UNSURE`;
- provider/extension error;
- stagnation detected.

`NOTIFY_ONLY` must support the use case "notify me when this tab's response finishes and take no action".

Notification delivery must not itself modify the chat.

Notification delivery must use a channel abstraction so additional destinations do not become coupled to coordinator or guarded-send logic. The first Telegram version is outbound notification-only: a user who has installed the extension can configure their own bot token, destination/chat ID, enabled events, and a safe test notification. Telegram must not gain authority to send ChatGPT messages, answer approvals, alter classifier decisions, change `AUTO`, or retry browser mutations. Telegram failures/timeouts/rate limits must remain observational only. Notification payloads should be bounded/minimized and must not export full chat content by default.

### 4.11 AI-provider architecture

The extension must be standalone: no local daemon, local LLM, 9Router installation, server, or companion app is required for normal operation.

Use a pluggable provider layer so the core does not depend on one vendor. Support:

- provider presets for practical hosted APIs, with a free-tier/free-model-first use case where available;
- OpenRouter as a first-class option;
- a generic OpenAI-compatible endpoint configuration (`baseUrl`, API key, model, optional headers/timeouts);
- additional provider adapters/presets where their APIs materially differ and are useful;
- configurable provider priority/fallback.

Free quotas and model availability are not product invariants and must not be hardcoded as permanent facts.

The provider layer receives only the bounded classification input and returns only a normalized decision/reason. It has no direct DOM/tab action authority.

### 4.12 Context minimization and privacy

Do not send the entire conversation to a classifier by default. Prefer the smallest recent context that can safely decide the stop, such as the latest assistant response plus the immediately relevant preceding turn(s), with large logs/code blocks omitted or bounded when they do not affect the decision.

Provider credentials and notification credentials such as Telegram bot tokens must never be committed, logged, embedded in distributed extension source, rendered back into ordinary status UI, or exposed to page/content scripts. Configuration is user-supplied and locally stored using the safest practical browser-extension mechanism for the chosen architecture.

Any external transfer of user/chat-derived data must be minimized to the implemented feature, clearly disclosed where required, and kept consistent with the product's privacy policy and current Chrome Web Store requirements when distributed through that channel.

### 4.13 Persistence and service-worker resilience

Manifest V3 service-worker suspension/restart must not cause cross-chat confusion or duplicate actions.

Persist durable user policy/configuration separately from ephemeral runtime state. Every delayed/AI decision must be correlated to the exact session/message identity and revalidated after wake/restart before any action.

## 5. Safety invariants

1. **Fail closed:** uncertainty/error/provider failure => no automatic send.
2. **Per-chat isolation:** a decision/action is valid only for the exact session/message it was created for.
3. **Human precedence:** human interaction cancels or supersedes pending automation.
4. **No blind retry:** ambiguous send outcome is re-read/reconciled before any retry.
5. **No limit/safeguard bypass:** do not use the extension to evade account/model limits, approvals, safety controls, CAPTCHAs, confirmations, or platform restrictions.
6. **No approval fabrication:** never auto-answer a real approval/material decision/human-operation request.
7. **No hidden global automation:** chats are opt-in; the user can always see/pause managed chats.
8. **Minimal authority:** AI providers classify; only the guarded page adapter may perform the narrow configured continuation action.
9. **Notification isolation:** external notification channels are observational only and can never authorize or mutate a ChatGPT conversation.
10. **Extensible boundaries:** new channels/providers/adapters must use narrow interfaces and cannot inherit authority merely by being added to the product.

## 6. Initial supported environment

MVP support target:

- Chromium-family browser extension using Manifest V3;
- ChatGPT Web as the first page adapter;
- one browser profile/session at a time;
- functionality only while the browser/page environment needed by the extension is available.

The architecture should permit additional chat-site adapters later, but supporting other sites is not an MVP requirement.

Chrome Web Store publication is not required to prove the MVP, but **Chrome Web Store publishability is a standing engineering constraint**: implementation choices should preserve Manifest V3 reviewability, minimal permissions, self-contained extension logic, secure credential handling, accurate privacy/data disclosure, and a narrow understandable product purpose so a later store release does not require architectural rework or weaker safeguards. Current store policy must be re-verified at release time because distribution requirements can change.

## 7. Non-goals for MVP

- running or replacing the engineering/project orchestration Skill inside the chat;
- understanding GitHub/project state independently of the chat;
- moving review prompts/results between chats;
- automatically creating new ChatGPT chats;
- acting as a general autonomous browser agent;
- Telegram/Discord remote control;
- requiring a local companion service or local model;
- bypassing ChatGPT/provider usage limits or platform safeguards;
- Chrome Web Store publication as a prerequisite for proving the MVP.

The final bullet does not make store compatibility optional: public publication is a later release milestone, while store-ready architecture/privacy/permissions are project-wide constraints from now on.

## 8. Future extension points

Design clean interfaces so later versions may add:

- additional notification channels beyond browser notifications and Telegram;
- read-only remote status queries after a separate bounded security/privacy design;
- additional AI provider adapters;
- additional supported chat-site adapters;
- richer audit/export/diagnostics;
- optional remote commands only after a separate security/authorization design.

The first post-MVP Telegram capability is notification-only and user-configured. Arbitrary message injection, approvals, or remote control are not part of Telegram v1. Later Telegram capabilities, if any, require separate scope and security review.

## 9. Distribution and Chrome Web Store readiness

The codebase and release process must stay suitable for a later Chrome Web Store submission. Engineering should therefore preserve:

- one narrow, accurately described product purpose;
- Manifest V3 with extension logic contained in the packaged code rather than remotely hosted executable logic;
- the smallest permissions/host access needed by implemented features, avoiding permissions requested only for hypothetical future functionality;
- secure local handling of API keys/bot tokens and HTTPS transport to external services;
- explicit, minimized, purpose-bound data transfer to configured AI/notification services;
- accurate in-product/store/privacy-policy disclosure of collected/processed/transferred data when required;
- production-quality icon/listing assets and versioned deterministic package/provenance;
- validation of every advertised feature before submission.

See [`STORE_READINESS.md`](STORE_READINESS.md) for the engineering/release checklist. Actual store submission/publication is a separate release action and requires current policy review plus explicit human authorization.

## 10. MVP success criteria

The MVP is successful when all of the following are demonstrated with automated tests and/or high-signal manual integration scenarios as appropriate:

- multiple managed ChatGPT tabs can generate concurrently without state or action crossing between them;
- the user can independently set each chat to `OFF`, `OBSERVE`, `AUTO`, or `NOTIFY_ONLY`;
- global timing defaults and per-chat timing overrides work and pending timers cancel on stale/user-interaction conditions;
- a clearly needless stop can be classified and safely continued in the same chat;
- a genuine human approval/decision/operation boundary is held without automatic input;
- `UNSURE`, provider failure, rate-limit/error UI, or stale decision results in no automatic send;
- user typing/sending/navigation invalidates pending automation;
- duplicate tabs for one conversation cannot both auto-send;
- send verification prevents duplicate blind retries;
- stagnation/repetition is detected and held;
- `NOTIFY_ONLY` can notify on response completion without modifying the chat;
- provider configuration supports OpenRouter plus a generic OpenAI-compatible endpoint and is extensible to additional providers;
- service-worker restart/recovery does not cause stale or duplicate actions;
- a new developer can install the unpacked extension, configure a provider, run the test suite, and reproduce the core supervised-chat flow from repository documentation.

## 11. Product principle

Chat Turn Guardian should make an existing high-quality chat workflow more continuous, not more autonomous than the workflow itself intended to be. When in doubt, preserve the chat, preserve the user's control, and do nothing automatically.
