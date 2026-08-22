import { createDurableStorage, restrictDurableStorageToTrustedContexts } from "../storage/index.js";
import type {
  GuardianNotificationEvent,
  RedactedTelegramSettings,
  TelegramHealth,
  TelegramHealthCode,
  TelegramSettingsMutation,
  TelegramSettingsState,
} from "./types.js";

const SETTINGS_KEY = "config";
const ALL_EVENTS = new Set<GuardianNotificationEvent>([
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
const LEGACY_EVENT_MAP: Readonly<Record<string, readonly GuardianNotificationEvent[]>> = {
  RESPONSE_COMPLETE: ["RESPONSE_COMPLETE"],
  HUMAN_ATTENTION_REQUIRED: ["APPROVAL_REQUIRED", "DECISION_REQUIRED", "HUMAN_OPERATION_REQUIRED", "TASK_COMPLETE"],
  UNSURE: ["SEMANTIC_UNKNOWN"],
  STAGNATION: ["REPEATED_RESPONSE", "GENERATION_STALLED"],
  PROVIDER_ERROR: ["PROVIDER_ERROR"],
  EXTENSION_ERROR: ["EXTENSION_ERROR"],
};
const HEALTH_CODES = new Set<TelegramHealthCode>([
  "TIMEOUT",
  "RATE_LIMIT",
  "AUTHENTICATION",
  "DESTINATION",
  "NETWORK",
  "API_ERROR",
]);

export const DEFAULT_TELEGRAM_SETTINGS: TelegramSettingsState = {
  version: 1,
  enabled: false,
  destination: "",
  eventMode: "INHERIT",
  events: [],
  health: { status: "NEVER_TESTED" },
};

export class TelegramConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramConfigurationError";
  }
}

export interface TelegramSettingsPersistence {
  load(): Promise<TelegramSettingsState | undefined>;
  save(state: TelegramSettingsState): Promise<void>;
}

export interface TelegramConfigurationIdentity {
  destination: string;
  botToken?: string;
}

function cloneState(state: TelegramSettingsState): TelegramSettingsState {
  return structuredClone(state);
}

function normalizeDestination(value: string): string {
  const destination = value.trim();
  if (destination.length === 0) return "";
  if (destination.length > 64) throw new TelegramConfigurationError("Telegram Chat ID is too long.");
  if (!/^-?\d{1,20}$/.test(destination) && !/^@[A-Za-z0-9_]{5,32}$/.test(destination)) {
    throw new TelegramConfigurationError("Telegram Chat ID must be a numeric chat ID or an @username destination.");
  }
  return destination;
}

function normalizeBotToken(value: string): string {
  const token = value.trim();
  if (token.length < 20 || token.length > 512 || token.includes("/") || /\s/.test(token) || !/^\d{5,20}:[A-Za-z0-9_-]{10,480}$/.test(token)) {
    throw new TelegramConfigurationError("Telegram bot token format is invalid.");
  }
  return token;
}

function migrateStoredEvents(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const migrated: GuardianNotificationEvent[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return value;
    const mapped = ALL_EVENTS.has(raw as GuardianNotificationEvent)
      ? [raw as GuardianNotificationEvent]
      : LEGACY_EVENT_MAP[raw];
    if (mapped === undefined) return value;
    for (const event of mapped) {
      if (!migrated.includes(event)) migrated.push(event);
    }
  }
  return migrated;
}

function normalizeEvents(value: unknown): GuardianNotificationEvent[] {
  if (!Array.isArray(value) || value.length > ALL_EVENTS.size) {
    throw new TelegramConfigurationError("Telegram notification event selection is invalid.");
  }
  const normalized: GuardianNotificationEvent[] = [];
  for (const event of value) {
    if (typeof event !== "string" || !ALL_EVENTS.has(event as GuardianNotificationEvent)) {
      throw new TelegramConfigurationError("Telegram notification event selection is invalid.");
    }
    const typed = event as GuardianNotificationEvent;
    if (!normalized.includes(typed)) normalized.push(typed);
  }
  return normalized;
}

function normalizeHealth(value: unknown): TelegramHealth {
  if (typeof value !== "object" || value === null) return { status: "NEVER_TESTED" };
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "NEVER_TESTED" && status !== "HEALTHY" && status !== "ERROR") return { status: "NEVER_TESTED" };
  const checkedAt = typeof record.checkedAt === "number" && Number.isFinite(record.checkedAt) && record.checkedAt >= 0
    ? record.checkedAt
    : undefined;
  const code = typeof record.code === "string" && HEALTH_CODES.has(record.code as TelegramHealthCode)
    ? record.code as TelegramHealthCode
    : undefined;
  return {
    status,
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(status !== "ERROR" || code === undefined ? {} : { code }),
  };
}

