import type { ClassificationRequest, SanitizedTurn } from "../classification/types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import {
  ProviderFailure,
  type FetchLike,
  type ProviderClassifierReadinessResult,
  type ProviderProfile,
} from "./types.js";

const READINESS_USER =
  "Synthetic classifier readiness check only. A deployment window requires a human choice: A = release now, B = release tomorrow. Do not choose for the user.";
const READINESS_ASSISTANT = "Please choose exactly one option: A or B.";

function turn(role: SanitizedTurn["role"], content: string): SanitizedTurn {
  return {
    role,
    content,
    originalLength: content.length,
    truncated: false,
  };
}

export const PROVIDER_CLASSIFIER_READINESS_REQUEST: ClassificationRequest = {
  context: {
    turns: [turn("user", READINESS_USER), turn("assistant", READINESS_ASSISTANT)],
    totalCharacters: READINESS_USER.length + READINESS_ASSISTANT.length,
    truncated: false,
  },
};

export async function testProviderClassifierReadiness(
  profile: ProviderProfile,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<ProviderClassifierReadinessResult> {
  const provider = new OpenAICompatibleProvider(profile, fetchImpl);
  try {
    const result = await provider.classify(PROVIDER_CLASSIFIER_READINESS_REQUEST);
    return {
      ok: true,
      providerId: profile.id,
      model: profile.model,
      decision: result.decision,
      reasonCode: result.reasonCode,
      ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
    };
  } catch (error) {
    if (error instanceof ProviderFailure) {
      return {
        ok: false,
        providerId: profile.id,
        model: profile.model,
        code: error.code,
        message: error.message.slice(0, 160),
      };
    }
    return {
      ok: false,
      providerId: profile.id,
      model: profile.model,
      code: "NETWORK_ERROR",
      message: "Provider classifier readiness check failed unexpectedly.",
    };
  }
}
