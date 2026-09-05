import {
  PROTOCOL_VERSION,
  isContentHello,
  isContentNavigation,
  isContentObservation,
  isContentUserInteraction,
  isPanelHistoryClear,
  isPanelMonitoringDefaultsUpdate,
  isPanelMonitoringPolicyUpdate,
  isPanelOverviewRequest,
  isPanelProviderClassifierReadinessRequest,
  isPanelProviderModelCatalogRequest,
  isPanelProviderOrderUpdate,
  isPanelProviderProfileRemove,
  isPanelProviderProfileUpsert,
  isPanelStatusRequest,
  type ContentAgentAck,
  type ContentHello,
  type ContentNavigation,
  type ContentObservation,
  type ContentUserInteraction,
  type GuardianResponse,
  type HistoryClearResponse,
  type ManagedChatStatus,
  type MonitoringPolicyResponse,
  type PanelMonitoringDefaultsUpdate,
  type PanelMonitoringPolicyUpdate,
  type PanelOverviewResponse,
  type PanelProviderClassifierReadinessRequest,
  type PanelProviderModelCatalogRequest,
  type PanelProviderOrderUpdate,
  type PanelProviderProfileRemove,
  type PanelProviderProfileUpsert,
  type PanelStatusResponse,
  type ProtocolErrorResponse,
  type ProviderSettingsResponse,
} from "../shared/protocol.js";
import {
  SessionRegistry,
  type SessionMutationResult,
  type SessionRegistryState,
} from "../core/session-registry.js";
import { isPanelMonitoringChatsReset, type MonitoringChatsResetResponse } from "../monitoring/reset-protocol.js";
import { MonitoringService } from "../monitoring/service.js";
import { ProviderConfigurationError, redactProviderProfile } from "../providers/settings.js";
import { testProviderClassifierReadiness } from "../providers/readiness.js";
import { ProviderFailure, type ProviderSettingsState } from "../providers/types.js";
import {
  createEphemeralStorage,
  restrictDurableStorageToTrustedContexts,
} from "../storage/index.js";

const REGISTRY_KEY = "runtime";
const registryStorage = createEphemeralStorage<SessionRegistryState>("session-registry");

const BACKGROUND_MONITORING_DIAGNOSTIC_KEY = "trace";
const MAX_BACKGROUND_MONITORING_DIAGNOSTIC_ENTRIES = 256;
const BACKGROUND_MONITORING_DIAGNOSTIC_CHANGE_SAMPLE_MS = 2_000;
const BACKGROUND_MONITORING_DIAGNOSTIC_HEARTBEAT_MS = 15_000;

type DiagnosticContentMessage = Pick<ContentObservation, "agentInstanceId" | "pageEpoch" | "sequence" | "sentAt">;
type DiagnosticIdentity = { tabId: number; documentId: string };

interface BackgroundMonitoringDiagnosticEntry {
  at: number;
  bootId: string;
  kind: "WORKER_BOOT" | "MANUAL_SEND" | "OBSERVATION" | "SESSION_REJECTED" | "TAB_ACTIVATED";
  tabId?: number | undefined;
  activeTabId?: number | undefined;
  tabActive?: boolean | undefined;
  documentId?: string | undefined;
  agentInstanceId?: string | undefined;
  pageEpoch?: number | undefined;
  sequence?: number | undefined;
  contentSentAt?: number | undefined;
  conversationId?: string | undefined;
  rejectReason?: string | undefined;
  observedAt?: number | undefined;
  generation?: ContentObservation["observation"]["generation"] | undefined;
  confidence?: ContentObservation["observation"]["confidence"] | undefined;
  userMessageId?: string | undefined;
  userLength?: number | undefined;
  assistantMessageId?: string | undefined;
  assistantLength?: number | undefined;
  pageState?: string | undefined;
  markerHealth?: string | undefined;
  semanticDecision?: string | undefined;
  semanticSource?: string | undefined;
  lastEvent?: string | undefined;
  monitoringUpdatedAt?: number | undefined;
  latestEventType?: string | undefined;
  latestEventAt?: number | undefined;
}

interface BackgroundMonitoringDiagnosticTrace {
  version: 1;
  entries: BackgroundMonitoringDiagnosticEntry[];
}

