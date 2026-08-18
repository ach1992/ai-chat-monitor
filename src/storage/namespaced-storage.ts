export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class NamespacedStorage<T> {
  readonly #prefix: string;
  readonly #area: StorageAreaLike;

  constructor(namespace: string, area: StorageAreaLike) {
    const normalized = namespace.trim();
    if (normalized.length === 0 || normalized.includes(":")) {
      throw new Error("Storage namespace must be a non-empty token without colons.");
    }

    this.#prefix = `guardian:${normalized}:`;
    this.#area = area;
  }

  async get(key: string): Promise<T | undefined> {
    const storageKey = this.#storageKey(key);
    const values = await this.#area.get(storageKey);
    return values[storageKey] as T | undefined;
  }

  async set(key: string, value: T): Promise<void> {
    await this.#area.set({ [this.#storageKey(key)]: value });
  }

  async remove(key: string): Promise<void> {
    await this.#area.remove(this.#storageKey(key));
  }

  async clearNamespace(): Promise<void> {
    const values = await this.#area.get(null);
    const ownedKeys = Object.keys(values).filter((key) => key.startsWith(this.#prefix));

    if (ownedKeys.length > 0) {
      await this.#area.remove(ownedKeys);
    }
  }

  #storageKey(key: string): string {
    const normalized = key.trim();
    if (normalized.length === 0) {
      throw new Error("Storage key must be non-empty.");
    }

    return `${this.#prefix}${normalized}`;
  }
}
