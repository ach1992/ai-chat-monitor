import { ConservativeStopClassifier } from "../classification/classifier.js";
import {
  inspectConversationStatusMarker,
  parseConversationProtocolStatus,
  stripConversationProtocolStatus,
  type ConversationProtocolDecision,
  type ConversationStatusMarkerResult,
} from "../classification/conversation-protocol.js";
import type { ClassificationResult } from "../classification/types.js";
import type { SessionView } from "../core/session-registry.js";
import { defaultNotificationManager } from "../notifications/manager.js";
import { fetchProviderModelCatalog } from "../providers/catalog.js";
import { createProviderManager } from "../providers/manager.js";
import {
  providerOriginPattern,
  resolveProviderCatalogProfile,
  resolveProviderProfileMutation,
} from "../providers/settings.js";
import { ProviderSettingsStore } from "../providers/settings-store.js";
import type {
  ProviderCatalogSpec,
  ProviderModelCatalogEntry,
  ProviderProfileMutation,
  ProviderSettingsState,
} from "../providers/types.js";
import type { PageObservation } from "../shared/observation.js";
import { createDurableStorage, createEphemeralStorage } from "../storage/index.js";
import { MonitoringHistoryRepository, type MonitoringHistoryState } from "./history.js";
import { MonitoringPolicyRepository, type MonitoringPolicyPersistence } from "./policy.js";
import type {
  ChatMonitoringPolicyPatch,
  MonitoringEvent,
  MonitoringEventType,
  MonitoringPageState,
  MonitoringPolicyDefaults,
  MonitoringPolicyState,
  MonitoringRuntimeStatus,
  ResolvedMonitoringPolicy,
  SemanticStatusSource,
} from "./types.js";

const POLICY_KEY = "config";
const HISTORY_KEY = "events";
const CACHE_KEY = "runtime";
const MAX_CACHE_ENTRIES = 256;

interface LegacyAutomationPolicyState {
  version?: number;
  revision?: number;
  defaults?: { notificationTriggers?: string[] };
  chats?: Array<{ conversationId?: string; mode?: string; notificationTriggers?: string[] }>;
}

interface ResolutionCacheEntry {
  key: string;
  decision?: ConversationProtocolDecision | undefined;
  source: SemanticStatusSource;
  marker: ConversationStatusMarkerResult;
  classification?: ClassificationResult | undefined;
}

interface ResolutionCacheState {
  version: 1;
  entries: ResolutionCacheEntry[];
}

interface GenerationProgress {
  fingerprint?: string;
  textLength: number;
  changedAt: number;
  notified: boolean;
}

interface LastAssistantIdentity {
  fingerprint: string;
  domMessageId?: string;
}

export interface MonitoringServiceStatus {
  policy?: ResolvedMonitoringPolicy;
  runtime?: MonitoringRuntimeStatus;
}

export interface MonitoringResetResult {
  state: MonitoringPolicyState;
  cleared: number;
}

function pageState(observation: PageObservation): MonitoringPageState {
  const reasons = new Set(observation.blocking.reasons);
  if (reasons.has("RATE_LIMIT")) return "RATE_LIMIT";
  if (reasons.has("AUTH")) return "AUTH_REQUIRED";
  if (reasons.has("CAPTCHA") || reasons.has("ACCOUNT_VERIFICATION") || reasons.has("CONFIRMATION_REQUIRED")) {
    return "VERIFICATION_REQUIRED";
  }
  if (reasons.has("CONVERSATION_FULL")) return "CONVERSATION_FULL";
  if (reasons.has("NETWORK")) return "NETWORK_ERROR";
  if (reasons.has("ERROR") || reasons.has("MODAL")) return "PLATFORM_ERROR";
  if (observation.actions.retryAvailable) return "RETRY_AVAILABLE";
  if (observation.generation === "GENERATING") return "GENERATING";
  if (observation.generation === "IDLE") return "IDLE";
  return "UNKNOWN";
}

