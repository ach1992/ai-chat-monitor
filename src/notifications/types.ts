export type GuardianNotificationEvent =
  | "RESPONSE_COMPLETE"
  | "HUMAN_ATTENTION_REQUIRED"
  | "UNSURE"
  | "STAGNATION"
  | "PROVIDER_ERROR"
  | "EXTENSION_ERROR";

export interface GuardianNotification {
  id: string;
  event: GuardianNotificationEvent;
  title: string;
  message: string;
  browserEnabled: boolean;
  conversationId?: string;
}

export interface NotificationChannel {
  send(notification: GuardianNotification): Promise<void>;
}

export type TelegramEventMode = "INHERIT" | "CUSTOM";

export type TelegramHealthStatus = "NEVER_TESTED" | "HEALTHY" | "ERROR";

export type TelegramHealthCode =
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "AUTHENTICATION"
  | "DESTINATION"
  | "NETWORK"
  | "API_ERROR";

export interface TelegramHealth {
  status: TelegramHealthStatus;
  checkedAt?: number;
  code?: TelegramHealthCode;
}

export interface TelegramSettingsState {
  version: 1;
  enabled: boolean;
  destination: string;
  eventMode: TelegramEventMode;
  events: GuardianNotificationEvent[];
  health: TelegramHealth;
  botToken?: string;
}

export interface TelegramSettingsMutation {
  enabled: boolean;
  destination: string;
  botToken: string;
  eventMode: TelegramEventMode;
  events: GuardianNotificationEvent[];
}

export interface RedactedTelegramSettings {
  enabled: boolean;
  configured: boolean;
  destination: string;
  eventMode: TelegramEventMode;
  events: GuardianNotificationEvent[];
  health: TelegramHealth;
}
