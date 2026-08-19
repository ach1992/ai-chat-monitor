import type {
  AutomationTiming,
  ChatAutomationMode,
  NotificationTrigger,
  ResolvedAutomationPolicy,
} from "./types.js";

export interface AutomationPolicyDefaults extends AutomationTiming {
  continuationText: string;
  notificationTriggers: NotificationTrigger[];
  hardFuseMaxAutoContinues: number;
}

export interface ChatAutomationPolicy {
  conversationId: string;
  mode: ChatAutomationMode;
  settleDelayMs?: number;
  continueDelayMs?: number;
  cooldownMs?: number;
  continuationText?: string;
  notificationTriggers?: NotificationTrigger[];
  hardFuseMaxAutoContinues?: number;
}

export interface AutomationPolicyState {
  version: 1;
  revision: number;
  emergencyPaused: boolean;
  defaults: AutomationPolicyDefaults;
  chats: ChatAutomationPolicy[];
}

export interface ChatAutomationPolicyPatch {
  mode?: ChatAutomationMode;
  settleDelayMs?: number | null;
  continueDelayMs?: number | null;
  cooldownMs?: number | null;
  continuationText?: string | null;
  notificationTriggers?: NotificationTrigger[] | null;
  hardFuseMaxAutoContinues?: number | null;
}

export interface AutomationPolicyPersistence {
  load(): Promise<AutomationPolicyState | undefined>;
  save(state: AutomationPolicyState): Promise<void>;
}

export const DEFAULT_HARD_FUSE_MAX_AUTO_CONTINUES = 50;
export const DEFAULT_AUTOMATION_POLICY: AutomationPolicyState = {
  version: 1,
  revision: 1,
  emergencyPaused: false,
  defaults: {
    settleDelayMs: 1_200,
    continueDelayMs: 800,
    cooldownMs: 3_000,
    continuationText: "Continue.",
    notificationTriggers: [],
    hardFuseMaxAutoContinues: DEFAULT_HARD_FUSE_MAX_AUTO_CONTINUES,
  },
  chats: [],
};

const MODES = new Set<ChatAutomationMode>(["OFF", "OBSERVE", "AUTO", "NOTIFY_ONLY"]);
const NOTIFICATION_TRIGGERS = new Set<NotificationTrigger>([
  "RESPONSE_FINISHED",
  "HOLD",
  "UNSURE",
  "ERROR",
  "STAGNATION",
]);

function validDelay(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
}

function validHardFuse(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 500;
}

function normalizeContinuationText(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0 || normalized.length > 200) throw new Error("Continuation text must be between 1 and 200 characters.");
  return normalized;
}

function normalizeNotificationTriggers(value: unknown): NotificationTrigger[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > NOTIFICATION_TRIGGERS.size) throw new Error("Notification triggers are invalid.");
  const normalized: NotificationTrigger[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !NOTIFICATION_TRIGGERS.has(entry as NotificationTrigger)) throw new Error("Notification trigger is invalid.");
    const trigger = entry as NotificationTrigger;
    if (!normalized.includes(trigger)) normalized.push(trigger);
  }
  return normalized;
}

function normalizeDefaults(defaults: AutomationPolicyDefaults): AutomationPolicyDefaults {
  if (!validDelay(defaults.settleDelayMs, 60_000)) throw new Error("Settle delay is invalid.");
  if (!validDelay(defaults.continueDelayMs, 60_000)) throw new Error("Continue delay is invalid.");
  if (!validDelay(defaults.cooldownMs, 300_000)) throw new Error("Cooldown is invalid.");
  if (!validHardFuse(defaults.hardFuseMaxAutoContinues)) throw new Error("Hard fuse must be between 5 and 500 auto-continues.");
  return {
    settleDelayMs: defaults.settleDelayMs,
    continueDelayMs: defaults.continueDelayMs,
    cooldownMs: defaults.cooldownMs,
    continuationText: normalizeContinuationText(defaults.continuationText),
    notificationTriggers: normalizeNotificationTriggers(defaults.notificationTriggers),
    hardFuseMaxAutoContinues: defaults.hardFuseMaxAutoContinues,
  };
}

