import { redactSecrets } from "../classification/context.js";
import type { ClassificationDecision, ClassificationReasonCode } from "../classification/types.js";
import type { ChatAutomationMode } from "../automation/types.js";

export type AuditEventKind =
  | "RESPONSE_COMPLETE"
  | "CONTINUE"
  | "HOLD"
  | "UNSURE"
  | "ERROR"
  | "STAGNATION"
  | "AMBIGUOUS_WRITE"
  | "NOTIFICATION_ERROR";

export interface AuditEvent {
  id: string;
  at: number;
  tabId: number;
  conversationId?: string;
  kind: AuditEventKind;
  mode?: ChatAutomationMode;
  phase?: string;
  decision?: ClassificationDecision;
  reasonCode?: ClassificationReasonCode;
  reason?: string;
  assistantFingerprint?: string;
  providerId?: string;
}

export interface AuditHistoryState {
  version: 1;
  events: AuditEvent[];
}

export interface AuditHistoryPersistence {
  load(): Promise<AuditHistoryState | undefined>;
  save(state: AuditHistoryState): Promise<void>;
}

export const MAX_AUDIT_EVENTS = 200;
const MAX_REASON_CHARS = 240;
const MAX_PROVIDER_ID_CHARS = 64;

function cleanReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const redacted = redactSecrets(value).replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
  return redacted.length === 0 ? undefined : redacted;
}

function validEvent(event: AuditEvent): boolean {
  return (
    typeof event.id === "string" && event.id.length > 0 && event.id.length <= 160 &&
    Number.isFinite(event.at) &&
    Number.isInteger(event.tabId) && event.tabId >= 0 &&
    (event.conversationId === undefined || (typeof event.conversationId === "string" && event.conversationId.length <= 200)) &&
    (event.assistantFingerprint === undefined || /^[a-f0-9]{64}$/.test(event.assistantFingerprint)) &&
    (event.providerId === undefined || (typeof event.providerId === "string" && event.providerId.length <= MAX_PROVIDER_ID_CHARS))
  );
}

function normalizedEvent(event: AuditEvent): AuditEvent {
  const { reason: originalReason, providerId: originalProviderId, ...rest } = event;
  const reason = cleanReason(originalReason);
  return {
    ...rest,
    ...(reason === undefined ? {} : { reason }),
    ...(originalProviderId === undefined ? {} : { providerId: originalProviderId.slice(0, MAX_PROVIDER_ID_CHARS) }),
  };
}

function normalizeState(state: AuditHistoryState | undefined): AuditHistoryState {
  if (state?.version !== 1 || !Array.isArray(state.events)) return { version: 1, events: [] };
  return {
    version: 1,
    events: state.events.filter(validEvent).map(normalizedEvent).slice(-MAX_AUDIT_EVENTS),
  };
}

export class AuditHistoryRepository {
  readonly #persistence: AuditHistoryPersistence;
  #state: AuditHistoryState = { version: 1, events: [] };
  #queue: Promise<void> = Promise.resolve();

  constructor(persistence: AuditHistoryPersistence) {
    this.#persistence = persistence;
  }

  async restore(): Promise<void> {
    this.#state = normalizeState(await this.#persistence.load());
  }

  snapshot(limit = MAX_AUDIT_EVENTS): AuditEvent[] {
    const bounded = Number.isInteger(limit) ? Math.max(0, Math.min(MAX_AUDIT_EVENTS, limit)) : MAX_AUDIT_EVENTS;
    return structuredClone(this.#state.events.slice(-bounded));
  }

  append(event: AuditEvent): Promise<void> {
    return this.#enqueue(async () => {
      const next: AuditHistoryState = {
        version: 1,
        events: [...this.#state.events, normalizedEvent(event)].slice(-MAX_AUDIT_EVENTS),
      };
      await this.#persistence.save(next);
      this.#state = next;
    });
  }

  clear(): Promise<void> {
    return this.#enqueue(async () => {
      const next: AuditHistoryState = { version: 1, events: [] };
      await this.#persistence.save(next);
      this.#state = next;
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
