import {
  PROTOCOL_VERSION,
  type GuardianResponse,
  type ManagedChatStatus,
  type PanelAutomationPolicyUpdate,
  type PanelOverviewRequest,
  type PanelOverviewResponse,
} from "../shared/protocol.js";
import {
  currentTabIdentityMatches,
  currentTabRouteMatchesChat,
  directCurrentTabMode,
  desiredCurrentTabMode,
  ensureCurrentTabConnected,
  shouldRefreshCurrentTabForUpdate,
  supportedChatGptRouteKey,
} from "./current-tab.js";

type AgentProbeResponse = {
  type: "content:agent-probe";
  protocolVersion: typeof PROTOCOL_VERSION;
  agentInstanceId: string;
  pageEpoch: number;
  routeKey: string;
  conversationId?: string;
};

type AgentReconnectResponse = {
  type: "content:agent-reconnected";
  protocolVersion: typeof PROTOCOL_VERSION;
  accepted: boolean;
};

interface CurrentTabState {
  tab: chrome.tabs.Tab | undefined;
  overview: PanelOverviewResponse;
  chat: ManagedChatStatus | undefined;
  routeKey: string | undefined;
  agentReachable: boolean;
  identityCurrent: boolean;
}

function q<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Side panel markup is missing required element: ${selector}`);
  return element;
}

function e<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function badge(parent: Element, text: string, tone?: "ok" | "warn"): void {
  const item = e("span", "badge", text);
  if (tone !== undefined) item.dataset.tone = tone;
  parent.append(item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgentProbeResponse(value: unknown): value is AgentProbeResponse {
  if (!isRecord(value)) return false;
  return (
    value.type === "content:agent-probe" &&
    value.protocolVersion === PROTOCOL_VERSION &&
    typeof value.agentInstanceId === "string" &&
    Number.isInteger(value.pageEpoch) &&
    typeof value.routeKey === "string" &&
    (value.conversationId === undefined || typeof value.conversationId === "string")
  );
}

function isAgentReconnectResponse(value: unknown): value is AgentReconnectResponse {
  return isRecord(value) && value.type === "content:agent-reconnected" && value.protocolVersion === PROTOCOL_VERSION && typeof value.accepted === "boolean";
}

const root = q<HTMLElement>("[data-current-tab-live]");
const statusElement = q<HTMLElement>("[data-status]");
const detailsElement = q<HTMLElement>("[data-details]");
const refreshButton = q<HTMLButtonElement>("[data-refresh]");
let activeTabId: number | undefined;
let currentTabBusy = false;
let refreshPromise: Promise<void> | undefined;
let refreshSerial = 0;

function status(message: string, details: string): void {
  statusElement.textContent = message;
  detailsElement.textContent = details;
}

function requireSuccess(response: GuardianResponse): GuardianResponse {
  if (response.type === "background:error") throw new Error(response.message);
  return response;
}

async function loadOverview(): Promise<PanelOverviewResponse> {
  const request: PanelOverviewRequest = { type: "panel:overview-request", protocolVersion: PROTOCOL_VERSION };
  const response = requireSuccess(await chrome.runtime.sendMessage<GuardianResponse>(request));
  if (response.type !== "background:overview") throw new Error("The service worker returned an unexpected overview response.");
  return response;
}

async function readManagedChat(tabId: number): Promise<ManagedChatStatus | undefined> {
  const response = await loadOverview();
  return response.chats.find((candidate) => candidate.tabId === tabId);
}

async function probeContentAgent(tabId: number): Promise<AgentProbeResponse | undefined> {
  try {
    const response = await chrome.tabs.sendMessage<unknown>(tabId, {
      type: "panel:agent-probe",
      protocolVersion: PROTOCOL_VERSION,
    });
    return isAgentProbeResponse(response) ? response : undefined;
  } catch {
    return undefined;
  }
}

async function requestContentAgentReconnect(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage<unknown>(tabId, {
      type: "panel:agent-reconnect",
      protocolVersion: PROTOCOL_VERSION,
    });
    return isAgentReconnectResponse(response) && response.accepted;
  } catch {
    return false;
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

async function ensureConnected(tabId: number, expectedRouteKey: string): Promise<ManagedChatStatus> {
  return ensureCurrentTabConnected({
    now: Date.now,
    probe: probeContentAgent,
    requestReconnect: requestContentAgentReconnect,
    reload: (targetTabId) => chrome.tabs.reload(targetTabId),
    readChat: readManagedChat,
    wait,
  }, tabId, { expectedRouteKey });
}

async function updateCurrentTabMode(
  tabId: number,
  conversationId: string,
  mode: "OFF" | "OBSERVE" | "AUTO" | "NOTIFY_ONLY",
): Promise<void> {
  const request: PanelAutomationPolicyUpdate = {
    type: "panel:automation-policy-update",
    protocolVersion: PROTOCOL_VERSION,
    tabId,
    conversationId,
    patch: { mode },
  };
  requireSuccess(await chrome.runtime.sendMessage<GuardianResponse>(request));
}

function primaryProviderText(overview: PanelOverviewResponse): string {
  const primaryId = overview.providers.order[0];
  if (primaryId === undefined) return "No AI provider configured";
  const profile = overview.providers.profiles.find((candidate) => candidate.id === primaryId);
  return profile === undefined ? `Provider ${primaryId} is missing` : `${profile.id} - ${profile.model}`;
}

function shortId(value: string | undefined): string {
  if (value === undefined) return "identity pending";
  return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function currentTitle(state: CurrentTabState): string {
  const title = state.tab?.title?.trim();
  if (title !== undefined && title.length > 0) return title;
  const pageTitle = state.chat?.pageTitle?.trim();
  if (pageTitle !== undefined && pageTitle.length > 0) return pageTitle;
  return "Current ChatGPT tab";
}

function modeLabel(mode: string): string {
  if (mode === "OBSERVE") return "Observe";
  if (mode === "AUTO") return "Auto";
  if (mode === "NOTIFY_ONLY") return "Notify only";
  return "Off";
}

function clearStaleFailureIfRecovered(overview: PanelOverviewResponse, identityCurrent: boolean): void {
  if (!identityCurrent) return;
  const currentStatus = statusElement.textContent ?? "";
  if (currentStatus !== "Current-tab update failed." && currentStatus !== "Reconnect failed.") return;
  const managed = overview.chats.filter((chat) => chat.policy?.mode !== undefined && chat.policy.mode !== "OFF").length;
  status(
    overview.emergencyPaused ? "All automatic sends are paused." : "Guardian is ready.",
    `${managed} managed of ${overview.chats.length} connected chat tab${overview.chats.length === 1 ? "" : "s"}.`,
  );
}

function renderCurrentTab(state: CurrentTabState): void {
  root.replaceChildren();
  const tabId = state.tab?.id;
  if (tabId === undefined) {
    root.className = "empty-state";
    root.textContent = "No active browser tab is available.";
    return;
  }
  const routeKey = state.routeKey;
  if (routeKey === undefined) {
    root.className = "current-card current-card-primary";
    root.append(
      e("strong", "guardian-state", "Guardian unavailable"),
      e("div", "reason", "Open a supported ChatGPT tab (chatgpt.com or chat.openai.com) to manage supervision here."),
    );
    return;
  }

  const chat = state.chat;
  const routeStateCurrent = currentTabRouteMatchesChat(chat, routeKey);
  const mode = routeStateCurrent ? (chat?.policy?.mode ?? "OFF") : "OFF";
  const enabled = mode !== "OFF";
  const currentConversationId = routeStateCurrent ? chat?.conversationId : undefined;
  root.className = "current-card current-card-primary";
  root.dataset.enabled = String(enabled);

  const head = e("div", "chat-card-head");
  const title = e("div", "title-block");
  title.append(
    e("h3", "chat-title", currentTitle(state)),
    e("div", "meta", `Tab ${tabId} - ${shortId(currentConversationId)}`),
  );
  const stateBlock = e("div", "guardian-state-block");
  const stateText = e("strong", "guardian-state", enabled ? "Guardian ON" : "Guardian OFF");
  stateText.dataset.enabled = String(enabled);
  stateBlock.append(stateText, e("span", "meta", enabled ? `${modeLabel(mode)} mode` : "No supervision"));
  head.append(title, stateBlock);

  const connection = e("div", "current-connection");
  if (state.identityCurrent) {
    connection.append(e("strong", undefined, "Connected"), e("span", "meta", "Content-agent and registry identities match this exact route and conversation."));
  } else if (state.agentReachable) {
    connection.append(e("strong", undefined, "Identity reconnect needed"), e("span", "meta", "The content agent is live, but its route/conversation identity does not match the last registered state."));
  } else {
    connection.append(e("strong", undefined, "Reconnect needed"), e("span", "meta", "One action can reload this ChatGPT tab and restore the content agent."));
  }

  const meta = e("div", "meta-row");
  badge(meta, modeLabel(mode), mode === "AUTO" ? "ok" : undefined);
  if (chat !== undefined && state.identityCurrent) {
    badge(meta, chat.controlEligibility, chat.controlEligibility === "OWNER" ? "ok" : "warn");
    if (chat.runtime !== undefined) badge(meta, chat.runtime.phase, chat.runtime.phase === "AMBIGUOUS_WRITE" ? "warn" : undefined);
    if (chat.runtime?.lastDecision !== undefined) badge(meta, `Decision: ${chat.runtime.lastDecision.decision}`);
  } else if (routeStateCurrent) {
    badge(meta, "Agent stale", "warn");
  } else if (chat !== undefined) {
    badge(meta, "Previous identity stale", "warn");
  }

  const actions = e("div", "current-actions");
  const toggle = e("button", enabled ? "secondary" : undefined, enabled ? "Turn Guardian OFF" : "Turn Guardian ON");
  toggle.type = "button";
  toggle.disabled = currentTabBusy;
  toggle.setAttribute("aria-pressed", String(enabled));
  toggle.addEventListener("click", () => {
    void setCurrentTabEnabled(tabId, !enabled, routeKey, currentConversationId, mode, state.identityCurrent);
  });
  actions.append(toggle);
  if (enabled && !state.identityCurrent) {
    const reconnect = e("button", "secondary", "Reconnect");
    reconnect.type = "button";
    reconnect.disabled = currentTabBusy;
    reconnect.addEventListener("click", () => { void recoverCurrentTab(tabId, routeKey); });
    actions.append(reconnect);
  }

  const advanced = e("div", "current-help");
  advanced.append(
    e("strong", undefined, "Advanced modes stay available."),
    document.createTextNode(" Use Open ChatGPT chats below to choose OBSERVE, AUTO, or NOTIFY_ONLY and per-chat overrides. Turning ON from OFF starts safely in OBSERVE."),
  );

  root.append(head, connection, meta);
  if (state.identityCurrent && chat?.controlEligibility === "MIRROR") {
    root.append(e("div", "reason", "This is a MIRROR of the same conversation. Automated control remains isolated to the OWNER tab."));
  } else if (state.identityCurrent && chat?.controlEligibility === "NONE") {
    root.append(e("div", "reason", "This tab is not currently eligible for automated control."));
  }
  if (state.identityCurrent && chat?.runtime?.reason !== undefined) root.append(e("div", "reason", chat.runtime.reason));
  root.append(e("div", "meta", primaryProviderText(state.overview)), actions, advanced);
}

async function setCurrentTabEnabled(
  tabId: number,
  enabled: boolean,
  expectedRouteKey: string,
  knownConversationId: string | undefined,
  knownMode: "OFF" | "OBSERVE" | "AUTO" | "NOTIFY_ONLY",
  identityCurrent: boolean,
): Promise<void> {
  if (currentTabBusy) return;
  currentTabBusy = true;
  status(enabled ? "Turning Guardian ON..." : "Turning Guardian OFF...", "Current conversation identity is revalidated before the policy changes.");
  try {
    const directMode = directCurrentTabMode(knownMode, enabled, identityCurrent, knownConversationId);
    if (directMode !== undefined && knownConversationId !== undefined) {
      if (directMode !== knownMode) await updateCurrentTabMode(tabId, knownConversationId, directMode);
      status(
        enabled ? "Guardian is ON for this tab." : "Guardian is OFF for this tab.",
        enabled ? `Mode: ${modeLabel(directMode)}. Advanced modes remain per-conversation.` : "Supervision is disabled for this conversation.",
      );
      return;
    }

    const chat = await ensureConnected(tabId, expectedRouteKey);
    if (chat.conversationId === undefined) throw new Error("ChatGPT has not exposed a stable conversation identity yet.");
    const currentMode = chat.policy?.mode ?? "OFF";
    const desiredMode = desiredCurrentTabMode(currentMode, enabled);
    if (desiredMode !== currentMode) await updateCurrentTabMode(tabId, chat.conversationId, desiredMode);
    status(enabled ? "Guardian is ON for this tab." : "Guardian is OFF for this tab.", enabled ? `Mode: ${modeLabel(desiredMode)}. Advanced modes remain per-conversation.` : "Supervision is disabled for this conversation.");
  } catch (error) {
    status("Current-tab update failed.", error instanceof Error ? error.message : "Guardian could not recover the current ChatGPT tab.");
  } finally {
    currentTabBusy = false;
    await refreshCurrentTab(true);
  }
}

async function recoverCurrentTab(tabId: number, expectedRouteKey: string): Promise<void> {
  if (currentTabBusy) return;
  currentTabBusy = true;
  status("Reconnecting current ChatGPT tab...", "Guardian will use the live content agent when possible, otherwise it reloads this tab once and waits for a fresh identity.");
  try {
    await ensureConnected(tabId, expectedRouteKey);
    status("Current ChatGPT tab reconnected.", "The tab is reporting fresh Guardian state again.");
  } catch (error) {
    status("Reconnect failed.", error instanceof Error ? error.message : "Guardian could not recover the current ChatGPT tab.");
  } finally {
    currentTabBusy = false;
    await refreshCurrentTab(true);
  }
}

async function doRefreshCurrentTab(serial: number): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id;
    const overview = await loadOverview();
    const chat = activeTabId === undefined ? undefined : overview.chats.find((candidate) => candidate.tabId === activeTabId);
    const routeKey = supportedChatGptRouteKey(tab?.url);
    const probe = routeKey !== undefined && activeTabId !== undefined ? await probeContentAgent(activeTabId) : undefined;
    const identityCurrent = currentTabIdentityMatches(chat, probe);
    if (serial === refreshSerial) {
      renderCurrentTab({ tab, overview, chat, routeKey, agentReachable: probe !== undefined, identityCurrent });
      clearStaleFailureIfRecovered(overview, identityCurrent);
    }
  } catch (error) {
    if (serial === refreshSerial) {
      root.className = "current-card current-card-primary";
      root.replaceChildren(
        e("strong", "guardian-state", "Guardian status unavailable"),
        e("div", "reason", error instanceof Error ? error.message : "The current-tab status could not be refreshed."),
      );
    }
  }
}

function refreshCurrentTab(force = false): Promise<void> {
  if (!force && refreshPromise !== undefined) return refreshPromise;
  const serial = refreshSerial + 1;
  refreshSerial = serial;
  const running = doRefreshCurrentTab(serial);
  refreshPromise = running;
  void running.finally(() => {
    if (refreshPromise === running) refreshPromise = undefined;
  });
  return running;
}

refreshButton.addEventListener("click", () => { void refreshCurrentTab(true); });
chrome.tabs.onActivated.addListener(() => { void refreshCurrentTab(true); });
chrome.tabs.onRemoved.addListener(() => {
  refreshButton.dispatchEvent(new Event("click"));
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (shouldRefreshCurrentTabForUpdate(activeTabId, tabId, changeInfo)) void refreshCurrentTab(true);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshCurrentTab(true);
});
window.addEventListener("focus", () => { void refreshCurrentTab(true); });
window.setInterval(() => {
  if (!document.hidden && !currentTabBusy) void refreshCurrentTab();
}, 1500);

void refreshCurrentTab(true);
