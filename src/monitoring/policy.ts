import type {
  ChatMonitoringPolicy,
  ChatMonitoringPolicyPatch,
  MonitoringEventType,
  MonitoringPolicyDefaults,
  MonitoringPolicyState,
  ResolvedMonitoringPolicy,
} from "./types.js";

interface LegacyAutomationDefaults {
  notificationTriggers?: string[];
}

interface LegacyChatAutomationPolicy {
  conversationId?: string;
  mode?: string;
  notificationTriggers?: string[];
}

interface LegacyAutomationPolicyState {
  version?: number;
  revision?: number;
  defaults?: LegacyAutomationDefaults;
  chats?: LegacyChatAutomationPolicy[];
}

export interface MonitoringPolicyPersistence {
  load(): Promise<MonitoringPolicyState | undefined>;
  save(state: MonitoringPolicyState): Promise<void>;
  loadLegacy?(): Promise<LegacyAutomationPolicyState | undefined>;
}

export const MONITORING_EVENTS: readonly MonitoringEventType[] = [
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
] as const;

const EVENT_SET = new Set<MonitoringEventType>(MONITORING_EVENTS);

export const DEFAULT_MONITORING_POLICY: MonitoringPolicyState = {
  version: 2,
  revision: 1,
  defaults: {
    browserEvents: [
      "RESPONSE_COMPLETE",
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
    ],
    soundEvents: [],
    stallThresholdMs: 300_000,
    suppressLowPriorityWhileFocused: true,
  },
  chats: [],
};

function cloneState(state: MonitoringPolicyState): MonitoringPolicyState {
  return structuredClone(state);
}

function nextRevision(revision: number): number {
  return revision >= Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
}

function normalizeEvents(value: unknown): MonitoringEventType[] {
  if (!Array.isArray(value) || value.length > MONITORING_EVENTS.length) throw new Error("Monitoring event selection is invalid.");
  const result: MonitoringEventType[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !EVENT_SET.has(entry as MonitoringEventType)) throw new Error("Monitoring event selection is invalid.");
    const event = entry as MonitoringEventType;
    if (!result.includes(event)) result.push(event);
  }
  return result;
}

function validStallThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 30_000 && value <= 3_600_000;
}

function normalizeDefaults(defaults: MonitoringPolicyDefaults): MonitoringPolicyDefaults {
  if (!validStallThreshold(defaults.stallThresholdMs)) throw new Error("Generation stall threshold is invalid.");
  if (typeof defaults.suppressLowPriorityWhileFocused !== "boolean") throw new Error("Focused-chat suppression setting is invalid.");
  return {
    browserEvents: normalizeEvents(defaults.browserEvents),
    soundEvents: normalizeEvents(defaults.soundEvents),
    stallThresholdMs: defaults.stallThresholdMs,
    suppressLowPriorityWhileFocused: defaults.suppressLowPriorityWhileFocused,
  };
}

function normalizeChat(policy: ChatMonitoringPolicy): ChatMonitoringPolicy {
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(policy.conversationId)) throw new Error("Conversation id is invalid.");
  if (typeof policy.enabled !== "boolean") throw new Error("Monitoring enabled state is invalid.");
  if (policy.stallThresholdMs !== undefined && !validStallThreshold(policy.stallThresholdMs)) throw new Error("Generation stall threshold is invalid.");
  if (policy.suppressLowPriorityWhileFocused !== undefined && typeof policy.suppressLowPriorityWhileFocused !== "boolean") {
    throw new Error("Focused-chat suppression setting is invalid.");
  }
  return {
    conversationId: policy.conversationId,
    enabled: policy.enabled,
    ...(policy.browserEvents === undefined ? {} : { browserEvents: normalizeEvents(policy.browserEvents) }),
    ...(policy.soundEvents === undefined ? {} : { soundEvents: normalizeEvents(policy.soundEvents) }),
    ...(policy.stallThresholdMs === undefined ? {} : { stallThresholdMs: policy.stallThresholdMs }),
    ...(policy.suppressLowPriorityWhileFocused === undefined ? {} : {
      suppressLowPriorityWhileFocused: policy.suppressLowPriorityWhileFocused,
    }),
  };
}

