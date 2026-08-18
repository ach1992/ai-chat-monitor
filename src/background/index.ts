import {
  PROTOCOL_VERSION,
  isContentHello,
  isContentNavigation,
  isContentObservation,
  isContentUserInteraction,
  isPanelAutomationDefaultsUpdate,
  isPanelAutomationPolicyUpdate,
  isPanelEmergencyPauseUpdate,
  isPanelStatusRequest,
  type AutomationPolicyResponse,
  type ContentAgentAck,
  type ContentHello,
  type ContentNavigation,
  type ContentObservation,
  type ContentUserInteraction,
  type GuardianResponse,
  type PanelAutomationDefaultsUpdate,
  type PanelAutomationPolicyUpdate,
  type PanelEmergencyPauseUpdate,
  type PanelStatusResponse,
  type ProtocolErrorResponse,
} from "../shared/protocol.js";
import {
  SessionRegistry,
  type SessionMutationResult,
  type SessionRegistryState,
} from "../core/session-registry.js";
import {
  createEphemeralStorage,
  restrictDurableStorageToTrustedContexts,
} from "../storage/index.js";
import { AutomationService } from "./automation-service.js";

const REGISTRY_KEY = "runtime";
const registryStorage = createEphemeralStorage<SessionRegistryState>("session-registry");
let registry = new SessionRegistry();
let mutationQueue: Promise<void> = Promise.resolve();

const durableStorageReady = restrictDurableStorageToTrustedContexts();
const automation = new AutomationService((tabId) => registry.getTab(tabId), durableStorageReady);
const registryReady = Promise.all([
  durableStorageReady,
  registryStorage.get(REGISTRY_KEY),
]).then(([, state]) => {
  registry = SessionRegistry.fromState(state, { invalidateObservations: true });
});

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
    await automation.invalidateTab(identity.tabId, "Content-agent registration changed; fresh observation is required.");
    await automation.handleSession(result.session);
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
    await automation.invalidateTab(identity.tabId, "Navigation changed the page identity; pending automation was cancelled.");
    await automation.handleSession(result.session);
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
    if (!result.accepted) return staleEvent(result.reason);
    await automation.handleSession(result.session);
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
    if (!result.accepted) return staleEvent(result.reason);
    await automation.handleHumanInteraction(result.session);
    return acceptedAck(identity.tabId, identity.documentId, result);
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist user-interaction state.");
  }
}

async function handlePanelStatusRequest(tabId: number): Promise<GuardianResponse> {
  try {
    await registryReady;
    await mutationQueue;
    await automation.ready();
    const session = registry.getTab(tabId);
    const automationStatus = await automation.status(tabId);
    const response: PanelStatusResponse = {
      type: "background:status",
      protocolVersion: PROTOCOL_VERSION,
      tabId,
      connected: session !== undefined,
      ...(session === undefined ? {} : {
        documentId: session.documentId,
        ...(session.conversationId === undefined ? {} : { conversationId: session.conversationId }),
        controlEligibility: session.controlEligibility,
        session,
        lastSeenAt: session.lastSeenAt,
      }),
      ...(automationStatus.policy === undefined ? {} : { automationPolicy: automationStatus.policy }),
      ...(automationStatus.runtime === undefined ? {} : { automationRuntime: automationStatus.runtime }),
    };
    return response;
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to read session/automation state.");
  }
}

function policyResponse(tabId?: number): AutomationPolicyResponse {
  const state = automation.policySnapshot();
  return {
    type: "background:automation-policy",
    protocolVersion: PROTOCOL_VERSION,
    revision: state.revision,
    emergencyPaused: state.emergencyPaused,
    ...(tabId === undefined ? {} : { tabId }),
  };
}

async function handlePolicyUpdate(message: PanelAutomationPolicyUpdate, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may change automation policy.");
  try {
    await registryReady;
    await mutationQueue;
    const current = registry.getTab(message.tabId);
    if (current?.conversationId !== message.conversationId) {
      return protocolError("INVALID_MESSAGE", "Tab conversation identity changed before the policy update.");
    }
    const policy = await automation.updateChat(message.tabId, message.conversationId, message.patch);
    const status = await automation.status(message.tabId);
    const response = policyResponse(message.tabId);
    response.policy = policy;
    if (status.runtime !== undefined) response.runtime = status.runtime;
    return response;
  } catch {
    const current = registry.getTab(message.tabId);
    if (current?.conversationId !== message.conversationId) {
      return protocolError("INVALID_MESSAGE", "Tab conversation identity changed before the policy update.");
    }
    return protocolError("STORAGE_FAILURE", "Unable to persist chat automation policy.");
  }
}

async function handleDefaultsUpdate(message: PanelAutomationDefaultsUpdate, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may change automation defaults.");
  try {
    await automation.updateDefaults(message.patch);
    return policyResponse();
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist automation defaults.");
  }
}

async function handleEmergencyPauseUpdate(message: PanelEmergencyPauseUpdate, sender: chrome.runtime.MessageSender): Promise<GuardianResponse> {
  if (!trustedExtensionSender(sender)) return protocolError("INVALID_SENDER", "Only trusted extension pages may change emergency pause.");
  try {
    await automation.setEmergencyPaused(message.paused);
    return policyResponse();
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist emergency-pause state.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isContentHello(message)) { void handleContentHello(message, sender).then(sendResponse); return true; }
  if (isContentNavigation(message)) { void handleNavigation(message, sender).then(sendResponse); return true; }
  if (isContentObservation(message)) { void handleObservation(message, sender).then(sendResponse); return true; }
  if (isContentUserInteraction(message)) { void handleInteraction(message, sender).then(sendResponse); return true; }
  if (isPanelStatusRequest(message)) { void handlePanelStatusRequest(message.tabId).then(sendResponse); return true; }
  if (isPanelAutomationPolicyUpdate(message)) { void handlePolicyUpdate(message, sender).then(sendResponse); return true; }
  if (isPanelAutomationDefaultsUpdate(message)) { void handleDefaultsUpdate(message, sender).then(sendResponse); return true; }
  if (isPanelEmergencyPauseUpdate(message)) { void handleEmergencyPauseUpdate(message, sender).then(sendResponse); return true; }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void Promise.allSettled([
    mutateTabLifecycle(tabId, "remove"),
    automation.invalidateTab(tabId, "Tab closed; pending automation was cancelled."),
  ]);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void Promise.allSettled([
      mutateTabLifecycle(tabId, "invalidate"),
      automation.invalidateTab(tabId, "Top-level loading invalidated pending automation."),
    ]);
  }
});