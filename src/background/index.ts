import {
  PROTOCOL_VERSION,
  isContentHello,
  isContentNavigation,
  isContentObservation,
  isContentUserInteraction,
  isPanelStatusRequest,
  type ContentAgentAck,
  type ContentHello,
  type ContentNavigation,
  type ContentObservation,
  type ContentUserInteraction,
  type GuardianResponse,
  type PanelStatusResponse,
  type ProtocolErrorResponse,
} from "../shared/protocol.js";
import {
  SessionRegistry,
  type SessionMutationResult,
  type SessionRegistryState,
} from "../core/session-registry.js";
import { createEphemeralStorage } from "../storage/index.js";

const REGISTRY_KEY = "runtime";
const registryStorage = createEphemeralStorage<SessionRegistryState>("session-registry");
let registry = new SessionRegistry();
let mutationQueue: Promise<void> = Promise.resolve();

const registryReady = registryStorage.get(REGISTRY_KEY).then((state) => {
  registry = SessionRegistry.fromState(state, { invalidateObservations: true });
});

function protocolError(code: ProtocolErrorResponse["code"], message: string): ProtocolErrorResponse {
  return { type: "background:error", protocolVersion: PROTOCOL_VERSION, code, message };
}

function senderIdentity(
  sender: chrome.runtime.MessageSender,
): { tabId: number; documentId: string } | undefined {
  const tabId = sender.tab?.id;
  const documentId = sender.documentId;
  if (tabId === undefined || documentId === undefined || documentId.length === 0) return undefined;
  return { tabId, documentId };
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function mutateRegistry(
  operation: (current: SessionRegistry) => SessionMutationResult,
): Promise<SessionMutationResult> {
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

function acceptedAck(
  tabId: number,
  documentId: string,
  result: Extract<SessionMutationResult, { accepted: true }>,
): ContentAgentAck {
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

async function handleContentHello(
  message: ContentHello,
  sender: chrome.runtime.MessageSender,
): Promise<GuardianResponse> {
  const identity = senderIdentity(sender);
  if (identity === undefined) {
    return protocolError("INVALID_SENDER", "Content message has no exact tab/document identity.");
  }

  try {
    const result = await mutateRegistry((current) =>
      current.registerAgent({
        ...identity,
        agentInstanceId: message.agentInstanceId,
        pageEpoch: message.pageEpoch,
        sequence: message.sequence,
        routeKey: message.routeKey,
        ...(message.conversationId === undefined ? {} : { conversationId: message.conversationId }),
        sentAt: message.sentAt,
      }),
    );
    return result.accepted ? acceptedAck(identity.tabId, identity.documentId, result) : staleEvent(result.reason);
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist content-agent registration.");
  }
}

async function handleNavigation(
  message: ContentNavigation,
  sender: chrome.runtime.MessageSender,
): Promise<GuardianResponse> {
  const identity = senderIdentity(sender);
  if (identity === undefined) return protocolError("INVALID_SENDER", "Navigation event has no exact tab/document identity.");

  try {
    const result = await mutateRegistry((current) =>
      current.applyNavigation({
        ...identity,
        agentInstanceId: message.agentInstanceId,
        pageEpoch: message.pageEpoch,
        sequence: message.sequence,
        routeKey: message.routeKey,
        ...(message.conversationId === undefined ? {} : { conversationId: message.conversationId }),
        sentAt: message.sentAt,
      }),
    );
    return result.accepted ? acceptedAck(identity.tabId, identity.documentId, result) : staleEvent(result.reason);
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist navigation state.");
  }
}

async function handleObservation(
  message: ContentObservation,
  sender: chrome.runtime.MessageSender,
): Promise<GuardianResponse> {
  const identity = senderIdentity(sender);
  if (identity === undefined) return protocolError("INVALID_SENDER", "Observation event has no exact tab/document identity.");

  try {
    const result = await mutateRegistry((current) =>
      current.applyObservation({
        ...identity,
        agentInstanceId: message.agentInstanceId,
        pageEpoch: message.pageEpoch,
        sequence: message.sequence,
        observation: message.observation,
        sentAt: message.sentAt,
      }),
    );
    return result.accepted ? acceptedAck(identity.tabId, identity.documentId, result) : staleEvent(result.reason);
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist observation state.");
  }
}

async function handleInteraction(
  message: ContentUserInteraction,
  sender: chrome.runtime.MessageSender,
): Promise<GuardianResponse> {
  const identity = senderIdentity(sender);
  if (identity === undefined) return protocolError("INVALID_SENDER", "Interaction event has no exact tab/document identity.");

  try {
    const result = await mutateRegistry((current) =>
      current.applyInteraction({
        ...identity,
        agentInstanceId: message.agentInstanceId,
        pageEpoch: message.pageEpoch,
        sequence: message.sequence,
        sentAt: message.sentAt,
      }),
    );
    return result.accepted ? acceptedAck(identity.tabId, identity.documentId, result) : staleEvent(result.reason);
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to persist user-interaction state.");
  }
}

async function handlePanelStatusRequest(tabId: number): Promise<GuardianResponse> {
  try {
    await registryReady;
    await mutationQueue;
    const session = registry.getTab(tabId);
    const response: PanelStatusResponse = {
      type: "background:status",
      protocolVersion: PROTOCOL_VERSION,
      tabId,
      connected: session !== undefined,
      ...(session === undefined
        ? {}
        : {
            documentId: session.documentId,
            ...(session.conversationId === undefined ? {} : { conversationId: session.conversationId }),
            controlEligibility: session.controlEligibility,
            session,
            lastSeenAt: session.lastSeenAt,
          }),
    };
    return response;
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to read session state.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isContentHello(message)) {
    void handleContentHello(message, sender).then(sendResponse);
    return true;
  }
  if (isContentNavigation(message)) {
    void handleNavigation(message, sender).then(sendResponse);
    return true;
  }
  if (isContentObservation(message)) {
    void handleObservation(message, sender).then(sendResponse);
    return true;
  }
  if (isContentUserInteraction(message)) {
    void handleInteraction(message, sender).then(sendResponse);
    return true;
  }
  if (isPanelStatusRequest(message)) {
    void handlePanelStatusRequest(message.tabId).then(sendResponse);
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void mutateTabLifecycle(tabId, "remove").catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void mutateTabLifecycle(tabId, "invalidate").catch(() => undefined);
  }
});
