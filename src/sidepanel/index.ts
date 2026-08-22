import { MONITORING_EVENTS } from "../monitoring/policy.js";
import type {
  MonitoringEvent,
  MonitoringEventType,
  MonitoringPageState,
  MonitoringRuntimeStatus,
  SemanticStatusSource,
} from "../monitoring/types.js";
import type { ConversationProtocolDecision, ConversationStatusMarkerHealth } from "../classification/conversation-protocol.js";
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
const RESET_CONFIRM_WINDOW_MS = 6_000;

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

type UiTone = "info" | "ok" | "warn" | "danger" | "violet" | "muted";
type OperationTone = "working" | "success" | "error" | "warning";
type ButtonActionState = "working" | "success" | "error";

interface MonitoringChatsResetResponse {
  type: "background:monitoring-chats-reset";
  protocolVersion: typeof PROTOCOL_VERSION;
  revision: number;
  cleared: number;
}

function q<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Side Panel is missing required element: ${selector}`);
  return element;
}

function e<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const summaryCard = q<HTMLElement>("[data-summary-card]");
const statusElement = q<HTMLElement>("[data-status]");
const detailsElement = q<HTMLElement>("[data-details]");
const refreshButton = q<HTMLButtonElement>("[data-refresh]");
const currentTabElement = q<HTMLElement>("[data-current-tab-live]");
const chatList = q<HTMLElement>("[data-chat-list]");
const chatCount = q<HTMLElement>("[data-chat-count]");
const resetChatsButton = q<HTMLButtonElement>("[data-reset-chats]");
const resetStatus = q<HTMLElement>("[data-reset-status]");
const defaultsForm = q<HTMLFormElement>("[data-defaults-form]");
const defaultsSaveButton = q<HTMLButtonElement>("[data-save-defaults]", defaultsForm);
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
let resetConfirmUntil = 0;
let resetConfirmTimer: number | undefined;

function setOperationStatus(element: HTMLElement, message: string, tone?: OperationTone): void {
  element.textContent = message;
  if (tone === undefined) delete element.dataset.tone;
  else element.dataset.tone = tone;
}

function setButtonState(button: HTMLButtonElement, state: ButtonActionState | undefined, label?: string): void {
  if (state === undefined) delete button.dataset.actionState;
  else button.dataset.actionState = state;
  if (label !== undefined) button.textContent = label;
}

function flashButton(button: HTMLButtonElement, state: Exclude<ButtonActionState, "working">, label: string, restoreLabel: string): void {
  setButtonState(button, state, label);
  window.setTimeout(() => {
    if (button.dataset.actionState === state) setButtonState(button, undefined, restoreLabel);
  }, 1_600);
}

function badge(text: string, tone: UiTone): HTMLElement {
  const element = e("span", "badge", text);
  element.dataset.tone = tone;
  return element;
}

function humanizeToken(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
}

function pageTone(state: MonitoringPageState): UiTone {
  if (state === "PLATFORM_ERROR" || state === "NETWORK_ERROR" || state === "RATE_LIMIT" || state === "AUTH_REQUIRED" || state === "VERIFICATION_REQUIRED" || state === "CONVERSATION_FULL") return "danger";
  if (state === "RETRY_AVAILABLE") return "warn";
  if (state === "GENERATING") return "info";
  if (state === "IDLE") return "ok";
  return "muted";
}

function semanticTone(decision: ConversationProtocolDecision | undefined): UiTone {
  if (decision === "COMPLETE") return "ok";
  if (decision === "CONTINUE") return "info";
  if (decision === "HOLD_APPROVAL" || decision === "HOLD_DECISION" || decision === "HOLD_HUMAN_OPERATION" || decision === "UNSURE") return "warn";
  if (decision === "PLATFORM_ERROR" || decision === "RATE_LIMIT") return "danger";
  return "muted";
}

function sourceTone(source: SemanticStatusSource | undefined): UiTone {
  if (source === "STATUS_MARKER") return "violet";
  if (source === "UI") return "info";
  if (source === "RULE") return "ok";
  if (source === "PROVIDER") return "violet";
  return "muted";
}

function markerTone(health: ConversationStatusMarkerHealth | undefined): UiTone {
  if (health === "DETECTED") return "ok";
  if (health === "LEGACY") return "violet";
  if (health === "MALFORMED") return "danger";
  return "muted";
}

function eventTone(event: MonitoringEventType): UiTone {
  if (["PLATFORM_ERROR", "NETWORK_ERROR", "RATE_LIMIT", "AUTH_REQUIRED", "VERIFICATION_REQUIRED", "CONVERSATION_FULL", "PROVIDER_ERROR"].includes(event)) return "danger";
  if (["APPROVAL_REQUIRED", "DECISION_REQUIRED", "HUMAN_OPERATION_REQUIRED", "RETRY_AVAILABLE", "SEMANTIC_UNKNOWN", "GENERATION_STALLED", "REPEATED_RESPONSE"].includes(event)) return "warn";
  if (event === "TASK_COMPLETE") return "ok";
  return "info";
}

function renderRuntime(runtime: MonitoringRuntimeStatus | undefined): HTMLElement {
  const row = e("div", "runtime-summary");
  if (runtime === undefined) {
    row.append(badge("Waiting for observation", "muted"));
    return row;
  }
  row.append(badge(humanizeToken(runtime.pageState), pageTone(runtime.pageState)));
  row.append(badge(runtime.semanticDecision === undefined ? "Semantic unknown" : humanizeToken(runtime.semanticDecision), semanticTone(runtime.semanticDecision)));
  row.append(badge(`Source: ${humanizeToken(runtime.semanticSource)}`, sourceTone(runtime.semanticSource)));
  return row;
}

function markerHealthText(runtime: MonitoringRuntimeStatus | undefined): string {
  switch (runtime?.markerHealth) {
    case "DETECTED": return "Marker detected";
    case "LEGACY": return "Legacy marker";
    case "MALFORMED": return "Malformed — fallback active";
    case "MISSING": return "Missing — fallback active";
    default: return "Not observed yet";
  }
}

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

async function resetMonitoredChats(): Promise<MonitoringChatsResetResponse> {
  const response = await chrome.runtime.sendMessage<GuardianResponse | MonitoringChatsResetResponse>({
    type: "panel:monitoring-chats-reset",
    protocolVersion: PROTOCOL_VERSION,
  });
  if (response.type === "background:error") throw new Error(response.message);
  if (response.type !== "background:monitoring-chats-reset") throw new Error("Unexpected monitored-chat reset response.");
  return response;
}

function renderCurrentStatus(status: PanelStatusResponse | undefined, tab: chrome.tabs.Tab | undefined): void {
  currentTabElement.replaceChildren();
  if (tab?.id === undefined || !isSupportedUrl(tab.url)) {
    currentTabElement.className = "empty-state";
    currentTabElement.textContent = "Open a ChatGPT conversation in the active tab to monitor it.";
    markerHealth.textContent = "Not observed yet";
    markerHealth.dataset.tone = "muted";
    return;
  }
  if (status === undefined || !status.connected || status.conversationId === undefined) {
    currentTabElement.className = "empty-state";
    currentTabElement.textContent = "The ChatGPT observer is reconnecting. Open a saved conversation if this is a new-chat page.";
    markerHealth.textContent = "Not observed yet";
    markerHealth.dataset.tone = "muted";
    return;
  }

  const enabled = status.monitoringPolicy?.enabled ?? false;
  currentTabElement.className = "current-card current-card-primary";
  currentTabElement.dataset.enabled = String(enabled);

  const heading = e("div", "section-heading");
  const title = e("div", "title-block");
  title.append(e("strong", undefined, tab.title ?? "ChatGPT conversation"), renderRuntime(status.monitoringRuntime));

  const toggle = e("button", enabled ? "danger-outline small" : "small", enabled ? "Turn monitoring off" : "Turn monitoring on");
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    const original = toggle.textContent ?? "Update monitoring";
    toggle.disabled = true;
    setButtonState(toggle, "working", "Updating…");
    void setMonitoring(tab.id as number, status.conversationId as string, !enabled)
      .then(async () => {
        setButtonState(toggle, "success", !enabled ? "Monitoring on ✓" : "Monitoring off ✓");
        await refreshAll();
      })
      .catch((error) => {
        setButtonState(toggle, "error", "Update failed");
        detailsElement.textContent = error instanceof Error ? error.message : "Monitoring update failed.";
        summaryCard.dataset.tone = "danger";
      })
      .finally(() => {
        toggle.disabled = false;
        window.setTimeout(() => {
          if (toggle.isConnected) setButtonState(toggle, undefined, original);
        }, 1_200);
      });
  });

  heading.append(title, toggle);
  currentTabElement.append(heading);
  markerHealth.textContent = markerHealthText(status.monitoringRuntime);
  markerHealth.dataset.tone = markerTone(status.monitoringRuntime?.markerHealth);
}

function renderChatCard(chat: ManagedChatStatus): HTMLElement {
  const card = e("article", "chat-card");
  const heading = e("div", "section-heading");
  const title = e("div", "title-block");
  title.append(e("strong", undefined, chat.pageTitle ?? chat.conversationId ?? `Tab ${chat.tabId}`), renderRuntime(chat.runtime));
  heading.append(title);
  card.append(heading);

  if (chat.conversationId === undefined) {
    card.append(e("p", "meta", "No stable conversation identity is available yet."));
    return card;
  }

  const meta = e("div", "meta-row");
  meta.append(badge("Monitoring ON", "ok"));
  meta.append(badge(markerHealthText(chat.runtime), markerTone(chat.runtime?.markerHealth)));
  card.append(meta);

  const actions = e("div", "chat-actions");
  const toggle = e("button", "danger-outline small", "Turn monitoring off");
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    toggle.disabled = true;
    setButtonState(toggle, "working", "Turning off…");
    void setMonitoring(chat.tabId, chat.conversationId as string, false)
      .then(() => refreshAll())
      .catch((error) => {
        setButtonState(toggle, "error", "Update failed");
        detailsElement.textContent = error instanceof Error ? error.message : "Monitoring update failed.";
        summaryCard.dataset.tone = "danger";
      })
      .finally(() => { toggle.disabled = false; });
  });

  const focus = e("button", "secondary small", "Focus tab");
  focus.type = "button";
  focus.addEventListener("click", () => {
    setButtonState(focus, "working", "Opening…");
    void chrome.tabs.update(chat.tabId, { active: true }).then(
      () => flashButton(focus, "success", "Focused ✓", "Focus tab"),
      () => flashButton(focus, "error", "Tab unavailable", "Focus tab"),
    );
  });
  actions.append(toggle, focus);
  card.append(actions);
  return card;
}

function renderEvent(event: MonitoringEvent): HTMLElement {
  const item = e("article", "audit-item");
  const row = e("div", "meta-row");
  row.append(badge(EVENT_LABELS[event.type], eventTone(event.type)));
  row.append(e("span", "meta", new Date(event.at).toLocaleString()));
  item.append(row, e("p", "meta", `${humanizeToken(event.pageState)} · ${humanizeToken(event.semanticSource)}`), e("p", undefined, event.message));
  return item;
}

function renderOverview(data: PanelOverviewResponse): void {
  latestOverview = data;
  chatCount.textContent = String(data.chats.length);
  resetChatsButton.disabled = data.chats.length === 0;
  chatList.replaceChildren(...data.chats.map(renderChatCard));
  if (data.chats.length === 0) {
    chatList.append(e("div", "empty-state", "No monitored chats. Turn monitoring on from Current tab to add one."));
  }

  for (const [event, input] of browserInputs) input.checked = data.defaults.browserEvents.includes(event);
  for (const [event, input] of soundInputs) input.checked = data.defaults.soundEvents.includes(event);
  stallThresholdInput.value = String(Math.round(data.defaults.stallThresholdMs / 1_000));
  suppressFocusedInput.checked = data.defaults.suppressLowPriorityWhileFocused;

  const events = [...data.events].reverse();
  eventList.replaceChildren(...events.map(renderEvent));
  if (events.length === 0) eventList.append(e("div", "empty-state", "No monitoring events recorded yet."));
}

function selectedEvents(inputs: Map<MonitoringEventType, HTMLInputElement>): MonitoringEventType[] {
  return [...inputs.entries()].filter(([, input]) => input.checked).map(([event]) => event);
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function handleCopy(button: HTMLButtonElement, text: string, successMessage: string): void {
  const original = button.textContent ?? "Copy";
  button.disabled = true;
  setButtonState(button, "working", "Copying…");
  void copyText(text).then(
    () => {
      flashButton(button, "success", "Copied ✓", original);
      setOperationStatus(copyStatus, successMessage, "success");
    },
    () => {
      flashButton(button, "error", "Copy failed", original);
      setOperationStatus(copyStatus, "Copy failed. Open the preview and select the text manually.", "error");
    },
  ).finally(() => { button.disabled = false; });
}

copyCustom.addEventListener("click", () => handleCopy(copyCustom, CUSTOM_INSTRUCTIONS, "Custom Instructions copied to clipboard."));
copyChat.addEventListener("click", () => handleCopy(copyChat, CHAT_INSTRUCTION, "Per-chat instruction copied to clipboard."));

defaultsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const seconds = Number(stallThresholdInput.value);
  if (!Number.isFinite(seconds) || seconds < 30 || seconds > 3_600) {
    detailsElement.textContent = "Generation stall threshold must be between 30 and 3600 seconds.";
    summaryCard.dataset.tone = "danger";
    flashButton(defaultsSaveButton, "error", "Check value", "Save notification defaults");
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
  defaultsSaveButton.disabled = true;
  setButtonState(defaultsSaveButton, "working", "Saving…");
  void chrome.runtime.sendMessage<GuardianResponse>(request).then(async (response) => {
    if (response.type === "background:error") throw new Error(response.message);
    detailsElement.textContent = "Notification defaults saved.";
    summaryCard.dataset.tone = "ok";
    flashButton(defaultsSaveButton, "success", "Saved ✓", "Save notification defaults");
    await refreshAll();
  }).catch((error) => {
    detailsElement.textContent = error instanceof Error ? error.message : "Unable to save monitoring defaults.";
    summaryCard.dataset.tone = "danger";
    flashButton(defaultsSaveButton, "error", "Save failed", "Save notification defaults");
  }).finally(() => { defaultsSaveButton.disabled = false; });
});

function cancelResetConfirmation(): void {
  resetConfirmUntil = 0;
  if (resetConfirmTimer !== undefined) window.clearTimeout(resetConfirmTimer);
  resetConfirmTimer = undefined;
  resetChatsButton.classList.remove("danger");
  resetChatsButton.classList.add("secondary", "danger-outline");
  setButtonState(resetChatsButton, undefined, "Reset monitored chats");
}

resetChatsButton.addEventListener("click", () => {
  if (Date.now() > resetConfirmUntil) {
    resetConfirmUntil = Date.now() + RESET_CONFIRM_WINDOW_MS;
    resetChatsButton.classList.remove("secondary", "danger-outline");
    resetChatsButton.classList.add("danger");
    resetChatsButton.textContent = "Confirm reset";
    setOperationStatus(resetStatus, "Click again within 6 seconds to remove all saved monitored chats. Other settings and event history stay unchanged.", "warning");
    resetConfirmTimer = window.setTimeout(cancelResetConfirmation, RESET_CONFIRM_WINDOW_MS);
    return;
  }

  if (resetConfirmTimer !== undefined) window.clearTimeout(resetConfirmTimer);
  resetConfirmTimer = undefined;
  resetConfirmUntil = 0;
  resetChatsButton.disabled = true;
  setButtonState(resetChatsButton, "working", "Resetting…");
  setOperationStatus(resetStatus, "Removing saved monitored-chat policies…", "working");
  void resetMonitoredChats().then(async (response) => {
    setOperationStatus(resetStatus, `Reset complete. ${response.cleared} saved chat${response.cleared === 1 ? "" : "s"} removed.`, "success");
    flashButton(resetChatsButton, "success", "Reset complete ✓", "Reset monitored chats");
    await refreshAll();
  }).catch((error) => {
    setOperationStatus(resetStatus, error instanceof Error ? error.message : "Unable to reset monitored chats.", "error");
    flashButton(resetChatsButton, "error", "Reset failed", "Reset monitored chats");
  }).finally(() => {
    resetChatsButton.disabled = latestOverview?.chats.length === 0;
    window.setTimeout(cancelResetConfirmation, 1_700);
  });
});

historyClear.addEventListener("click", () => {
  historyClear.disabled = true;
  setButtonState(historyClear, "working", "Clearing…");
  setOperationStatus(historyStatus, "Clearing monitoring event history…", "working");
  void chrome.runtime.sendMessage<GuardianResponse>({ type: "panel:history-clear", protocolVersion: PROTOCOL_VERSION }).then(async (response) => {
    if (response.type === "background:error") throw new Error(response.message);
    if (response.type !== "background:history-cleared") throw new Error("Unexpected history clear response.");
    setOperationStatus(historyStatus, "Monitoring event history cleared.", "success");
    flashButton(historyClear, "success", "Cleared ✓", "Clear event history");
    await refreshAll();
  }).catch((error) => {
    setOperationStatus(historyStatus, error instanceof Error ? error.message : "Unable to clear monitoring history.", "error");
    flashButton(historyClear, "error", "Clear failed", "Clear event history");
  }).finally(() => { historyClear.disabled = false; });
});

async function refreshAll(manual = false): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refreshButton.disabled = true;
  if (manual) setButtonState(refreshButton, "working", "Refreshing…");
  try {
    const tab = await activeTab();
    if (tab?.id !== undefined && isSupportedUrl(tab.url)) await reconnect(tab.id);
    const [data, tabStatus] = await Promise.all([
      overview(),
      tab?.id !== undefined && isSupportedUrl(tab.url) ? statusForTab(tab.id).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    renderOverview(data);
    renderCurrentStatus(tabStatus, tab);
    const monitored = data.chats.length;
    statusElement.textContent = `${monitored} monitored conversation${monitored === 1 ? "" : "s"}`;
    detailsElement.textContent = monitored === 0
      ? "Guardian is ready. Turn monitoring on from a ChatGPT tab to add it."
      : "Guardian is observing only; it has no ChatGPT mutation path.";
    summaryCard.dataset.tone = monitored > 0 ? "ok" : "info";
    if (manual) flashButton(refreshButton, "success", "Refreshed ✓", "Refresh");
  } catch (error) {
    statusElement.textContent = "Monitoring status unavailable";
    detailsElement.textContent = error instanceof Error ? error.message : "Unable to read monitoring state.";
    summaryCard.dataset.tone = "danger";
    if (manual) flashButton(refreshButton, "error", "Refresh failed", "Refresh");
  } finally {
    refreshButton.disabled = false;
    refreshInFlight = false;
  }
}

refreshButton.addEventListener("click", () => { void refreshAll(true); });
void refreshAll();
window.setInterval(() => { void refreshAll(); }, 5_000);