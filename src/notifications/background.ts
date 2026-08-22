import { PROTOCOL_VERSION } from "../shared/protocol.js";
import { defaultNotificationManager } from "./manager.js";
import { TelegramConfigurationError } from "./settings.js";
import { TELEGRAM_ORIGIN_PATTERN, TelegramDeliveryError } from "./telegram.js";
import type {
  GuardianNotificationEvent,
  RedactedTelegramSettings,
  TelegramEventMode,
  TelegramSettingsMutation,
} from "./types.js";

const ALLOWED_EVENTS = new Set<GuardianNotificationEvent>([
  "RESPONSE_COMPLETE",
  "CONTINUE_READY",
  "APPROVAL_REQUIRED",
  "DECISION_REQUIRED",
  "HUMAN_OPERATION_REQUIRED",
  "TASK_COMPLETE",
  "RETRY_AVAILABLE",
  "PLATFORM_ERROR",
  "NETWORK_ERROR",
  "RATE_LIMIT",
  "AUTH_REQUIRED",
  "VERIFICATION_REQUIRED",
  "CONVERSATION_FULL",
  "SEMANTIC_UNKNOWN",
  "PROVIDER_ERROR",
  "GENERATION_STALLED",
  "REPEATED_RESPONSE",
  "EXTENSION_ERROR",
]);

interface TelegramReadRequest {
  type: "panel:telegram-settings-request";
  protocolVersion: typeof PROTOCOL_VERSION;
}

interface TelegramUpdateRequest {
  type: "panel:telegram-settings-update";
  protocolVersion: typeof PROTOCOL_VERSION;
  settings: TelegramSettingsMutation;
}

interface TelegramTestRequest {
  type: "panel:telegram-test-notification";
  protocolVersion: typeof PROTOCOL_VERSION;
  settings?: TelegramSettingsMutation;
}

export interface TelegramSettingsResponse {
  type: "background:telegram-settings";
  protocolVersion: typeof PROTOCOL_VERSION;
  telegram: RedactedTelegramSettings;
}

export interface TelegramTestResponse {
  type: "background:telegram-test-result";
  protocolVersion: typeof PROTOCOL_VERSION;
  telegram: RedactedTelegramSettings;
}

export interface TelegramErrorResponse {
  type: "background:telegram-error";
  protocolVersion: typeof PROTOCOL_VERSION;
  code: "INVALID_SENDER" | "INVALID_CONFIG" | "PERMISSION_REQUIRED" | "DELIVERY_FAILED" | "STORAGE_FAILURE";
  message: string;
}

export type TelegramPanelResponse = TelegramSettingsResponse | TelegramTestResponse | TelegramErrorResponse;

type TelegramPanelRequest = TelegramReadRequest | TelegramUpdateRequest | TelegramTestRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isEventMode(value: unknown): value is TelegramEventMode {
  return value === "INHERIT" || value === "CUSTOM";
}

function isEvents(value: unknown): value is GuardianNotificationEvent[] {
  return Array.isArray(value) &&
    value.length <= ALLOWED_EVENTS.size &&
    value.every((event) => typeof event === "string" && ALLOWED_EVENTS.has(event as GuardianNotificationEvent)) &&
    new Set(value).size === value.length;
}

function isMutation(value: unknown): value is TelegramSettingsMutation {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, new Set(["enabled", "destination", "botToken", "eventMode", "events"]))) return false;
  return typeof value.enabled === "boolean" &&
    typeof value.destination === "string" && value.destination.length <= 64 &&
    typeof value.botToken === "string" && value.botToken.length <= 512 &&
    isEventMode(value.eventMode) &&
    isEvents(value.events);
}

function parseRequest(value: unknown): TelegramPanelRequest | undefined {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.type !== "string") return undefined;
  if (value.type === "panel:telegram-settings-request") {
    return hasOnlyKeys(value, new Set(["type", "protocolVersion"])) ? value as unknown as TelegramReadRequest : undefined;
  }
  if (value.type === "panel:telegram-test-notification") {
    if (!hasOnlyKeys(value, new Set(["type", "protocolVersion", "settings"]))) return undefined;
    if (value.settings !== undefined && !isMutation(value.settings)) return undefined;
    return value as unknown as TelegramTestRequest;
  }
  if (value.type === "panel:telegram-settings-update" && isMutation(value.settings)) {
    return hasOnlyKeys(value, new Set(["type", "protocolVersion", "settings"])) ? value as unknown as TelegramUpdateRequest : undefined;
  }
  return undefined;
}

function errorResponse(code: TelegramErrorResponse["code"], message: string): TelegramErrorResponse {
  return { type: "background:telegram-error", protocolVersion: PROTOCOL_VERSION, code, message };
}

function trustedExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.tab === undefined;
}

async function hasTelegramPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [TELEGRAM_ORIGIN_PATTERN] });
}

async function handleRequest(request: TelegramPanelRequest, sender: chrome.runtime.MessageSender): Promise<TelegramPanelResponse> {
  if (!trustedExtensionSender(sender)) {
    return errorResponse("INVALID_SENDER", "Only trusted extension pages may access Telegram notification settings.");
  }

  const manager = defaultNotificationManager();
  try {
    if (request.type === "panel:telegram-settings-request") {
      return {
        type: "background:telegram-settings",
        protocolVersion: PROTOCOL_VERSION,
        telegram: await manager.settings(),
      };
    }

    if (request.type === "panel:telegram-settings-update") {
      if (request.settings.enabled && !await hasTelegramPermission()) {
        return errorResponse("PERMISSION_REQUIRED", "Telegram host access must be granted before enabling Telegram notifications.");
      }
      return {
        type: "background:telegram-settings",
        protocolVersion: PROTOCOL_VERSION,
        telegram: await manager.updateTelegram(request.settings),
      };
    }

    if (!await hasTelegramPermission()) {
      return errorResponse("PERMISSION_REQUIRED", "Telegram host access must be granted before sending a test notification.");
    }
    return {
      type: "background:telegram-test-result",
      protocolVersion: PROTOCOL_VERSION,
      telegram: await manager.testTelegram(request.settings),
    };
  } catch (error) {
    if (error instanceof TelegramConfigurationError) return errorResponse("INVALID_CONFIG", error.message);
    if (error instanceof TelegramDeliveryError) return errorResponse("DELIVERY_FAILED", error.message);
    return errorResponse("STORAGE_FAILURE", "Telegram settings or health state could not be persisted.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const request = parseRequest(message);
  if (request === undefined) return false;
  void handleRequest(request, sender).then(sendResponse);
  return true;
});
