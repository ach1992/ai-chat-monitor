import type { ClassificationResult } from "../classification/types.js";

export type ChatAutomationMode = "OFF" | "OBSERVE" | "AUTO" | "NOTIFY_ONLY";

export type NotificationTrigger =
  | "RESPONSE_FINISHED"
  | "HOLD"
  | "UNSURE"
  | "ERROR"
  | "STAGNATION";

export interface AutomationTiming {
  settleDelayMs: number;
  continueDelayMs: number;
  cooldownMs: number;
}

export interface ResolvedAutomationPolicy {
  revision: number;
  conversationId: string;
  mode: ChatAutomationMode;
  timing: AutomationTiming;
  continuationText: string;
  notificationTriggers: NotificationTrigger[];
  hardFuseMaxAutoContinues: number;
  emergencyPaused: boolean;
}

export type AutomationRuntimePhase =
  | "DISABLED"
  | "IDLE"
  | "OBSERVING"
  | "SETTLING"
  | "EVALUATING"
  | "SELF_CHECK_SENDING"
  | "WAITING_FOR_SELF_CHECK_RESPONSE"
  | "WAITING_TO_CONTINUE"
  | "SENDING"
  | "COOLDOWN"
  | "HOLD"
  | "UNSURE"
  | "AMBIGUOUS_WRITE"
  | "PAUSED";

export interface AutomationDecisionEnvelope {
  action: "CONTINUATION" | "SELF_CHECK_PROBE";
  decisionId: string;
  tabId: number;
  documentId: string;
  agentInstanceId: string;
  pageEpoch: number;
  conversationId: string;
  routeKey: string;
  assistantFingerprint: string;
  assistantDomMessageId?: string;
  lastUserInteractionAt?: number;
  policyRevision: number;
  evidenceKey: string;
  classification: ClassificationResult;
  continuationText: string;
  createdAt: number;
  expiresAt: number;
}

export type GuardedSendStatus = "NOT_STARTED" | "VERIFIED" | "AMBIGUOUS";

export interface GuardedSendResult {
  decisionId: string;
  status: GuardedSendStatus;
  reason: string;
  observedConversationId?: string;
  observedAssistantFingerprint?: string;
}

export interface AutomationRuntimeStatus {
  tabId: number;
  conversationId?: string;
  mode: ChatAutomationMode;
  phase: AutomationRuntimePhase;
  policyRevision?: number;
  assistantFingerprint?: string;
  lastDecision?: ClassificationResult;
  decisionId?: string;
  cooldownUntil?: number;
  reason?: string;
  updatedAt: number;
}

export function isGuardedSendResult(value: unknown): value is GuardedSendResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.decisionId === "string" &&
    record.decisionId.length > 0 &&
    (record.status === "NOT_STARTED" || record.status === "VERIFIED" || record.status === "AMBIGUOUS") &&
    typeof record.reason === "string" &&
    (record.observedConversationId === undefined || typeof record.observedConversationId === "string") &&
    (record.observedAssistantFingerprint === undefined || typeof record.observedAssistantFingerprint === "string")
  );
}