function normalizeChatPolicy(policy: ChatAutomationPolicy): ChatAutomationPolicy {
  if (typeof policy.conversationId !== "string" || policy.conversationId.length < 4 || policy.conversationId.length > 200) throw new Error("Conversation id is invalid.");
  if (!MODES.has(policy.mode)) throw new Error("Automation mode is invalid.");
  if (policy.settleDelayMs !== undefined && !validDelay(policy.settleDelayMs, 60_000)) throw new Error("Settle delay is invalid.");
  if (policy.continueDelayMs !== undefined && !validDelay(policy.continueDelayMs, 60_000)) throw new Error("Continue delay is invalid.");
  if (policy.cooldownMs !== undefined && !validDelay(policy.cooldownMs, 300_000)) throw new Error("Cooldown is invalid.");
  if (policy.hardFuseMaxAutoContinues !== undefined && !validHardFuse(policy.hardFuseMaxAutoContinues)) throw new Error("Hard fuse is invalid.");
  return {
    conversationId: policy.conversationId,
    mode: policy.mode,
    ...(policy.settleDelayMs === undefined ? {} : { settleDelayMs: policy.settleDelayMs }),
    ...(policy.continueDelayMs === undefined ? {} : { continueDelayMs: policy.continueDelayMs }),
    ...(policy.cooldownMs === undefined ? {} : { cooldownMs: policy.cooldownMs }),
    ...(policy.continuationText === undefined ? {} : { continuationText: normalizeContinuationText(policy.continuationText) }),
    ...(policy.notificationTriggers === undefined ? {} : { notificationTriggers: normalizeNotificationTriggers(policy.notificationTriggers) }),
    ...(policy.hardFuseMaxAutoContinues === undefined ? {} : { hardFuseMaxAutoContinues: policy.hardFuseMaxAutoContinues }),
  };
}

function normalizeState(state: AutomationPolicyState): AutomationPolicyState {
  if (state.version !== 1 || !Number.isInteger(state.revision) || state.revision < 1 || typeof state.emergencyPaused !== "boolean") throw new Error("Automation policy state is invalid.");
  const defaults = normalizeDefaults(state.defaults);
  const chats = state.chats.map(normalizeChatPolicy);
  const ids = new Set<string>();
  for (const chat of chats) {
    if (ids.has(chat.conversationId)) throw new Error("Duplicate chat automation policy.");
    ids.add(chat.conversationId);
  }
  return { version: 1, revision: state.revision, emergencyPaused: state.emergencyPaused, defaults, chats };
}

function cloneState(state: AutomationPolicyState): AutomationPolicyState { return structuredClone(state); }
function nextRevision(revision: number): number { return revision >= Number.MAX_SAFE_INTEGER ? 1 : revision + 1; }

