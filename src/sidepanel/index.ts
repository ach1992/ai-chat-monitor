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

const NOTIFICATIONS: ReadonlyArray<{ value: NotificationTrigger; label: string }> = [
  { value: "RESPONSE_FINISHED", label: "Response finished" },
  { value: "HOLD", label: "Human attention / HOLD" },
  { value: "UNSURE", label: "UNSURE" },
  { value: "ERROR", label: "Provider / extension error" },
  { value: "STAGNATION", label: "Stagnation" },
];

const MODES: ReadonlyArray<{ value: ChatAutomationMode; label: string }> = [
  { value: "OFF", label: "Off" },
  { value: "OBSERVE", label: "Observe" },
  { value: "AUTO", label: "Auto" },
  { value: "NOTIFY_ONLY", label: "Notify only" },
];

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

function shortId(value: string | undefined): string {
  if (value === undefined) return "no conversation id";
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function chatTitle(chat: ManagedChatStatus): string {
  const title = chat.pageTitle?.trim();
  if (title !== undefined && title.length > 0) return title;
  return chat.conversationId === undefined ? `Tab ${chat.tabId}` : `Conversation ${shortId(chat.conversationId)}`;
}

function modeText(mode: ChatAutomationMode | undefined): string {
  return MODES.find((candidate) => candidate.value === mode)?.label ?? "Off";
}

const statusElement = q<HTMLElement>("[data-status]");
const detailsElement = q<HTMLElement>("[data-details]");
const refreshButton = q<HTMLButtonElement>("[data-refresh]");
const pauseAllButton = q<HTMLButtonElement>("[data-pause-all]");
const currentTabElement = q<HTMLElement>("[data-current-tab]");
const chatListElement = q<HTMLElement>("[data-chat-list]");
const chatCountElement = q<HTMLElement>("[data-chat-count]");
const defaultsForm = q<HTMLFormElement>("[data-defaults-form]");
const defaultNotificationsElement = q<HTMLElement>("[data-default-notifications]");
const providerListElement = q<HTMLElement>("[data-provider-list]");
const providerForm = q<HTMLFormElement>("[data-provider-form]");
const providerBaseUrlField = q<HTMLElement>("[data-base-url-field]");

let overview: PanelOverviewResponse | undefined;
let activeTabId: number | undefined;
let refreshing = false;

function status(message: string, details: string): void {
  statusElement.textContent = message;
  detailsElement.textContent = details;
}

async function send(request: object): Promise<GuardianResponse> {
  return chrome.runtime.sendMessage<GuardianResponse>(request);
}

function requireSuccess(response: GuardianResponse): GuardianResponse {
  if (response.type === "background:error") throw new Error(response.message);
  return response;
}

async function mutate(request: object, message: string): Promise<void> {
  status(message, "Pending automatic decisions remain fail-closed while configuration changes persist.");
  requireSuccess(await send(request));
  await refreshOverview();
}

function namedInput(form: HTMLFormElement, name: string): HTMLInputElement {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLInputElement)) throw new Error(`Missing input ${name}.`);
  return control;
}

function namedSelect(form: HTMLFormElement, name: string): HTMLSelectElement {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLSelectElement)) throw new Error(`Missing select ${name}.`);
  return control;
}

