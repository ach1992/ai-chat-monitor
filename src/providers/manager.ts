import { unsureResult, type ClassificationRequest, type ClassificationResult } from "../classification/types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { normalizeProviderSettings } from "./settings.js";
import type { AIProvider, FetchLike, ProviderSettingsState } from "./types.js";

export class ProviderManager {
  readonly #providers: AIProvider[];

  constructor(providers: readonly AIProvider[]) {
    this.#providers = [...providers];
  }

  async classify(request: ClassificationRequest): Promise<ClassificationResult> {
    for (const provider of this.#providers) {
      try {
        return await provider.classify(request);
      } catch {
        // Operational/provider protocol failure may fall through to the next configured provider.
      }
    }
    return unsureResult("PROVIDER_FAILURE", "No configured provider produced a valid classification.");
  }

  providers(): readonly AIProvider[] {
    return [...this.#providers];
  }
}

export function createProviderManager(
  settings: ProviderSettingsState,
  fetchImpl: FetchLike = fetch,
): ProviderManager {
  const normalized = normalizeProviderSettings(settings);
  const byId = new Map(normalized.profiles.map((profile) => [profile.id, profile] as const));
  const providers = normalized.order.map((id) => {
    const profile = byId.get(id);
    if (profile === undefined) throw new Error(`Provider order references missing profile: ${id}`);
    return new OpenAICompatibleProvider(profile, fetchImpl);
  });
  return new ProviderManager(providers);
}
