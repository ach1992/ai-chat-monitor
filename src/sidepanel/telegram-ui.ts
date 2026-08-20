import { PROTOCOL_VERSION } from "../shared/protocol.js";
import { TELEGRAM_ORIGIN_PATTERN } from "../notifications/telegram.js";
import type {
  GuardianNotificationEvent,
  RedactedTelegramSettings,
  TelegramSettingsMutation,
} from "../notifications/types.js";

const EVENTS: ReadonlyArray<{ value: GuardianNotificationEvent; label: string }> = [
  { value: "RESPONSE_COMPLETE", label: "Assistant response completed" },
  { value: "HUMAN_ATTENTION_REQUIRED", label: "HOLD / human attention required" },
  { value: "UNSURE", label: "UNSURE" },
  { value: "STAGNATION", label: "Stagnation" },
  { value: "PROVIDER_ERROR", label: "Provider error" },
  { value: "EXTENSION_ERROR", label: "Extension / platform error" },
];

type TelegramErrorCode =
  | "INVALID_SENDER"
  | "INVALID_CONFIG"
  | "PERMISSION_REQUIRED"
  | "DELIVERY_FAILED"
  | "STORAGE_FAILURE";

interface TelegramResponse {
  type: "background:telegram-settings" | "background:telegram-test-result" | "background:telegram-error";
  protocolVersion: typeof PROTOCOL_VERSION;
  telegram?: RedactedTelegramSettings;
  code?: TelegramErrorCode;
  message?: string;
}

class TelegramPanelError extends Error {
  readonly code?: TelegramErrorCode;

  constructor(message: string, code?: TelegramErrorCode) {
    super(message);
    this.name = "TelegramPanelError";
    this.code = code;
  }
}

function e<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function buildSection(): {
  root: HTMLDetailsElement;
  form: HTMLFormElement;
  enabled: HTMLInputElement;
  destination: HTMLInputElement;
  token: HTMLInputElement;
  eventMode: HTMLSelectElement;
  customEvents: HTMLFieldSetElement;
  eventInputs: HTMLInputElement[];
  configured: HTMLElement;
  enabledState: HTMLElement;
  health: HTMLElement;
  test: HTMLButtonElement;
  save: HTMLButtonElement;
  status: HTMLElement;
} {
  const root = e("details", "panel-section disclosure");
  const summary = e("summary", "section-heading");
  const title = e("div");
  title.append(e("p", "eyebrow", "Notifications"), e("h2", undefined, "Telegram"));
  summary.append(title);
  root.append(summary);

  root.append(e(
    "p",
    "section-note",
    "Optional outbound-only alerts through your own Telegram bot. Telegram can never approve, control, or send ChatGPT turns.",
  ));

  const stateRow = e("div", "meta-row");
  const configured = e("span", "badge", "Not configured");
  const enabledState = e("span", "badge", "Disabled");
  const health = e("span", "badge", "Never tested");
  stateRow.append(configured, enabledState, health);
  root.append(stateRow);

  const status = e("p", "meta telegram-operation-status");
  status.setAttribute("aria-live", "polite");
  root.append(status);

  const form = e("form", "form-grid");
  const enabledLabel = e("label", "checkbox-row wide");
  const enabled = e("input");
  enabled.type = "checkbox";
  enabled.name = "enabled";
  enabledLabel.append(enabled, e("span", undefined, "Enable Telegram notifications"));

  const destinationLabel = e("label", "wide");
  destinationLabel.append(e("span", undefined, "Chat ID / destination"));
  const destination = e("input");
  destination.type = "text";
  destination.maxLength = 64;
  destination.placeholder = "123456789 or @channel_username";
  destination.autocomplete = "off";
  destinationLabel.append(destination);

  const tokenLabel = e("label", "wide");
  tokenLabel.append(e("span", undefined, "Bot Token"));
  const token = e("input");
  token.type = "password";
  token.maxLength = 512;
  token.autocomplete = "off";
  token.placeholder = "Paste the BotFather token";
  tokenLabel.append(token);
  tokenLabel.append(e("span", "meta", "Saved tokens are never rendered back. Leave blank to keep the saved token only when the destination is unchanged."));

  const modeLabel = e("label", "wide");
  modeLabel.append(e("span", undefined, "Telegram event policy"));
  const eventMode = e("select");
  const inherit = e("option");
  inherit.value = "INHERIT";
  inherit.textContent = "Inherit Guardian notification events";
  const custom = e("option");
  custom.value = "CUSTOM";
  custom.textContent = "Use Telegram-specific event selection";
  eventMode.append(inherit, custom);
  modeLabel.append(eventMode);

  const customEvents = e("fieldset", "wide compact-fieldset");
  customEvents.append(e("legend", undefined, "Telegram events"));
  const grid = e("div", "check-grid");
  const eventInputs: HTMLInputElement[] = [];
  for (const option of EVENTS) {
    const label = e("label");
    const input = e("input");
    input.type = "checkbox";
    input.value = option.value;
    label.append(input, e("span", undefined, option.label));
    grid.append(label);
    eventInputs.push(input);
  }
  customEvents.append(grid);

  const help = e("div", "wide override-note");
  help.textContent = "Setup: create a bot with @BotFather, start/contact the bot or add it to the destination so it can send there, then enter the token and Chat ID here. The token stays in trusted extension storage. Telegram v1 receives only bounded Guardian notification metadata (event title/reason and a bounded conversation identifier when available); it never sends full ChatGPT messages and accepts no inbound commands.";

  const actions = e("div", "wide form-actions telegram-actions");
  const test = e("button", "secondary", "Test notification");
  test.type = "button";
  const save = e("button", undefined, "Save Telegram settings");
  save.type = "submit";
  actions.append(test, save);

  form.append(enabledLabel, destinationLabel, tokenLabel, modeLabel, customEvents, help, actions);
  root.append(form);
  return { root, form, enabled, destination, token, eventMode, customEvents, eventInputs, configured, enabledState, health, test, save, status };
}

