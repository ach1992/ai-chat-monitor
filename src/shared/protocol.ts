import { isPageObservation, type PageObservation } from "./observation.js";
import type { ControlEligibility, SessionView } from "../core/session-registry.js";

export const PROTOCOL_VERSION = 2 as const;

export type UserInteractionKind = "COMPOSER_INPUT" | "COMPOSER_FOCUS" | "MANUAL_SEND";

interface ContentSessionBase {
  protocolVersion: typeof PROTOCOL_VERSION;
  agentInstanceId: string;
  pageEpoch: number;
  sequence: number;
  sentAt: number;
}

export interface ContentHello extends ContentSessionBase {
  type: "content:hello";
  routeKey: string;
  conversationId?: string;
}

export interface ContentNavigation extends ContentSessionBase {
  type: "content:navigation";
  routeKey: string;
  conversationId?: string;
}

export interface ContentObservation extends ContentSessionBase {
  type: "content:observation";
  observation: PageObservation;
}

export interface ContentUserInteraction extends ContentSessionBase {
  type: "content:user-interaction";
  interaction: UserInteractionKind;
}

export interface PanelStatusRequest {
  type: "panel:status-request";
  protocolVersion: typeof PROTOCOL_VERSION;
  tabId: number;
}

export interface ContentAgentAck {
  type: "background:agent-ack";
  protocolVersion: typeof PROTOCOL_VERSION;
  accepted: boolean;
  tabId: number;
  documentId: string;
  controlEligibility?: ControlEligibility;
}

export interface PanelStatusResponse {
  type: "background:status";
  protocolVersion: typeof PROTOCOL_VERSION;
  tabId: number;
  connected: boolean;
  documentId?: string;
  conversationId?: string;
  controlEligibility?: ControlEligibility;
  session?: SessionView;
  lastSeenAt?: number;
}

export interface ProtocolErrorResponse {
  type: "background:error";
  protocolVersion: typeof PROTOCOL_VERSION;
  code: "INVALID_SENDER" | "INVALID_MESSAGE" | "STALE_EVENT" | "STORAGE_FAILURE";
  message: string;
}

export type GuardianRequest =
  | ContentHello
  | ContentNavigation
  | ContentObservation
  | ContentUserInteraction
  | PanelStatusRequest;

export type GuardianResponse = ContentAgentAck | PanelStatusResponse | ProtocolErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasProtocolVersion(value: Record<string, unknown>): boolean {
  return value.protocolVersion === PROTOCOL_VERSION;
}

function isSessionBase(value: Record<string, unknown>): boolean {
  return (
    hasProtocolVersion(value) &&
    typeof value.agentInstanceId === "string" &&
    value.agentInstanceId.length > 0 &&
    value.agentInstanceId.length <= 128 &&
    typeof value.pageEpoch === "number" &&
    Number.isInteger(value.pageEpoch) &&
    value.pageEpoch >= 1 &&
    typeof value.sequence === "number" &&
    Number.isInteger(value.sequence) &&
    value.sequence >= 1 &&
    typeof value.sentAt === "number" &&
    Number.isFinite(value.sentAt)
  );
}

function hasRouteIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.routeKey === "string" &&
    value.routeKey.length > 0 &&
    (value.conversationId === undefined || typeof value.conversationId === "string")
  );
}

export function isContentHello(value: unknown): value is ContentHello {
  return isRecord(value) && value.type === "content:hello" && isSessionBase(value) && hasRouteIdentity(value);
}

export function isContentNavigation(value: unknown): value is ContentNavigation {
  return isRecord(value) && value.type === "content:navigation" && isSessionBase(value) && hasRouteIdentity(value);
}

export function isContentObservation(value: unknown): value is ContentObservation {
  return isRecord(value) && value.type === "content:observation" && isSessionBase(value) && isPageObservation(value.observation);
}

export function isContentUserInteraction(value: unknown): value is ContentUserInteraction {
  return (
    isRecord(value) &&
    value.type === "content:user-interaction" &&
    isSessionBase(value) &&
    (value.interaction === "COMPOSER_INPUT" ||
      value.interaction === "COMPOSER_FOCUS" ||
      value.interaction === "MANUAL_SEND")
  );
}

export function isPanelStatusRequest(value: unknown): value is PanelStatusRequest {
  return (
    isRecord(value) &&
    hasProtocolVersion(value) &&
    value.type === "panel:status-request" &&
    typeof value.tabId === "number" &&
    Number.isInteger(value.tabId) &&
    value.tabId >= 0
  );
}