function requiredInteger(form: HTMLFormElement, name: string): number {
  const value = Number(namedInput(form, name).value);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function optionalInteger(input: HTMLInputElement): number | null {
  if (input.value.trim().length === 0) return null;
  const value = Number(input.value);
  if (!Number.isInteger(value)) throw new Error("Timing override must be an integer or blank to inherit.");
  return value;
}

function checkedNotifications(inputs: readonly HTMLInputElement[]): NotificationTrigger[] {
  return inputs.filter((input) => input.checked).map((input) => input.value as NotificationTrigger);
}

function primaryProviderText(): string {
  const state = overview?.providers;
  if (state === undefined || state.order.length === 0) return "No AI provider configured";
  const primaryId = state.order[0];
  if (primaryId === undefined) return "No AI provider configured";
  const profile = state.profiles.find((candidate) => candidate.id === primaryId);
  return profile === undefined ? `Provider ${primaryId} is missing` : `${profile.id} · ${profile.model}`;
}

function modeSelect(value: ChatAutomationMode): HTMLSelectElement {
  const select = e("select");
  for (const candidate of MODES) {
    const option = e("option");
    option.value = candidate.value;
    option.textContent = candidate.label;
    option.selected = candidate.value === value;
    select.append(option);
  }
  return select;
}

function overrideInput(
  labelText: string,
  value: number | string | undefined,
  placeholder: string,
  options: { type?: "number" | "text"; max?: number } = {},
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = e("label");
  const input = e("input");
  input.type = options.type ?? "number";
  input.value = value === undefined ? "" : String(value);
  input.placeholder = placeholder;
  if (input.type === "number") {
    input.min = "0";
    input.step = "100";
    if (options.max !== undefined) input.max = String(options.max);
  } else {
    input.maxLength = options.max ?? 200;
  }
  label.append(e("span", undefined, labelText), input);
  return { label, input };
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
  if (chat?.conversationId === undefined) {
    currentTabElement.className = "empty-state";
    currentTabElement.textContent = "The active tab is not a connected ChatGPT conversation yet.";
    return;
  }

  currentTabElement.className = "current-card";
  const head = e("div", "chat-card-head");
  const title = e("div", "title-block");
  title.append(e("h3", "chat-title", chatTitle(chat)), e("div", "meta", `Tab ${chat.tabId} · ${shortId(chat.conversationId)}`));
  const actions = e("div", "inline-actions");
  const currentMode = chat.policy?.mode ?? "OFF";
  const toggle = e("button", currentMode === "OFF" ? undefined : "secondary", currentMode === "OFF" ? "Enable observe" : "Disable");
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
      .catch((error: unknown) => status("Update failed.", error instanceof Error ? error.message : "Unknown error."));
  });
  const focus = e("button", "secondary", "Focus");
  focus.type = "button";
  focus.addEventListener("click", () => {
    void chrome.tabs.update(chat.tabId, { active: true })
      .then(() => status("Chat focused.", chatTitle(chat)))
      .catch(() => status("Unable to focus chat.", "The browser rejected the tab activation request."));
  });
  actions.append(toggle, focus);
  head.append(title, actions);

  const meta = e("div", "meta-row");
  badge(meta, modeText(currentMode), currentMode === "AUTO" ? "ok" : undefined);
  badge(meta, chat.controlEligibility, chat.controlEligibility === "OWNER" ? "ok" : chat.controlEligibility === "MIRROR" ? "warn" : undefined);
  if (chat.runtime !== undefined) badge(meta, chat.runtime.phase, chat.runtime.phase === "AMBIGUOUS_WRITE" ? "warn" : undefined);
  currentTabElement.append(head, meta, e("div", "meta", primaryProviderText()));
}

function notificationEditor(
  chat: ManagedChatStatus,
): { fieldset: HTMLFieldSetElement; inherit: HTMLInputElement; inputs: HTMLInputElement[] } {
  const fieldset = e("fieldset", "compact-fieldset wide");
  fieldset.append(e("legend", undefined, "Notifications"));
  const inheritRow = e("label", "checkbox-row");
  const inherit = e("input");
  inherit.type = "checkbox";
  inherit.checked = chat.overrides?.notificationTriggers === undefined;
  inheritRow.append(inherit, e("span", undefined, "Inherit global notification policy"));
  fieldset.append(inheritRow);

  const grid = e("div", "check-grid");
  const effective = chat.overrides?.notificationTriggers ?? chat.policy?.notificationTriggers ?? [];
  const inputs: HTMLInputElement[] = [];
  for (const option of NOTIFICATIONS) {
    const label = e("label");
    const input = e("input");
    input.type = "checkbox";
    input.value = option.value;
    input.checked = effective.includes(option.value);
    input.disabled = inherit.checked;
    label.append(input, e("span", undefined, option.label));
    grid.append(label);
    inputs.push(input);
  }
  inherit.addEventListener("change", () => {
    for (const input of inputs) input.disabled = inherit.checked;
  });
  fieldset.append(grid);
  return { fieldset, inherit, inputs };
}

