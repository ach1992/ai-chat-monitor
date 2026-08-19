import { unsureResult, type ClassificationRequest, type ClassificationResult } from "../classification/types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { normalizeProviderSettings } from "./settings.js";
import {
  ProviderFailure,
  type AIProvider,
  type FetchLike,
  type ProviderSettingsState,
} from "./types.js";

interface ProviderFailureSummary {
  providerId: string;
  code: string;
  message: string;
}

export class ProviderManager {
  readonly #providers: AIProvider[];

  constructor(providers: readonly AIProvider[]) {
    this.#providers = [...providers];
  }

  async classify(request: ClassificationRequest): Promise<ClassificationResult> {
    let lastFailure: ProviderFailureSummary | undefined;
    for (const provider of this.#providers) {
      try {
        return await provider.classify(request);
      } catch (error) {
        if (error instanceof ProviderFailure) {
          lastFailure = {
            providerId: provider.id,
            code: error.code,
            message: error.message,
          };
        } else {
          lastFailure = {
            providerId: provider.id,
            code: "UNKNOWN",
            message: "Provider failed unexpectedly.",
          };
        }
        // Operational/provider protocol failure may fall through to the next configured provider.
      }
    }
    if (lastFailure !== undefined) {
      return unsureResult(
        "PROVIDER_FAILURE",
        `Provider ${lastFailure.providerId} failed (${lastFailure.code}): ${lastFailure.message}`,
      );
    }
    return unsureResult("PROVIDER_FAILURE", "No configured provider produced a valid classification.");
  }

  providers(): readonly AIProvider[] {
    return [...this.#providers];
  }
}

export function createProviderManager(
  settings: ProviderSettingsState,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
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
