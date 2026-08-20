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

interface TelegramResponse {
  type: "background:telegram-settings" | "background:telegram-test-result" | "background:telegram-error";
  protocolVersion: typeof PROTOCOL_VERSION;
  telegram?: RedactedTelegramSettings;
  message?: string;
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
  help.textContent = "Setup: create a bot with @BotFather, start/contact the bot or add it to the destination so it can send there, then enter the token and Chat ID here. The token stays in trusted extension storage. Telegram receives only bounded Guardian notification metadata, not full chat content by default.";

  const actions = e("div", "wide form-actions");
  const test = e("button", "secondary", "Test notification");
  test.type = "button";
  const save = e("button", undefined, "Save Telegram settings");
  save.type = "submit";
  actions.append(test, save);

  const status = e("p", "meta wide");
  status.setAttribute("aria-live", "polite");

  form.append(enabledLabel, destinationLabel, tokenLabel, modeLabel, customEvents, help, actions, status);
  root.append(form);
  return { root, form, enabled, destination, token, eventMode, customEvents, eventInputs, configured, enabledState, health, test, status };
}

const ui = buildSection();
const providersHeading = document.querySelector("#providers-heading");
const providersSection = providersHeading?.closest("details");
if (providersSection !== null && providersSection !== undefined) providersSection.before(ui.root);
else document.querySelector(".footer-note")?.before(ui.root);

let current: RedactedTelegramSettings | undefined;
let busy = false;

function setStatus(message: string): void {
  ui.status.textContent = message;
}

function healthText(settings: RedactedTelegramSettings): string {
  const health = settings.health;
  if (health.status === "NEVER_TESTED") return "Never tested";
  if (health.status === "HEALTHY") return "Healthy";
  return health.code === undefined ? "Delivery error" : `Error: ${health.code.toLowerCase().replaceAll("_", " ")}`;
}

function render(settings: RedactedTelegramSettings): void {
  current = settings;
  ui.enabled.checked = settings.enabled;
  ui.destination.value = settings.destination;
  ui.token.value = "";
  ui.token.placeholder = settings.configured ? "Saved token hidden - blank keeps it" : "Paste the BotFather token";
  ui.eventMode.value = settings.eventMode;
  for (const input of ui.eventInputs) input.checked = settings.events.includes(input.value as GuardianNotificationEvent);
  ui.customEvents.disabled = settings.eventMode !== "CUSTOM";
  ui.configured.textContent = settings.configured ? "Configured" : "Not configured";
  ui.configured.dataset.tone = settings.configured ? "ok" : "warn";
  ui.enabledState.textContent = settings.enabled ? "Enabled" : "Disabled";
  ui.enabledState.dataset.tone = settings.enabled ? "ok" : "warn";
  ui.health.textContent = healthText(settings);
  ui.health.dataset.tone = settings.health.status === "HEALTHY" ? "ok" : settings.health.status === "ERROR" ? "warn" : "";
}

function selectedEvents(): GuardianNotificationEvent[] {
  return ui.eventInputs
    .filter((input) => input.checked)
    .map((input) => input.value as GuardianNotificationEvent);
}

async function send(request: object): Promise<RedactedTelegramSettings> {
  const response = await chrome.runtime.sendMessage<TelegramResponse>(request);
  if (response.type === "background:telegram-error") throw new Error(response.message ?? "Telegram operation failed.");
  if (response.telegram === undefined) throw new Error("Guardian returned an unexpected Telegram response.");
  return response.telegram;
}

async function requestTelegramPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: [TELEGRAM_ORIGIN_PATTERN] });
}

async function refresh(): Promise<void> {
  if (busy) return;
  try {
    render(await send({ type: "panel:telegram-settings-request", protocolVersion: PROTOCOL_VERSION }));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Telegram settings are unavailable.");
  }
}

ui.eventMode.addEventListener("change", () => {
  ui.customEvents.disabled = ui.eventMode.value !== "CUSTOM";
});

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  const mutation: TelegramSettingsMutation = {
    enabled: ui.enabled.checked,
    destination: ui.destination.value,
    botToken: ui.token.value,
    eventMode: ui.eventMode.value === "CUSTOM" ? "CUSTOM" : "INHERIT",
    events: selectedEvents(),
  };
  busy = true;
  ui.test.disabled = true;
  setStatus("Saving Telegram settings...");
  void (async () => {
    try {
      if (mutation.enabled && !await requestTelegramPermission()) {
        throw new Error("Telegram host access was not granted; settings were not enabled.");
      }
      render(await send({ type: "panel:telegram-settings-update", protocolVersion: PROTOCOL_VERSION, settings: mutation }));
      setStatus("Telegram settings saved. Stored bot token remains hidden.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Telegram settings could not be saved.");
    } finally {
      busy = false;
      ui.test.disabled = false;
    }
  })();
});

ui.test.addEventListener("click", () => {
  if (busy) return;
  busy = true;
  ui.test.disabled = true;
  setStatus("Sending a bounded Telegram test notification...");
  void (async () => {
    try {
      if (!await requestTelegramPermission()) throw new Error("Telegram host access was not granted.");
      render(await send({ type: "panel:telegram-test-notification", protocolVersion: PROTOCOL_VERSION }));
      setStatus("Telegram test notification delivered successfully.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Telegram test delivery failed.");
      await refresh();
    } finally {
      busy = false;
      ui.test.disabled = false;
    }
  })();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});

void refresh();
