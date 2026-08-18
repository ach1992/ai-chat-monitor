import {
  PROTOCOL_VERSION,
  isContentHello,
  isPanelStatusRequest,
  type ContentHelloAck,
  type GuardianResponse,
  type PanelStatusResponse,
  type ProtocolErrorResponse,
} from "../shared/protocol.js";
import { createEphemeralStorage } from "../storage/index.js";

interface AgentPresence {
  tabId: number;
  documentId?: string;
  lastSeenAt: number;
}

const presenceStorage = createEphemeralStorage<AgentPresence>("presence");

function storageKey(tabId: number): string {
  return `tab-${tabId}`;
}

function protocolError(
  code: ProtocolErrorResponse["code"],
  message: string,
): ProtocolErrorResponse {
  return {
    type: "background:error",
    protocolVersion: PROTOCOL_VERSION,
    code,
    message,
  };
}

async function handleContentHello(
  sender: chrome.runtime.MessageSender,
): Promise<GuardianResponse> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return protocolError("INVALID_SENDER", "Content message has no browser tab identity.");
  }

  const presence: AgentPresence = {
    tabId,
    lastSeenAt: Date.now(),
    ...(sender.documentId === undefined ? {} : { documentId: sender.documentId }),
  };

  try {
    await presenceStorage.set(storageKey(tabId), presence);
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to record content-agent presence.");
  }

  const response: ContentHelloAck = {
    type: "background:hello-ack",
    protocolVersion: PROTOCOL_VERSION,
    tabId,
    ...(presence.documentId === undefined
      ? {}
      : { documentId: presence.documentId }),
  };

  return response;
}

async function handlePanelStatusRequest(tabId: number): Promise<GuardianResponse> {
  try {
    const presence = await presenceStorage.get(storageKey(tabId));
    const response: PanelStatusResponse = {
      type: "background:status",
      protocolVersion: PROTOCOL_VERSION,
      tabId,
      connected: presence !== undefined,
      ...(presence?.documentId === undefined
        ? {}
        : { documentId: presence.documentId }),
      ...(presence === undefined ? {} : { lastSeenAt: presence.lastSeenAt }),
    };

    return response;
  } catch {
    return protocolError("STORAGE_FAILURE", "Unable to read content-agent presence.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isContentHello(message)) {
    void handleContentHello(sender).then(sendResponse);
    return true;
  }

  if (isPanelStatusRequest(message)) {
    void handlePanelStatusRequest(message.tabId).then(sendResponse);
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void presenceStorage.remove(storageKey(tabId)).catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void presenceStorage.remove(storageKey(tabId)).catch(() => undefined);
  }
});