function classificationDecision(classification: ClassificationResult): ConversationProtocolDecision {
  if (classification.decision === "CONTINUE") return "CONTINUE";
  if (classification.decision === "UNSURE") return "UNSURE";
  switch (classification.reasonCode) {
    case "HUMAN_APPROVAL_REQUIRED": return "HOLD_APPROVAL";
    case "MATERIAL_DECISION_REQUIRED": return "HOLD_DECISION";
    case "HUMAN_OPERATION_REQUIRED": return "HOLD_HUMAN_OPERATION";
    case "PROJECT_COMPLETE": return "COMPLETE";
    case "PLATFORM_ERROR": return "PLATFORM_ERROR";
    case "RATE_LIMIT": return "RATE_LIMIT";
    default: return "UNSURE";
  }
}

function semanticFromUi(state: MonitoringPageState): ConversationProtocolDecision | undefined {
  if (state === "RATE_LIMIT") return "RATE_LIMIT";
  if (state === "PLATFORM_ERROR" || state === "NETWORK_ERROR") return "PLATFORM_ERROR";
  return undefined;
}

function eventForPageState(state: MonitoringPageState): MonitoringEventType | undefined {
  switch (state) {
    case "RETRY_AVAILABLE": return "RETRY_AVAILABLE";
    case "PLATFORM_ERROR": return "PLATFORM_ERROR";
    case "NETWORK_ERROR": return "NETWORK_ERROR";
    case "RATE_LIMIT": return "RATE_LIMIT";
    case "AUTH_REQUIRED": return "AUTH_REQUIRED";
    case "VERIFICATION_REQUIRED": return "VERIFICATION_REQUIRED";
    case "CONVERSATION_FULL": return "CONVERSATION_FULL";
    default: return undefined;
  }
}

function eventForDecision(decision: ConversationProtocolDecision | undefined): MonitoringEventType | undefined {
  switch (decision) {
    case "CONTINUE": return "CONTINUE_READY";
    case "HOLD_APPROVAL": return "APPROVAL_REQUIRED";
    case "HOLD_DECISION": return "DECISION_REQUIRED";
    case "HOLD_HUMAN_OPERATION": return "HUMAN_OPERATION_REQUIRED";
    case "COMPLETE": return "TASK_COMPLETE";
    case "PLATFORM_ERROR": return "PLATFORM_ERROR";
    case "RATE_LIMIT": return "RATE_LIMIT";
    case "UNSURE": return "SEMANTIC_UNKNOWN";
    default: return undefined;
  }
}

function eventPresentation(type: MonitoringEventType): { title: string; message: string } {
  switch (type) {
    case "RESPONSE_COMPLETE": return { title: "ChatGPT response finished", message: "The monitored chat finished a response." };
    case "CONTINUE_READY": return { title: "Chat can continue", message: "The chat reports that work remains and can continue without a human gate." };
    case "APPROVAL_REQUIRED": return { title: "Approval required", message: "The monitored chat is waiting for human approval." };
    case "DECISION_REQUIRED": return { title: "Decision required", message: "The monitored chat is waiting for a material human decision." };
    case "HUMAN_OPERATION_REQUIRED": return { title: "Human action required", message: "The monitored chat needs human input, credentials, or an external action." };
    case "TASK_COMPLETE": return { title: "Task complete", message: "The monitored chat reports that the requested work is complete." };
    case "RETRY_AVAILABLE": return { title: "Retry available", message: "ChatGPT is idle and the page exposes a Retry action." };
    case "PLATFORM_ERROR": return { title: "ChatGPT platform error", message: "A platform error is blocking the monitored chat." };
    case "NETWORK_ERROR": return { title: "ChatGPT network error", message: "A network or connection error is blocking the monitored chat." };
    case "RATE_LIMIT": return { title: "Rate limit reached", message: "The monitored chat is blocked by a usage or rate limit." };
    case "AUTH_REQUIRED": return { title: "Authentication required", message: "The monitored chat requires sign-in or session recovery." };
    case "VERIFICATION_REQUIRED": return { title: "Verification required", message: "The monitored chat requires human verification or confirmation." };
    case "CONVERSATION_FULL": return { title: "Conversation limit reached", message: "The monitored conversation indicates that a new chat may be required." };
    case "SEMANTIC_UNKNOWN": return { title: "Chat status uncertain", message: "Guardian could not reliably determine the semantic work state." };
    case "PROVIDER_ERROR": return { title: "Classifier provider error", message: "The optional classifier provider could not resolve the chat state." };
    case "GENERATION_STALLED": return { title: "Generation may be stalled", message: "No observable response progress was detected within the configured threshold." };
    case "REPEATED_RESPONSE": return { title: "Repeated assistant response", message: "A fresh assistant turn repeated the previous response exactly." };
  }
}

