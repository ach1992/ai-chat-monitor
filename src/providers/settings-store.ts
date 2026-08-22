import { createDurableStorage, restrictDurableStorageToTrustedContexts } from "../storage/index.js";
import { isProviderSettingsState, normalizeProviderSettings, providerOriginPattern } from "./settings.js";
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
    const stored = await this.#storage.get(SETTINGS_KEY);
    const previous = isProviderSettingsState(stored)
      ? normalizeProviderSettings(stored)
      : { version: 1 as const, profiles: [], order: [] };
    const next = normalizeProviderSettings(settings);

    const staleReplacementOrigins = new Set<string>();
    for (const previousProfile of previous.profiles) {
      const replacement = next.profiles.find((profile) => profile.id === previousProfile.id);
      if (replacement === undefined) continue;
      const previousOrigin = providerOriginPattern(previousProfile);
      if (providerOriginPattern(replacement) === previousOrigin) continue;
      if (!next.profiles.some((profile) => providerOriginPattern(profile) === previousOrigin)) {
        staleReplacementOrigins.add(previousOrigin);
      }
    }

    await this.#storage.set(SETTINGS_KEY, next);

    if (staleReplacementOrigins.size > 0 && typeof chrome !== "undefined") {
      try {
        await chrome.permissions.remove({ origins: [...staleReplacementOrigins] });
      } catch {
        // Optional permission cleanup must not make an otherwise valid settings update fail.
      }
    }
  }
}
