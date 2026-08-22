import { PROTOCOL_VERSION } from "../shared/protocol.js";

export interface PanelMonitoringChatsReset {
  type: "panel:monitoring-chats-reset";
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface MonitoringChatsResetResponse {
  type: "background:monitoring-chats-reset";
  protocolVersion: typeof PROTOCOL_VERSION;
  revision: number;
  cleared: number;
}

export function isPanelMonitoringChatsReset(value: unknown): value is PanelMonitoringChatsReset {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "panel:monitoring-chats-reset" &&
    record.protocolVersion === PROTOCOL_VERSION &&
    Object.keys(record).every((key) => key === "type" || key === "protocolVersion")
  );
}