const backgroundMonitoringDiagnosticStorage = createEphemeralStorage<BackgroundMonitoringDiagnosticTrace>(
  "background-monitoring-diagnostic",
);
const backgroundMonitoringDiagnosticBootId = crypto.randomUUID();
let backgroundMonitoringDiagnosticTrace: BackgroundMonitoringDiagnosticTrace = { version: 1, entries: [] };
const backgroundMonitoringDiagnosticReady = backgroundMonitoringDiagnosticStorage
  .get(BACKGROUND_MONITORING_DIAGNOSTIC_KEY)
  .then((stored) => {
    if (stored?.version === 1 && Array.isArray(stored.entries)) {
      backgroundMonitoringDiagnosticTrace = { version: 1, entries: stored.entries.slice(-MAX_BACKGROUND_MONITORING_DIAGNOSTIC_ENTRIES) };
    }
  })
  .catch(() => undefined);
let backgroundMonitoringDiagnosticQueue: Promise<void> = Promise.resolve();
const backgroundMonitoringObservationSamples = new Map<number, { signature: string; at: number }>();

function diagnosticContentIdentity(
  identity: DiagnosticIdentity,
  message: DiagnosticContentMessage,
  sender: chrome.runtime.MessageSender,
): Partial<BackgroundMonitoringDiagnosticEntry> {
  return {
    tabId: identity.tabId,
    tabActive: sender.tab?.active,
    documentId: identity.documentId,
    agentInstanceId: message.agentInstanceId,
    pageEpoch: message.pageEpoch,
    sequence: message.sequence,
    contentSentAt: message.sentAt,
  };
}

function recordBackgroundMonitoringDiagnostic(
  entry: Omit<BackgroundMonitoringDiagnosticEntry, "at" | "bootId">,
): Promise<void> {
  const run = backgroundMonitoringDiagnosticQueue.then(async () => {
    await backgroundMonitoringDiagnosticReady;
    backgroundMonitoringDiagnosticTrace = {
      version: 1,
      entries: [
        ...backgroundMonitoringDiagnosticTrace.entries,
        { ...entry, at: Date.now(), bootId: backgroundMonitoringDiagnosticBootId },
      ].slice(-MAX_BACKGROUND_MONITORING_DIAGNOSTIC_ENTRIES),
    };
    await backgroundMonitoringDiagnosticStorage.set(BACKGROUND_MONITORING_DIAGNOSTIC_KEY, backgroundMonitoringDiagnosticTrace);
  });
  backgroundMonitoringDiagnosticQueue = run.catch(() => undefined);
  return run.catch(() => undefined);
}

let registry = new SessionRegistry();
let mutationQueue: Promise<void> = Promise.resolve();

const durableStorageReady = restrictDurableStorageToTrustedContexts();
const monitoring = new MonitoringService((tabId) => registry.getTab(tabId), durableStorageReady);
const registryReady = Promise.all([
  durableStorageReady,
  registryStorage.get(REGISTRY_KEY),
]).then(([, state]) => {
  registry = SessionRegistry.fromState(state, { invalidateObservations: true });
});

void recordBackgroundMonitoringDiagnostic({ kind: "WORKER_BOOT" });

async function requestContentAgentReconnect(tabId: number, documentId?: string): Promise<void> {
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: "panel:agent-reconnect", protocolVersion: PROTOCOL_VERSION },
      ...(documentId === undefined ? [] : [{ documentId }]),
    );
  } catch {
    // Missing/stale tabs and documents are expected during restore/navigation.
  }
}

async function refreshRestoredContentAgents(): Promise<void> {
  await registryReady;
  for (const session of registry.list()) {
    await requestContentAgentReconnect(session.tabId, session.documentId);
  }
}

void refreshRestoredContentAgents();

function protocolError(code: ProtocolErrorResponse["code"], message: string): ProtocolErrorResponse {
  return { type: "background:error", protocolVersion: PROTOCOL_VERSION, code, message };
}

function senderIdentity(sender: chrome.runtime.MessageSender): { tabId: number; documentId: string } | undefined {
  const tabId = sender.tab?.id;
  const documentId = sender.documentId;
  if (tabId === undefined || documentId === undefined || documentId.length === 0) return undefined;
  return { tabId, documentId };
}

function trustedExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.tab === undefined;
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function mutateRegistry(operation: (current: SessionRegistry) => SessionMutationResult): Promise<SessionMutationResult> {
  await registryReady;
  return enqueueMutation(async () => {
    const previous = registry.exportState();
    const result = operation(registry);
    if (!result.accepted) return result;
    try {
      await registryStorage.set(REGISTRY_KEY, registry.exportState());
      return result;
    } catch (error) {
      registry = SessionRegistry.fromState(previous);
      throw error;
    }
  });
}

async function mutateTabLifecycle(tabId: number, kind: "invalidate" | "remove"): Promise<void> {
  await registryReady;
  await enqueueMutation(async () => {
    const previous = registry.exportState();
    if (kind === "invalidate") registry.invalidateTab(tabId);
    else registry.removeTab(tabId);
    try {
      await registryStorage.set(REGISTRY_KEY, registry.exportState());
    } catch (error) {
      registry = SessionRegistry.fromState(previous);
      throw error;
    }
  });
}

function acceptedAck(tabId: number, documentId: string, result: Extract<SessionMutationResult, { accepted: true }>): ContentAgentAck {
  return {
    type: "background:agent-ack",
    protocolVersion: PROTOCOL_VERSION,
    accepted: true,
    tabId,
    documentId,
    controlEligibility: result.session.controlEligibility,
  };
}

function staleEvent(reason: string): ProtocolErrorResponse {
  return protocolError("STALE_EVENT", `Session event rejected: ${reason}.`);
}

async function handleContentHello(message: ContentHello, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  const identity = senderIdentity(sender);
  if (identity === undefined) return protocolError("INVALID_SENDER", "Content message has no exact tab/document identity.");
  try {
    const result = await mutateRegistry((current) => current.registerAgent({
      ...identity,
      agentInstanceId: message.agentInstanceId,
      pageEpoch: message.pageEpoch,
      sequence: message.sequence,
      routeKey: message.routeKey,
      ...(message.conversationId === undefined ? {} : { conversationId: message.conversationId }),
      sentAt: message.sentAt,
    }));
    if (!result.accepted) return staleEvent(result.reason);
    await monitoring.handleSession(result.session);
    return acceptedAck(identity.tabId, identity.documentId, result);
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist content-agent registration.");
  }
}

async function handleNavigation(message: ContentNavigation, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  const identity = senderIdentity(sender);
  if (identity === undefined) return protocolError("INVALID_SENDER", "Navigation event has no exact tab/document identity.");
  try {
    const result = await mutateRegistry((current) => current.applyNavigation({
      ...identity,
      agentInstanceId: message.agentInstanceId,
      pageEpoch: message.pageEpoch,
      sequence: message.sequence,
      routeKey: message.routeKey,
      ...(message.conversationId === undefined ? {} : { conversationId: message.conversationId }),
      sentAt: message.sentAt,
    }));
    if (!result.accepted) return staleEvent(result.reason);
    await monitoring.handleSession(result.session);
    return acceptedAck(identity.tabId, identity.documentId, result);
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist navigation state.");
  }
}

