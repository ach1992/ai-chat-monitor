import type { MonitoringEvent } from "./types.js";

export interface MonitoringHistoryState {
  version: 1;
  events: MonitoringEvent[];
}

export interface MonitoringHistoryPersistence {
  load(): Promise<MonitoringHistoryState | undefined>;
  save(state: MonitoringHistoryState): Promise<void>;
}

const MAX_EVENTS = 200;

function validEvent(event: MonitoringEvent): boolean {
  return (
    typeof event.id === "string" && event.id.length > 0 && event.id.length <= 500 &&
    Number.isFinite(event.at) &&
    Number.isInteger(event.tabId) && event.tabId >= 0 &&
    typeof event.conversationId === "string" && event.conversationId.length >= 4 && event.conversationId.length <= 200 &&
    typeof event.type === "string" &&
    typeof event.pageState === "string" &&
    typeof event.semanticSource === "string" &&
    typeof event.markerHealth === "string" &&
    typeof event.title === "string" && event.title.length <= 160 &&
    typeof event.message === "string" && event.message.length <= 500 &&
    (event.assistantFingerprint === undefined || /^[a-f0-9]{64}$/.test(event.assistantFingerprint))
  );
}

function normalizeState(state: MonitoringHistoryState | undefined): MonitoringHistoryState {
  if (state?.version !== 1 || !Array.isArray(state.events)) return { version: 1, events: [] };
  return { version: 1, events: state.events.filter(validEvent).slice(-MAX_EVENTS) };
}

export class MonitoringHistoryRepository {
  readonly #persistence: MonitoringHistoryPersistence;
  #state: MonitoringHistoryState = { version: 1, events: [] };
  #queue: Promise<void> = Promise.resolve();

  constructor(persistence: MonitoringHistoryPersistence) {
    this.#persistence = persistence;
  }

  async restore(): Promise<void> {
    this.#state = normalizeState(await this.#persistence.load());
  }

  snapshot(limit = 80): MonitoringEvent[] {
    const bounded = Number.isInteger(limit) ? Math.max(0, Math.min(MAX_EVENTS, limit)) : 80;
    return structuredClone(this.#state.events.slice(-bounded));
  }

  has(id: string): boolean {
    return this.#state.events.some((event) => event.id === id);
  }

  append(event: MonitoringEvent): Promise<boolean> {
    return this.#enqueue(async () => {
      if (this.#state.events.some((existing) => existing.id === event.id)) return false;
      const next: MonitoringHistoryState = {
        version: 1,
        events: [...this.#state.events, structuredClone(event)].slice(-MAX_EVENTS),
      };
      await this.#persistence.save(next);
      this.#state = next;
      return true;
    });
  }

  clear(): Promise<void> {
    return this.#enqueue(async () => {
      const next: MonitoringHistoryState = { version: 1, events: [] };
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
