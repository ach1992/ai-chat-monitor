import type { ChatAutomationMode } from "../automation/types.js";

export interface CurrentTabChat {
  tabId: number;
  conversationId?: string;
  routeKey: string;
  lastSeenAt: number;
}

export interface CurrentTabAgentProbe {
  conversationId?: string;
  routeKey: string;
}

export interface CurrentTabConnectionGateway<TChat extends CurrentTabChat> {
  now(): number;
  probe(tabId: number): Promise<CurrentTabAgentProbe | undefined>;
  requestReconnect(tabId: number): Promise<boolean>;
  reload(tabId: number): Promise<void>;
  readChat(tabId: number): Promise<TChat | undefined>;
  wait(delayMs: number): Promise<void>;
}

export interface CurrentTabConnectionOptions {
  attempts?: number;
  intervalMs?: number;
  expectedRouteKey?: string;
}

export interface CurrentTabUpdateSignal {
  status?: string;
  url?: string;
}

export function supportedChatGptRouteKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com")) return undefined;
    const normalized = url.pathname.replace(/\/+$/, "");
    return normalized.length === 0 ? "/" : normalized;
  } catch {
    return undefined;
  }
}

export function isSupportedChatGptUrl(value: string | undefined): boolean {
  return supportedChatGptRouteKey(value) !== undefined;
}

export function currentTabRouteMatchesChat(
  chat: CurrentTabChat | undefined,
  routeKey: string | undefined,
): boolean {
  return chat?.conversationId !== undefined && routeKey !== undefined && chat.routeKey === routeKey;
}

export function currentTabIdentityMatches(
  chat: CurrentTabChat | undefined,
  probe: CurrentTabAgentProbe | undefined,
): boolean {
  return (
    chat?.conversationId !== undefined &&
    probe?.conversationId !== undefined &&
    chat.conversationId === probe.conversationId &&
    chat.routeKey === probe.routeKey
  );
}

export function desiredCurrentTabMode(currentMode: ChatAutomationMode, enabled: boolean): ChatAutomationMode {
  if (!enabled) return "OFF";
  return currentMode === "OFF" ? "OBSERVE" : currentMode;
}

export function shouldRefreshCurrentTabForUpdate(
  activeTabId: number | undefined,
  updatedTabId: number,
  changeInfo: CurrentTabUpdateSignal,
): boolean {
  return activeTabId === updatedTabId && (changeInfo.status !== undefined || changeInfo.url !== undefined);
}

function sameRecoveryIntent(
  probe: CurrentTabAgentProbe | undefined,
  expectedRouteKey: string | undefined,
  expectedConversationId: string | undefined,
): boolean {
  if (probe === undefined) return false;
  if (expectedRouteKey !== undefined && probe.routeKey !== expectedRouteKey) return false;
  if (expectedConversationId !== undefined && probe.conversationId !== expectedConversationId) return false;
  return true;
}

export async function ensureCurrentTabConnected<TChat extends CurrentTabChat>(
  gateway: CurrentTabConnectionGateway<TChat>,
  tabId: number,
  options: CurrentTabConnectionOptions = {},
): Promise<TChat> {
  const attempts = options.attempts ?? 30;
  const intervalMs = options.intervalMs ?? 300;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("Reconnect attempts must be a positive integer.");
  if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error("Reconnect interval must be a non-negative integer.");

  const existing = await gateway.readChat(tabId);
  const initialProbe = await gateway.probe(tabId);
  const expectedRouteKey = options.expectedRouteKey ?? initialProbe?.routeKey;
  const expectedConversationId = initialProbe?.conversationId;
  if (initialProbe !== undefined && !sameRecoveryIntent(initialProbe, expectedRouteKey, expectedConversationId)) {
    throw new Error("The ChatGPT tab navigated before Guardian could start the requested action.");
  }
  if (currentTabIdentityMatches(existing, initialProbe) && sameRecoveryIntent(initialProbe, expectedRouteKey, expectedConversationId)) {
    return existing as TChat;
  }

  const recoveryStartedAt = gateway.now();
  if (initialProbe !== undefined) {
    const requested = await gateway.requestReconnect(tabId);
    if (!requested) throw new Error("The ChatGPT content agent did not accept the reconnect request.");
  } else {
    await gateway.reload(tabId);
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const chat = await gateway.readChat(tabId);
    const probe = await gateway.probe(tabId);
    if (probe !== undefined && !sameRecoveryIntent(probe, expectedRouteKey, expectedConversationId)) {
      throw new Error("The ChatGPT tab navigated while Guardian was recovering it. No policy change was applied.");
    }
    if (
      chat?.conversationId !== undefined &&
      chat.lastSeenAt >= recoveryStartedAt &&
      currentTabIdentityMatches(chat, probe) &&
      sameRecoveryIntent(probe, expectedRouteKey, expectedConversationId)
    ) {
      return chat;
    }
    if (attempt + 1 < attempts) await gateway.wait(intervalMs);
  }

  throw new Error("ChatGPT did not reconnect to Guardian after the recovery action.");
}