async function handleObservation(message: ContentObservation, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  const identity = senderIdentity(sender);
  if (identity === undefined) return protocolError("INVALID_SENDER", "Observation event has no exact tab/document identity.");
  try {
    const result = await mutateRegistry((current) => current.applyObservation({
      ...identity,
      agentInstanceId: message.agentInstanceId,
      pageEpoch: message.pageEpoch,
      sequence: message.sequence,
      observation: message.observation,
      sentAt: message.sentAt,
    }));
    if (!result.accepted) {
      await recordBackgroundMonitoringDiagnostic({
        kind: "SESSION_REJECTED",
        ...diagnosticContentIdentity(identity, message, sender),
        rejectReason: result.reason,
      });
      return staleEvent(result.reason);
    }

    await monitoring.handleSession(result.session);
    const runtime = (await monitoring.status(identity.tabId)).runtime;
    const latestEvent = monitoring.history(20).reverse().find((event) => event.conversationId === result.session.conversationId);
    const user = message.observation.latestUser;
    const assistant = message.observation.latestAssistant;
    const entry: Omit<BackgroundMonitoringDiagnosticEntry, "at" | "bootId"> = {
      kind: "OBSERVATION",
      ...diagnosticContentIdentity(identity, message, sender),
      conversationId: result.session.conversationId,
      observedAt: message.observation.observedAt,
      generation: message.observation.generation,
      confidence: message.observation.confidence,
      userMessageId: user?.domMessageId,
      userLength: user?.textLength,
      assistantMessageId: assistant?.domMessageId,
      assistantLength: assistant?.textLength,
      pageState: runtime?.pageState,
      markerHealth: runtime?.markerHealth,
      semanticDecision: runtime?.semanticDecision,
      semanticSource: runtime?.semanticSource,
      lastEvent: runtime?.lastEvent,
      monitoringUpdatedAt: runtime?.updatedAt,
      latestEventType: latestEvent?.type,
      latestEventAt: latestEvent?.at,
    };
    const signature = JSON.stringify([
      entry.tabActive,
      entry.generation,
      entry.confidence,
      entry.userMessageId,
      entry.userLength,
      entry.assistantMessageId,
      entry.assistantLength,
      entry.pageState,
      entry.markerHealth,
      entry.semanticDecision,
      entry.lastEvent,
      entry.latestEventType,
      entry.latestEventAt,
    ]);
    const now = Date.now();
    const prior = backgroundMonitoringObservationSamples.get(identity.tabId);
    const changed = prior?.signature !== signature;
    if (prior === undefined ||
      (changed && now - prior.at >= BACKGROUND_MONITORING_DIAGNOSTIC_CHANGE_SAMPLE_MS) ||
      now - prior.at >= BACKGROUND_MONITORING_DIAGNOSTIC_HEARTBEAT_MS) {
      backgroundMonitoringObservationSamples.set(identity.tabId, { signature, at: now });
      await recordBackgroundMonitoringDiagnostic(entry);
    }

    return acceptedAck(identity.tabId, identity.documentId, result);
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist observation state.");
  }
}

async function handleInteraction(message: ContentUserInteraction, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  const identity = senderIdentity(sender);
  if (identity === undefined) return protocolError("INVALID_SENDER", "Interaction event has no exact tab/document identity.");
  try {
    const result = await mutateRegistry((current) => current.applyInteraction({
      ...identity,
      agentInstanceId: message.agentInstanceId,
      pageEpoch: message.pageEpoch,
      sequence: message.sequence,
      sentAt: message.sentAt,
    }));
    if (!result.accepted) {
      if (message.interaction === "MANUAL_SEND") {
        await recordBackgroundMonitoringDiagnostic({
          kind: "SESSION_REJECTED",
          ...diagnosticContentIdentity(identity, message, sender),
          rejectReason: result.reason,
        });
      }
      return staleEvent(result.reason);
    }
    await monitoring.handleSession(result.session);
    if (message.interaction === "MANUAL_SEND") {
      await recordBackgroundMonitoringDiagnostic({
        kind: "MANUAL_SEND",
        ...diagnosticContentIdentity(identity, message, sender),
        conversationId: result.session.conversationId,
      });
    }
    return acceptedAck(identity.tabId, identity.documentId, result);
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist user-interaction state.");
  }
}

async function handlePanelStatusRequest(tabId: number, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may read monitored-chat status.");
  try {
    await registryReady;
    await mutationQueue;
    await monitoring.ready();
    const session = registry.getTab(tabId);
    const status = await monitoring.status(tabId);
    const response: PanelStatusResponse = {
      type: "background:status",
      protocolVersion: PROTOCOL_VERSION,
      tabId,
      connected: session !== undefined,
      ...(session === undefined ? {} : {
        documentId: session.documentId,
        ...(session.conversationId === undefined ? {} : { conversationId: session.conversationId }),
        controlEligibility: session.controlEligibility,
        lastSeenAt: session.lastSeenAt,
      }),
      ...(status.policy === undefined ? {} : { monitoringPolicy: status.policy }),
      ...(status.runtime === undefined ? {} : { monitoringRuntime: status.runtime }),
    };
    return response;
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to read session/monitoring state.");
  }
}

function redactProviderSettings(settings: ProviderSettingsState): ProviderSettingsResponse["providers"] {
  return {
    profiles: settings.profiles.map(redactProviderProfile),
    order: [...settings.order],
  };
}