function createChatCard(chat: ManagedChatStatus): HTMLElement {
  const card = e("article", "chat-card");
  const mode = chat.policy?.mode ?? "OFF";
  card.dataset.managed = String(mode !== "OFF");

  const head = e("div", "chat-card-head");
  const title = e("div", "title-block");
  title.append(e("h3", "chat-title", chatTitle(chat)), e("div", "meta", `Tab ${chat.tabId} · ${shortId(chat.conversationId)}`));
  const focus = e("button", "secondary small", "Focus");
  focus.type = "button";
  focus.addEventListener("click", () => {
    void chrome.tabs.update(chat.tabId, { active: true })
      .then(() => status("Chat focused.", chatTitle(chat)))
      .catch(() => status("Unable to focus chat.", "The browser rejected the tab activation request."));
  });
  head.append(title, focus);

  const meta = e("div", "meta-row");
  badge(meta, modeText(mode), mode === "AUTO" ? "ok" : undefined);
  badge(meta, chat.controlEligibility, chat.controlEligibility === "OWNER" ? "ok" : chat.controlEligibility === "MIRROR" ? "warn" : undefined);
  if (chat.generation !== undefined) badge(meta, chat.generation);
  if (chat.runtime !== undefined) badge(meta, chat.runtime.phase, chat.runtime.phase === "AMBIGUOUS_WRITE" ? "warn" : undefined);

  if (chat.conversationId === undefined || chat.policy === undefined) {
    card.append(head, meta, e("div", "reason", "Waiting for a stable ChatGPT conversation identity."));
    return card;
  }

  const controls = e("div", "chat-controls");
  const modeLabel = e("label");
  const modeControl = modeSelect(mode);
  modeLabel.append(e("span", undefined, "Mode"), modeControl);
  const settle = overrideInput("Settle override (ms)", chat.overrides?.settleDelayMs, `Inherit ${chat.policy.timing.settleDelayMs}`, { max: 60_000 });
  const continuationDelay = overrideInput("Continue override (ms)", chat.overrides?.continueDelayMs, `Inherit ${chat.policy.timing.continueDelayMs}`, { max: 60_000 });
  const cooldown = overrideInput("Cooldown override (ms)", chat.overrides?.cooldownMs, `Inherit ${chat.policy.timing.cooldownMs}`, { max: 300_000 });
  const continuation = overrideInput("Continuation text override", chat.overrides?.continuationText, `Inherit: ${chat.policy.continuationText}`, { type: "text", max: 200 });
  continuation.label.classList.add("wide");
  const notifications = notificationEditor(chat);
  const note = e("div", "override-note", `AI provider: ${primaryProviderText()} · blank timing/text fields inherit global defaults.`);
  const actions = e("div", "wide form-actions");
  const save = e("button", undefined, "Save chat policy");
  save.type = "button";
  save.addEventListener("click", () => {
    try {
      const continuationText = continuation.input.value.trim();
      const patch: ChatAutomationPolicyPatch = {
        mode: modeControl.value as ChatAutomationMode,
        settleDelayMs: optionalInteger(settle.input),
        continueDelayMs: optionalInteger(continuationDelay.input),
        cooldownMs: optionalInteger(cooldown.input),
        continuationText: continuationText.length === 0 ? null : continuationText,
        notificationTriggers: notifications.inherit.checked ? null : checkedNotifications(notifications.inputs),
      };
      const request: PanelAutomationPolicyUpdate = {
        type: "panel:automation-policy-update",
        protocolVersion: PROTOCOL_VERSION,
        tabId: chat.tabId,
        conversationId: chat.conversationId as string,
        patch,
      };
      void mutate(request, `Saving ${chatTitle(chat)}…`)
        .catch((error: unknown) => status("Chat policy update failed.", error instanceof Error ? error.message : "Unknown error."));
    } catch (error) {
      status("Invalid chat policy.", error instanceof Error ? error.message : "Review the timing fields.");
    }
  });
  actions.append(save);
  controls.append(modeLabel, settle.label, continuationDelay.label, cooldown.label, continuation.label, notifications.fieldset, note, actions);

  card.append(head, meta);
  if (chat.runtime !== undefined) {
    const runtime = e("div", "runtime-row");
    runtime.append(e("span", "meta", `Runtime: ${chat.runtime.phase}`));
    if (chat.runtime.lastDecision !== undefined) runtime.append(e("span", "meta", `Decision: ${chat.runtime.lastDecision.decision}`));
    if (chat.runtime.phase === "SETTLING") runtime.append(e("span", "meta", `Delay: ${chat.policy.timing.settleDelayMs} ms`));
    if (chat.runtime.phase === "WAITING_TO_CONTINUE") runtime.append(e("span", "meta", `Delay: ${chat.policy.timing.continueDelayMs} ms`));
    if (chat.runtime.phase === "COOLDOWN") runtime.append(e("span", "meta", `Cooldown: ${chat.policy.timing.cooldownMs} ms`));
    card.append(runtime);
    if (chat.runtime.reason !== undefined) card.append(e("div", "reason", chat.runtime.reason));
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
    return chatTitle(left).localeCompare(chatTitle(right));
  });
  chatCountElement.textContent = String(chats.length);
  if (chats.length === 0) {
    chatListElement.append(e("div", "empty-state", "No connected ChatGPT tabs are visible to the extension."));
    return;
  }
  for (const chat of chats) chatListElement.append(createChatCard(chat));
}

