import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  isPanelProviderClassifierReadinessRequest,
} from "../dist/shared/protocol.js";

test("classifier readiness requests accept only bounded provider ids and current protocol", () => {
  assert.equal(isPanelProviderClassifierReadinessRequest({
    type: "panel:provider-classifier-readiness-request",
    protocolVersion: PROTOCOL_VERSION,
    providerId: "main",
  }), true);
  assert.equal(isPanelProviderClassifierReadinessRequest({
    type: "panel:provider-classifier-readiness-request",
    protocolVersion: PROTOCOL_VERSION,
    providerId: "bad id",
  }), false);
  assert.equal(isPanelProviderClassifierReadinessRequest({
    type: "panel:provider-classifier-readiness-request",
    protocolVersion: 1,
    providerId: "main",
  }), false);
});
