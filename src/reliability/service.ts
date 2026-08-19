import type { AutomationRuntimeStatus, ResolvedAutomationPolicy } from "../automation/types.js";
import type { SessionView } from "../core/session-registry.js";
import { redactSecrets } from "../classification/context.js";
import type { AuditEvent, AuditEventKind } from "./audit.js";
import { AuditHistoryRepository } from "./audit.js";

export interface ReliabilityRuntimeState {
  version: 1;
  seenKeys: string[];
}

export interface ReliabilityRuntimePersistence {
  load(): Promise<ReliabilityRuntimeState | undefined>;
  save(state: ReliabilityRuntimeState): Promise<void>;
}

export interface ReliabilityNotification {
  id: string;
  title: string;
  message: string;
}

export interface ReliabilityServiceOptions {
  audit: AuditHistoryRepository;
  runtimePersistence: ReliabilityRuntimePersistence;
  resolvePolicy(conversationId: string): ResolvedAutomationPolicy;
  notify(notification: ReliabilityNotification): Promise<void>;
  now?: () => number;
}

const MAX_SEEN_KEYS = 256;
const NOTIFICATION_ICON = "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20128%20128'%3E%3Crect%20width='128'%20height='128'%20rx='28'%20fill='%23111827'/%3E%3Cpath%20d='M34%2065l18%2018%2042-42'%20fill='none'%20stroke='white'%20stroke-width='12'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3C/svg%3E";

function normalizeRuntimeState(state: ReliabilityRuntimeState | undefined): ReliabilityRuntimeState {
  if (state?.version !== 1 || !Array.isArray(state.seenKeys)) return { version: 1, seenKeys: [] };
  return {
    version: 1,
    seenKeys: state.seenKeys
      .filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 500)
      .slice(-MAX_SEEN_KEYS),
  };
}

function boundedMessage(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const cleaned = redactSecrets(value).replace(/\s+/g, " ").trim().slice(0, 220);
  return cleaned.length === 0 ? fallback : cleaned;
}

function notificationTitle(kind: AuditEventKind): string {
  switch (kind) {
    case "RESPONSE_COMPLETE": return "ChatGPT response finished";
    case "STAGNATION": return "Chat needs attention: stagnation";
    case "HOLD": return "Chat needs human attention";
    case "UNSURE": return "Chat continuation is uncertain";
    case "ERROR":
    case "AMBIGUOUS_WRITE": return "Chat Turn Guardian error";
    default: return "Chat Turn Guardian";
  }
}

