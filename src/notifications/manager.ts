import {
  TelegramConfigurationError,
  TelegramSettingsStore,
  redactTelegramSettings,
  resolveTelegramSettingsMutation,
  type TelegramConfigurationIdentity,
} from "./settings.js";
import { SoundNotificationChannel } from "./sound.js";
import {
  TelegramBotApiTransport,
  TelegramDeliveryError,
  type TelegramTransport,
} from "./telegram.js";
import type {
  GuardianNotification,
  NotificationChannel,
  RedactedTelegramSettings,
  TelegramHealth,
  TelegramSettingsMutation,
  TelegramSettingsState,
} from "./types.js";

const NOTIFICATION_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAACmklEQVR4nO3byVEjQQAF0c94ACfGAvDfmvGA27jAHAgCNGqhXqpry0wH1NH/aYno0sPj88t7DNuv1hdgbRMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBVOrv25/Wl7CYACr0OX6PCARwcv+P3hsCAZzYrbF7QiCAk7o3ci8IBHBCa8ftAYEACrd11NYIBFCwvWO2RCCAQh0dsRUCARSoxHhPv18LXMn2BHCwkcdPBHCo0cdPBLC7GcZPBLCrWcZPBLC5mcZPBLCp2cZPBLC6GcdPBLCqWcdPBHC3mcdPBPBjs4+fCOBmhPETASxGGT8RwFWk8RMBXEQbP+kYQO3n48Txk04B1D5HTx0/6RBA7XP05PGTzgDUPkdPHz/pCEDtc/SO/1EXAGqfo3f8r5oDqH2O3vEvawqg9jl6x7+uGYDa72THX64ZgBI3s+ZvhxnHTxp/BdRA4Pg/1/xH4JkIHP9+zQEk5yBw/HV1ASApi8Dx1/fw+Pzy3voivtf6//IJZ/yko0+Az1rf/NavX7vuACTtRqCNn3QKIKk/BnH8pGMASb1RqOMnnQNIzh+HPH4yAIDkvJHo4yeDAEjKj+X4Hw0DICk3muN/NRSA5Ph4jn/ZcACS/SM6/nVDAki2j+n4yw0LIFk/quPfrruHQXtbeojk8PebBoDta+ivADueAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOD9A59V1Pv7P/C7AAAAAElFTkSuQmCC";
const MAX_TELEGRAM_MESSAGE_LENGTH = 700;
const TELEGRAM_DIVIDER = "━━━━━━━━━━━━";
const MAX_TELEGRAM_TITLE_HTML_LENGTH = 140;
const MAX_TELEGRAM_DETAIL_HTML_LENGTH = 260;
const MAX_TELEGRAM_CONVERSATION_HTML_LENGTH = 120;

const TELEGRAM_EVENT_ICON: Record<GuardianNotification["event"], string> = {
  RESPONSE_COMPLETE: "✅",
  CONTINUE_READY: "▶️",
  APPROVAL_REQUIRED: "👤",
  DECISION_REQUIRED: "🧭",
  HUMAN_OPERATION_REQUIRED: "🛠️",
  TASK_COMPLETE: "🏁",
  RETRY_AVAILABLE: "🔄",
  PLATFORM_ERROR: "🚨",
  NETWORK_ERROR: "🌐",
  RATE_LIMIT: "⏳",
  AUTH_REQUIRED: "🔐",
  VERIFICATION_REQUIRED: "🛡️",
  CONVERSATION_FULL: "📚",
  SEMANTIC_UNKNOWN: "❓",
  PROVIDER_ERROR: "⚠️",
  GENERATION_STALLED: "⏸️",
  REPEATED_RESPONSE: "🔁",
  EXTENSION_ERROR: "🚨",
};

export interface TelegramSettingsAccess {
  load(): Promise<TelegramSettingsState>;
  update(mutation: TelegramSettingsMutation): Promise<TelegramSettingsState>;
  updateHealth(
    health: TelegramHealth,
    expectedConfiguration?: TelegramConfigurationIdentity,
  ): Promise<TelegramSettingsState>;
}

export interface NotificationManagerOptions {
  settings: TelegramSettingsAccess;
  telegram: TelegramTransport;
  browser: NotificationChannel;
  sound?: NotificationChannel;
  now?: () => number;
}

function configured(settings: TelegramSettingsState): settings is TelegramSettingsState & { botToken: string } {
  return settings.botToken !== undefined && settings.destination.length > 0;
}

function telegramSelected(settings: TelegramSettingsState, notification: GuardianNotification): boolean {
  if (!settings.enabled || !configured(settings)) return false;
  return settings.eventMode === "INHERIT"
    ? notification.browserEnabled
    : settings.events.includes(notification.event);
}

function configurationIdentity(settings: TelegramSettingsState & { botToken: string }): TelegramConfigurationIdentity {
  return { destination: settings.destination, botToken: settings.botToken };
}

function sameConfiguration(
  stored: TelegramSettingsState,
  candidate: TelegramSettingsState & { botToken: string },
): boolean {
  return stored.botToken === candidate.botToken && stored.destination === candidate.destination;
}

function normalizedTelegramText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeTelegramHtml(value: string, maxEncodedLength: number): string {
  let escaped = "";
  for (const char of value) {
    const encoded = char === "&"
      ? "&amp;"
      : char === "<"
        ? "&lt;"
        : char === ">"
          ? "&gt;"
          : char === '"'
            ? "&quot;"
            : char === "'"
              ? "&#39;"
              : char;
    if (escaped.length + encoded.length > maxEncodedLength) break;
    escaped += encoded;
  }
  return escaped;
}