function cacheState(value: ResolutionCacheState | undefined): ResolutionCacheState {
  if (value?.version !== 1 || !Array.isArray(value.entries)) return { version: 1, entries: [] };
  return {
    version: 1,
    entries: value.entries.filter((entry) => typeof entry?.key === "string" && entry.key.length > 0).slice(-MAX_CACHE_ENTRIES),
  };
}

export class MonitoringService {
  readonly #policies: MonitoringPolicyRepository;
  readonly #history: MonitoringHistoryRepository;
  readonly #providerSettings = new ProviderSettingsStore();
  readonly #cacheStorage = createEphemeralStorage<ResolutionCacheState>("monitoring-resolution-cache");
  readonly #getSession: (tabId: number) => SessionView | undefined;
  readonly #runtime = new Map<number, MonitoringRuntimeStatus>();
  readonly #generation = new Map<string, GenerationProgress>();
  readonly #lastAssistant = new Map<string, LastAssistantIdentity>();
  readonly #ready: Promise<void>;
  #cache: ResolutionCacheState = { version: 1, entries: [] };
  #providerMutationQueue: Promise<void> = Promise.resolve();

  constructor(
    getSession: (tabId: number) => SessionView | undefined,
    durableStorageReady: Promise<unknown> = Promise.resolve(),
  ) {
    this.#getSession = getSession;
    const policyStorage = createDurableStorage<MonitoringPolicyState>("monitoring-policy");
    const legacyPolicyStorage = createDurableStorage<LegacyAutomationPolicyState>("automation-policy");
    const historyStorage = createDurableStorage<MonitoringHistoryState>("monitoring-history");
    const persistence: MonitoringPolicyPersistence = {
      load: () => policyStorage.get(POLICY_KEY),
      save: (state) => policyStorage.set(POLICY_KEY, state),
      loadLegacy: () => legacyPolicyStorage.get(POLICY_KEY),
    };
    this.#policies = new MonitoringPolicyRepository(persistence);
    this.#history = new MonitoringHistoryRepository({
      load: () => historyStorage.get(HISTORY_KEY),
      save: (state) => historyStorage.set(HISTORY_KEY, state),
    });
    this.#ready = durableStorageReady.then(async () => {
      const [storedCache] = await Promise.all([
        this.#cacheStorage.get(CACHE_KEY),
        this.#policies.restore(),
        this.#history.restore(),
      ]);
      this.#cache = cacheState(storedCache);
    });
  }

  ready(): Promise<void> { return this.#ready; }

  async handleSession(session: SessionView): Promise<void> {
    await this.#ready;
    const conversationId = session.conversationId;
    const observation = session.observation;
    if (conversationId === undefined || observation === undefined) {
      this.#runtime.set(session.tabId, {
        tabId: session.tabId,
        enabled: false,
        pageState: "UNKNOWN",
        blockingReasons: [],
        semanticSource: "UNKNOWN",
        markerHealth: "MISSING",
        updatedAt: Date.now(),
      });
      return;
    }

    const policy = this.#policies.resolve(conversationId);
    const state = pageState(observation);
    if (!policy.enabled) {
      this.#runtime.set(session.tabId, {
        tabId: session.tabId,
        conversationId,
        enabled: false,
        generation: observation.generation,
        pageState: state,
        blockingReasons: [...observation.blocking.reasons],
        semanticSource: "UNKNOWN",
        markerHealth: "MISSING",
        ...(observation.latestAssistant === undefined ? {} : { assistantFingerprint: observation.latestAssistant.fingerprint }),
        updatedAt: Date.now(),
      });
      return;
    }

    if (observation.generation === "GENERATING") {
      await this.#handleGenerating(session, policy, state);
      return;
    }
    this.#generation.delete(conversationId);

    const pageEvent = eventForPageState(state);
    const assistant = observation.latestAssistant;
    if (assistant === undefined || observation.confidence !== "HIGH") {
      const uiDecision = semanticFromUi(state);
      const runtime: MonitoringRuntimeStatus = {
        tabId: session.tabId,
        conversationId,
        enabled: true,
        generation: observation.generation,
        pageState: state,
        blockingReasons: [...observation.blocking.reasons],
        ...(uiDecision === undefined ? {} : { semanticDecision: uiDecision }),
        semanticSource: uiDecision === undefined ? "UNKNOWN" : "UI",
        markerHealth: "MISSING",
        ...(pageEvent === undefined ? {} : { lastEvent: pageEvent }),
        updatedAt: Date.now(),
      };
      this.#runtime.set(session.tabId, runtime);
      if (pageEvent !== undefined) await this.#emitEvent(session, policy, runtime, pageEvent);
      return;
    }

    const resolution = await this.#resolveSemantic(session, state);
    const prior = this.#lastAssistant.get(conversationId);
    const repeated = prior !== undefined &&
      prior.fingerprint === assistant.fingerprint &&
      prior.domMessageId !== undefined &&
      assistant.domMessageId !== undefined &&
      prior.domMessageId !== assistant.domMessageId;
    this.#lastAssistant.set(conversationId, {
      fingerprint: assistant.fingerprint,
      ...(assistant.domMessageId === undefined ? {} : { domMessageId: assistant.domMessageId }),
    });

    let eventType = pageEvent ?? eventForDecision(resolution.decision) ?? "RESPONSE_COMPLETE";
    if (resolution.classification?.reasonCode === "PROVIDER_FAILURE") eventType = "PROVIDER_ERROR";
    if (repeated && pageEvent === undefined) eventType = "REPEATED_RESPONSE";

    const runtime: MonitoringRuntimeStatus = {
      tabId: session.tabId,
      conversationId,
      enabled: true,
      generation: observation.generation,
      pageState: state,
      blockingReasons: [...observation.blocking.reasons],
      ...(resolution.decision === undefined ? {} : { semanticDecision: resolution.decision }),
      semanticSource: resolution.source,
      markerHealth: resolution.marker.health,
      ...(resolution.classification === undefined ? {} : { classification: resolution.classification }),
      assistantFingerprint: assistant.fingerprint,
      lastEvent: eventType,
      updatedAt: Date.now(),
    };
    this.#runtime.set(session.tabId, runtime);
    await this.#emitEvent(session, policy, runtime, eventType);
  }

  async updateChat(tabId: number, expectedConversationId: string, patch: ChatMonitoringPolicyPatch): Promise<ResolvedMonitoringPolicy> {
    await this.#ready;
    const session = this.#getSession(tabId);
    if (session?.conversationId !== expectedConversationId) throw new Error("Tab conversation identity changed before the monitoring update.");
    const policy = await this.#policies.updateChat(expectedConversationId, patch);
    if (session !== undefined) await this.handleSession(session);
    return policy;
  }

  async updateDefaults(patch: Partial<MonitoringPolicyDefaults>): Promise<MonitoringPolicyState> {
    await this.#ready;
    return this.#policies.updateDefaults(patch);
  }

  async resetChats(): Promise<MonitoringResetResult> {
    await this.#ready;
    const before = this.#policies.snapshot();
    const state = await this.#policies.clearChats();
    this.#generation.clear();
    this.#lastAssistant.clear();
    this.#cache = { version: 1, entries: [] };
    try { await this.#cacheStorage.set(CACHE_KEY, this.#cache); } catch { /* cache reset is best effort */ }

    for (const tabId of [...this.#runtime.keys()]) {
      const session = this.#getSession(tabId);
      if (session === undefined) {
        this.#runtime.delete(tabId);
        continue;
      }
      await this.handleSession(session);
    }

    return { state, cleared: before.chats.length };
  }

  async status(tabId: number): Promise<MonitoringServiceStatus> {
    await this.#ready;
    const session = this.#getSession(tabId);
    const runtime = this.#runtime.get(tabId);
    return {
      ...(session?.conversationId === undefined ? {} : { policy: this.#policies.resolve(session.conversationId) }),
      ...(runtime === undefined ? {} : { runtime: structuredClone(runtime) }),
    };
  }

  policySnapshot(): MonitoringPolicyState { return this.#policies.snapshot(); }
  history(limit = 80): MonitoringEvent[] { return this.#history.snapshot(limit); }
  clearHistory(): Promise<void> { return this.#history.clear(); }

  async providerSettings(): Promise<ProviderSettingsState> {
    await this.#ready;
    await this.#providerMutationQueue;
    return this.#providerSettings.load();
  }

  async upsertProviderProfile(mutation: ProviderProfileMutation, makePrimary = false): Promise<ProviderSettingsState> {
    await this.#ready;
    return this.#withProviderWrite(async () => {
      const current = await this.#providerSettings.load();
      const existing = current.profiles.find((candidate) => candidate.id === mutation.id);
      const previousOrigin = existing === undefined ? undefined : providerOriginPattern(existing);
      const profile = resolveProviderProfileMutation(mutation, existing);
      const profiles = current.profiles.filter((candidate) => candidate.id !== profile.id);
      profiles.push(profile);
      const wasActive = current.order.includes(profile.id);
      const withoutProfile = current.order.filter((id) => id !== profile.id);
      const order = makePrimary ? [profile.id, ...withoutProfile] : wasActive ? [...current.order] : [...withoutProfile, profile.id];
      const next: ProviderSettingsState = { version: 1, profiles, order };
      await this.#providerSettings.save(next);
      if (previousOrigin !== undefined && previousOrigin !== providerOriginPattern(profile)) {
        const stillUsed = next.profiles.some((candidate) => providerOriginPattern(candidate) === previousOrigin);
        if (!stillUsed) {
          try { await chrome.permissions.remove({ origins: [previousOrigin] }); } catch { /* optional permission cleanup */ }
        }
      }
      return this.#providerSettings.load();
    });
  }

  async providerModelCatalog(spec: ProviderCatalogSpec): Promise<ProviderModelCatalogEntry[]> {
    await this.#ready;
    const profile = await this.#withProviderWrite(async () => {
      const current = await this.#providerSettings.load();
      const existing = spec.providerId === undefined
        ? undefined
        : current.profiles.find((candidate) => candidate.id === spec.providerId);
      return resolveProviderCatalogProfile(spec, existing);
    });
    return fetchProviderModelCatalog(profile);
  }

  async removeProviderProfile(providerId: string): Promise<ProviderSettingsState> {
    await this.#ready;
    return this.#withProviderWrite(async () => {
      const current = await this.#providerSettings.load();
      const removed = current.profiles.find((profile) => profile.id === providerId);
      const next: ProviderSettingsState = {
        version: 1,
        profiles: current.profiles.filter((profile) => profile.id !== providerId),
        order: current.order.filter((id) => id !== providerId),
      };
      await this.#providerSettings.save(next);
      if (removed !== undefined) {
        const origin = providerOriginPattern(removed);
        const stillUsed = next.profiles.some((profile) => providerOriginPattern(profile) === origin);
        if (!stillUsed) {
          try { await chrome.permissions.remove({ origins: [origin] }); } catch { /* optional permission cleanup */ }
        }
      }
      return this.#providerSettings.load();
    });
  }

  async updateProviderOrder(order: string[]): Promise<ProviderSettingsState> {
    await this.#ready;
    return this.#withProviderWrite(async () => {
      const current = await this.#providerSettings.load();
      const next: ProviderSettingsState = { ...current, order: [...order] };
      await this.#providerSettings.save(next);
      return this.#providerSettings.load();
    });
  }

  async #resolveSemantic(
    session: SessionView,
    state: MonitoringPageState,
  ): Promise<ResolutionCacheEntry> {
    const observation = session.observation;
    const assistant = observation?.latestAssistant;
    const conversationId = session.conversationId;
    if (assistant === undefined || conversationId === undefined) {
      return { key: "missing", source: "UNKNOWN", marker: { health: "MISSING" } };
    }

    const key = `${conversationId}:${assistant.fingerprint}`;
    const cached = this.#cache.entries.find((entry) => entry.key === key);
    if (cached !== undefined) return structuredClone(cached);

    const uiDecision = semanticFromUi(state);
    const marker = inspectConversationStatusMarker(assistant.normalizedText);
    if (uiDecision !== undefined) {
      return this.#cacheResolution({ key, decision: uiDecision, source: "UI", marker });
    }

    if ((marker.health === "DETECTED" || marker.health === "LEGACY") && marker.decision !== undefined) {
      const classification = parseConversationProtocolStatus(assistant.normalizedText);
      return this.#cacheResolution({
        key,
        decision: marker.decision,
        source: "STATUS_MARKER",
        marker,
        classification,
      });
    }

    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    const latestUser = observation?.latestUser?.normalizedText;
    if (latestUser !== undefined && latestUser.length > 0) turns.push({ role: "user", content: latestUser });
    turns.push({ role: "assistant", content: stripConversationProtocolStatus(assistant.normalizedText) });

    const localClassifier = new ConservativeStopClassifier();
    const deterministic = localClassifier.classifyDeterministic({ turns });
    if (deterministic !== undefined) {
      return this.#cacheResolution({
        key,
        decision: classificationDecision(deterministic),
        source: "RULE",
        marker,
        classification: deterministic,
      });
    }

    const settings = await this.#providerSettings.load();
    if (settings.order.length === 0) {
      return this.#cacheResolution({ key, decision: "UNSURE", source: "UNKNOWN", marker });
    }

    let classification: ClassificationResult;
    try {
      classification = await new ConservativeStopClassifier(createProviderManager(settings)).classify({ turns });
    } catch {
      classification = {
        decision: "UNSURE",
        reasonCode: "PROVIDER_FAILURE",
        reason: "Configured provider classification failed.",
        source: "SYSTEM",
      };
    }
    return this.#cacheResolution({
      key,
      decision: classificationDecision(classification),
      source: classification.source === "PROVIDER" ? "PROVIDER" : "UNKNOWN",
      marker,
      classification,
    });
  }

  async #cacheResolution(entry: ResolutionCacheEntry): Promise<ResolutionCacheEntry> {
    this.#cache = {
      version: 1,
      entries: [...this.#cache.entries.filter((candidate) => candidate.key !== entry.key), structuredClone(entry)].slice(-MAX_CACHE_ENTRIES),
    };
    try { await this.#cacheStorage.set(CACHE_KEY, this.#cache); } catch { /* cache is an optimization only */ }
    return structuredClone(entry);
  }

  async #handleGenerating(
    session: SessionView,
    policy: ResolvedMonitoringPolicy,
    state: MonitoringPageState,
  ): Promise<void> {
    const observation = session.observation;
    const conversationId = session.conversationId;
    if (observation === undefined || conversationId === undefined) return;
    const now = Date.now();
    const assistant = observation.latestAssistant;
    const currentFingerprint = assistant?.fingerprint;
    const currentLength = assistant?.textLength ?? 0;
    const existing = this.#generation.get(conversationId);
    const changed = existing === undefined || existing.fingerprint !== currentFingerprint || existing.textLength !== currentLength;
    const progress: GenerationProgress = changed
      ? { ...(currentFingerprint === undefined ? {} : { fingerprint: currentFingerprint }), textLength: currentLength, changedAt: now, notified: false }
      : existing;
    this.#generation.set(conversationId, progress);

    let lastEvent: MonitoringEventType | undefined;
    if (!progress.notified && now - progress.changedAt >= policy.stallThresholdMs) {
      progress.notified = true;
      lastEvent = "GENERATION_STALLED";
      const runtime: MonitoringRuntimeStatus = {
        tabId: session.tabId,
        conversationId,
        enabled: true,
        generation: observation.generation,
        pageState: state,
        blockingReasons: [...observation.blocking.reasons],
        semanticSource: "UNKNOWN",
        markerHealth: "MISSING",
        ...(currentFingerprint === undefined ? {} : { assistantFingerprint: currentFingerprint }),
        lastEvent,
        updatedAt: now,
      };
      this.#runtime.set(session.tabId, runtime);
      await this.#emitEvent(session, policy, runtime, lastEvent);
      return;
    }

    this.#runtime.set(session.tabId, {
      tabId: session.tabId,
      conversationId,
      enabled: true,
      generation: observation.generation,
      pageState: state,
      blockingReasons: [...observation.blocking.reasons],
      semanticSource: "UNKNOWN",
      markerHealth: "MISSING",
      ...(currentFingerprint === undefined ? {} : { assistantFingerprint: currentFingerprint }),
      ...(lastEvent === undefined ? {} : { lastEvent }),
      updatedAt: now,
    });
  }

  async #emitEvent(
    session: SessionView,
    policy: ResolvedMonitoringPolicy,
    runtime: MonitoringRuntimeStatus,
    type: MonitoringEventType,
  ): Promise<void> {
    const conversationId = runtime.conversationId;
    if (conversationId === undefined) return;
    const assistantIdentity = runtime.assistantFingerprint ?? session.observation?.latestAssistant?.domMessageId ?? session.routeKey;
    const id = `monitor:${conversationId}:${assistantIdentity}:${type}`.slice(0, 500);
    const presentation = eventPresentation(type);
    const event: MonitoringEvent = {
      id,
      at: Date.now(),
      tabId: session.tabId,
      conversationId,
      type,
      pageState: runtime.pageState,
      ...(runtime.semanticDecision === undefined ? {} : { semanticDecision: runtime.semanticDecision }),
      semanticSource: runtime.semanticSource,
      markerHealth: runtime.markerHealth,
      ...(runtime.assistantFingerprint === undefined ? {} : { assistantFingerprint: runtime.assistantFingerprint }),
      title: presentation.title,
      message: presentation.message,
    };

    let appended = false;
    try { appended = await this.#history.append(event); } catch { appended = false; }
    if (!appended) return;

    const browserEnabled = policy.browserEvents.includes(type);
    const soundEnabled = policy.soundEvents.includes(type);
    try {
      await defaultNotificationManager().deliver({
        id,
        event: type,
        title: presentation.title,
        message: presentation.message,
        browserEnabled,
        soundEnabled,
        conversationId,
        tabId: session.tabId,
      });
    } catch {
      // Delivery failures are observational and never alter monitoring state.
    }
  }

  #withProviderWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#providerMutationQueue.then(operation, operation);
    this.#providerMutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}