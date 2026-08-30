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

export type ConversationStatusMarkerHealth = "DETECTED" | "MISSING" | "MALFORMED";

export interface ConversationStatusMarkerResult {
  health: ConversationStatusMarkerHealth;
  decision?: ConversationProtocolDecision;
  prefix?: typeof AI_CHAT_MONITOR_STATUS_PREFIX;
}

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

export const AI_CHAT_MONITOR_STATUS_PREFIX = "AI_CHAT_MONITOR_STATUS=";

function normalizeLines(raw: string): string[] {
  return raw.replace(/\r\n?/g, "\n").trimEnd().split("\n");
}

function parseStatusJson(raw: string): ConversationProtocolStatus | undefined {
  const match = /^\{\s*"decision"\s*:\s*"([A-Z_]+)"\s*\}$/.exec(raw);
  const decision = match?.[1];
  if (decision === undefined || !ALLOWED_DECISIONS.has(decision as ConversationProtocolDecision)) return undefined;
  return { decision: decision as ConversationProtocolDecision };
}

function markerOccurrences(raw: string): number[] {
  const occurrences: number[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const index = raw.indexOf(AI_CHAT_MONITOR_STATUS_PREFIX, offset);
    if (index < 0) break;
    occurrences.push(index);
    offset = index + AI_CHAT_MONITOR_STATUS_PREFIX.length;
  }
  return occurrences;
}

function markerAppearsInsideOpenFence(lines: string[], markerLineIndex: number): boolean {
  let openFence: { char: "`" | "~"; length: number } | undefined;

  for (let index = 0; index < markerLineIndex; index += 1) {
    const line = lines[index] ?? "";
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    const token = match?.[1];
    if (token === undefined) continue;

    const char = token[0] as "`" | "~";
    if (openFence === undefined) {
      openFence = { char, length: token.length };
      continue;
    }

    if (char === openFence.char && token.length >= openFence.length) openFence = undefined;
  }

  return openFence !== undefined;
}

export function inspectConversationStatusMarker(raw: string): ConversationStatusMarkerResult {
  const normalized = raw.replace(/\r\n?/g, "\n").trimEnd();
  if (normalized.length === 0) return { health: "MISSING" };

  const occurrences = markerOccurrences(normalized);
  if (occurrences.length === 0) return { health: "MISSING" };
  if (occurrences.length !== 1) return { health: "MALFORMED" };

  const lines = normalizeLines(normalized);
  const terminalLine = lines.at(-1)?.trim() ?? "";
  if (!terminalLine.startsWith(AI_CHAT_MONITOR_STATUS_PREFIX)) return { health: "MALFORMED" };

  const markerLineIndex = lines.length - 1;
  if (markerAppearsInsideOpenFence(lines, markerLineIndex)) return { health: "MALFORMED" };

  const status = parseStatusJson(terminalLine.slice(AI_CHAT_MONITOR_STATUS_PREFIX.length).trim());
  if (status === undefined) return { health: "MALFORMED" };

  return {
    health: "DETECTED",
    decision: status.decision,
    prefix: AI_CHAT_MONITOR_STATUS_PREFIX,
  };
}

export function conversationProtocolDecision(raw: string): ConversationProtocolDecision | undefined {
  return inspectConversationStatusMarker(raw).decision;
}

export function hasValidConversationProtocolStatus(raw: string): boolean {
  return inspectConversationStatusMarker(raw).health === "DETECTED";
}

export function stripConversationProtocolStatus(raw: string): string {
  const marker = inspectConversationStatusMarker(raw);
  if (marker.health !== "DETECTED") return raw;
  const lines = normalizeLines(raw);
  lines.pop();
  return lines.join("\n").trimEnd();
}

export function parseConversationProtocolStatus(raw: string): ClassificationResult {
  const marker = inspectConversationStatusMarker(raw);
  if (marker.health !== "DETECTED" || marker.decision === undefined || marker.decision === "UNSURE") {
    return {
      decision: "UNSURE",
      reasonCode: "AMBIGUOUS",
      reason: marker.health === "MISSING"
        ? "No standalone terminal AI Chat Monitor status marker was present."
        : "The terminal AI Chat Monitor status marker was malformed, ambiguous, or uncertain.",
      source: "CONVERSATION_PROTOCOL",
    };
  }

  const reason = boundedReason("The assistant supplied a valid terminal AI Chat Monitor status marker.");
  const common = { source: "CONVERSATION_PROTOCOL" as const, confidence: 1 };

  switch (marker.decision) {
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
        reason: "The AI Chat Monitor status marker could not be resolved.",
        source: "CONVERSATION_PROTOCOL",
      };
  }
}