async function handleOverview(sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may read the monitoring overview.");
  try {
    await registryReady;
    await mutationQueue;
    await monitoring.ready();
    const policyState = monitoring.policySnapshot();
    const providerSettings = await monitoring.providerSettings();
    const chats: ManagedChatStatus[] = [];
    for (const session of registry.list()) {
      if (session.conversationId === undefined) continue;
      const overrides = policyState.chats.find((chat) => chat.conversationId === session.conversationId);
      if (overrides?.enabled !== true) continue;
      const status = await monitoring.status(session.tabId);
      chats.push({
        tabId: session.tabId,
        conversationId: session.conversationId,
        routeKey: session.routeKey,
        controlEligibility: session.controlEligibility,
        lastSeenAt: session.lastSeenAt,
        ...(session.observation?.pageTitle === undefined ? {} : { pageTitle: session.observation.pageTitle }),
        ...(session.observation === undefined ? {} : { generation: session.observation.generation }),
        overrides: structuredClone(overrides),
        ...(status.policy === undefined ? {} : { policy: status.policy }),
        ...(status.runtime === undefined ? {} : { runtime: status.runtime }),
      });
    }
    const response: PanelOverviewResponse = {
      type: "background:overview",
      protocolVersion: PROTOCOL_VERSION,
      policyRevision: policyState.revision,
      defaults: policyState.defaults,
      chats,
      providers: redactProviderSettings(providerSettings),
      events: monitoring.history(80),
    };
    return response;
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to read the monitoring overview.");
  }
}

function monitoringPolicyResponse(tabId?: number): MonitoringPolicyResponse {
  const state = monitoring.policySnapshot();
  return {
    type: "background:monitoring-policy",
    protocolVersion: PROTOCOL_VERSION,
    revision: state.revision,
    ...(tabId === undefined ? {} : { tabId }),
  };
}

function providerResponse(settings: ProviderSettingsState): ProviderSettingsResponse {
  return {
    type: "background:provider-settings",
    protocolVersion: PROTOCOL_VERSION,
    providers: redactProviderSettings(settings),
  };
}

async function handleMonitoringPolicyUpdate(message: PanelMonitoringPolicyUpdate, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may change monitoring policy.");
  try {
    await registryReady;
    await mutationQueue;
    const current = registry.getTab(message.tabId);
    if (current?.conversationId !== message.conversationId) {
      return protocolError("INVALID_MESSAGE", "Tab conversation identity changed before the monitoring update.");
    }
    const policy = await monitoring.updateChat(message.tabId, message.conversationId, message.patch);
    const status = await monitoring.status(message.tabId);
    const response = monitoringPolicyResponse(message.tabId);
    response.policy = policy;
    if (status.runtime !== undefined) response.runtime = status.runtime;
    return response;
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist chat monitoring policy.");
  }
}

async function handleMonitoringDefaultsUpdate(message: PanelMonitoringDefaultsUpdate, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may change monitoring defaults.");
  try {
    await monitoring.updateDefaults(message.patch);
    return monitoringPolicyResponse();
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist monitoring defaults.");
  }
}

async function handleMonitoringChatsReset(sender: chrome.runtime.MessageSender): Promise<GuardianResponse | MonitoringChatsResetResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may reset monitored chats.");
  try {
    await registryReady;
    await mutationQueue;
    const result = await monitoring.resetChats();
    return {
      type: "background:monitoring-chats-reset",
      protocolVersion: PROTOCOL_VERSION,
      revision: result.state.revision,
      cleared: result.cleared,
    };
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to reset monitored chats.");
  }
}

async function handleProviderProfileUpsert(message: PanelProviderProfileUpsert, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may change provider settings.");
  try {
    const saved = await monitoring.upsertProviderProfile(message.profile, message.makePrimary ?? false);
    return providerResponse(saved);
  } catch (error) {
    if (error instanceof ProviderConfigurationError) return protocolError("INVALID_MESSAGE", error.message);
    return protocolError("STORAGE_FAILURE", "Unable to persist provider profile.");
  }
}

async function handleProviderModelCatalog(message: PanelProviderModelCatalogRequest, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may load provider models.");
  try {
    const models = await monitoring.providerModelCatalog(message.spec);
    return {
      type: "background:provider-model-catalog",
      protocolVersion: PROTOCOL_VERSION,
      models,
    };
  } catch (error) {
    if (error instanceof ProviderConfigurationError) return protocolError("INVALID_MESSAGE", error.message);
    if (error instanceof ProviderFailure) return protocolError("PROVIDER_FAILURE", error.message);
    return protocolError("PROVIDER_FAILURE", "Unable to load the provider model catalog.");
  }
}

