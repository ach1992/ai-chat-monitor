export type GenerationState = "IDLE" | "GENERATING" | "UNKNOWN";

export type BlockingReason =
  | "MODAL"
  | "RATE_LIMIT"
  | "AUTH"
  | "NETWORK"
  | "ERROR";

export interface AssistantResponseSnapshot {
  text: string;
  fingerprint: string;
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
  summary?: string;
}

export interface PageObservation {
  conversationId?: string;
  routeKey: string;
  generation: GenerationState;
  latestAssistant?: AssistantResponseSnapshot;
  composer: ComposerSnapshot;
  blocking: BlockingSnapshot;
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
    value === "ERROR"
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isPageObservation(value: unknown): value is PageObservation {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isOptionalString(value.conversationId) ||
    typeof value.routeKey !== "string" ||
    value.routeKey.length === 0 ||
    !isGenerationState(value.generation) ||
    !Number.isFinite(value.observedAt)
  ) {
    return false;
  }

  if (!isRecord(value.composer)) {
    return false;
  }
  if (
    typeof value.composer.present !== "boolean" ||
    typeof value.composer.hasText !== "boolean" ||
    typeof value.composer.focused !== "boolean"
  ) {
    return false;
  }

  if (!isRecord(value.blocking) || typeof value.blocking.blocked !== "boolean") {
    return false;
  }
  if (
    !Array.isArray(value.blocking.reasons) ||
    !value.blocking.reasons.every(isBlockingReason) ||
    !isOptionalString(value.blocking.summary)
  ) {
    return false;
  }

  if (value.latestAssistant !== undefined) {
    if (!isRecord(value.latestAssistant)) {
      return false;
    }
    if (
      typeof value.latestAssistant.text !== "string" ||
      typeof value.latestAssistant.fingerprint !== "string" ||
      value.latestAssistant.fingerprint.length !== 64 ||
      !isOptionalString(value.latestAssistant.domMessageId)
    ) {
      return false;
    }
  }

  return true;
}
