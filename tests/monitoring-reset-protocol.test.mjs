import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "../dist/shared/protocol.js";
import { isPanelMonitoringChatsReset } from "../dist/monitoring/reset-protocol.js";

test("monitored-chat reset accepts only the exact trusted panel request shape", () => {
  assert.equal(isPanelMonitoringChatsReset({
    type: "panel:monitoring-chats-reset",
    protocolVersion: PROTOCOL_VERSION,
  }), true);

  assert.equal(isPanelMonitoringChatsReset({
    type: "panel:monitoring-chats-reset",
    protocolVersion: 1,
  }), false);

  assert.equal(isPanelMonitoringChatsReset({
    type: "panel:monitoring-chats-reset",
    protocolVersion: PROTOCOL_VERSION,
    enabled: true,
  }), false);

  assert.equal(isPanelMonitoringChatsReset({
    type: "panel:monitoring-chats-reset",
  }), false);
});