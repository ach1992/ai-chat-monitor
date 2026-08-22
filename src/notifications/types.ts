export type GuardianNotificationEvent =
  | "RESPONSE_COMPLETE"
  | "CONTINUE_READY"
  | "APPROVAL_REQUIRED"
  | "DECISION_REQUIRED"
  | "HUMAN_OPERATION_REQUIRED"
  | "TASK_COMPLETE"
  | "RETRY_AVAILABLE"
  | "PLATFORM_ERROR"
  | "NETWORK_ERROR"
  | "RATE_LIMIT"
  | "AUTH_REQUIRED"
  | "VERIFICATION_REQUIRED"
  | "CONVERSATION_FULL"
  | "SEMANTIC_UNKNOWN"
  | "PROVIDER_ERROR"
  | "GENERATION_STALLED"
  | "REPEATED_RESPONSE"
  | "EXTENSION_ERROR";

export interface GuardianNotification {
  id: string;
  event: GuardianNotificationEvent;
  title: string;
  message: string;
  browserEnabled: boolean;
  soundEnabled?: boolean;
  telegramInheritedEnabled?: boolean;
  conversationId?: string;
  tabId?: number;
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
