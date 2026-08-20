export type ClassificationDecision = "CONTINUE" | "HOLD" | "UNSURE";

export type ClassificationReasonCode =
  | "HUMAN_APPROVAL_REQUIRED"
  | "MATERIAL_DECISION_REQUIRED"
  | "HUMAN_OPERATION_REQUIRED"
  | "PROJECT_COMPLETE"
  | "USER_STOP"
  | "STAGNATION"
  | "PLATFORM_ERROR"
  | "RATE_LIMIT"
  | "SAFETY_BOUNDARY"
  | "NEEDLESS_TURN_BOUNDARY"
  | "AMBIGUOUS"
  | "PROVIDER_FAILURE"
  | "OTHER";

export type ClassificationSource = "RULE" | "PROVIDER" | "SELF_CHECK" | "SYSTEM";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SanitizedTurn extends ConversationTurn {
  originalLength: number;
  truncated: boolean;
}

export interface SanitizedContext {
  turns: SanitizedTurn[];
  totalCharacters: number;
  truncated: boolean;
}

export interface ClassificationRequest {
  context: SanitizedContext;
}

export interface ClassificationResult {
  decision: ClassificationDecision;
  reasonCode: ClassificationReasonCode;
  reason: string;
  source: ClassificationSource;
  confidence?: number;
  providerId?: string;
}

export const MAX_REASON_LENGTH = 240;

export function boundedReason(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_LENGTH);
}

export function unsureResult(
  reasonCode: ClassificationReasonCode,
  reason: string,
  options: { providerId?: string; confidence?: number } = {},
): ClassificationResult {
  return {
    decision: "UNSURE",
    reasonCode,
    reason: boundedReason(reason),
    source: options.providerId === undefined ? "SYSTEM" : "PROVIDER",
    ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
    ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
  };
}
