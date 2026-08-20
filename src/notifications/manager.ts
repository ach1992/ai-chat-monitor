import {
  TelegramConfigurationError,
  TelegramSettingsStore,
  redactTelegramSettings,
} from "./settings.js";
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

const NOTIFICATION_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAACmklEQVR4nO3byVEjQQAF0c94ACfGAvDfmvGA27jAHAgCNGqhXqpry0wH1NH/aYno0sPj88t7DNuv1hdgbRMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBVOrv25/Wl7CYACr0OX6PCARwcv+P3hsCAZzYrbF7QiCAk7o3ci8IBHBCa8ftAYEACrd11NYIBFCwvWO2RCCAQh0dsRUCARSoxHhPv18LXMn2BHCwkcdPBHCo0cdPBLC7GcZPBLCrWcZPBLC5mcZPBLCp2cZPBLC6GcdPBLCqWcdPBHC3mcdPBPBjs4+fCOBmhPETASxGGT8RwFWk8RMBXEQbP+kYQO3n48Txk04B1D5HTx0/6RBA7XP05PGTzgDUPkdPHz/pCEDtc/SO/1EXAGqfo3f8r5oDqH2O3vEvawqg9jl6x7+uGYDa72THX64ZgBI3s+ZvhxnHTxp/BdRA4Pg/1/xH4JkIHP9+zQEk5yBw/HV1ASApi8Dx1/fw+Pzy3voivtf6//IJZ/yko0+Az1rf/NavX7vuACTtRqCNn3QKIKk/BnH8pGMASb1RqOMnnQNIzh+HPH4yAIDkvJHo4yeDAEjKj+X4Hw0DICk3muN/NRSA5Ph4jn/ZcACS/SM6/nVDAki2j+n4yw0LIFk/quPfrruHQXtbeojk8PebBoDta+ivADueAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOD9A59V1Pv7P/C7AAAAAElFTkSuQmCC";
const MAX_TELEGRAM_MESSAGE_LENGTH = 700;

export interface TelegramSettingsAccess {
  load(): Promise<TelegramSettingsState>;
  update(mutation: TelegramSettingsMutation): Promise<TelegramSettingsState>;
  updateHealth(health: TelegramHealth): Promise<TelegramSettingsState>;
}

export interface NotificationManagerOptions {
  settings: TelegramSettingsAccess;
  telegram: TelegramTransport;
  browser: NotificationChannel;
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

export function telegramNotificationText(notification: GuardianNotification): string {
  const title = notification.title.replace(/\s+/g, " ").trim().slice(0, 120);
  const message = notification.message.replace(/\s+/g, " ").trim().slice(0, 360);
  const conversation = notification.conversationId === undefined
    ? undefined
    : `Conversation: ${notification.conversationId.slice(0, 80)}`;
  return ["Chat Turn Guardian", title, message, conversation]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n")
    .slice(0, MAX_TELEGRAM_MESSAGE_LENGTH);
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
  readonly #now: () => number;

  constructor(options: NotificationManagerOptions) {
    this.#settings = options.settings;
    this.#telegram = options.telegram;
    this.#browser = options.browser;
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
      try {
        await this.#browser.send(notification);
      } catch {
        failed = true;
      }
    }

    let settings: TelegramSettingsState | undefined;
    try {
      settings = await this.#settings.load();
    } catch {
      failed = true;
    }

    if (settings !== undefined && telegramSelected(settings, notification) && configured(settings)) {
      try {
        await this.#telegram.send(settings.botToken, settings.destination, telegramNotificationText(notification));
        await this.#saveHealth({ status: "HEALTHY", checkedAt: this.#now() });
      } catch (error) {
        failed = true;
        const code = error instanceof TelegramDeliveryError ? error.code : "API_ERROR";
        await this.#saveHealth({ status: "ERROR", checkedAt: this.#now(), code });
      }
    }

    if (failed) throw new Error("One or more notification channels failed; automation state was not changed.");
  }

  async testTelegram(): Promise<RedactedTelegramSettings> {
    const settings = await this.#settings.load();
    if (!configured(settings)) {
      throw new TelegramConfigurationError("Configure a Telegram bot token and Chat ID before sending a test notification.");
    }
    try {
      await this.#telegram.send(
        settings.botToken,
        settings.destination,
        "Chat Turn Guardian\nTest notification\nTelegram delivery is configured. No chat content was included.",
      );
      const health: TelegramHealth = { status: "HEALTHY", checkedAt: this.#now() };
      await this.#saveHealth(health);
      return redactTelegramSettings({ ...settings, health });
    } catch (error) {
      const code = error instanceof TelegramDeliveryError ? error.code : "API_ERROR";
      await this.#saveHealth({ status: "ERROR", checkedAt: this.#now(), code });
      throw error instanceof TelegramDeliveryError ? error : new TelegramDeliveryError("API_ERROR");
    }
  }

  async #saveHealth(health: TelegramHealth): Promise<void> {
    try {
      await this.#settings.updateHealth(health);
    } catch {
      // Health persistence is observational and must not change delivery or chat automation authority.
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
    });
  }
  return defaultManager;
}
