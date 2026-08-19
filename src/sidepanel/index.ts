import type { AutomationPolicyDefaults, ChatAutomationPolicyPatch } from "../automation/policy.js";
import type { ChatAutomationMode, NotificationTrigger } from "../automation/types.js";
import type { ProviderProfile } from "../providers/types.js";
import {
  PROTOCOL_VERSION,
  type GuardianResponse,
  type ManagedChatStatus,
  type PanelAutomationDefaultsUpdate,
  type PanelAutomationPolicyUpdate,
  type PanelEmergencyPauseUpdate,
  type PanelOverviewRequest,
  type PanelOverviewResponse,
  type PanelProviderOrderUpdate,
  type PanelProviderProfileRemove,
  type PanelProviderProfileUpsert,
} from "../shared/protocol.js";

const NOTIFICATION_OPTIONS: ReadonlyArray<{ value: NotificationTrigger; label: string }> = [
  { value: "RESPONSE_FINISHED", label: "Response finished" },
  { value: "HOLD", label: "Human attention / HOLD" },
  { value: "UNSURE", label: "UNSURE" },
  { value: "ERROR", label: "Provider / extension error" },
  { value: "STAGNATION", label: "Stagnation" },
];

const MODE_OPTIONS: ReadonlyArray<{ value: ChatAutomationMode; label: string }> = [
  { value: "OFF", label: "Off" },
  { value: "OBSERVE", label: "Observe" },
  { value: "AUTO", label: "Auto" },
  { value: "NOTIFY_ONLY", label: "Notify only" },
];

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Side panel markup is missing required element: ${selector}`);
  return element;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function shortConversationId(value: string | undefined): string {
  if (value === undefined) return "no conversation id";
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function displayTitle(chat: ManagedChatStatus): string {
  const title = chat.pageTitle?.trim();
  if (title !== undefined && title.length > 0) return title;
  return chat.conversationId === undefined ? `Tab ${chat.tabId}` : `Conversation ${shortConversationId(chat.conversationId)}`;
}

function modeLabel(mode: ChatAutomationMode | undefined): string {
  return MODE_OPTIONS.find((entry) => entry.value === mode)?.label ?? "Off";
}

function addBadge(parent: Element, text: string, tone?: "ok" | "warn"): void {
  const badge = createElement("span", "badge", text);
  if (tone !== undefined) badge.dataset.tone = tone;
  parent.append(badge);
}

const statusElement = requireElement<HTMLElement>("[data-status]");
const detailsElement = requireElement<HTMLElement>("[data-details]");
const refreshButton = requireElement<HTMLButtonElement>("[data-refresh]");
const pauseAllButton = requireElement<HTMLButtonElement>("[data-pause-all]");
const currentTabElement = requireElement<HTMLElement>("[data-current-tab]");
const chatListElement = requireElement<HTMLElement>("[data-chat-list]");
const chatCountElement = requireElement<HTMLElement>("[data-chat-count]");
const defaultsForm = requireElement<HTMLFormElement>("[data-defaults-form]");
const defaultNotificationsElement = requireElement<HTMLElement>("[data-default-notifications]");
const providerListElement = requireElement<HTMLElement>("[data-provider-list]");
const providerForm = requireElement<HTMLFormElement>("[data-provider-form]");
const providerBaseUrlField = requireElement<HTMLElement>("[data-base-url-field]");

let overview: PanelOverviewResponse | undefined;
let activeTabId: number | undefined;
let refreshing = false;

function renderStatus(message: string, details: string): void {
  statusElement.textContent = message;
  detailsElement.textContent = details;
}

async function send(request: object): Promise<GuardianResponse> {
  return chrome.runtime.sendMessage<GuardianResponse>(request);
}

function assertSuccess(response: GuardianResponse): GuardianResponse {
  if (response.type === "background:error") throw new Error(response.message);
  return response;
}

async function mutate(request: object, progressMessage: string): Promise<void> {
  renderStatus(progressMessage, "Pending automatic decisions remain fail-closed while configuration changes persist.");
  const response = await send(request);
  assertSuccess(response);
  await refreshOverview();
}

function createNotificationChecks(
  selected: readonly NotificationTrigger[],
  namePrefix: string,
): HTMLInputElement[] {
  const inputs: HTMLInputElement[] = [];
  for (const option of NOTIFICATION_OPTIONS) {
    const label = createElement("label");
    const input = createElement("input");
    input.type = "checkbox";
    input.name = `${namePrefix}-${option.value}`;
    input.value = option.value;
    input.checked = selected.includes(option.value);
    label.append(input, createElement("span", undefined, option.label));
    inputs.push(input);
    if (namePrefix === "default") defaultNotificationsElement.append(label);
  }
  return inputs;
}

function selectedNotifications(inputs: readonly HTMLInputElement[]): NotificationTrigger[] {
  return inputs
    .filter((input) => input.checked)
    .map((input) => input.value as NotificationTrigger);
}

function getNamedInput(form: HTMLFormElement, name: string): HTMLInputElement {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLInputElement)) throw new Error(`Missing input ${name}.`);
  return control;
}

function getNamedSelect(form: HTMLFormElement, name: string): HTMLSelectElement {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLSelectElement)) throw new Error(`Missing select ${name}.`);
  return control;
}

function readRequiredInteger(form: HTMLFormElement, name: string): number {
  const input = getNamedInput(form, name);
  const value = Number(input.value);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function readOptionalInteger(input: HTMLInputElement): number | null {
  const trimmed = input.value.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value)) throw new Error("Timing override must be an integer or blank to inherit.");
  return value;
}

function primaryProviderLabel(): string {
  const state = overview?.providers;
  const primaryId = state?.order[0];
  if (primaryId === undefined) return "No AI provider configured";
  const profile = state.profiles.find((candidate) => candidate.id === primaryId);
  return profile === undefined ? `Provider ${primaryId} is missing` : `${profile.id} · ${profile.model}`;
}

function renderCurrentTab(): void {
  currentTabElement.replaceChildren();
  const tabId = activeTabId;
  const chat = tabId === undefined ? undefined : overview?.chats.find((candidate) => candidate.tabId === tabId);
  if (tabId === undefined) {
    currentTabElement.className = "empty-state";
    currentTabElement.textContent = "No active browser tab is available.";
    return;
  }
  if (chat === undefined || chat.conversationId === undefined) {
    currentTabElement.className = "empty-state";
    currentTabElement.textContent = "The active tab is not a connected ChatGPT conversation yet.";
    return;
  }

  currentTabElement.className = "current-card";
  const head = createElement("div", "chat-card-head");
  const title = createElement("div", "title-block");
  title.append(
    createElement("h3", "chat-title", displayTitle(chat)),
    createElement("div", "meta", `Tab ${chat.tabId} · ${shortConversationId(chat.conversationId)}`),
  );
  const actions = createElement("div", "inline-actions");
  const currentMode = chat.policy?.mode ?? "OFF";
  const toggle = createElement(
    "button",
    currentMode === "OFF" ? undefined : "secondary",
    currentMode === "OFF" ? "Enable observe" : "Disable",
  );
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    const request: PanelAutomationPolicyUpdate = {
      type: "panel:automation-policy-update",
      protocolVersion: PROTOCOL_VERSION,
      tabId: chat.tabId,
      conversationId: chat.conversationId as string,
      patch: { mode: currentMode === "OFF" ? "OBSERVE" : "OFF" },
    };
    void mutate(request, currentMode === "OFF" ? "Enabling current chat…" : "Disabling current chat…")
      .catch((error: unknown) => renderStatus("Update failed.", error instanceof Error ? error.message : "Unknown error."));
  });
  const focus = createElement("button", "secondary", "Focus");
  focus.type = "button";
  focus.addEventListener("click", () => {
    void chrome.tabs.update(chat.tabId, { active: true })
      .then(() => renderStatus("Chat focused.", displayTitle(chat)))
      .catch(() => renderStatus("Unable to focus chat.", "The browser rejected the tab activation request."));
  });
  actions.append(toggle, focus);
  head.append(title, actions);
  const meta = createElement("div", "meta-row");
  addBadge(meta, modeLabel(currentMode), currentMode === "AUTO" ? "ok" : undefined);
  addBadge(meta, chat.controlEligibility, chat.controlEligibility === "OWNER" ? "ok" : chat.controlEligibility === "MIRROR" ? "warn" : undefined);
  if (chat.runtime?.phase !== undefined) addBadge(meta, chat.runtime.phase, chat.runtime.phase === "AMBIGUOUS_WRITE" ? "warn" : undefined);
  currentTabElement.append(head, meta, createElement("div", "meta", primaryProviderLabel()));
}

function createModeSelect(value: ChatAutomationMode): HTMLSelectElement {
  const select = createElement("select");
  for (const option of MODE_OPTIONS) {
    const item = createElement("option");
    item.value = option.value;
    item.textContent = option.label;
    item.selected = option.value === value;
    select.append(item);
  }
  return select;
}

function createOverrideInput(
  labelText: string,
  value: number | string | undefined,
  placeholder: string,
  options: { type?: "number" | "text"; max?: number } = {},
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = createElement("label");
  const caption = createElement("span", undefined, labelText);
  const input = createElement("input");
  input.type = options.type ?? "number";
  input.placeholder = placeholder;
  input.value = value === undefined ? "" : String(value);
  if (input.type === "number") {
    input.min = "0";
    input.step = "100";
    if (options.max !== undefined) input.max = String(options.max);
  } else {
    input.maxLength = options.max ?? 200;
  }
  label.append(caption, input);
  return { label, input };
}

function createChatCard(chat: ManagedChatStatus): HTMLElement {
  const card = createElement("article", "chat-card");
  const mode = chat.policy?.mode ?? "OFF";
  card.dataset.managed = String(mode !== "OFF");

  const head = createElement("div", "chat-card-head");
  const title = createElement("div", "title-block");
  title.append(
    createElement("h3", "chat-title", displayTitle(chat)),
    createElement("div", "meta", `Tab ${chat.tabId} · ${shortConversationId(chat.conversationId)}`),
  );
  const headActions = createElement("div", "inline-actions");
  const focus = createElement("button", "secondary small", "Focus");
  focus.type = "button";
  focus.addEventListener("click", () => {
    void chrome.tabs.update(chat.tabId, { active: true })
      .then(() => renderStatus("Chat focused.", displayTitle(chat)))
      .catch(() => renderStatus("Unable to focus chat.", "The browser rejected the tab activation request."));
  });
  headActions.append(focus);
  head.append(title, headActions);

  const meta = createElement("div", "meta-row");
  addBadge(meta, modeLabel(mode), mode === "AUTO" ? "ok" : undefined);
  addBadge(meta, chat.controlEligibility, chat.controlEligibility === "OWNER" ? "ok" : chat.controlEligibility === "MIRROR" ? "warn" : undefined);
  if (chat.generation !== undefined) addBadge(meta, chat.generation);
  if (chat.runtime?.phase !== undefined) addBadge(meta, chat.runtime.phase, chat.runtime.phase === "AMBIGUOUS_WRITE" ? "warn" : undefined);

  if (chat.conversationId === undefined || chat.policy === undefined) {
    card.append(head, meta, createElement("div", "reason", "Waiting for a stable ChatGPT conversation identity."));
    return card;
  }

  const controls = createElement("div", "chat-controls");
  const modeLabelElement = createElement("label");
  modeLabelElement.append(createElement("span", undefined, "Mode"));
  const modeSelect = createModeSelect(mode);
  modeLabelElement.append(modeSelect);

  const settle = createOverrideInput(
    "Settle override (ms)",
    chat.overrides?.settleDelayMs,
    `Inherit ${chat.policy.timing.settleDelayMs}`,
    { max: 60_000 },
  );
  const continuationDelay = createOverrideInput(
    "Continue override (ms)",
    chat.overrides?.continueDelayMs,
    `Inherit ${chat.policy.timing.continueDelayMs}`,
    { max: 60_000 },
  );
  const cooldown = createOverrideInput(
    "Cooldown override (ms)",
    chat.overrides?.cooldownMs,
    `Inherit ${chat.policy.timing.cooldownMs}`,
    { max: 300_000 },
  );
  const continuation = createOverrideInput(
    "Continuation text override",
    chat.overrides?.continuationText,
    `Inherit: ${chat.policy.continuationText}`,
    { type: "text", max: 200 },
  );
  continuation.label.classList.add("wide");

  const notificationFieldset = createElement("fieldset", "compact-fieldset wide");
  notificationFieldset.append(createElement("legend", undefined, "Notifications"));
  const inheritRow = createElement("label", "checkbox-row");
  const inheritNotifications = createElement("input");
  inheritNotifications.type = "checkbox";
  inheritNotifications.checked = chat.overrides?.notificationTriggers === undefined;
  inheritRow.append(inheritNotifications, createElement("span", undefined, "Inherit global notification policy"));
  notificationFieldset.append(inheritRow);
  const notificationGrid = createElement("div", "check-grid");
  const effectiveNotifications = chat.overrides?.notificationTriggers ?? chat.policy.notificationTriggers;
  const notificationInputs: HTMLInputElement[] = [];
  for (const option of NOTIFICATION_OPTIONS) {
    const label = createElement("label");
    const input = createElement("input");
    input.type = "checkbox";
    input.value = option.value;
    input.checked = effectiveNotifications.includes(option.value);
    input.disabled = inheritNotifications.checked;
    label.append(input, createElement("span", undefined, option.label));
    notificationInputs.push(input);
    notificationGrid.append(label);
  }
  inheritNotifications.addEventListener("change", () => {
    for (const input of notificationInputs) input.disabled = inheritNotifications.checked;
  });
  notificationFieldset.append(notificationGrid);

  const overrideNote = createElement(
    "div",
    "override-note",
    `AI provider: ${primaryProviderLabel()} · blank timing/text fields inherit global defaults.`,
  );
  const actions = createElement("div", "wide form-actions");
  const save = createElement("button", undefined, "Save chat policy");
  save.type = "button";
  save.addEventListener("click", () => {
    try {
      const continuationValue = continuation.input.value.trim();
      const patch: ChatAutomationPolicyPatch = {
        mode: modeSelect.value as ChatAutomationMode,
        settleDelayMs: readOptionalInteger(settle.input),
        continueDelayMs: readOptionalInteger(continuationDelay.input),
        cooldownMs: readOptionalInteger(cooldown.input),
        continuationText: continuationValue.length === 0 ? null : continuationValue,
        notificationTriggers: inheritNotifications.checked ? null : selectedNotifications(notificationInputs),
      };
      const request: PanelAutomationPolicyUpdate = {
        type: "panel:automation-policy-update",
        protocolVersion: PROTOCOL_VERSION,
        tabId: chat.tabId,
        conversationId: chat.conversationId as string,
        patch,
      };
      void mutate(request, `Saving ${displayTitle(chat)}…`)
        .catch((error: unknown) => renderStatus("Chat policy update failed.", error instanceof Error ? error.message : "Unknown error."));
    } catch (error) {
      renderStatus("Invalid chat policy.", error instanceof Error ? error.message : "Review the timing fields.");
    }
  });
  actions.append(save);

  controls.append(
    modeLabelElement,
    settle.label,
    continuationDelay.label,
    cooldown.label,
    continuation.label,
    notificationFieldset,
    overrideNote,
    actions,
  );

  card.append(head, meta);
  const runtime = chat.runtime;
  if (runtime !== undefined) {
    const runtimeRow = createElement("div", "runtime-row");
    runtimeRow.append(createElement("span", "meta", `Runtime: ${runtime.phase}`));
    if (runtime.lastDecision !== undefined) {
      runtimeRow.append(createElement("span", "meta", `Decision: ${runtime.lastDecision.decision}`));
    }
    if (runtime.phase === "SETTLING") runtimeRow.append(createElement("span", "meta", `Delay: ${chat.policy.timing.settleDelayMs} ms`));
    if (runtime.phase === "WAITING_TO_CONTINUE") runtimeRow.append(createElement("span", "meta", `Delay: ${chat.policy.timing.continueDelayMs} ms`));
    if (runtime.phase === "COOLDOWN") runtimeRow.append(createElement("span", "meta", `Cooldown: ${chat.policy.timing.cooldownMs} ms`));
    card.append(runtimeRow);
    if (runtime.reason !== undefined) card.append(createElement("div", "reason", runtime.reason));
  }
  card.append(controls);
  return card;
}

function renderChats(): void {
  chatListElement.replaceChildren();
  const chats = [...(overview?.chats ?? [])].sort((left, right) => {
    const leftManaged = left.policy?.mode !== undefined && left.policy.mode !== "OFF";
    const rightManaged = right.policy?.mode !== undefined && right.policy.mode !== "OFF";
    if (leftManaged !== rightManaged) return leftManaged ? -1 : 1;
    if (left.tabId === activeTabId) return -1;
    if (right.tabId === activeTabId) return 1;
    return displayTitle(left).localeCompare(displayTitle(right));
  });
  chatCountElement.textContent = String(chats.length);
  if (chats.length === 0) {
    chatListElement.append(createElement("div", "empty-state", "No connected ChatGPT tabs are visible to the extension."));
    return;
  }
  for (const chat of chats) chatListElement.append(createChatCard(chat));
}

function renderDefaults(): void {
  const defaults = overview?.defaults;
  if (defaults === undefined) return;
  getNamedInput(defaultsForm, "settleDelayMs").value = String(defaults.settleDelayMs);
  getNamedInput(defaultsForm, "continueDelayMs").value = String(defaults.continueDelayMs);
  getNamedInput(defaultsForm, "cooldownMs").value = String(defaults.cooldownMs);
  getNamedInput(defaultsForm, "continuationText").value = defaults.continuationText;
  defaultNotificationsElement.replaceChildren();
  createNotificationChecks(defaults.notificationTriggers, "default");
}

function renderProviders(): void {
  providerListElement.replaceChildren();
  const state = overview?.providers;
  if (state === undefined || state.profiles.length === 0) {
    providerListElement.append(createElement("div", "empty-state", "No AI provider is configured. AUTO remains fail-closed on ambiguous stops."));
    return;
  }
  const profileById = new Map(state.profiles.map((profile) => [profile.id, profile] as const));
  const orderedIds = [...state.order, ...state.profiles.map((profile) => profile.id).filter((id) => !state.order.includes(id))];
  orderedIds.forEach((id, index) => {
    const profile = profileById.get(id);
    if (profile === undefined) return;
    const row = createElement("div", "provider-row");
    const copy = createElement("div", "provider-copy");
    const title = createElement("div", "meta-row");
    title.append(createElement("strong", undefined, profile.id));
    if (index === 0 && state.order[0] === id) addBadge(title, "Primary", "ok");
    copy.append(
      title,
      createElement("div", "meta", `${profile.kind} · ${profile.model}`),
      createElement("div", "meta", profile.endpoint),
    );
    const actions = createElement("div", "provider-actions");
    const up = createElement("button", "secondary small", "↑");
    up.type = "button";
    up.title = "Move provider earlier";
    up.disabled = index === 0 || !state.order.includes(id);
    up.addEventListener("click", () => {
      const order = [...state.order];
      const currentIndex = order.indexOf(id);
      if (currentIndex <= 0) return;
      [order[currentIndex - 1], order[currentIndex]] = [order[currentIndex] as string, order[currentIndex - 1] as string];
      const request: PanelProviderOrderUpdate = { type: "panel:provider-order-update", protocolVersion: PROTOCOL_VERSION, order };
      void mutate(request, "Updating provider priority…")
        .catch((error: unknown) => renderStatus("Provider update failed.", error instanceof Error ? error.message : "Unknown error."));
    });
    const down = createElement("button", "secondary small", "↓");
    down.type = "button";
    down.title = "Move provider later";
    down.disabled = !state.order.includes(id) || state.order.indexOf(id) === state.order.length - 1;
    down.addEventListener("click", () => {
      const order = [...state.order];
      const currentIndex = order.indexOf(id);
      if (currentIndex < 0 || currentIndex >= order.length - 1) return;
      [order[currentIndex], order[currentIndex + 1]] = [order[currentIndex + 1] as string, order[currentIndex] as string];
      const request: PanelProviderOrderUpdate = { type: "panel:provider-order-update", protocolVersion: PROTOCOL_VERSION, order };
      void mutate(request, "Updating provider priority…")
        .catch((error: unknown) => renderStatus("Provider update failed.", error instanceof Error ? error.message : "Unknown error."));
    });
    const remove = createElement("button", "secondary small", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => {
      if (!window.confirm(`Remove provider profile ${profile.id}? The stored API key for this profile will be deleted.`)) return;
      const request: PanelProviderProfileRemove = {
        type: "panel:provider-profile-remove",
        protocolVersion: PROTOCOL_VERSION,
        providerId: profile.id,
      };
      void mutate(request, `Removing ${profile.id}…`)
        .catch((error: unknown) => renderStatus("Provider removal failed.", error instanceof Error ? error.message : "Unknown error."));
    });
    actions.append(up, down, remove);
    row.append(copy, actions);
    providerListElement.append(row);
  });
}

function renderPauseAll(): void {
  const paused = overview?.emergencyPaused === true;
  pauseAllButton.textContent = paused ? "Resume All" : "Pause All";
  pauseAllButton.className = paused ? "secondary" : "danger";
}

function renderAll(): void {
  renderPauseAll();
  renderCurrentTab();
  renderChats();
  renderDefaults();
  renderProviders();
}

async function refreshOverview(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  refreshButton.disabled = true;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = activeTab?.id;
    const request: PanelOverviewRequest = { type: "panel:overview-request", protocolVersion: PROTOCOL_VERSION };
    const response = assertSuccess(await send(request));
    if (response.type !== "background:overview") throw new Error("The service worker returned an unexpected overview response.");
    overview = response;
    renderAll();
    const managedCount = response.chats.filter((chat) => chat.policy?.mode !== undefined && chat.policy.mode !== "OFF").length;
    renderStatus(
      response.emergencyPaused ? "All automatic sends are paused." : "Guardian is ready.",
      `${managedCount} managed of ${response.chats.length} connected chat tab${response.chats.length === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    renderStatus("Management state unavailable.", error instanceof Error ? error.message : "The service worker could not answer the request.");
  } finally {
    refreshing = false;
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => {
  void refreshOverview();
});