function renderDefaults(): void {
  const defaults = overview?.defaults;
  if (defaults === undefined) return;
  namedInput(defaultsForm, "settleDelayMs").value = String(defaults.settleDelayMs);
  namedInput(defaultsForm, "continueDelayMs").value = String(defaults.continueDelayMs);
  namedInput(defaultsForm, "cooldownMs").value = String(defaults.cooldownMs);
  namedInput(defaultsForm, "continuationText").value = defaults.continuationText;
  defaultNotificationsElement.replaceChildren();
  for (const option of NOTIFICATIONS) {
    const label = e("label");
    const input = e("input");
    input.type = "checkbox";
    input.value = option.value;
    input.checked = defaults.notificationTriggers.includes(option.value);
    label.append(input, e("span", undefined, option.label));
    defaultNotificationsElement.append(label);
  }
}

function reordered(order: readonly string[], from: number, to: number): string[] {
  const next = [...order];
  if (from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const moving = next[from];
  if (moving === undefined) return next;
  next.splice(from, 1);
  next.splice(to, 0, moving);
  return next;
}

function renderProviders(): void {
  providerListElement.replaceChildren();
  const state = overview?.providers;
  if (state === undefined || state.profiles.length === 0) {
    providerListElement.append(e("div", "empty-state", "No AI provider is configured. AUTO remains fail-closed on ambiguous stops."));
    return;
  }

  const byId = new Map(state.profiles.map((profile) => [profile.id, profile] as const));
  const ids = [...state.order, ...state.profiles.map((profile) => profile.id).filter((id) => !state.order.includes(id))];
  for (const id of ids) {
    const profile = byId.get(id);
    if (profile === undefined) continue;
    const orderIndex = state.order.indexOf(id);
    const row = e("div", "provider-row");
    const copy = e("div", "provider-copy");
    const title = e("div", "meta-row");
    title.append(e("strong", undefined, profile.id));
    if (orderIndex === 0) badge(title, "Primary", "ok");
    copy.append(title, e("div", "meta", `${profile.kind} · ${profile.model}`), e("div", "meta", profile.endpoint));

    const actions = e("div", "provider-actions");
    const up = e("button", "secondary small", "↑");
    up.type = "button";
    up.title = "Move provider earlier";
    up.disabled = orderIndex <= 0;
    up.addEventListener("click", () => {
      const request: PanelProviderOrderUpdate = {
        type: "panel:provider-order-update",
        protocolVersion: PROTOCOL_VERSION,
        order: reordered(state.order, orderIndex, orderIndex - 1),
      };
      void mutate(request, "Updating provider priority…")
        .catch((error: unknown) => status("Provider update failed.", error instanceof Error ? error.message : "Unknown error."));
    });

    const down = e("button", "secondary small", "↓");
    down.type = "button";
    down.title = "Move provider later";
    down.disabled = orderIndex < 0 || orderIndex >= state.order.length - 1;
    down.addEventListener("click", () => {
      const request: PanelProviderOrderUpdate = {
        type: "panel:provider-order-update",
        protocolVersion: PROTOCOL_VERSION,
        order: reordered(state.order, orderIndex, orderIndex + 1),
      };
      void mutate(request, "Updating provider priority…")
        .catch((error: unknown) => status("Provider update failed.", error instanceof Error ? error.message : "Unknown error."));
    });

    const remove = e("button", "secondary small", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => {
      if (!window.confirm(`Remove provider profile ${profile.id}? The stored API key for this profile will be deleted.`)) return;
      const request: PanelProviderProfileRemove = {
        type: "panel:provider-profile-remove",
        protocolVersion: PROTOCOL_VERSION,
        providerId: profile.id,
      };
      void mutate(request, `Removing ${profile.id}…`)
        .catch((error: unknown) => status("Provider removal failed.", error instanceof Error ? error.message : "Unknown error."));
    });
    actions.append(up, down, remove);
    row.append(copy, actions);
    providerListElement.append(row);
  }
}

function renderAll(): void {
  const paused = overview?.emergencyPaused === true;
  pauseAllButton.textContent = paused ? "Resume All" : "Pause All";
  pauseAllButton.className = paused ? "secondary" : "danger";
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
    const response = requireSuccess(await send(request));
    if (response.type !== "background:overview") throw new Error("The service worker returned an unexpected overview response.");
    overview = response;
    renderAll();
    const managed = response.chats.filter((chat) => chat.policy?.mode !== undefined && chat.policy.mode !== "OFF").length;
    status(
      response.emergencyPaused ? "All automatic sends are paused." : "Guardian is ready.",
      `${managed} managed of ${response.chats.length} connected chat tab${response.chats.length === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    status("Management state unavailable.", error instanceof Error ? error.message : "The service worker could not answer the request.");
  } finally {
    refreshing = false;
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => void refreshOverview());

pauseAllButton.addEventListener("click", () => {
  const request: PanelEmergencyPauseUpdate = {
    type: "panel:emergency-pause-update",
    protocolVersion: PROTOCOL_VERSION,
    paused: overview?.emergencyPaused !== true,
  };
  void mutate(request, overview?.emergencyPaused === true ? "Resuming automatic supervision…" : "Pausing all automatic sends…")
    .catch((error: unknown) => status("Pause update failed.", error instanceof Error ? error.message : "Unknown error."));
});

defaultsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const notificationInputs = Array.from(defaultNotificationsElement.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    const patch: Partial<AutomationPolicyDefaults> = {
      settleDelayMs: requiredInteger(defaultsForm, "settleDelayMs"),
      continueDelayMs: requiredInteger(defaultsForm, "continueDelayMs"),
      cooldownMs: requiredInteger(defaultsForm, "cooldownMs"),
      continuationText: namedInput(defaultsForm, "continuationText").value.trim(),
      notificationTriggers: checkedNotifications(notificationInputs),
    };
    const request: PanelAutomationDefaultsUpdate = {
      type: "panel:automation-defaults-update",
      protocolVersion: PROTOCOL_VERSION,
      patch,
    };
    void mutate(request, "Saving global defaults…")
      .catch((error: unknown) => status("Default update failed.", error instanceof Error ? error.message : "Unknown error."));
  } catch (error) {
    status("Invalid global defaults.", error instanceof Error ? error.message : "Review the form values.");
  }
});

function syncProviderKind(): void {
  const generic = namedSelect(providerForm, "kind").value === "OPENAI_COMPATIBLE";
  providerBaseUrlField.hidden = !generic;
  namedInput(providerForm, "baseUrl").required = generic;
}

namedSelect(providerForm, "kind").addEventListener("change", syncProviderKind);
syncProviderKind();

providerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const kind = namedSelect(providerForm, "kind").value;
    const id = namedInput(providerForm, "id").value.trim();
    const model = namedInput(providerForm, "model").value.trim();
    const apiKeyInput = namedInput(providerForm, "apiKey");
    const apiKey = apiKeyInput.value.trim();
    const makePrimary = namedInput(providerForm, "makePrimary").checked;
    let profile: ProviderProfile;
    let originPattern: string;

    if (kind === "OPENROUTER") {
      profile = { kind: "OPENROUTER", id, model, apiKey };
      originPattern = "https://openrouter.ai/*";
    } else if (kind === "OPENAI_COMPATIBLE") {
      const baseUrl = namedInput(providerForm, "baseUrl").value.trim();
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
    })().catch((error: unknown) => status("Provider setup failed.", error instanceof Error ? error.message : "Unknown error."));
  } catch (error) {
    status("Invalid provider configuration.", error instanceof Error ? error.message : "Review the provider form.");
  }
});

void refreshOverview();
