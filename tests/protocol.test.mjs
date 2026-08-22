import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  isContentHello,
  isContentNavigation,
  isContentObservation,
  isContentUserInteraction,
  isPanelHistoryClear,
  isPanelMonitoringDefaultsUpdate,
  isPanelMonitoringPolicyUpdate,
  isPanelProviderModelCatalogRequest,
  isPanelProviderProfileUpsert,
  isPanelStatusRequest,
} from "../dist/shared/protocol.js";

const base = {
  protocolVersion: PROTOCOL_VERSION,
  agentInstanceId: "agent-1",
  pageEpoch: 1,
  sequence: 1,
  sentAt: 100,
};

test("protocol accepts identity-bound observational content events", () => {
  assert.equal(isContentHello({ ...base, type: "content:hello", routeKey: "/c/abc1", conversationId: "abc1" }), true);
  assert.equal(
    isContentNavigation({ ...base, type: "content:navigation", pageEpoch: 2, routeKey: "/c/abc2", conversationId: "abc2" }),
    true,
  );
  assert.equal(isContentUserInteraction({ ...base, type: "content:user-interaction", interaction: "COMPOSER_INPUT" }), true);
});

test("protocol rejects malformed content messages", () => {
  assert.equal(isContentHello({ ...base, type: "content:hello", sequence: 0, routeKey: "/" }), false);
  assert.equal(isContentHello({ ...base, type: "content:hello", protocolVersion: 1, routeKey: "/" }), false);
  assert.equal(isContentUserInteraction({ ...base, type: "content:user-interaction", interaction: "CLICK_ANYWHERE" }), false);
});

test("observation validates bounded response metadata and read-only action hints", () => {
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
    actions: { retryAvailable: false, continueGeneratingAvailable: false },
    confidence: "HIGH",
    observedAt: 200,
  };
  assert.equal(isContentObservation({ ...base, type: "content:observation", observation }), true);
  assert.equal(
    isContentObservation({
      ...base,
      type: "content:observation",
      observation: { ...observation, actions: { retryAvailable: "yes", continueGeneratingAvailable: false } },
    }),
    false,
  );
});

test("panel status requests reject invalid tab identities", () => {
  assert.equal(isPanelStatusRequest({ type: "panel:status-request", protocolVersion: PROTOCOL_VERSION, tabId: 42 }), true);
  assert.equal(isPanelStatusRequest({ type: "panel:status-request", protocolVersion: PROTOCOL_VERSION, tabId: -1 }), false);
});

test("monitoring policy messages expose no continuation authority", () => {
  assert.equal(isPanelMonitoringPolicyUpdate({
    type: "panel:monitoring-policy-update",
    protocolVersion: PROTOCOL_VERSION,
    tabId: 1,
    conversationId: "conv-1",
    patch: { enabled: true, soundEvents: ["TASK_COMPLETE"], stallThresholdMs: 90_000 },
  }), true);
  assert.equal(isPanelMonitoringDefaultsUpdate({
    type: "panel:monitoring-defaults-update",
    protocolVersion: PROTOCOL_VERSION,
    patch: { browserEvents: ["RETRY_AVAILABLE"], suppressLowPriorityWhileFocused: true },
  }), true);
  assert.equal(isPanelMonitoringDefaultsUpdate({
    type: "panel:monitoring-defaults-update",
    protocolVersion: PROTOCOL_VERSION,
    patch: { continuationText: "Continue." },
  }), false);
  assert.equal(isPanelHistoryClear({ type: "panel:history-clear", protocolVersion: PROTOCOL_VERSION }), true);
});

test("provider profile and model catalog validation remain bounded to HTTPS profiles", () => {
  assert.equal(isPanelProviderProfileUpsert({
    type: "panel:provider-profile-upsert",
    protocolVersion: PROTOCOL_VERSION,
    profile: { kind: "NARAROUTER", id: "nara", model: "saved-alias", apiKey: "" },
  }), true);
  assert.equal(isPanelProviderProfileUpsert({
    type: "panel:provider-profile-upsert",
    protocolVersion: PROTOCOL_VERSION,
    profile: { kind: "OPENAI_COMPATIBLE", id: "generic", model: "manual", baseUrl: "http://insecure.example/v1", apiKey: "secret" },
  }), false);
  assert.equal(isPanelProviderModelCatalogRequest({
    type: "panel:provider-model-catalog-request",
    protocolVersion: PROTOCOL_VERSION,
    spec: { kind: "OPENAI_COMPATIBLE", baseUrl: "https://api.example.test/v1", apiKey: "secret" },
  }), true);
});
