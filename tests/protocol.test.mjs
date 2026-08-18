import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  isContentHello,
  isPanelStatusRequest,
} from "../dist/shared/protocol.js";

test("content hello requires the current protocol and a finite timestamp", () => {
  assert.equal(
    isContentHello({
      type: "content:hello",
      protocolVersion: PROTOCOL_VERSION,
      sentAt: 123,
    }),
    true,
  );
  assert.equal(
    isContentHello({
      type: "content:hello",
      protocolVersion: PROTOCOL_VERSION + 1,
      sentAt: 123,
    }),
    false,
  );
});

test("panel status requests reject invalid tab identities", () => {
  assert.equal(
    isPanelStatusRequest({
      type: "panel:status-request",
      protocolVersion: PROTOCOL_VERSION,
      tabId: 42,
    }),
    true,
  );
  assert.equal(
    isPanelStatusRequest({
      type: "panel:status-request",
      protocolVersion: PROTOCOL_VERSION,
      tabId: -1,
    }),
    false,
  );
});
