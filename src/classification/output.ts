import {
  boundedReason,
  unsureResult,
  type ClassificationReasonCode,
  type ClassificationResult,
} from "./types.js";

const REASON_CODES = new Set<ClassificationReasonCode>([
  "HUMAN_APPROVAL_REQUIRED",
  "MATERIAL_DECISION_REQUIRED",
  "HUMAN_OPERATION_REQUIRED",
  "PROJECT_COMPLETE",
  "USER_STOP",
  "STAGNATION",
  "PLATFORM_ERROR",
  "RATE_LIMIT",
  "SAFETY_BOUNDARY",
  "NEEDLESS_TURN_BOUNDARY",
  "AMBIGUOUS",
  "PROVIDER_FAILURE",
  "OTHER",
]);
const ALLOWED_KEYS = new Set(["decision", "reasonCode", "reason", "confidence"]);
const DEFAULT_MIN_CONFIDENCE = 0.9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ProviderOutputError extends Error {
  override readonly name = "ProviderOutputError";
}

export function parseProviderClassification(
  raw: string,
  providerId: string,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
): ClassificationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderOutputError("Provider output was not valid JSON.");
  }
  if (!isRecord(parsed)) throw new ProviderOutputError("Provider output must be a JSON object.");
  if (Object.keys(parsed).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new ProviderOutputError("Provider output contained unsupported fields.");
  }

  const decision = parsed.decision;
  const reasonCode = parsed.reasonCode;
  const reason = parsed.reason;
  const confidence = parsed.confidence;
  if (decision !== "CONTINUE" && decision !== "HOLD" && decision !== "UNSURE") {
    throw new ProviderOutputError("Provider decision was invalid.");
  }
  if (typeof reasonCode !== "string" || !REASON_CODES.has(reasonCode as ClassificationReasonCode)) {
    throw new ProviderOutputError("Provider reason code was invalid.");
  }
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1_000) {
    throw new ProviderOutputError("Provider reason was invalid.");
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ProviderOutputError("Provider confidence was invalid.");
  }

  const typedReasonCode = reasonCode as ClassificationReasonCode;
  const threshold = Math.min(1, Math.max(0.5, minConfidence));
  if (confidence < threshold) {
    return unsureResult("AMBIGUOUS", "Provider confidence was below the configured threshold.", {
      providerId,
      confidence,
    });
  }

  if (decision === "CONTINUE" && typedReasonCode !== "NEEDLESS_TURN_BOUNDARY") {
    return unsureResult("AMBIGUOUS", "Provider continuation output was semantically inconsistent.", {
      providerId,
      confidence,
    });
  }
  if (decision === "HOLD" && typedReasonCode === "NEEDLESS_TURN_BOUNDARY") {
    return unsureResult("AMBIGUOUS", "Provider hold output was semantically inconsistent.", {
      providerId,
      confidence,
    });
  }
  if (decision === "UNSURE" && typedReasonCode !== "AMBIGUOUS" && typedReasonCode !== "OTHER") {
    return unsureResult("AMBIGUOUS", "Provider uncertainty output was semantically inconsistent.", {
      providerId,
      confidence,
    });
  }

  return {
    decision,
    reasonCode: typedReasonCode,
    reason: boundedReason(reason),
    source: "PROVIDER",
    confidence,
    providerId,
  };
}
