import type { ChatAutomationMode } from "../automation/types.js";

export interface CurrentTabChat {
  tabId: number;
  conversationId?: string;
  lastSeenAt: number;
}

export interface CurrentTabConnectionGateway<TChat extends CurrentTabChat> {
  now(): number;
  probe(tabId: number): Promise<boolean>;
  requestReconnect(tabId: number): Promise<boolean>;
  reload(tabId: number): Promise<void>;
  readChat(tabId: number): Promise<TChat | undefined>;
  wait(delayMs: number): Promise<void>;
}

export interface CurrentTabConnectionOptions {
  attempts?: number;
  intervalMs?: number;
}

export interface CurrentTabUpdateSignal {
  status?: string;
  url?: string;
}

export function isSupportedChatGptUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com");
  } catch {
    return false;
  }
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
  const reachable = await gateway.probe(tabId);
  if (reachable && existing?.conversationId !== undefined) return existing;

  const recoveryStartedAt = gateway.now();
  if (reachable) {
    const requested = await gateway.requestReconnect(tabId);
    if (!requested) throw new Error("The ChatGPT content agent did not accept the reconnect request.");
  } else {
    await gateway.reload(tabId);
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const chat = await gateway.readChat(tabId);
    if (chat?.conversationId !== undefined && chat.lastSeenAt >= recoveryStartedAt) return chat;
    if (attempt + 1 < attempts) await gateway.wait(intervalMs);
  }

  throw new Error("ChatGPT did not reconnect to Guardian after the recovery action.");
}