function normalizeState(state: MonitoringPolicyState): MonitoringPolicyState {
  if (state.version !== 2 || !Number.isInteger(state.revision) || state.revision < 1) throw new Error("Monitoring policy state is invalid.");
  if (!Array.isArray(state.chats)) throw new Error("Monitoring chat policies are invalid.");
  const chats = state.chats.map(normalizeChat);
  const ids = new Set<string>();
  for (const chat of chats) {
    if (ids.has(chat.conversationId)) throw new Error("Duplicate monitoring chat policy.");
    ids.add(chat.conversationId);
  }
  return {
    version: 2,
    revision: state.revision,
    defaults: normalizeDefaults(state.defaults),
    chats,
  };
}

function migrateLegacyEvents(value: string[] | undefined): MonitoringEventType[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<MonitoringEventType>();
  if (value.includes("RESPONSE_FINISHED")) result.add("RESPONSE_COMPLETE");
  if (value.includes("HOLD")) {
    result.add("APPROVAL_REQUIRED");
    result.add("DECISION_REQUIRED");
    result.add("HUMAN_OPERATION_REQUIRED");
    result.add("TASK_COMPLETE");
  }
  if (value.includes("UNSURE")) result.add("SEMANTIC_UNKNOWN");
  if (value.includes("ERROR")) {
    result.add("PLATFORM_ERROR");
    result.add("NETWORK_ERROR");
    result.add("RATE_LIMIT");
    result.add("AUTH_REQUIRED");
    result.add("VERIFICATION_REQUIRED");
    result.add("CONVERSATION_FULL");
    result.add("PROVIDER_ERROR");
  }
  if (value.includes("STAGNATION")) result.add("REPEATED_RESPONSE");
  return [...result];
}

export function migrateLegacyAutomationPolicy(legacy: LegacyAutomationPolicyState | undefined): MonitoringPolicyState | undefined {
  if (legacy?.version !== 1 || !Array.isArray(legacy.chats)) return undefined;
  const defaults = cloneState(DEFAULT_MONITORING_POLICY).defaults;
  const inherited = migrateLegacyEvents(legacy.defaults?.notificationTriggers);
  if (inherited.length > 0) defaults.browserEvents = inherited;

  const chats: ChatMonitoringPolicy[] = [];
  for (const candidate of legacy.chats) {
    const conversationId = candidate.conversationId;
    if (typeof conversationId !== "string" || !/^[A-Za-z0-9_-]{4,200}$/.test(conversationId)) continue;
    const mode = candidate.mode;
    const enabled = mode === "OBSERVE" || mode === "NOTIFY_ONLY" || mode === "AUTO";
    if (mode !== "OFF" && !enabled) continue;
    const events = migrateLegacyEvents(candidate.notificationTriggers);
    chats.push({
      conversationId,
      enabled,
      ...(events.length === 0 ? {} : { browserEvents: events }),
    });
  }

  return normalizeState({
    version: 2,
    revision: Math.max(1, Number.isInteger(legacy.revision) ? Number(legacy.revision) : 1),
    defaults,
    chats,
  });
}

export class MonitoringPolicyRepository {
  readonly #persistence: MonitoringPolicyPersistence;
  #state: MonitoringPolicyState = cloneState(DEFAULT_MONITORING_POLICY);
  #queue: Promise<void> = Promise.resolve();

  constructor(persistence: MonitoringPolicyPersistence) {
    this.#persistence = persistence;
  }

