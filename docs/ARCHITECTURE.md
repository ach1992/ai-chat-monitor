# Architecture

This document defines the initial architecture and safety boundaries for Chat Turn Guardian. It is intentionally implementation-oriented but avoids locking the project to a UI framework or vendor SDK before the first foundation task validates the simplest fit.

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

It must not select providers, make classification policy, or coordinate other tabs.

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
- route notifications.

### 2.3 Side Panel UI

The Side Panel is the main management surface for concurrent chats.

It should expose:

- all currently discovered/managed ChatGPT tabs;
- explicit per-chat enable/mode controls;
- runtime state and last decision;
- global defaults and per-chat overrides;
- provider/model configuration and health test;
- notification triggers;
- pause-all/emergency disable;
- focus/open-chat action;
- compact recent decision history useful for debugging safety issues.

A browser-action popup may be added for quick current-tab controls, but it should not become the primary multi-chat management surface.

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

Tokens such as `APPROVAL_REQUIRED`, `MATERIAL_DECISION_REQUIRED`, `HUMAN OPERATION REQUIRED`, and `PROJECT_COMPLETE` are useful high-confidence signals for GitHub Project Orchestrator workflows, but the implementation should reason from message meaning/context rather than require one exact Skill vocabulary forever.

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

Initial architecture should include:

- `OpenAICompatibleProvider` as the generic transport where possible;
- OpenRouter preset/metadata;
- generic custom OpenAI-compatible endpoint configuration;
- additional provider presets/adapters only where useful and justified at implementation time;
- provider priority/fallback managed outside the chat-session code.

A provider failure must never authorize continuation. Exhausted fallback => `UNSURE`.

### 2.7 Notification manager

Use a channel interface so browser notifications are the initial implementation and Telegram/other channels can be added later without touching session/action logic.

```ts
interface NotificationChannel {
  send(event: GuardianNotification): Promise<void>;
}
```

Initial events should include:

- `RESPONSE_COMPLETE`;
- `HUMAN_ATTENTION_REQUIRED`;
- `UNSURE`;
- `STAGNATION`;
- `PROVIDER_ERROR`;
- `EXTENSION_ERROR`.

Notification policy is per chat, with global defaults.

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

- exact conversation/document still current;
- exact expected response still the last assistant response;
- no generation active;
- composer is not user-modified/being edited;
- no new user message appeared;
- no blocking/modal/error/rate-limit state;
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

The implementation should prefer false negatives (requiring a manual continuation) over false positive automated messages.

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

- durable user configuration: managed-conversation policy, provider configuration metadata, global defaults, notification preferences;
- ephemeral/session state: tab/document mappings, control ownership, pending decisions/timers, recent fingerprints, cooldown state;
- compact audit history: bounded recent events, with secrets/chat content excluded or redacted.

Do not assume Manifest V3 service-worker memory survives. On wake/restart, reconstruct state from storage/page reinspection and invalidate decisions that cannot be proven current.

## 11. Security and privacy boundaries

- never expose provider credentials to page JavaScript;
- never log API keys or authorization headers;
- request only host/browser permissions needed for configured providers and ChatGPT support;
- model providers receive only classification context, never Chrome action authority;
- page content is treated as untrusted input to the classifier, not instructions to the extension core;
- classifier output is data and must pass local safety/revalidation gates before action;
- no automated responses to CAPTCHA, account verification, permission confirmations, model/account limit messages, or platform safety gates;
- sanitize/limit context sent off-device and make provider use visible/configurable.

## 12. Testing strategy

Prefer deterministic adapters/fixtures for most logic, with a small number of manual/e2e ChatGPT scenarios for DOM integration.

Test layers should cover:

1. pure state-machine/policy tests;
2. rule-engine classification fixtures;
3. provider normalization/failure tests;
4. multi-tab/session identity and stale-decision concurrency tests;
5. content-adapter DOM fixtures for generation/composer/error states;
6. guarded-send verification and ambiguous-write tests;
7. service-worker restart/recovery tests where practical;
8. manual integration checklist against the current ChatGPT Web UI.

The test suite must explicitly include adversarial race cases: delayed provider result, navigation during delay, user typing during delay, duplicate conversation tabs, provider failure, and response change before send.

## 13. Future Telegram boundary

Telegram is an extension point, not an MVP dependency. The first implementation should be outbound notification/read-only status only.

Any future remote command capability requires a separate threat model for authentication, chat targeting, replay protection, authorization, and safe interaction with pending local automation before it may send or control a ChatGPT tab.
