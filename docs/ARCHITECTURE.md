# Architecture

This document defines the current architecture and safety boundaries for Chat Turn Guardian. It is implementation-oriented while keeping provider, notification, and page-adapter boundaries modular.

## 1. Design goals

- strict per-chat/per-tab isolation;
- conservative automation with fail-closed behavior;
- deterministic state transitions and stale-decision rejection;
- human interaction takes precedence over automation;
- provider-independent classification;
- minimal coupling to ChatGPT DOM details;
- resilient behavior across Manifest V3 service-worker suspension/restart;
- clean extension points for notifications/providers without turning the extension into a general browser agent.

## 2. Major components

```text
ChatGPT Tab A ─ Content Agent A ─┐
ChatGPT Tab B ─ Content Agent B ─┼─> Background Coordinator / Service Worker
ChatGPT Tab C ─ Content Agent C ─┘              │
                                                 ├─ Session Registry
                                                 ├─ Decision Coordinator
                                                 ├─ Provider Manager
                                                 ├─ Notification Manager
                                                 │    ├─ Browser notifications
                                                 │    └─ Telegram Bot API (optional, outbound-only)
                                                 └─ Persistent/Session Storage
                                                        │
                                                 Chromium Side Panel
```

### 2.1 ChatGPT page adapter / content agent

Responsibilities:

- derive current conversation/page identity;
- observe generation and response stabilization;
- expose the latest relevant chat context in a bounded normalized form;
- detect human composer/navigation interaction;
- detect blocking UI/error/rate-limit/confirmation conditions;
- perform the narrow guarded continuation send only after coordinator authorization;
- verify that the intended user message appeared and generation began.

It must not select providers, make classification policy, coordinate other tabs, access provider/Telegram credentials, or deliver external notifications.

Keep DOM selectors/heuristics inside a `ChatGPTAdapter` boundary. Core code should consume normalized events/state rather than raw DOM assumptions.

### 2.2 Background coordinator

Owns cross-tab coordination and is the only component that may issue automatic-action authorizations.

Responsibilities:

- maintain the managed-chat registry;
- correlate `tabId`, document identity, conversation identity, and response fingerprint;
- prevent duplicate automatic-control ownership for the same conversation;
- manage delays/timers and invalidate stale work;
- invoke deterministic policy and AI classification;
- bind model decisions to an immutable decision envelope;
- request final page-level revalidation before send;
- record compact audit/diagnostic events;
- emit normalized notification events to the notification boundary.

The coordinator never treats notification delivery as authority or as evidence that a ChatGPT mutation should occur.

### 2.3 Side Panel UI

The Side Panel is the main management surface for concurrent chats and trusted configuration.

It exposes:

- all currently discovered/managed ChatGPT tabs;
- explicit per-chat enable/mode controls;
- runtime state and last decision;
- global defaults and per-chat overrides;
- provider/model configuration;
- browser/Telegram notification configuration and health;
- pause-all/emergency disable;
- focus/open-chat actions;
- compact recent decision history useful for debugging safety issues; and
- prominent privacy/data-transfer disclosures consistent with actual runtime behavior.

The extension toolbar action opens this Side Panel on supported ChatGPT pages through the Chromium Side Panel API. Unsupported tabs remain disabled/fail-closed.

### 2.4 Rule engine

The rule engine performs deterministic/high-confidence classification before any remote model call.

Initial normalized outputs:

```ts
type Decision = "CONTINUE" | "HOLD" | "UNSURE";
```

`HOLD` should carry a normalized reason when known, e.g.:

```ts
type HoldReason =
  | "HUMAN_APPROVAL_REQUIRED"
  | "MATERIAL_DECISION_REQUIRED"
  | "HUMAN_OPERATION_REQUIRED"
  | "PROJECT_COMPLETE"
  | "USER_STOP"
  | "STAGNATION"
  | "PLATFORM_ERROR"
  | "RATE_LIMIT"
  | "SAFETY_BOUNDARY"
  | "OTHER";
```

Tokens such as `APPROVAL_REQUIRED`, `MATERIAL_DECISION_REQUIRED`, `HUMAN OPERATION REQUIRED`, and `PROJECT_COMPLETE` are useful high-confidence signals for GitHub Project Orchestrator workflows, but the implementation reasons from message meaning/context rather than requiring one exact Skill vocabulary forever.