function normalizeStoredState(value: TelegramSettingsState | undefined): TelegramSettingsState {
  if (value?.version !== 1 || typeof value.enabled !== "boolean") return cloneState(DEFAULT_TELEGRAM_SETTINGS);
  try {
    const destination = normalizeDestination(value.destination);
    const eventMode = value.eventMode === "CUSTOM" ? "CUSTOM" : value.eventMode === "INHERIT" ? "INHERIT" : undefined;
    if (eventMode === undefined) return cloneState(DEFAULT_TELEGRAM_SETTINGS);
    const events = normalizeEvents(migrateStoredEvents(value.events));
    const botToken = value.botToken === undefined ? undefined : normalizeBotToken(value.botToken);
    const enabled = value.enabled && botToken !== undefined && destination.length > 0;
    return {
      version: 1,
      enabled,
      destination,
      eventMode,
      events,
      health: normalizeHealth(value.health),
      ...(botToken === undefined ? {} : { botToken }),
    };
  } catch {
    return cloneState(DEFAULT_TELEGRAM_SETTINGS);
  }
}

export function resolveTelegramSettingsMutation(
  current: TelegramSettingsState,
  mutation: TelegramSettingsMutation,
): TelegramSettingsState {
  const destination = normalizeDestination(mutation.destination);
  const events = normalizeEvents(mutation.events);
  if (mutation.eventMode !== "INHERIT" && mutation.eventMode !== "CUSTOM") {
    throw new TelegramConfigurationError("Telegram notification event mode is invalid.");
  }

  const rawToken = mutation.botToken.trim();
  let botToken: string | undefined;
  if (rawToken.length > 0) {
    botToken = normalizeBotToken(rawToken);
  } else if (current.botToken !== undefined) {
    if (destination !== current.destination) {
      throw new TelegramConfigurationError("Re-enter the Telegram bot token when changing the destination.");
    }
    botToken = current.botToken;
  }

  if (botToken !== undefined && destination.length === 0) {
    throw new TelegramConfigurationError("Telegram Chat ID is required when a bot token is stored.");
  }
  if (mutation.enabled && (botToken === undefined || destination.length === 0)) {
    throw new TelegramConfigurationError("Configure both the Telegram bot token and Chat ID before enabling Telegram.");
  }

  const credentialChanged = rawToken.length > 0 || destination !== current.destination;
  return {
    version: 1,
    enabled: mutation.enabled,
    destination,
    eventMode: mutation.eventMode,
    events,
    health: credentialChanged ? { status: "NEVER_TESTED" } : normalizeHealth(current.health),
    ...(botToken === undefined ? {} : { botToken }),
  };
}

export function redactTelegramSettings(state: TelegramSettingsState): RedactedTelegramSettings {
  return {
    enabled: state.enabled,
    configured: state.botToken !== undefined && state.destination.length > 0,
    destination: state.destination,
    eventMode: state.eventMode,
    events: [...state.events],
    health: structuredClone(state.health),
  };
}

export class TelegramSettingsStore {
  readonly #persistence: TelegramSettingsPersistence;
  #queue: Promise<void> = Promise.resolve();

  constructor(persistence?: TelegramSettingsPersistence) {
    if (persistence !== undefined) {
      this.#persistence = persistence;
      return;
    }
    const storage = createDurableStorage<TelegramSettingsState>("telegram-notifications");
    this.#persistence = {
      load: async () => {
        await restrictDurableStorageToTrustedContexts();
        return storage.get(SETTINGS_KEY);
      },
      save: async (state) => {
        await restrictDurableStorageToTrustedContexts();
        await storage.set(SETTINGS_KEY, state);
      },
    };
  }

  async load(): Promise<TelegramSettingsState> {
    await this.#queue;
    return normalizeStoredState(await this.#persistence.load());
  }

  update(mutation: TelegramSettingsMutation): Promise<TelegramSettingsState> {
    return this.#enqueue(async () => {
      const current = normalizeStoredState(await this.#persistence.load());
      const next = resolveTelegramSettingsMutation(current, mutation);
      await this.#persistence.save(next);
      return cloneState(next);
    });
  }

  updateHealth(
    health: TelegramHealth,
    expectedConfiguration?: TelegramConfigurationIdentity,
  ): Promise<TelegramSettingsState> {
    return this.#enqueue(async () => {
      const current = normalizeStoredState(await this.#persistence.load());
      if (
        expectedConfiguration !== undefined &&
        (current.destination !== expectedConfiguration.destination || current.botToken !== expectedConfiguration.botToken)
      ) {
        return cloneState(current);
      }
      const next: TelegramSettingsState = { ...current, health: normalizeHealth(health) };
      await this.#persistence.save(next);
      return cloneState(next);
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