export class AutomationPolicyRepository {
  readonly #persistence: AutomationPolicyPersistence;
  #state: AutomationPolicyState = cloneState(DEFAULT_AUTOMATION_POLICY);
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(persistence: AutomationPolicyPersistence) { this.#persistence = persistence; }

  async restore(): Promise<void> {
    const stored = await this.#persistence.load();
    if (stored === undefined) {
      this.#state = cloneState(DEFAULT_AUTOMATION_POLICY);
      return;
    }
    const migrated = {
      ...stored,
      defaults: {
        ...stored.defaults,
        notificationTriggers: stored.defaults.notificationTriggers ?? [],
        hardFuseMaxAutoContinues: stored.defaults.hardFuseMaxAutoContinues ?? DEFAULT_HARD_FUSE_MAX_AUTO_CONTINUES,
      },
    } as AutomationPolicyState;
    this.#state = normalizeState(migrated);
  }

  snapshot(): AutomationPolicyState { return cloneState(this.#state); }

  resolve(conversationId: string): ResolvedAutomationPolicy {
    const chat = this.#state.chats.find((candidate) => candidate.conversationId === conversationId);
    return {
      revision: this.#state.revision,
      conversationId,
      mode: chat?.mode ?? "OFF",
      timing: {
        settleDelayMs: chat?.settleDelayMs ?? this.#state.defaults.settleDelayMs,
        continueDelayMs: chat?.continueDelayMs ?? this.#state.defaults.continueDelayMs,
        cooldownMs: chat?.cooldownMs ?? this.#state.defaults.cooldownMs,
      },
      continuationText: chat?.continuationText ?? this.#state.defaults.continuationText,
      notificationTriggers: [...(chat?.notificationTriggers ?? this.#state.defaults.notificationTriggers)],
      hardFuseMaxAutoContinues: chat?.hardFuseMaxAutoContinues ?? this.#state.defaults.hardFuseMaxAutoContinues,
      emergencyPaused: this.#state.emergencyPaused,
    };
  }

  updateChat(conversationId: string, patch: ChatAutomationPolicyPatch): Promise<ResolvedAutomationPolicy> {
    return this.#enqueue(async () => {
      const existing = this.#state.chats.find((candidate) => candidate.conversationId === conversationId);
      const settleDelayMs = this.#patchedNumber(existing?.settleDelayMs, patch.settleDelayMs, 60_000, "Settle delay");
      const continueDelayMs = this.#patchedNumber(existing?.continueDelayMs, patch.continueDelayMs, 60_000, "Continue delay");
      const cooldownMs = this.#patchedNumber(existing?.cooldownMs, patch.cooldownMs, 300_000, "Cooldown");
      const continuationText = this.#patchedText(existing?.continuationText, patch.continuationText);
      const notificationTriggers = this.#patchedNotificationTriggers(existing?.notificationTriggers, patch.notificationTriggers);
      const hardFuseMaxAutoContinues = this.#patchedHardFuse(existing?.hardFuseMaxAutoContinues, patch.hardFuseMaxAutoContinues);
      const next: ChatAutomationPolicy = {
        conversationId,
        mode: patch.mode ?? existing?.mode ?? "OFF",
        ...(settleDelayMs === undefined ? {} : { settleDelayMs }),
        ...(continueDelayMs === undefined ? {} : { continueDelayMs }),
        ...(cooldownMs === undefined ? {} : { cooldownMs }),
        ...(continuationText === undefined ? {} : { continuationText }),
        ...(notificationTriggers === undefined ? {} : { notificationTriggers }),
        ...(hardFuseMaxAutoContinues === undefined ? {} : { hardFuseMaxAutoContinues }),
      };
      const normalized = normalizeChatPolicy(next);
      const chats = this.#state.chats.filter((candidate) => candidate.conversationId !== conversationId);
      chats.push(normalized);
      const nextState = normalizeState({ ...this.#state, revision: nextRevision(this.#state.revision), chats });
      await this.#persistence.save(nextState);
      this.#state = nextState;
      return this.resolve(conversationId);
    });
  }

  updateDefaults(patch: Partial<AutomationPolicyDefaults>): Promise<AutomationPolicyState> {
    return this.#enqueue(async () => {
      const nextState = normalizeState({ ...this.#state, revision: nextRevision(this.#state.revision), defaults: { ...this.#state.defaults, ...patch } });
      await this.#persistence.save(nextState);
      this.#state = nextState;
      return this.snapshot();
    });
  }

  setEmergencyPaused(paused: boolean): Promise<AutomationPolicyState> {
    return this.#enqueue(async () => {
      if (this.#state.emergencyPaused === paused) return this.snapshot();
      const nextState = normalizeState({ ...this.#state, revision: nextRevision(this.#state.revision), emergencyPaused: paused });
      await this.#persistence.save(nextState);
      this.#state = nextState;
      return this.snapshot();
    });
  }

  #patchedNumber(existing: number | undefined, patch: number | null | undefined, maximum: number, name: string): number | undefined {
    if (patch === undefined) return existing;
    if (patch === null) return undefined;
    if (!validDelay(patch, maximum)) throw new Error(`${name} is invalid.`);
    return patch;
  }

  #patchedText(existing: string | undefined, patch: string | null | undefined): string | undefined {
    if (patch === undefined) return existing;
    if (patch === null) return undefined;
    return normalizeContinuationText(patch);
  }

  #patchedNotificationTriggers(existing: NotificationTrigger[] | undefined, patch: NotificationTrigger[] | null | undefined): NotificationTrigger[] | undefined {
    if (patch === undefined) return existing;
    if (patch === null) return undefined;
    return normalizeNotificationTriggers(patch);
  }

  #patchedHardFuse(existing: number | undefined, patch: number | null | undefined): number | undefined {
    if (patch === undefined) return existing;
    if (patch === null) return undefined;
    if (!validHardFuse(patch)) throw new Error("Hard fuse is invalid.");
    return patch;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