### 2.5 AI classifier

The classifier receives only a bounded classification request. It has no access to browser action APIs.

Conceptual contract:

```ts
interface ClassificationRequest {
  conversationContext: SanitizedTurnContext;
  policyVersion: string;
}

interface ClassificationResult {
  decision: "CONTINUE" | "HOLD" | "UNSURE";
  reason?: string;
  confidence?: number;
}
```

Malformed/unexpected output is `UNSURE`.

Before provider transport, classification context is minimized/redacted and bounded to at most 4 recent turns, 4,000 characters per turn, and 8,000 total characters.

### 2.6 Provider manager

Core provider interface:

```ts
interface AIProvider {
  id: string;
  testConnection(): Promise<ProviderHealth>;
  listModels?(): Promise<ModelInfo[]>;
  classify(request: ClassificationRequest): Promise<ClassificationResult>;
}
```

Current architecture includes:

- `OpenAICompatibleProvider` as the generic HTTPS transport;
- OpenRouter and NaraRouter presets;
- generic custom OpenAI-compatible HTTPS endpoint configuration;
- provider priority/fallback managed outside chat-session code.

Provider credentials remain in trusted extension storage. Provider transports reject non-HTTPS endpoints and automatic redirects. Provider output is untrusted advisory data and never gains Chrome/page mutation authority.

A provider failure must never authorize continuation. Exhausted fallback => `UNSURE`.

### 2.7 Notification manager

Notifications use a channel boundary so delivery remains outside session/action authority:

```ts
interface NotificationChannel {
  send(event: GuardianNotification): Promise<void>;
}
```

Current normalized events include:

- `RESPONSE_COMPLETE`;
- `HUMAN_ATTENTION_REQUIRED`;
- `UNSURE`;
- `STAGNATION`;
- `PROVIDER_ERROR`;
- `EXTENSION_ERROR`.

Browser notifications remain the local channel and continue to follow the existing per-chat/global Guardian notification policy.

Telegram v1 is an optional second channel. It supports enable/disable, a user-supplied bot token and destination, inherited or Telegram-specific event selection, redacted configuration status, health state, and an explicit Test notification. Its transport runs only in the trusted extension context and sends HTTPS requests directly to the official Telegram Bot API. There is no backend, webhook, inbound command path, or persistent polling loop.

The Telegram bot token is stored only in trusted extension storage and is never returned by ordinary read/status APIs or exposed to content/page contexts. Transport errors are normalized before reaching UI/audit surfaces. Notification payloads are bounded metadata rather than full ChatGPT messages.

Notification delivery is observational. Browser/Telegram success, failure, timeout, API error, rate limiting, permission failure, or disabled configuration cannot change classifier output, `AUTO`/`HOLD`, OWNER/MIRROR state, stale-decision handling, guarded-send authorization, retry behavior, or conversation content.

## 3. Session identity and duplicate-tab control

`tabId` is not sufficient identity because tabs navigate and the same conversation may appear in multiple tabs.

Conceptual runtime identity:

```ts
interface ChatSessionIdentity {
  tabId: number;
  documentId?: string;
  conversationId: string;
  messageFingerprint?: string;
}
```

Every asynchronous operation carries the identity snapshot it was created from.

When two tabs point to the same `conversationId`, use one automatic-control owner:

```text
conversation abc
├─ tab 12 -> CONTROL_OWNER / AUTO eligible
└─ tab 27 -> MIRROR / observe only
```

Ownership transfer requires fresh page/session verification. Never silently let both tabs auto-send.

## 4. Per-chat policy

```ts
type ChatMode = "OFF" | "OBSERVE" | "AUTO" | "NOTIFY_ONLY";

interface ChatTimingPolicy {
  settleDelayMs: number;
  continueDelayMs: number;
  postSendCooldownMs: number;
}

interface ChatPolicy {
  mode: ChatMode;
  continuationText: string;
  timing: ChatTimingPolicy;
  notificationEvents: string[];
  providerProfileId?: string;
}
```

Use global defaults plus sparse per-chat overrides so a user can quickly tune one chat without duplicating all settings.