  async restore(): Promise<void> {
    const stored = await this.#persistence.load();
    if (stored !== undefined) {
      this.#state = normalizeState(stored);
      return;
    }
    const migrated = migrateLegacyAutomationPolicy(await this.#persistence.loadLegacy?.());
    if (migrated !== undefined) {
      await this.#persistence.save(migrated);
      this.#state = migrated;
      return;
    }
    this.#state = cloneState(DEFAULT_MONITORING_POLICY);
  }

  snapshot(): MonitoringPolicyState { return cloneState(this.#state); }

  resolve(conversationId: string): ResolvedMonitoringPolicy {
    const chat = this.#state.chats.find((candidate) => candidate.conversationId === conversationId);
    return {
      revision: this.#state.revision,
      conversationId,
      enabled: chat?.enabled ?? false,
      browserEvents: [...(chat?.browserEvents ?? this.#state.defaults.browserEvents)],
      soundEvents: [...(chat?.soundEvents ?? this.#state.defaults.soundEvents)],
      stallThresholdMs: chat?.stallThresholdMs ?? this.#state.defaults.stallThresholdMs,
      suppressLowPriorityWhileFocused: chat?.suppressLowPriorityWhileFocused ?? this.#state.defaults.suppressLowPriorityWhileFocused,
    };
  }

  updateChat(conversationId: string, patch: ChatMonitoringPolicyPatch): Promise<ResolvedMonitoringPolicy> {
    return this.#enqueue(async () => {
      const existing = this.#state.chats.find((candidate) => candidate.conversationId === conversationId);
      const next: ChatMonitoringPolicy = {
        conversationId,
        enabled: patch.enabled ?? existing?.enabled ?? false,
        ...(this.#patchEvents(existing?.browserEvents, patch.browserEvents, "browserEvents")),
        ...(this.#patchEvents(existing?.soundEvents, patch.soundEvents, "soundEvents")),
        ...(this.#patchStall(existing?.stallThresholdMs, patch.stallThresholdMs)),
        ...(this.#patchFocused(existing?.suppressLowPriorityWhileFocused, patch.suppressLowPriorityWhileFocused)),
      };
      const normalized = normalizeChat(next);
      const chats = this.#state.chats.filter((candidate) => candidate.conversationId !== conversationId);
      chats.push(normalized);
      const nextState = normalizeState({ ...this.#state, revision: nextRevision(this.#state.revision), chats });
      await this.#persistence.save(nextState);
      this.#state = nextState;
      return this.resolve(conversationId);
    });
  }

  updateDefaults(patch: Partial<MonitoringPolicyDefaults>): Promise<MonitoringPolicyState> {
    return this.#enqueue(async () => {
      const nextState = normalizeState({
        ...this.#state,
        revision: nextRevision(this.#state.revision),
        defaults: { ...this.#state.defaults, ...patch },
      });
      await this.#persistence.save(nextState);
      this.#state = nextState;
      return this.snapshot();
    });
  }

  clearChats(): Promise<MonitoringPolicyState> {
    return this.#enqueue(async () => {
      const nextState = normalizeState({
        ...this.#state,
        revision: nextRevision(this.#state.revision),
        chats: [],
      });
      await this.#persistence.save(nextState);
      this.#state = nextState;
      return this.snapshot();
    });
  }

  #patchEvents(
    existing: MonitoringEventType[] | undefined,
    patch: MonitoringEventType[] | null | undefined,
    key: "browserEvents" | "soundEvents",
  ): Partial<Pick<ChatMonitoringPolicy, "browserEvents" | "soundEvents">> {
    if (patch === undefined) return existing === undefined ? {} : { [key]: [...existing] };
    if (patch === null) return {};
    return { [key]: normalizeEvents(patch) };
  }

  #patchStall(existing: number | undefined, patch: number | null | undefined): Pick<ChatMonitoringPolicy, "stallThresholdMs"> | {} {
    if (patch === undefined) return existing === undefined ? {} : { stallThresholdMs: existing };
    if (patch === null) return {};
    if (!validStallThreshold(patch)) throw new Error("Generation stall threshold is invalid.");
    return { stallThresholdMs: patch };
  }

  #patchFocused(
    existing: boolean | undefined,
    patch: boolean | null | undefined,
  ): Pick<ChatMonitoringPolicy, "suppressLowPriorityWhileFocused"> | {} {
    if (patch === undefined) return existing === undefined ? {} : { suppressLowPriorityWhileFocused: existing };
    if (patch === null) return {};
    if (typeof patch !== "boolean") throw new Error("Focused-chat suppression setting is invalid.");
    return { suppressLowPriorityWhileFocused: patch };
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}