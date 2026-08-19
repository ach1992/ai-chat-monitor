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
const NOTIFICATION_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAACmklEQVR4nO3byVEjQQAF0c94ACfGAvDfmvGA27jAHAgCNGqhXqpry0wH1NH/aYno0sPj88t7DNuv1hdgbRMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBwBMAPAHAEwA8AcATADwBVOrv25/Wl7CYACr0OX6PCARwcv+P3hsCAZzYrbF7QiCAk7o3ci8IBHBCa8ftAYEACrd11NYIBFCwvWO2RCCAQh0dsRUCARSoxHhPv18LXMn2BHCwkcdPBHCo0cdPBLC7GcZPBLCrWcZPBLC5mcZPBLCp2cZPBLC6GcdPBLCqWcdPBHC3mcdPBPBjs4+fCOBmhPETASxGGT8RwFWk8RMBXEQbP+kYQO3n48Txk04B1D5HTx0/6RBA7XP05PGTzgDUPkdPHz/pCEDtc/SO/1EXAGqfo3f8r5oDqH2O3vEvawqg9jl6x7+uGYDa72THX64ZgBI3s+ZvhxnHTxp/BdRA4Pg/1/xH4JkIHP9+zQEk5yBw/HV1ASApi8Dx1/fw+Pzy3voivtf6//IJZ/yko0+Az1rf/NavX7vuACTtRqCNn3QKIKk/BnH8pGMASb1RqOMnnQNIzh+HPH4yAIDkvJHo4yeDAEjKj+X4Hw0DICk3muN/NRSA5Ph4jn/ZcACS/SM6/nVDAki2j+n4yw0LIFk/quPfrruHQXtbeojk8PebBoDta+ivADueAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOAJAJ4A4AkAngDgCQCeAOD9A59V1Pv7P/C7AAAAAElFTkSuQmCC";

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

function responseCompleteKey(conversationId: string, fingerprint: string, domMessageId: string | undefined): string {
  const boundedDomMessageId = domMessageId !== undefined && domMessageId.length > 0 && domMessageId.length <= 200
    ? domMessageId
    : undefined;
  return boundedDomMessageId === undefined
    ? `response:${conversationId}:${fingerprint}`
    : `response:${conversationId}:dom:${boundedDomMessageId}:${fingerprint}`;
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
      const key = responseCompleteKey(conversationId, assistant.fingerprint, assistant.domMessageId);
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
