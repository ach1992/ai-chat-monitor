import type { ClassificationResult } from "../classification/types.js";
import type { ConversationStatusMarkerHealth, ConversationProtocolDecision } from "../classification/conversation-protocol.js";
import type { BlockingReason, GenerationState } from "../shared/observation.js";

export type MonitoringEventType =
  | "RESPONSE_COMPLETE"
  | "CONTINUE_READY"
  | "APPROVAL_REQUIRED"
  | "DECISION_REQUIRED"
  | "HUMAN_OPERATION_REQUIRED"
  | "TASK_COMPLETE"
  | "RETRY_AVAILABLE"
  | "PLATFORM_ERROR"
  | "NETWORK_ERROR"
  | "RATE_LIMIT"
  | "AUTH_REQUIRED"
  | "VERIFICATION_REQUIRED"
  | "CONVERSATION_FULL"
  | "SEMANTIC_UNKNOWN"
  | "PROVIDER_ERROR"
  | "GENERATION_STALLED"
  | "REPEATED_RESPONSE";

export type SemanticStatusSource = "UI" | "STATUS_MARKER" | "RULE" | "PROVIDER" | "UNKNOWN";

export type MonitoringPageState =
  | "GENERATING"
  | "IDLE"
  | "RETRY_AVAILABLE"
  | "PLATFORM_ERROR"
  | "NETWORK_ERROR"
  | "RATE_LIMIT"
  | "AUTH_REQUIRED"
  | "VERIFICATION_REQUIRED"
  | "CONVERSATION_FULL"
  | "UNKNOWN";

export interface MonitoringPolicyDefaults {
  browserEvents: MonitoringEventType[];
  soundEvents: MonitoringEventType[];
  stallThresholdMs: number;
  suppressLowPriorityWhileFocused: boolean;
}

export interface ChatMonitoringPolicy {
  conversationId: string;
  enabled: boolean;
  browserEvents?: MonitoringEventType[];
  soundEvents?: MonitoringEventType[];
  stallThresholdMs?: number;
  suppressLowPriorityWhileFocused?: boolean;
}

export interface ResolvedMonitoringPolicy {
  revision: number;
  conversationId: string;
  enabled: boolean;
  browserEvents: MonitoringEventType[];
  soundEvents: MonitoringEventType[];
  stallThresholdMs: number;
  suppressLowPriorityWhileFocused: boolean;
}

export interface MonitoringPolicyState {
  version: 2;
  revision: number;
  defaults: MonitoringPolicyDefaults;
  chats: ChatMonitoringPolicy[];
}

export interface ChatMonitoringPolicyPatch {
  enabled?: boolean;
  browserEvents?: MonitoringEventType[] | null;
  soundEvents?: MonitoringEventType[] | null;
  stallThresholdMs?: number | null;
  suppressLowPriorityWhileFocused?: boolean | null;
}

export interface MonitoringRuntimeStatus {
  tabId: number;
  conversationId?: string;
  enabled: boolean;
  generation?: GenerationState;
  pageState: MonitoringPageState;
  blockingReasons: BlockingReason[];
  semanticDecision?: ConversationProtocolDecision;
  semanticSource: SemanticStatusSource;
  markerHealth: ConversationStatusMarkerHealth;
  classification?: ClassificationResult;
  assistantFingerprint?: string;
  lastEvent?: MonitoringEventType;
  updatedAt: number;
}

export interface MonitoringEvent {
  id: string;
  at: number;
  tabId: number;
  conversationId: string;
  type: MonitoringEventType;
  pageState: MonitoringPageState;
  semanticDecision?: ConversationProtocolDecision;
  semanticSource: SemanticStatusSource;
  markerHealth: ConversationStatusMarkerHealth;
  assistantFingerprint?: string;
  title: string;
  message: string;
}
