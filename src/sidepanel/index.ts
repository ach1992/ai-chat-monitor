import { MONITORING_EVENTS } from "../monitoring/policy.js";
import type { MonitoringEventType, MonitoringRuntimeStatus } from "../monitoring/types.js";
import {
  PROTOCOL_VERSION,
  type GuardianResponse,
  type ManagedChatStatus,
  type PanelMonitoringDefaultsUpdate,
  type PanelMonitoringPolicyUpdate,
  type PanelOverviewRequest,
  type PanelOverviewResponse,
  type PanelStatusRequest,
  type PanelStatusResponse,
} from "../shared/protocol.js";

const SUPPORTED_ORIGINS = new Set(["https://chatgpt.com", "https://chat.openai.com"]);

const EVENT_LABELS: Readonly<Record<MonitoringEventType, string>> = {
  RESPONSE_COMPLETE: "Response completed",
  CONTINUE_READY: "Manual continuation available",
  APPROVAL_REQUIRED: "Approval required",
  DECISION_REQUIRED: "Material decision required",
  HUMAN_OPERATION_REQUIRED: "Human action / input required",
  TASK_COMPLETE: "Task complete",
  RETRY_AVAILABLE: "Retry available",
  PLATFORM_ERROR: "Platform error",
  NETWORK_ERROR: "Network error",
  RATE_LIMIT: "Rate limit",
  AUTH_REQUIRED: "Authentication required",
  VERIFICATION_REQUIRED: "Verification required",
  CONVERSATION_FULL: "Conversation limit reached",
  SEMANTIC_UNKNOWN: "Semantic state unknown",
  PROVIDER_ERROR: "Provider error",
  GENERATION_STALLED: "Generation stalled",
  REPEATED_RESPONSE: "Repeated response",
};

const CUSTOM_INSTRUCTIONS = `Chat Turn Guardian — optional status protocol

This status is metadata for a read-only monitoring extension. It must not change, continue, restart, summarize, or reframe the user's task.

For normal replies, first answer the user normally. After the answer is complete, add one blank line and then exactly one standalone final line in this format:
CHAT_TURN_GUARDIAN_STATUS={"decision":"<VALUE>"}

Choose <VALUE> from the actual work state after producing the answer:
- CONTINUE — Requested work remains and can proceed autonomously without human approval, a material human decision, missing human-provided information/credentials, or a human-only operation.
- HOLD_APPROVAL — Progress is blocked on explicit human approval or authorization.
- HOLD_DECISION — Progress is blocked on a material choice that should be made by the human rather than selected autonomously.
- HOLD_HUMAN_OPERATION — Progress requires missing human-provided information or credentials, or an action only the human can perform.
- COMPLETE — The user's requested outcome is actually complete and no further work remains for the current request. Do not use COMPLETE merely because one intermediate step finished.
- PLATFORM_ERROR — Progress is blocked by a platform, tool, runtime, or service failure rather than a normal human decision boundary.
- RATE_LIMIT — Progress is blocked specifically by a usage, quota, or rate limit.
- UNSURE — You cannot reliably classify the current state into the categories above.

Rules:
- Do not use CONTINUE when a real human gate is required.
- Output exactly one status record when the status line is appropriate.
- The status record must be a separate trailing line, outside Markdown code fences, inline code, JSON/code payloads, block quotes, tables, or other requested output containers.
- Put no text after the status record.
- If the user explicitly requires an exact, strict, or format-exclusive output where an extra status line would invalidate the requested output, omit the status line for that reply. The monitoring extension is designed to work without it.`;

const CHAT_INSTRUCTION = `For this conversation, use the following optional Chat Turn Guardian status protocol. It is metadata for a read-only monitor and must not change the task itself.

For normal replies, answer normally first. Then add one blank line and exactly one standalone final line:
CHAT_TURN_GUARDIAN_STATUS={"decision":"<VALUE>"}

Choose <VALUE> from the actual work state after the answer:
- CONTINUE — Work remains and can proceed autonomously without human approval, a material decision, missing human-provided information/credentials, or a human-only operation.
- HOLD_APPROVAL — Explicit human approval/authorization is required.
- HOLD_DECISION — A material human decision is required.
- HOLD_HUMAN_OPERATION — Human-provided information/credentials or a human-only action is required.
- COMPLETE — The requested outcome is actually complete; do not use this for a merely completed intermediate step.
- PLATFORM_ERROR — A platform/tool/runtime/service failure blocks progress.
- RATE_LIMIT — A usage/quota/rate limit blocks progress.
- UNSURE — The state cannot be classified reliably.

Never mark CONTINUE when a real human gate exists. Keep the status record outside code fences, inline code, JSON/code payloads, block quotes, tables, or other requested output containers, and put nothing after it. If I explicitly request an exact/strict/format-exclusive output where the extra line would invalidate the output, omit the status line for that reply.`;

