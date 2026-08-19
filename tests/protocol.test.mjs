import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  isContentHello,
  isContentNavigation,
  isContentObservation,
  isContentUserInteraction,
  isPanelAuditClear,
  isPanelAutomationDefaultsUpdate,
  isPanelAutomationPolicyUpdate,
  isPanelStatusRequest,
} from "../dist/shared/protocol.js";

const base = {
  protocolVersion: PROTOCOL_VERSION,
  agentInstanceId: "agent-1",
  pageEpoch: 1,
  sequence: 1,
  sentAt: 100,
};

test("protocol accepts identity-bound content events", () => {
  assert.equal(isContentHello({ ...base, type: "content:hello", routeKey: "/c/abc1", conversationId: "abc1" }), true);
  assert.equal(
    isContentNavigation({ ...base, type: "content:navigation", pageEpoch: 2, routeKey: "/c/abc2", conversationId: "abc2" }),
    true,
  );
  assert.equal(isContentUserInteraction({ ...base, type: "content:user-interaction", interaction: "COMPOSER_INPUT" }), true);
});

test("protocol rejects malformed or stale-shape messages", () => {
  assert.equal(isContentHello({ ...base, type: "content:hello", sequence: 0, routeKey: "/" }), false);
  assert.equal(isContentHello({ ...base, type: "content:hello", protocolVersion: 1, routeKey: "/" }), false);
  assert.equal(isContentUserInteraction({ ...base, type: "content:user-interaction", interaction: "CLICK_ANYWHERE" }), false);
});

test("observation validates bounded normalized response metadata", () => {
  const observation = {
    conversationId: "abc1",
    routeKey: "/c/abc1",
    generation: "IDLE",
    latestAssistant: {
      normalizedText: "done",
      textLength: 4,
      fingerprint: "a".repeat(64),
    },
    composer: { present: true, hasText: false, focused: false },
    blocking: { blocked: false, reasons: [] },
    confidence: "HIGH",
    observedAt: 200,
  };
  assert.equal(isContentObservation({ ...base, type: "content:observation", observation }), true);
  assert.equal(
    isContentObservation({
      ...base,
      type: "content:observation",
      observation: { ...observation, latestAssistant: { ...observation.latestAssistant, fingerprint: "bad" } },
    }),
    false,
  );
});

test("panel status requests reject invalid tab identities", () => {
  assert.equal(isPanelStatusRequest({ type: "panel:status-request", protocolVersion: PROTOCOL_VERSION, tabId: 42 }), true);
  assert.equal(isPanelStatusRequest({ type: "panel:status-request", protocolVersion: PROTOCOL_VERSION, tabId: -1 }), false);
});

test("reliability policy messages validate bounded hard fuse values and clear-audit command", () => {
  assert.equal(
    isPanelAutomationDefaultsUpdate({
      type: "panel:automation-defaults-update",
      protocolVersion: PROTOCOL_VERSION,
      patch: { hardFuseMaxAutoContinues: 50 },
    }),
    true,
  );
  assert.equal(
    isPanelAutomationDefaultsUpdate({
      type: "panel:automation-defaults-update",
      protocolVersion: PROTOCOL_VERSION,
      patch: { hardFuseMaxAutoContinues: 4 },
    }),
    false,
  );
  assert.equal(
    isPanelAutomationPolicyUpdate({
      type: "panel:automation-policy-update",
      protocolVersion: PROTOCOL_VERSION,
      tabId: 1,
      conversationId: "conv-1",
      patch: { hardFuseMaxAutoContinues: null },
    }),
    true,
  );
  assert.equal(isPanelAuditClear({ type: "panel:audit-clear", protocolVersion: PROTOCOL_VERSION }), true);
  assert.equal(isPanelAuditClear({ type: "panel:audit-clear", protocolVersion: 1 }), false);
});
