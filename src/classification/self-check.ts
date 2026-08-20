import { boundedReason, type ClassificationResult } from "./types.js";

export type InChatSelfCheckDecision =
  | "CONTINUE"
  | "HOLD_APPROVAL"
  | "HOLD_DECISION"
  | "HOLD_HUMAN_OPERATION"
  | "COMPLETE"
  | "PLATFORM_ERROR"
  | "RATE_LIMIT"
  | "UNSURE";

interface InChatSelfCheckResponse {
  decision: InChatSelfCheckDecision;
  reason?: string;
}

const ALLOWED_KEYS = new Set(["decision", "reason"]);
const ALLOWED_DECISIONS = new Set<InChatSelfCheckDecision>([
  "CONTINUE",
  "HOLD_APPROVAL",
  "HOLD_DECISION",
  "HOLD_HUMAN_OPERATION",
  "COMPLETE",
  "PLATFORM_ERROR",
  "RATE_LIMIT",
  "UNSURE",
]);

export const DEFAULT_IN_CHAT_SELF_CHECK_PROMPT = [
  "Do not continue the task yet. Classify only why it stopped.",
  "Reply with exactly one JSON object: {\"decision\":\"...\"}.",
  "Allowed decisions: CONTINUE, HOLD_APPROVAL, HOLD_DECISION, HOLD_HUMAN_OPERATION, COMPLETE, PLATFORM_ERROR, RATE_LIMIT, UNSURE.",
  "Use CONTINUE only when work remains and no human approval, decision, information, credential, or human-only action is needed. Use UNSURE if uncertain.",
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(raw: string): InChatSelfCheckResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => !ALLOWED_KEYS.has(key))) return undefined;
  if (typeof parsed.decision !== "string" || !ALLOWED_DECISIONS.has(parsed.decision as InChatSelfCheckDecision)) return undefined;
  if (parsed.reason !== undefined && (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0 || parsed.reason.length > 1_000)) {
    return undefined;
  }
  return {
    decision: parsed.decision as InChatSelfCheckDecision,
    ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
  };
}

export function parseInChatSelfCheckResponse(raw: string): ClassificationResult {
  const response = parseResponse(raw);
  if (response === undefined || response.decision === "UNSURE") {
    return {
      decision: "UNSURE",
      reasonCode: "AMBIGUOUS",
      reason: "The in-chat self-check response was malformed or uncertain.",
      source: "SELF_CHECK",
    };
  }

  const reason = response.reason === undefined
    ? "The in-chat self-check classified the current stop episode."
    : boundedReason(response.reason);
  const common = { source: "SELF_CHECK" as const, confidence: 1 };

  switch (response.decision) {
    case "CONTINUE":
      return { decision: "CONTINUE", reasonCode: "NEEDLESS_TURN_BOUNDARY", reason, ...common };
    case "HOLD_APPROVAL":
      return { decision: "HOLD", reasonCode: "HUMAN_APPROVAL_REQUIRED", reason, ...common };
    case "HOLD_DECISION":
      return { decision: "HOLD", reasonCode: "MATERIAL_DECISION_REQUIRED", reason, ...common };
    case "HOLD_HUMAN_OPERATION":
      return { decision: "HOLD", reasonCode: "HUMAN_OPERATION_REQUIRED", reason, ...common };
    case "COMPLETE":
      return { decision: "HOLD", reasonCode: "PROJECT_COMPLETE", reason, ...common };
    case "PLATFORM_ERROR":
      return { decision: "HOLD", reasonCode: "PLATFORM_ERROR", reason, ...common };
    case "RATE_LIMIT":
      return { decision: "HOLD", reasonCode: "RATE_LIMIT", reason, ...common };
    default:
      return {
        decision: "UNSURE",
        reasonCode: "AMBIGUOUS",
        reason: "The in-chat self-check response was uncertain.",
        source: "SELF_CHECK",
      };
  }
}