pauseAllButton.addEventListener("click", () => {
  const paused = overview?.emergencyPaused === true;
  const request: PanelEmergencyPauseUpdate = {
    type: "panel:emergency-pause-update",
    protocolVersion: PROTOCOL_VERSION,
    paused: !paused,
  };
  void mutate(request, paused ? "Resuming automatic supervision…" : "Pausing all automatic sends…")
    .catch((error: unknown) => renderStatus("Pause update failed.", error instanceof Error ? error.message : "Unknown error."));
});

defaultsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const notificationInputs = [...defaultNotificationsElement.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const patch: Partial<AutomationPolicyDefaults> = {
      settleDelayMs: readRequiredInteger(defaultsForm, "settleDelayMs"),
      continueDelayMs: readRequiredInteger(defaultsForm, "continueDelayMs"),
      cooldownMs: readRequiredInteger(defaultsForm, "cooldownMs"),
      continuationText: getNamedInput(defaultsForm, "continuationText").value.trim(),
      notificationTriggers: selectedNotifications(notificationInputs),
    };
    const request: PanelAutomationDefaultsUpdate = {
      type: "panel:automation-defaults-update",
      protocolVersion: PROTOCOL_VERSION,
      patch,
    };
    void mutate(request, "Saving global defaults…")
      .catch((error: unknown) => renderStatus("Default update failed.", error instanceof Error ? error.message : "Unknown error."));
  } catch (error) {
    renderStatus("Invalid global defaults.", error instanceof Error ? error.message : "Review the form values.");
  }
});

