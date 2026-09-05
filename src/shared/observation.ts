export type GenerationState = "IDLE" | "GENERATING" | "UNKNOWN";
export type ObservationConfidence = "HIGH" | "LOW";

export type BlockingReason =
  | "MODAL"
  | "RATE_LIMIT"
  | "AUTH"
  | "NETWORK"
  | "ERROR"
  | "CAPTCHA"
  | "ACCOUNT_VERIFICATION"
  | "CONFIRMATION_REQUIRED"
  | "CONVERSATION_FULL";

export interface AssistantResponseSnapshot {
  normalizedText: string;
  textLength: number;
  fingerprint: string;
  domMessageId?: string;
}

export interface UserTurnSnapshot {
  normalizedText: string;
  textLength: number;
  domMessageId?: string;
}

export interface ComposerSnapshot {
  present: boolean;
  hasText: boolean;
  focused: boolean;
}

export interface BlockingSnapshot {
  blocked: boolean;
  reasons: BlockingReason[];
}

export interface PageActionSnapshot {
  retryAvailable: boolean;
  continueGeneratingAvailable: boolean;
}

export interface PageObservation {
  conversationId?: string;
  routeKey: string;
  pageTitle?: string;
  generation: GenerationState;
  latestUser?: UserTurnSnapshot;
  latestAssistant?: AssistantResponseSnapshot;
  composer: ComposerSnapshot;
  blocking: BlockingSnapshot;
  actions: PageActionSnapshot;
  confidence: ObservationConfidence;
  observedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGenerationState(value: unknown): value is GenerationState {
  return value === "IDLE" || value === "GENERATING" || value === "UNKNOWN";
}

function isBlockingReason(value: unknown): value is BlockingReason {
  return (
    value === "MODAL" ||
    value === "RATE_LIMIT" ||
    value === "AUTH" ||
    value === "NETWORK" ||
    value === "ERROR" ||
    value === "CAPTCHA" ||
    value === "ACCOUNT_VERIFICATION" ||
    value === "CONFIRMATION_REQUIRED" ||
    value === "CONVERSATION_FULL"
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isTurnSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.normalizedText === "string" &&
    typeof value.textLength === "number" &&
    Number.isInteger(value.textLength) &&
    value.textLength >= value.normalizedText.length &&
    isOptionalString(value.domMessageId)
  );
}

export function isPageObservation(value: unknown): value is PageObservation {
  if (!isRecord(value)) return false;
  if (
    !isOptionalString(value.conversationId) ||
    typeof value.routeKey !== "string" ||
    value.routeKey.length === 0 ||
    (value.pageTitle !== undefined && (typeof value.pageTitle !== "string" || value.pageTitle.length > 300)) ||
    !isGenerationState(value.generation) ||
    (value.confidence !== "HIGH" && value.confidence !== "LOW") ||
    !Number.isFinite(value.observedAt)
  ) {
    return false;
  }

  if (!isRecord(value.composer)) return false;
  if (
    typeof value.composer.present !== "boolean" ||
    typeof value.composer.hasText !== "boolean" ||
    typeof value.composer.focused !== "boolean"
  ) {
    return false;
  }

  if (!isRecord(value.blocking) || typeof value.blocking.blocked !== "boolean") return false;
  if (!Array.isArray(value.blocking.reasons) || !value.blocking.reasons.every(isBlockingReason)) return false;

  if (!isRecord(value.actions)) return false;
  if (
    typeof value.actions.retryAvailable !== "boolean" ||
    typeof value.actions.continueGeneratingAvailable !== "boolean"
  ) {
    return false;
  }

  if (value.latestUser !== undefined && !isTurnSnapshot(value.latestUser)) return false;

  if (value.latestAssistant !== undefined) {
    if (!isRecord(value.latestAssistant) || !isTurnSnapshot(value.latestAssistant)) return false;
    if (
      typeof value.latestAssistant.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.latestAssistant.fingerprint)
    ) {
      return false;
    }
  }

  return true;
}
