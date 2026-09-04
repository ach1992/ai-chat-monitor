export interface MonitoredTabLifecycleState {
  version: 1;
  tabs: Array<{ tabId: number; originalAutoDiscardable: boolean }>;
}

export interface MonitoredTabLifecyclePersistence {
  load(): Promise<MonitoredTabLifecycleState | undefined>;
  save(state: MonitoredTabLifecycleState): Promise<void>;
}

export interface MonitoredTabLifecycleApi {
  get(tabId: number): Promise<{ autoDiscardable?: boolean }>;
  update(tabId: number, properties: { autoDiscardable?: boolean }): Promise<unknown>;
}

function validState(state: MonitoredTabLifecycleState | undefined): MonitoredTabLifecycleState {
  if (state?.version !== 1 || !Array.isArray(state.tabs)) return { version: 1, tabs: [] };
  const tabs = state.tabs
    .filter((entry) => Number.isInteger(entry?.tabId) && entry.tabId >= 0 && typeof entry.originalAutoDiscardable === "boolean")
    .map((entry) => ({ tabId: entry.tabId, originalAutoDiscardable: entry.originalAutoDiscardable }));
  const unique = new Map<number, { tabId: number; originalAutoDiscardable: boolean }>();
  for (const entry of tabs) unique.set(entry.tabId, entry);
  return { version: 1, tabs: [...unique.values()] };
}

export class MonitoredTabLifecycle {
  readonly #api: MonitoredTabLifecycleApi;
  readonly #persistence: MonitoredTabLifecyclePersistence;
  readonly #ready: Promise<void>;
  #state: MonitoredTabLifecycleState = { version: 1, tabs: [] };
  #queue: Promise<void> = Promise.resolve();

  constructor(api: MonitoredTabLifecycleApi, persistence: MonitoredTabLifecyclePersistence) {
    this.#api = api;
    this.#persistence = persistence;
    this.#ready = persistence.load().then((state) => { this.#state = validState(state); });
  }

  protect(tabId: number): Promise<void> {
    return this.#enqueue(async () => {
      const tab = await this.#api.get(tabId);
      const existing = this.#state.tabs.find((entry) => entry.tabId === tabId);
      if (existing !== undefined) {
        if (tab.autoDiscardable !== false) await this.#api.update(tabId, { autoDiscardable: false });
        return;
      }

      const originalAutoDiscardable = tab.autoDiscardable ?? true;
      const previous = structuredClone(this.#state);
      this.#state = {
        version: 1,
        tabs: [...this.#state.tabs, { tabId, originalAutoDiscardable }],
      };
      await this.#persistence.save(this.snapshot());
      try {
        if (tab.autoDiscardable !== false) await this.#api.update(tabId, { autoDiscardable: false });
      } catch (error) {
        this.#state = previous;
        try { await this.#persistence.save(this.snapshot()); } catch { /* keep the original protection error */ }
        throw error;
      }
    });
  }

  release(tabId: number): Promise<void> {
    return this.#enqueue(async () => {
      const entry = this.#state.tabs.find((candidate) => candidate.tabId === tabId);
      if (entry === undefined) return;
      const tab = await this.#api.get(tabId);
      if (tab.autoDiscardable !== entry.originalAutoDiscardable) {
        await this.#api.update(tabId, { autoDiscardable: entry.originalAutoDiscardable });
      }
      this.#state = { version: 1, tabs: this.#state.tabs.filter((candidate) => candidate.tabId !== tabId) };
      await this.#persistence.save(this.snapshot());
    });
  }

  forget(tabId: number): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#state.tabs.some((entry) => entry.tabId === tabId)) return;
      this.#state = { version: 1, tabs: this.#state.tabs.filter((entry) => entry.tabId !== tabId) };
      await this.#persistence.save(this.snapshot());
    });
  }

  snapshot(): MonitoredTabLifecycleState {
    return structuredClone(this.#state);
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(async () => {
      await this.#ready;
      await operation();
    }, async () => {
      await this.#ready;
      await operation();
    });
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