function syncProviderFormKind(): void {
  const kind = getNamedSelect(providerForm, "kind").value;
  const baseUrl = getNamedInput(providerForm, "baseUrl");
  const generic = kind === "OPENAI_COMPATIBLE";
  providerBaseUrlField.hidden = !generic;
  baseUrl.required = generic;
}

getNamedSelect(providerForm, "kind").addEventListener("change", syncProviderFormKind);
syncProviderFormKind();

providerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const kind = getNamedSelect(providerForm, "kind").value;
    const id = getNamedInput(providerForm, "id").value.trim();
    const model = getNamedInput(providerForm, "model").value.trim();
    const apiKeyInput = getNamedInput(providerForm, "apiKey");
    const apiKey = apiKeyInput.value.trim();
    const makePrimary = getNamedInput(providerForm, "makePrimary").checked;
    let profile: ProviderProfile;
    let originPattern: string;
    if (kind === "OPENROUTER") {
      profile = { kind: "OPENROUTER", id, model, apiKey };
      originPattern = "https://openrouter.ai/*";
    } else if (kind === "OPENAI_COMPATIBLE") {
      const baseUrl = getNamedInput(providerForm, "baseUrl").value.trim();
      const url = new URL(baseUrl);
      if (url.protocol !== "https:") throw new Error("Provider base URL must use HTTPS.");
      profile = { kind: "OPENAI_COMPATIBLE", id, model, apiKey, baseUrl };
      originPattern = `${url.origin}/*`;
    } else {
      throw new Error("Choose a supported provider type.");
    }

    void (async () => {
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) throw new Error("Host permission is required for this provider endpoint.");
      const request: PanelProviderProfileUpsert = {
        type: "panel:provider-profile-upsert",
        protocolVersion: PROTOCOL_VERSION,
        profile,
        makePrimary,
      };
      await mutate(request, `Saving provider ${id}…`);
      apiKeyInput.value = "";
    })().catch((error: unknown) => {
      renderStatus("Provider setup failed.", error instanceof Error ? error.message : "Unknown error.");
    });
  } catch (error) {
    renderStatus("Invalid provider configuration.", error instanceof Error ? error.message : "Review the provider form.");
  }
});

void refreshOverview();
