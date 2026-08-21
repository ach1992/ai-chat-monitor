import { boundedReason, type ClassificationResult } from "./types.js";

export type ConversationProtocolDecision =
  | "CONTINUE"
  | "HOLD_APPROVAL"
  | "HOLD_DECISION"
  | "HOLD_HUMAN_OPERATION"
  | "COMPLETE"
  | "PLATFORM_ERROR"
  | "RATE_LIMIT"
  | "UNSURE";

interface ConversationProtocolStatus { decision: ConversationProtocolDecision; }

const ALLOWED_DECISIONS = new Set<ConversationProtocolDecision>([
  "CONTINUE",
  "HOLD_APPROVAL",
  "HOLD_DECISION",
  "HOLD_HUMAN_OPERATION",
  "COMPLETE",
  "PLATFORM_ERROR",
  "RATE_LIMIT",
  "UNSURE",
]);

export const CONVERSATION_PROTOCOL_VERSION = 1;
export const GUARDIAN_STATUS_PREFIX = "CHAT_TURN_GUARDIAN_STATUS_V1=";

export const CONVERSATION_PROTOCOL_CONTINUE_RESPONSE =
  "All right. Continue and complete the project. Do not stop unless you genuinely need human approval, a material decision, missing information or credentials, or a human-only action.";
export const CONVERSATION_PROTOCOL_RECOVERY_RESPONSE =
  "Check again to see whether the blocker has been resolved. If it has, continue and complete the project. Do not stop unless you genuinely need human approval, a material decision, missing information or credentials, or a human-only action.";
export const CONVERSATION_PROTOCOL_UNSURE_RESPONSE =
  "Check the work state again and return the status record once more.";

export const DEFAULT_CONVERSATION_PROTOCOL_PROMPT = [
  "[Chat Turn Guardian — Conversation Status Protocol]",
  "",
  "Purpose",
  "This protocol must not change, restart, reframe, summarize, reprioritize, or continue the current task or project.",
  "",
  "This reply",
  "- Remember the protocol for this conversation.",
  "- Classify the work state immediately before this message.",
  "- Reply with exactly one line and nothing else:",
  'CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"<VALUE>"}',
  "",
  "Future replies",
  "- Answer normally without changing the project's direction, scope, priority, or plan.",
  "- End with exactly one status record in the same format.",
  "- Add nothing after it.",
  "",
  "Values",
  "- CONTINUE — Work remains and can proceed autonomously.",
  "- HOLD_APPROVAL — Human approval is required.",
  "- HOLD_DECISION — A material human decision is required.",
  "- HOLD_HUMAN_OPERATION — Human input, credentials, or action is required.",
  "- COMPLETE — No work remains.",
  "- PLATFORM_ERROR — The platform blocks progress.",
  "- RATE_LIMIT — A rate limit blocks progress.",
  "- UNSURE — The state is unclear.",
].join("\n");

function parseStatusJson(raw: string): ConversationProtocolStatus | undefined {
  const match = /^\{\s*"decision"\s*:\s*"([A-Z_]+)"\s*\}$/.exec(raw);
  const decision = match?.[1];
  if (decision === undefined || !ALLOWED_DECISIONS.has(decision as ConversationProtocolDecision)) return undefined;
  return { decision: decision as ConversationProtocolDecision };
}

function trailingStatus(raw: string): ConversationProtocolStatus | undefined {
  const normalized = raw.replace(/\r\n?/g, "\n").trimEnd();
  const markerCount = normalized.split(GUARDIAN_STATUS_PREFIX).length - 1;
  if (markerCount !== 1) return undefined;
  const markerIndex = normalized.lastIndexOf(GUARDIAN_STATUS_PREFIX);
  const prefixText = normalized.slice(0, markerIndex);
  const fenceCount = prefixText.match(/```/g)?.length ?? 0;
  if (fenceCount % 2 !== 0) return undefined;
  const json = normalized.slice(markerIndex + GUARDIAN_STATUS_PREFIX.length).trim();
  return parseStatusJson(json);
}

export function conversationProtocolDecision(raw: string): ConversationProtocolDecision | undefined {
  return trailingStatus(raw)?.decision;
}

export function conversationProtocolResponseText(
  decision: ConversationProtocolDecision,
): string | undefined {
  switch (decision) {
    case "CONTINUE":
      return CONVERSATION_PROTOCOL_CONTINUE_RESPONSE;
    case "PLATFORM_ERROR":
    case "RATE_LIMIT":
      return CONVERSATION_PROTOCOL_RECOVERY_RESPONSE;
    case "UNSURE":
      return CONVERSATION_PROTOCOL_UNSURE_RESPONSE;
    default:
      return undefined;
  }
}

export function hasValidConversationProtocolStatus(raw: string): boolean {
  return trailingStatus(raw) !== undefined;
}

export function stripConversationProtocolStatus(raw: string): string {
  if (trailingStatus(raw) === undefined) return raw;
  const normalized = raw.replace(/\r\n?/g, "\n").trimEnd();
  const markerIndex = normalized.lastIndexOf(GUARDIAN_STATUS_PREFIX);
  return normalized.slice(0, markerIndex).trimEnd();
}

export function parseConversationProtocolStatus(raw: string): ClassificationResult {
  const response = trailingStatus(raw);
  if (response === undefined || response.decision === "UNSURE") {
    return {
      decision: "UNSURE",
      reasonCode: "AMBIGUOUS",
      reason: "The conversation protocol status was missing, malformed, duplicated, or uncertain.",
      source: "CONVERSATION_PROTOCOL",
    };
  }

  const reason = boundedReason("The assistant supplied a valid terminal conversation status.");
  const common = { source: "CONVERSATION_PROTOCOL" as const, confidence: 1 };

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
        reason: "The conversation protocol status was uncertain.",
        source: "CONVERSATION_PROTOCOL",
      };
  }
}