async function handleProviderClassifierReadiness(
  message: PanelProviderClassifierReadinessRequest,
  sender: chrome.runtime.MessageSender,
): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) {
    return protocolError("INVALID_SENDER", "Only trusted extension pages may test provider classifier readiness.");
  }
  try {
    const settings = await monitoring.providerSettings();
    const profile = settings.profiles.find((candidate) => candidate.id === message.providerId);
    if (profile === undefined) return protocolError("INVALID_MESSAGE", "The selected provider profile is not configured.");
    return {
      type: "background:provider-classifier-readiness",
      protocolVersion: PROTOCOL_VERSION,
      result: await testProviderClassifierReadiness(profile),
    };
  } catch {
    return protocolError("PROVIDER_FAILURE", "Unable to test provider classifier readiness.");
  }
}

async function handleProviderProfileRemove(message: PanelProviderProfileRemove, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may change provider settings.");
  try {
    return providerResponse(await monitoring.removeProviderProfile(message.providerId));
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to remove provider profile.");
  }
}

async function handleProviderOrderUpdate(message: PanelProviderOrderUpdate, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may change provider settings.");
  try {
    return providerResponse(await monitoring.updateProviderOrder(message.order));
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist provider priority.");
  }
}

async function handleHistoryClear(sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may clear monitoring history.");
  try {
    await monitoring.clearHistory();
    const response: HistoryClearResponse = { type: "background:history-cleared", protocolVersion: PROTOCOL_VERSION };
    return response;
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to clear monitoring history.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isContentHello(message)) { void handleContentHello(message, sender).then(sendResponse); return true; }
  if (isContentNavigation(message)) { void handleNavigation(message, sender).then(sendResponse); return true; }
  if (isContentObservation(message)) { void handleObservation(message, sender).then(sendResponse); return true; }
  if (isContentUserInteraction(message)) { void handleInteraction(message, sender).then(sendResponse); return true; }
  if (isPanelStatusRequest(message)) { void handlePanelStatusRequest(message.tabId, sender).then(sendResponse); return true; }
  if (isPanelOverviewRequest(message)) { void handleOverview(sender).then(sendResponse); return true; }
  if (isPanelMonitoringPolicyUpdate(message)) { void handleMonitoringPolicyUpdate(message, sender).then(sendResponse); return true; }
  if (isPanelMonitoringDefaultsUpdate(message)) { void handleMonitoringDefaultsUpdate(message, sender).then(sendResponse); return true; }
  if (isPanelMonitoringChatsReset(message)) { void handleMonitoringChatsReset(sender).then(sendResponse); return true; }
  if (isPanelProviderProfileUpsert(message)) { void handleProviderProfileUpsert(message, sender).then(sendResponse); return true; }
  if (isPanelProviderModelCatalogRequest(message)) { void handleProviderModelCatalog(message, sender).then(sendResponse); return true; }
  if (isPanelProviderClassifierReadinessRequest(message)) { void handleProviderClassifierReadiness(message, sender).then(sendResponse); return true; }
  if (isPanelProviderProfileRemove(message)) { void handleProviderProfileRemove(message, sender).then(sendResponse); return true; }
  if (isPanelProviderOrderUpdate(message)) { void handleProviderOrderUpdate(message, sender).then(sendResponse); return true; }
  if (isPanelHistoryClear(message)) { void handleHistoryClear(sender).then(sendResponse); return true; }
  return false;
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const event = monitoring.history(200).find((candidate) => candidate.id === notificationId);
  if (event === undefined) return;
  void chrome.tabs.get(event.tabId).then(async (tab) => {
    if (tab.windowId !== undefined) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* stale window */ }
    }
    try { await chrome.tabs.update(event.tabId, { active: true }); } catch { /* stale tab */ }
  }).catch(() => undefined);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void registryReady.then(async () => {
    const session = registry.getTab(activeInfo.tabId);
    await recordBackgroundMonitoringDiagnostic({
      kind: "TAB_ACTIVATED",
      activeTabId: activeInfo.tabId,
      conversationId: session?.conversationId,
    });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void mutateTabLifecycle(tabId, "remove");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void mutateTabLifecycle(tabId, "invalidate");
    return;
  }
  if (changeInfo.status === "complete") {
    void requestContentAgentReconnect(tabId);
  }
});