Pending timers are keyed by session/message identity. Any identity/policy/user-interaction change cancels the old timer.

## 5. Runtime state machine

Each managed chat has an independent state machine. A representative flow:

```text
DISABLED
  ↓ enable
OBSERVING
  ↓ generation starts
GENERATING
  ↓ generation ends
SETTLING
  ↓ stable for settleDelay
EVALUATING
  ├─ HOLD/UNSURE ─> HOLDING / OBSERVING
  └─ CONTINUE ─────> CONTINUE_WAIT
                        ↓ continueDelay
                    REVALIDATING
                      ├─ stale/unsafe -> OBSERVING/HOLDING
                      └─ safe -> SENDING
                                   ↓
                               VERIFYING
                                 ├─ known success -> COOLDOWN -> GENERATING/OBSERVING
                                 └─ ambiguous/fail -> HOLDING/ERROR
```

`NOTIFY_ONLY` observes completion events but cannot enter an automatic send state.

`OBSERVE` may evaluate/classify for visibility and diagnostics but cannot enter an automatic send state.

## 6. Decision envelope and stale-result protection

AI/rule decisions are never globally reusable.

```ts
interface DecisionEnvelope {
  decisionId: string;
  tabId: number;
  documentId?: string;
  conversationId: string;
  messageFingerprint: string;
  policyRevision: number;
  createdAt: number;
  decision: "CONTINUE" | "HOLD" | "UNSURE";
}
```

A delayed classifier response is dropped if any bound identity or policy revision is no longer current.

## 7. Guarded send protocol

### Phase A — candidate

Rules/model produce `CONTINUE` for an exact message fingerprint.

### Phase B — delay

Wait the configured `continueDelayMs`. User/page/policy changes cancel the candidate.

### Phase C — fresh revalidation

Immediately before mutation the content agent must verify:

- exact tab/document/content-agent/pageEpoch/route/conversation identity is still current;
- exact expected assistant response/response instance is still the last assistant response;
- no generation is active;
- composer is empty and not user-modified/being edited;
- no new user message appeared;
- no blocking/modal/error/rate-limit state exists;
- chat remains `AUTO`;
- this tab remains control owner;
- candidate is not expired/stale.

### Phase D — send

Insert/send only the configured continuation text.

### Phase E — verify

Verify intended user message identity/content appeared and assistant generation began.

If outcome is ambiguous, freeze automatic retry for that response and surface an error/notification. Do not blindly send again.

## 8. Human-precedence events

The following invalidate pending automatic work for the affected chat:

- composer input/typing by the user;
- manual user send;
- edit/regenerate/stop controls;
- navigation to another conversation/page;
- mode/timing/provider policy change;
- control-owner change;
- new assistant/user turn not matching the decision envelope;
- blocking confirmation/error interaction.

The implementation prefers false negatives requiring a manual continuation over false-positive automated messages.

## 9. Stagnation protection

Track compact recent outcome fingerprints/reasons per chat. Do not require meaningful project understanding.

Signals may include:

- substantially repeated assistant stop text;
- unchanged waiting/external-dependency explanation across consecutive auto-continues;
- repeated identical response fingerprint;
- repeated `CONTINUE` cycles with no observable turn-state change beyond the continuation itself.

When threshold/confidence is reached, transition to `HOLD` with `STAGNATION` and optionally notify.

Keep a separate hard emergency fuse as defense in depth, configurable but not the primary progress model.

## 10. Storage model

Use separate persistence classes:

- durable user configuration: managed-conversation policy, provider configuration and credentials, Telegram configuration and credential, global defaults, notification preferences;
- ephemeral/session state: tab/document mappings, control ownership, pending decisions/timers, recent fingerprints, cooldown state;
- durable negative-authority guarded-write journal: bounded mutation identity/control metadata used only to prevent blind replay across worker/browser restarts;
- compact audit history: bounded recent events, with secrets/full chat content excluded or redacted.

Credential-bearing durable storage is restricted to trusted extension contexts. Do not assume Manifest V3 service-worker memory survives. On wake/restart, reconstruct state from storage/page reinspection and invalidate decisions that cannot be proven current.

## 11. Security and privacy boundaries