const ui = buildSection();
const providersHeading = document.querySelector("#providers-heading");
const providersSection = providersHeading?.closest("details");
if (providersSection !== null && providersSection !== undefined) providersSection.before(ui.root);
else document.querySelector(".footer-note")?.before(ui.root);

let busy = false;
let dirty = false;

function setStatus(message: string): void {
  ui.status.textContent = message;
}

function setBusy(value: boolean): void {
  busy = value;
  ui.test.disabled = value;
  ui.save.disabled = value;
}

function healthText(settings: RedactedTelegramSettings): string {
  const health = settings.health;
  if (health.status === "NEVER_TESTED") return "Never tested";
  if (health.status === "HEALTHY") return "Healthy";
  return health.code === undefined ? "Delivery error" : `Error: ${health.code.toLowerCase().replaceAll("_", " ")}`;
}

function renderBadges(settings: RedactedTelegramSettings): void {
  ui.configured.textContent = settings.configured ? "Configured" : "Not configured";
  ui.configured.dataset.tone = settings.configured ? "ok" : "warn";
  ui.enabledState.textContent = settings.enabled ? "Enabled" : "Disabled";
  ui.enabledState.dataset.tone = settings.enabled ? "ok" : "warn";
  ui.health.textContent = healthText(settings);
  ui.health.dataset.tone = settings.health.status === "HEALTHY" ? "ok" : settings.health.status === "ERROR" ? "warn" : "";
}

function renderForm(settings: RedactedTelegramSettings): void {
  ui.enabled.checked = settings.enabled;
  ui.destination.value = settings.destination;
  ui.token.value = "";
  ui.token.placeholder = settings.configured ? "Saved token hidden - enter a new token to replace it" : "Paste the BotFather token";
  ui.eventMode.value = settings.eventMode;
  for (const input of ui.eventInputs) input.checked = settings.events.includes(input.value as GuardianNotificationEvent);
  ui.customEvents.disabled = settings.eventMode !== "CUSTOM";
  dirty = false;
}

function render(settings: RedactedTelegramSettings, hydrateForm: boolean): void {
  renderBadges(settings);
  if (hydrateForm) renderForm(settings);
}

function selectedEvents(): GuardianNotificationEvent[] {
  return ui.eventInputs
    .filter((input) => input.checked)
    .map((input) => input.value as GuardianNotificationEvent);
}

function collectMutation(): TelegramSettingsMutation {
  return {
    enabled: ui.enabled.checked,
    destination: ui.destination.value,
    botToken: ui.token.value,
    eventMode: ui.eventMode.value === "CUSTOM" ? "CUSTOM" : "INHERIT",
    events: selectedEvents(),
  };
}

async function send(request: object): Promise<RedactedTelegramSettings> {
  const response = await chrome.runtime.sendMessage<TelegramResponse>(request);
  if (response.type === "background:telegram-error") {
    throw new TelegramPanelError(response.message ?? "Telegram operation failed.", response.code);
  }
  if (response.telegram === undefined) throw new TelegramPanelError("Guardian returned an unexpected Telegram response.");
  return response.telegram;
}

async function requestTelegramPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: [TELEGRAM_ORIGIN_PATTERN] });
}

async function refresh(allowWhileBusy = false): Promise<void> {
  if (busy && !allowWhileBusy) return;
  try {
    const settings = await send({ type: "panel:telegram-settings-request", protocolVersion: PROTOCOL_VERSION });
    render(settings, !dirty);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Telegram settings are unavailable.");
  }
}

function operationError(error: unknown, fallback: string): string {
  if (error instanceof TelegramPanelError && error.code !== undefined) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : fallback;
}

ui.form.addEventListener("input", () => {
  dirty = true;
});

ui.form.addEventListener("change", () => {
  dirty = true;
});

ui.eventMode.addEventListener("change", () => {
  ui.customEvents.disabled = ui.eventMode.value !== "CUSTOM";
});

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  const mutation = collectMutation();
  setBusy(true);
  setStatus("Saving Telegram settings...");
  void (async () => {
    try {
      if (mutation.enabled && !await requestTelegramPermission()) {
        throw new TelegramPanelError("Telegram host access was not granted; settings were not enabled.", "PERMISSION_REQUIRED");
      }
      const settings = await send({ type: "panel:telegram-settings-update", protocolVersion: PROTOCOL_VERSION, settings: mutation });
      render(settings, true);
      setStatus("Telegram settings saved. Stored bot token remains hidden.");
    } catch (error) {
      setStatus(operationError(error, "Telegram settings could not be saved."));
    } finally {
      setBusy(false);
    }
  })();
});

ui.test.addEventListener("click", () => {
  if (busy) return;
  const mutation = collectMutation();
  const testingDraft = dirty;
  setBusy(true);
  setStatus("Sending a bounded Telegram test notification from the current form...");
  void (async () => {
    try {
      if (!await requestTelegramPermission()) {
        throw new TelegramPanelError("Telegram host access was not granted.", "PERMISSION_REQUIRED");
      }
      await send({
        type: "panel:telegram-test-notification",
        protocolVersion: PROTOCOL_VERSION,
        settings: mutation,
      });
      await refresh(true);
      setStatus(testingDraft
        ? "Telegram test notification delivered from the current form. Save settings to keep these values."
        : "Telegram test notification delivered successfully.");
    } catch (error) {
      await refresh(true);
      setStatus(operationError(error, "Telegram test delivery failed."));
    } finally {
      setBusy(false);
    }
  })();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});

void refresh();
