export const PROTOCOL_VERSION = 1 as const;

export interface ContentHello {
  type: "content:hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  sentAt: number;
}

export interface PanelStatusRequest {
  type: "panel:status-request";
  protocolVersion: typeof PROTOCOL_VERSION;
  tabId: number;
}

export interface ContentHelloAck {
  type: "background:hello-ack";
  protocolVersion: typeof PROTOCOL_VERSION;
  tabId: number;
  documentId?: string;
}

export interface PanelStatusResponse {
  type: "background:status";
  protocolVersion: typeof PROTOCOL_VERSION;
  tabId: number;
  connected: boolean;
  documentId?: string;
  lastSeenAt?: number;
}

export interface ProtocolErrorResponse {
  type: "background:error";
  protocolVersion: typeof PROTOCOL_VERSION;
  code: "INVALID_SENDER" | "STORAGE_FAILURE";
  message: string;
}

export type GuardianRequest = ContentHello | PanelStatusRequest;
export type GuardianResponse =
  | ContentHelloAck
  | PanelStatusResponse
  | ProtocolErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasProtocolVersion(value: Record<string, unknown>): boolean {
  return value.protocolVersion === PROTOCOL_VERSION;
}

export function isContentHello(value: unknown): value is ContentHello {
  if (!isRecord(value) || !hasProtocolVersion(value)) {
    return false;
  }

  return value.type === "content:hello" && Number.isFinite(value.sentAt);
}

export function isPanelStatusRequest(
  value: unknown,
): value is PanelStatusRequest {
  if (!isRecord(value) || !hasProtocolVersion(value)) {
    return false;
  }

  return (
    value.type === "panel:status-request" &&
    Number.isInteger(value.tabId) &&
    typeof value.tabId === "number" &&
    value.tabId >= 0
  );
}