- never expose provider or Telegram credentials to page JavaScript/content scripts;
- never log API keys, bot tokens, token-bearing URLs, or authorization headers;
- request persistent host access only for supported ChatGPT pages;
- arbitrary user-selected HTTPS provider hosts remain optional and are requested at exact origin at runtime;
- Telegram exact host access is requested only for `https://api.telegram.org/*`;
- model providers receive only bounded/redacted classification context, never Chrome action authority;
- Telegram receives only bounded notification metadata, never full ChatGPT messages in v1;
- page content is treated as untrusted input to the classifier, not instructions to the extension core;
- classifier output is data and must pass local safety/revalidation gates before action;
- no automated responses to CAPTCHA, account verification, permission confirmations, model/account limit messages, or platform safety gates;
- all extension executable logic is packaged locally; remote provider/Telegram responses are data only and are never evaluated as code;
- privacy policy, Store declarations, and in-product disclosures must stay synchronized with actual runtime behavior.

## 12. Testing strategy

Prefer deterministic adapters/fixtures for most logic, with a small number of manual/e2e ChatGPT scenarios for DOM integration.

Test layers cover:

1. pure state-machine/policy tests;
2. rule-engine classification fixtures;
3. provider normalization/failure tests;
4. multi-tab/session identity and stale-decision concurrency tests;
5. content-adapter DOM fixtures for generation/composer/error states;
6. guarded-send verification and ambiguous-write tests;
7. service-worker restart/recovery tests;
8. notification routing/Telegram secret storage/transport/error isolation tests;
9. manifest/store-readiness/package invariant tests;
10. manual integration checklist against the current ChatGPT Web UI.

The test suite explicitly includes adversarial race cases: delayed provider result, navigation during delay, user typing during delay, duplicate conversation tabs, provider failure, response change before send, ambiguous writes, and stale notification health results.

## 13. Telegram remote-control boundary

Telegram v1 is strictly outbound notification-only. The extension does not poll for inbound commands, register a webhook, inject Telegram messages into ChatGPT, answer approvals remotely, change `AUTO`/`OFF`/`OBSERVE`, start/stop supervision, or expose arbitrary commands/status controls through Telegram.

Any future inbound/read-only/remote-control Telegram capability is a separate product outcome and requires a separate threat model and authorization design covering authentication, destination/chat binding, replay protection, target selection, authorization, secret handling, and interaction with pending local automation. It cannot inherit authority from the outbound notification channel.

## 14. In-chat self-check architecture (Issue #51 / v1.1.0)

This section records the v1.1.0 in-chat self-check implementation. Earlier sections remain the authoritative v1.0 baseline; this section defines the added classifier and guarded-send path.

The classifier path makes the current ChatGPT conversation the primary classifier for eligible ambiguous stop episodes:

```text
STOP / ERROR EPISODE
  -> hard local safety + identity checks
  -> deterministic obvious decision when trustworthy
  -> SELF_CHECK_ELIGIBLE?
       no  -> HOLD / notify
       yes -> SELF_CHECK_WAIT
              -> final synchronous pre-probe revalidation
              -> send exactly one bounded self-check probe
              -> verify probe write
              -> await the response instance caused by that probe
              -> strict parse + episode/result revalidation
                   CONTINUE -> CONTINUE_WAIT -> guarded resume send
                   HOLD_*   -> HOLD
                   COMPLETE -> HOLD/complete
                   ERROR/RATE_LIMIT -> HOLD
                   UNSURE/malformed/stale -> HOLD/UNSURE
```

### 14.1 Stop/self-check episode identity

The implementation uses an explicit identity for the stop/error episode being classified. It is at least as strict as the existing action identity and prevents a self-check response from being confused with the original task response.

Conceptually, a self-check envelope should bind:

- `tabId`;
- document/content-agent identity;
- `pageEpoch` and route;
- conversation identity;
- the originating assistant-response identity when one exists;
- the current eligible error/stop fingerprint when the episode is UI-derived;
- policy revision;
- OWNER state;
- the specific probe write/result identity.

Any mismatch makes the result stale.

### 14.2 Self-check probe is a separate mutation type

The probe is not ordinary `CONTINUE` and must not inherit authorization implicitly from the old send path.

It requires:

- explicit `AUTO`-mode/user opt-in semantics;
- OWNER-only authority;
- empty/unchanged composer;
- final synchronous revalidation immediately before the probe mutation;
- a bounded write journal or equivalent no-replay/no-blind-retry guard;
- verification that the intended probe user message appeared and generation began;
- restart recovery that cannot replay stale probe authority.

If probe-write success is ambiguous, freeze automatic retry and HOLD.

### 14.3 Eligible Retry/red-error episodes

The runtime may classify a visible ChatGPT `Retry`, red delivery error, or `Message delivery timed out` episode through one in-chat self-check **without clicking Retry**, provided the ordinary composer remains safely usable and every fresh identity/human-precedence/write guard passes.

This is a deliberate change from the v1 rule that any Retry/error UI blocked all automatic mutation. The adapter should therefore distinguish:

- **self-check-eligible recoverable error UI** — e.g. Retry/red delivery-error state where a new normal user message can still be sent safely; from
- **hard no-probe UI** — capacity/context exhaustion requiring a new chat, unavailable/disabled composer, authentication/account verification/CAPTCHA/permission/safety controls, or other states that require human action or cannot establish safe episode identity.

The extension still never clicks/dismisses Retry/error controls automatically.

### 14.4 Self-check output

Self-check output is structured advisory data. The minimum semantic vocabulary is:

- `CONTINUE`;
- `HOLD_APPROVAL`;
- `HOLD_DECISION`;
- `HOLD_HUMAN_OPERATION`;
- `COMPLETE`;
- `PLATFORM_ERROR`;
- `RATE_LIMIT`;
- `UNSURE`.

Strict parsing is required. Extra/malformed/contradictory or stale output must not become `CONTINUE`.

The self-check prompt must explicitly say not to continue the task yet; it should only classify the previous/current stop episode.

### 14.5 Resume message

After a valid `CONTINUE`, Guardian uses a concise contextual resume instruction rather than relying only on bare `Continue.`. The default is:

```text
Continue the work from where you stopped. If you need approval, a decision, information, or an action from the human, say so; otherwise keep going until the requested work is complete.
```

Do not turn this into a second orchestration prompt. Keep it short and task-neutral.

### 14.6 Provider role after self-check

The provider subsystem remains modular and supported, but normal classification does not require an external API when in-chat self-check is enabled and reliable.

External providers may remain optional fallback/diagnostic paths. They never override hard local blockers, human precedence, stale-state rejection, or self-check result safety.

### 14.7 Loop/stagnation protection

The runtime must recognize self-check turns as control traffic and prevent recursive classification loops. At most one probe is allowed for one exact stop/error episode.

Existing stagnation tracking and the hard fuse must include repeated probe/resume no-progress cycles so the new path cannot create an infinite conversation loop.

See [`IN_CHAT_SELF_CHECK.md`](IN_CHAT_SELF_CHECK.md) and Issue #51 for the implementation details and acceptance scenarios.

## 15. Conversation terminal-status override (Issue #56 / next version)

The next-version runtime replaces the normal repeated probe-first path in Section 14 with a status-first path. The historical v1.1.0 section above remains evidence for Issue #51; where the two sections differ, this section governs the current implementation.

```text
STABLE RESPONSE
  -> local hard safety / identity / OWNER / human gates
  -> deterministic hard HOLD on marker-free body
  -> valid exact terminal status? -> map locally; no self-check
  -> otherwise deterministic obvious CONTINUE? -> continue candidate; no self-check
  -> otherwise eligible AUTO ambiguity? -> one guarded protocol self-check
       -> valid activation status -> map locally
       -> missing/malformed activation status -> UNSURE; no recursive self-check
  -> CONTINUE candidate -> final synchronous guards -> guarded contextual resume
```

The exact record is versioned and occupies the final line:

```text
CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"<VALUE>"}
```

The parser rejects duplicate/non-terminal markers, wrappers, extra JSON keys, unknown values, and trailing text. The marker is removed before deterministic body classification and progress-signature computation. Deterministic HOLD remains authoritative over a contradictory `CONTINUE` marker. The durable write journal is negative authority only: it prevents replay and does not grant a future send.

See [`CONVERSATION_STATUS_PROTOCOL.md`](CONVERSATION_STATUS_PROTOCOL.md) for the complete contract, fallback semantics, and acceptance coverage.