export class ReliabilityService {
  readonly #audit: AuditHistoryRepository;
  readonly #runtimePersistence: ReliabilityRuntimePersistence;
  readonly #resolvePolicy: (conversationId: string) => ResolvedAutomationPolicy;
  readonly #notify: (notification: ReliabilityNotification) => Promise<void>;
  readonly #now: () => number;
  #runtime: ReliabilityRuntimeState = { version: 1, seenKeys: [] };
  #ready: Promise<void> = Promise.resolve();
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ReliabilityServiceOptions) {
    this.#audit = options.audit;
    this.#runtimePersistence = options.runtimePersistence;
    this.#resolvePolicy = options.resolvePolicy;
    this.#notify = options.notify;
    this.#now = options.now ?? (() => Date.now());
  }

  restore(): Promise<void> {
    this.#ready = Promise.all([
      this.#audit.restore(),
      this.#runtimePersistence.load().then((state) => {
        this.#runtime = normalizeRuntimeState(state);
      }),
    ]).then(() => undefined);
    return this.#ready;
  }

  captureSession(session: SessionView): void {
    this.#schedule(async () => {
      const conversationId = session.conversationId;
      const observation = session.observation;
      const assistant = observation?.latestAssistant;
      if (
        conversationId === undefined ||
        observation === undefined ||
        assistant === undefined ||
        observation.generation !== "IDLE" ||
        observation.confidence !== "HIGH"
      ) return;
      const policy = this.#resolvePolicy(conversationId);
      if (policy.mode === "OFF") return;
      const key = `response:${conversationId}:${assistant.fingerprint}`;
      if (!(await this.#claimKey(key))) return;
      const event: AuditEvent = {
        id: key,
        at: this.#now(),
        tabId: session.tabId,
        conversationId,
        kind: "RESPONSE_COMPLETE",
        mode: policy.mode,
        phase: "IDLE",
        assistantFingerprint: assistant.fingerprint,
      };
      await this.#appendAudit(event);
      if (policy.notificationTriggers.includes("RESPONSE_FINISHED")) {
        await this.#deliver(event, "A selected assistant response finished.");
      }
    });
  }

  captureRuntime(status: AutomationRuntimeStatus): void {
    this.#schedule(async () => {
      const conversationId = status.conversationId;
      if (conversationId === undefined) return;
      const policy = this.#resolvePolicy(conversationId);
      if (policy.mode === "OFF") return;
      const classification = status.lastDecision;
      const localStagnation = status.phase === "HOLD" && status.reason?.startsWith("STAGNATION:") === true;
      const classifiedError = classification?.reasonCode === "PLATFORM_ERROR" || classification?.reasonCode === "RATE_LIMIT";
      let kind: AuditEventKind | undefined;
      let shouldNotify = false;

      if (status.phase === "COOLDOWN" && classification?.decision === "CONTINUE") {
        kind = "CONTINUE";
      } else if (localStagnation || (status.phase === "HOLD" && classification?.reasonCode === "STAGNATION")) {
        kind = "STAGNATION";
        shouldNotify = policy.notificationTriggers.includes("STAGNATION") || policy.notificationTriggers.includes("HOLD");
      } else if (status.phase === "HOLD" && classification?.decision === "HOLD" && classifiedError) {
        kind = "ERROR";
        shouldNotify = policy.notificationTriggers.includes("ERROR");
      } else if (status.phase === "HOLD" && classification?.decision === "HOLD") {
        kind = "HOLD";
        shouldNotify = policy.notificationTriggers.includes("HOLD");
      } else if (status.phase === "UNSURE") {
        const providerError = classification?.reasonCode === "PROVIDER_FAILURE";
        kind = providerError ? "ERROR" : "UNSURE";
        shouldNotify = providerError
          ? policy.notificationTriggers.includes("ERROR") || policy.notificationTriggers.includes("UNSURE")
          : policy.notificationTriggers.includes("UNSURE");
      } else if (status.phase === "AMBIGUOUS_WRITE") {
        kind = "AMBIGUOUS_WRITE";
        shouldNotify = policy.notificationTriggers.includes("ERROR");
      }

      if (kind === undefined) return;
      const key = [
        "runtime",
        status.tabId,
        conversationId,
        status.assistantFingerprint ?? "none",
        status.decisionId ?? "none",
        status.phase,
        classification?.reasonCode ?? (localStagnation ? "STAGNATION" : "none"),
      ].join(":");
      if (!(await this.#claimKey(key))) return;
      const event: AuditEvent = {
        id: key.slice(0, 160),
        at: this.#now(),
        tabId: status.tabId,
        conversationId,
        kind,
        mode: status.mode,
        phase: status.phase,
        ...(classification === undefined ? {} : {
          decision: classification.decision,
          reasonCode: classification.reasonCode,
          ...(classification.providerId === undefined ? {} : { providerId: classification.providerId }),
        }),
        ...(localStagnation && classification === undefined ? { reasonCode: "STAGNATION" as const } : {}),
        ...(status.reason === undefined ? {} : { reason: status.reason }),
        ...(status.assistantFingerprint === undefined ? {} : { assistantFingerprint: status.assistantFingerprint }),
      };
      await this.#appendAudit(event);
      if (shouldNotify) await this.#deliver(event, status.reason ?? "The chat requires attention.");
    });
  }

  history(limit = 80): AuditEvent[] { return this.#audit.snapshot(limit); }
  clearHistory(): Promise<void> { return this.#audit.clear(); }
  async flush(): Promise<void> { await this.#queue; }

  static browserNotify(notification: ReliabilityNotification): Promise<void> {
    return new Promise((resolve, reject) => {
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

  #schedule(operation: () => Promise<void>): void {
    const run = this.#queue.then(async () => {
      await this.#ready;
      await operation();
    });
    this.#queue = run.catch(() => undefined);
  }

  async #claimKey(key: string): Promise<boolean> {
    if (this.#runtime.seenKeys.includes(key)) return false;
    const next: ReliabilityRuntimeState = { version: 1, seenKeys: [...this.#runtime.seenKeys, key].slice(-MAX_SEEN_KEYS) };
    this.#runtime = next;
    try {
      await this.#runtimePersistence.save(next);
    } catch {
      // In-memory de-duplication still applies for this worker lifetime.
    }
    return true;
  }

  async #appendAudit(event: AuditEvent): Promise<void> {
    try {
      await this.#audit.append(event);
    } catch {
      // Audit failures cannot influence automation.
    }
  }

  async #deliver(event: AuditEvent, fallbackMessage: string): Promise<void> {
    const notification: ReliabilityNotification = {
      id: `guardian:${event.id}`.slice(0, 500),
      title: notificationTitle(event.kind),
      message: boundedMessage(event.reason, fallbackMessage),
    };
    try {
      await this.#notify(notification);
    } catch {
      await this.#appendAudit({
        id: `notify-error:${event.id}`.slice(0, 160),
        at: this.#now(),
        tabId: event.tabId,
        ...(event.conversationId === undefined ? {} : { conversationId: event.conversationId }),
        kind: "NOTIFICATION_ERROR",
        ...(event.mode === undefined ? {} : { mode: event.mode }),
        reason: "Browser notification delivery failed; automation state was not changed.",
        ...(event.assistantFingerprint === undefined ? {} : { assistantFingerprint: event.assistantFingerprint }),
      });
    }
  }
}
