import { createDurableStorage, restrictDurableStorageToTrustedContexts } from "../storage/index.js";
import { isProviderSettingsState, normalizeProviderSettings } from "./settings.js";
import type { ProviderSettingsState } from "./types.js";

const SETTINGS_KEY = "config";

export class ProviderSettingsStore {
  readonly #storage = createDurableStorage<ProviderSettingsState>("provider-settings");

  async load(): Promise<ProviderSettingsState> {
    await restrictDurableStorageToTrustedContexts();
    const stored = await this.#storage.get(SETTINGS_KEY);
    if (!isProviderSettingsState(stored)) return { version: 1, profiles: [], order: [] };
    return normalizeProviderSettings(stored);
  }

  async save(settings: ProviderSettingsState): Promise<void> {
    await restrictDurableStorageToTrustedContexts();
    await this.#storage.set(SETTINGS_KEY, normalizeProviderSettings(settings));
  }
}