function q<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Side Panel is missing required element: ${selector}`);
  return element;
}

function e<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const statusElement = q<HTMLElement>("[data-status]");
const detailsElement = q<HTMLElement>("[data-details]");
const refreshButton = q<HTMLButtonElement>("[data-refresh]");
const currentTabElement = q<HTMLElement>("[data-current-tab-live]");
const chatList = q<HTMLElement>("[data-chat-list]");
const chatCount = q<HTMLElement>("[data-chat-count]");
const defaultsForm = q<HTMLFormElement>("[data-defaults-form]");
const browserEventsRoot = q<HTMLElement>("[data-browser-events]");
const soundEventsRoot = q<HTMLElement>("[data-sound-events]");
const markerHealth = q<HTMLElement>("[data-marker-health]");
const customInstructions = q<HTMLTextAreaElement>("[data-custom-instructions]");
const chatInstruction = q<HTMLTextAreaElement>("[data-chat-instruction]");
const copyCustom = q<HTMLButtonElement>("[data-copy-custom]");
const copyChat = q<HTMLButtonElement>("[data-copy-chat]");
const copyStatus = q<HTMLElement>("[data-copy-status]");
const eventList = q<HTMLElement>("[data-event-list]");
const historyClear = q<HTMLButtonElement>("[data-history-clear]");
const historyStatus = q<HTMLElement>("[data-history-status]");
const stallThresholdInput = q<HTMLInputElement>('input[name="stallThresholdSeconds"]');
const suppressFocusedInput = q<HTMLInputElement>('input[name="suppressLowPriorityWhileFocused"]');

customInstructions.value = CUSTOM_INSTRUCTIONS;
chatInstruction.value = CHAT_INSTRUCTION;

const browserInputs = new Map<MonitoringEventType, HTMLInputElement>();
const soundInputs = new Map<MonitoringEventType, HTMLInputElement>();
let latestOverview: PanelOverviewResponse | undefined;
let refreshInFlight = false;

function buildEventChecks(root: HTMLElement, target: Map<MonitoringEventType, HTMLInputElement>): void {
  root.replaceChildren();
  for (const event of MONITORING_EVENTS) {
    const label = e("label");
    const input = e("input");
    input.type = "checkbox";
    input.value = event;
    label.append(input, e("span", undefined, EVENT_LABELS[event]));
    root.append(label);
    target.set(event, input);
  }
}

buildEventChecks(browserEventsRoot, browserInputs);
buildEventChecks(soundEventsRoot, soundInputs);

function isSupportedUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try { return SUPPORTED_ORIGINS.has(new URL(url).origin); } catch { return false; }
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function reconnect(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "panel:agent-reconnect", protocolVersion: PROTOCOL_VERSION });
  } catch {
    // Content script may still be loading. A later refresh can recover naturally.
  }
}

async function statusForTab(tabId: number): Promise<PanelStatusResponse> {
  const request: PanelStatusRequest = { type: "panel:status-request", protocolVersion: PROTOCOL_VERSION, tabId };
  const response = await chrome.runtime.sendMessage<GuardianResponse>(request);
  if (response.type !== "background:status") throw new Error(response.type === "background:error" ? response.message : "Unexpected status response.");
  return response;
}

async function overview(): Promise<PanelOverviewResponse> {
  const request: PanelOverviewRequest = { type: "panel:overview-request", protocolVersion: PROTOCOL_VERSION };
  const response = await chrome.runtime.sendMessage<GuardianResponse>(request);
  if (response.type !== "background:overview") throw new Error(response.type === "background:error" ? response.message : "Unexpected overview response.");
  return response;
}

async function setMonitoring(tabId: number, conversationId: string, enabled: boolean): Promise<void> {
  const request: PanelMonitoringPolicyUpdate = {
    type: "panel:monitoring-policy-update",
    protocolVersion: PROTOCOL_VERSION,
    tabId,
    conversationId,
    patch: { enabled },
  };
  const response = await chrome.runtime.sendMessage<GuardianResponse>(request);
  if (response.type === "background:error") throw new Error(response.message);
  if (response.type !== "background:monitoring-policy") throw new Error("Unexpected monitoring update response.");
}

function stateText(runtime: MonitoringRuntimeStatus | undefined): string {
  if (runtime === undefined) return "Waiting for fresh observation";
  const semantic = runtime.semanticDecision === undefined ? "Unknown semantic state" : runtime.semanticDecision;
  return `${runtime.pageState} · ${semantic} · ${runtime.semanticSource}`;
}

function markerHealthText(runtime: MonitoringRuntimeStatus | undefined): string {
  switch (runtime?.markerHealth) {
    case "DETECTED": return "Status marker: Detected";
    case "LEGACY": return "Status marker: Legacy marker detected";
    case "MALFORMED": return "Status marker: Malformed — fallback is active";
    case "MISSING": return "Status marker: Missing — fallback is active";
    default: return "Status marker: Not observed yet";
  }
}

function renderCurrentStatus(status: PanelStatusResponse | undefined, tab: chrome.tabs.Tab | undefined): void {
  currentTabElement.replaceChildren();
  if (tab?.id === undefined || !isSupportedUrl(tab.url)) {
    currentTabElement.className = "empty-state";
    currentTabElement.textContent = "Open a ChatGPT conversation in the active tab to monitor it.";
    markerHealth.textContent = "Not detected yet";
    return;
  }
  if (status === undefined || !status.connected || status.conversationId === undefined) {
    currentTabElement.className = "empty-state";
    currentTabElement.textContent = "The ChatGPT content observer is reconnecting. Open a saved conversation if this is a new-chat page.";
    markerHealth.textContent = "Not observed yet";
    return;
  }

  currentTabElement.className = "chat-card";
  const heading = e("div", "section-heading");
  const title = e("div");
  title.append(
    e("strong", undefined, tab.title ?? "ChatGPT conversation"),
    e("p", "meta", stateText(status.monitoringRuntime)),
  );
  const toggle = e("button", status.monitoringPolicy?.enabled ? "danger small" : "small", status.monitoringPolicy?.enabled ? "Monitoring ON" : "Monitoring OFF");
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    toggle.disabled = true;
    void setMonitoring(tab.id as number, status.conversationId as string, !(status.monitoringPolicy?.enabled ?? false))
      .then(() => refreshAll())
      .catch((error) => { detailsElement.textContent = error instanceof Error ? error.message : "Monitoring update failed."; })
      .finally(() => { toggle.disabled = false; });
  });
  heading.append(title, toggle);
  currentTabElement.append(heading);
  markerHealth.textContent = markerHealthText(status.monitoringRuntime);
  markerHealth.dataset.tone = status.monitoringRuntime?.markerHealth === "DETECTED" ? "ok" : "";
}

function renderChatCard(chat: ManagedChatStatus): HTMLElement {
  const card = e("article", "chat-card");
  const heading = e("div", "section-heading");
  const title = e("div");
  title.append(
    e("strong", undefined, chat.pageTitle ?? chat.conversationId ?? `Tab ${chat.tabId}`),
    e("p", "meta", stateText(chat.runtime)),
  );
  heading.append(title);
  card.append(heading);

  if (chat.conversationId === undefined) {
    card.append(e("p", "meta", "No stable conversation identity is available yet."));
    return card;
  }

  const meta = e("div", "meta-row");
  const enabled = e("span", "badge", chat.policy?.enabled ? "Monitoring ON" : "Monitoring OFF");
  enabled.dataset.tone = chat.policy?.enabled ? "ok" : "";
  const marker = e("span", "badge", markerHealthText(chat.runtime).replace("Status marker: ", ""));
  meta.append(enabled, marker);
  card.append(meta);

  const actions = e("div", "form-actions");
  const toggle = e("button", chat.policy?.enabled ? "danger small" : "small", chat.policy?.enabled ? "Turn monitoring off" : "Turn monitoring on");
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    toggle.disabled = true;
    void setMonitoring(chat.tabId, chat.conversationId as string, !(chat.policy?.enabled ?? false))
      .then(() => refreshAll())
      .catch((error) => { detailsElement.textContent = error instanceof Error ? error.message : "Monitoring update failed."; })
      .finally(() => { toggle.disabled = false; });
  });
  const focus = e("button", "secondary small", "Focus tab");
  focus.type = "button";
  focus.addEventListener("click", () => { void chrome.tabs.update(chat.tabId, { active: true }); });
  actions.append(toggle, focus);
  card.append(actions);
  return card;
}

function renderOverview(data: PanelOverviewResponse): void {
  latestOverview = data;
  chatCount.textContent = String(data.chats.length);
  chatList.replaceChildren(...data.chats.map(renderChatCard));
  if (data.chats.length === 0) chatList.append(e("div", "empty-state", "No open ChatGPT conversations are connected."));

  for (const [event, input] of browserInputs) input.checked = data.defaults.browserEvents.includes(event);
  for (const [event, input] of soundInputs) input.checked = data.defaults.soundEvents.includes(event);
  stallThresholdInput.value = String(Math.round(data.defaults.stallThresholdMs / 1_000));
  suppressFocusedInput.checked = data.defaults.suppressLowPriorityWhileFocused;

  eventList.replaceChildren();
  const events = [...data.events].reverse();
  for (const event of events) {
    const item = e("article", "audit-item");
    item.append(
      e("strong", undefined, EVENT_LABELS[event.type]),
      e("p", "meta", `${new Date(event.at).toLocaleString()} · ${event.pageState} · ${event.semanticSource}`),
      e("p", undefined, event.message),
    );
    eventList.append(item);
  }
  if (events.length === 0) eventList.append(e("div", "empty-state", "No monitoring events recorded yet."));
}

function selectedEvents(inputs: Map<MonitoringEventType, HTMLInputElement>): MonitoringEventType[] {
  return [...inputs.entries()].filter(([, input]) => input.checked).map(([event]) => event);
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

copyCustom.addEventListener("click", () => {
  void copyText(CUSTOM_INSTRUCTIONS).then(
    () => { copyStatus.textContent = "Custom Instructions copied."; },
    () => { copyStatus.textContent = "Copy failed. Select the text manually."; },
  );
});

copyChat.addEventListener("click", () => {
  void copyText(CHAT_INSTRUCTION).then(
    () => { copyStatus.textContent = "Per-chat instruction copied."; },
    () => { copyStatus.textContent = "Copy failed. Select the text manually."; },
  );
});

defaultsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const seconds = Number(stallThresholdInput.value);
  if (!Number.isFinite(seconds) || seconds < 30 || seconds > 3_600) {
    detailsElement.textContent = "Generation stall threshold must be between 30 and 3600 seconds.";
    return;
  }
  const request: PanelMonitoringDefaultsUpdate = {
    type: "panel:monitoring-defaults-update",
    protocolVersion: PROTOCOL_VERSION,
    patch: {
      browserEvents: selectedEvents(browserInputs),
      soundEvents: selectedEvents(soundInputs),
      stallThresholdMs: Math.round(seconds * 1_000),
      suppressLowPriorityWhileFocused: suppressFocusedInput.checked,
    },
  };
  void chrome.runtime.sendMessage<GuardianResponse>(request).then((response) => {
    if (response.type === "background:error") throw new Error(response.message);
    detailsElement.textContent = "Monitoring defaults saved.";
    return refreshAll();
  }).catch((error) => {
    detailsElement.textContent = error instanceof Error ? error.message : "Unable to save monitoring defaults.";
  });
});

historyClear.addEventListener("click", () => {
  historyClear.disabled = true;
  void chrome.runtime.sendMessage<GuardianResponse>({ type: "panel:history-clear", protocolVersion: PROTOCOL_VERSION }).then((response) => {
    if (response.type === "background:error") throw new Error(response.message);
    if (response.type !== "background:history-cleared") throw new Error("Unexpected history clear response.");
    historyStatus.textContent = "Monitoring event history cleared.";
    return refreshAll();
  }).catch((error) => {
    historyStatus.textContent = error instanceof Error ? error.message : "Unable to clear monitoring history.";
  }).finally(() => { historyClear.disabled = false; });
});

async function refreshAll(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refreshButton.disabled = true;
  try {
    const tab = await activeTab();
    if (tab?.id !== undefined && isSupportedUrl(tab.url)) await reconnect(tab.id);
    const [data, tabStatus] = await Promise.all([
      overview(),
      tab?.id !== undefined && isSupportedUrl(tab.url) ? statusForTab(tab.id).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    renderOverview(data);
    renderCurrentStatus(tabStatus, tab);
    const monitored = data.chats.filter((chat) => chat.policy?.enabled === true).length;
    statusElement.textContent = `${monitored} monitored conversation${monitored === 1 ? "" : "s"}`;
    detailsElement.textContent = "Guardian is observing only; it has no ChatGPT mutation path.";
  } catch (error) {
    statusElement.textContent = "Monitoring status unavailable";
    detailsElement.textContent = error instanceof Error ? error.message : "Unable to read monitoring state.";
  } finally {
    refreshButton.disabled = false;
    refreshInFlight = false;
  }
}

refreshButton.addEventListener("click", () => { void refreshAll(); });
void refreshAll();
window.setInterval(() => { void refreshAll(); }, 5_000);