export function telegramNotificationText(notification: GuardianNotification): string {
  const title = escapeTelegramHtml(
    normalizedTelegramText(notification.title),
    MAX_TELEGRAM_TITLE_HTML_LENGTH,
  );
  const message = escapeTelegramHtml(
    normalizedTelegramText(notification.message),
    MAX_TELEGRAM_DETAIL_HTML_LENGTH,
  );
  const conversation = notification.conversationId === undefined
    ? undefined
    : escapeTelegramHtml(
      normalizedTelegramText(notification.conversationId),
      MAX_TELEGRAM_CONVERSATION_HTML_LENGTH,
    );
  const sections = [
    "<b>🛡️ Chat Turn Guardian</b>",
    TELEGRAM_DIVIDER,
    `<b>${TELEGRAM_EVENT_ICON[notification.event]} ${title}</b>`,
    ...(message.length === 0 ? [] : ["", message]),
    ...(conversation === undefined || conversation.length === 0
      ? []
      : ["", "<b>💬 Conversation</b>", `<code>${conversation}</code>`]),
  ];
  const text = sections.join("\n");
  return text.length <= MAX_TELEGRAM_MESSAGE_LENGTH
    ? text
    : "<b>🛡️ Chat Turn Guardian</b>\n🚨 Notification formatting exceeded its safe bound.";
}

function telegramTestNotificationText(): string {
  return [
    "<b>🛡️ Chat Turn Guardian</b>",
    TELEGRAM_DIVIDER,
    "<b>🧪 Telegram test successful</b>",
    "",
    "Delivery is configured correctly.",
    "<i>No chat content was included.</i>",
  ].join("\n");
}

export async function browserNotification(notification: GuardianNotification): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.notifications.create(
      notification.id,
      {
        type: "basic",
        iconUrl: NOTIFICATION_ICON,
        title: notification.title,
        message: notification.message,
        priority: 0,
      },
      () => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error("Browser notification delivery failed."));
          return;
        }
        resolve();
      },
    );
  });
}

export class NotificationManager {
  readonly #settings: TelegramSettingsAccess;
  readonly #telegram: TelegramTransport;
  readonly #browser: NotificationChannel;
  readonly #sound: NotificationChannel | undefined;
  readonly #now: () => number;

  constructor(options: NotificationManagerOptions) {
    this.#settings = options.settings;
    this.#telegram = options.telegram;
    this.#browser = options.browser;
    this.#sound = options.sound;
    this.#now = options.now ?? (() => Date.now());
  }

  async settings(): Promise<RedactedTelegramSettings> {
    return redactTelegramSettings(await this.#settings.load());
  }

  async updateTelegram(mutation: TelegramSettingsMutation): Promise<RedactedTelegramSettings> {
    return redactTelegramSettings(await this.#settings.update(mutation));
  }

  async deliver(notification: GuardianNotification): Promise<void> {
    let failed = false;

    if (notification.browserEnabled) {
      try { await this.#browser.send(notification); } catch { failed = true; }
    }

    if (notification.soundEnabled === true && this.#sound !== undefined) {
      try { await this.#sound.send(notification); } catch { failed = true; }
    }

    let settings: TelegramSettingsState | undefined;
    try { settings = await this.#settings.load(); } catch { failed = true; }

    if (settings !== undefined && telegramSelected(settings, notification) && configured(settings)) {
      const identity = configurationIdentity(settings);
      try {
        await this.#telegram.send(settings.botToken, settings.destination, telegramNotificationText(notification));
        await this.#saveHealth({ status: "HEALTHY", checkedAt: this.#now() }, identity);
      } catch (error) {
        failed = true;
        const code = error instanceof TelegramDeliveryError ? error.code : "API_ERROR";
        await this.#saveHealth({ status: "ERROR", checkedAt: this.#now(), code }, identity);
      }
    }

    if (failed) throw new Error("One or more notification channels failed; monitoring state was not changed.");
  }

  async testTelegram(mutation?: TelegramSettingsMutation): Promise<RedactedTelegramSettings> {
    const stored = await this.#settings.load();
    const settings = mutation === undefined
      ? stored
      : resolveTelegramSettingsMutation(stored, mutation);
    if (!configured(settings)) {
      throw new TelegramConfigurationError("Configure a Telegram bot token and Chat ID before sending a test notification.");
    }

    const identity = configurationIdentity(settings);
    const shouldPersistHealth = sameConfiguration(stored, settings);
    try {
      await this.#telegram.send(settings.botToken, settings.destination, telegramTestNotificationText());
      const health: TelegramHealth = { status: "HEALTHY", checkedAt: this.#now() };
      if (shouldPersistHealth) {
        const persisted = await this.#saveHealth(health, identity);
        if (persisted !== undefined) return redactTelegramSettings(persisted);
      }
      return redactTelegramSettings({ ...settings, health });
    } catch (error) {
      const code = error instanceof TelegramDeliveryError ? error.code : "API_ERROR";
      if (shouldPersistHealth) {
        await this.#saveHealth({ status: "ERROR", checkedAt: this.#now(), code }, identity);
      }
      throw error instanceof TelegramDeliveryError ? error : new TelegramDeliveryError("API_ERROR");
    }
  }

  async #saveHealth(
    health: TelegramHealth,
    expectedConfiguration: TelegramConfigurationIdentity,
  ): Promise<TelegramSettingsState | undefined> {
    try {
      return await this.#settings.updateHealth(health, expectedConfiguration);
    } catch {
      return undefined;
    }
  }
}

let defaultManager: NotificationManager | undefined;

export function defaultNotificationManager(): NotificationManager {
  if (defaultManager === undefined) {
    defaultManager = new NotificationManager({
      settings: new TelegramSettingsStore(),
      telegram: new TelegramBotApiTransport(),
      browser: { send: browserNotification },
      sound: new SoundNotificationChannel(),
    });
  }
  return defaultManager;
}
