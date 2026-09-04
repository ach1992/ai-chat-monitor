import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../dist/core/session-registry.js";

function observation(conversationId, routeKey, generation = "IDLE") {
  return {
    conversationId,
    routeKey,
    generation,
    composer: { present: true, hasText: false, focused: false },
    blocking: { blocked: false, reasons: [] },
    confidence: "HIGH",
    observedAt: 100,
  };
}

function register(registry, tabId, conversationId, sentAt = tabId * 100, documentId = `doc-${tabId}`) {
  return registry.registerAgent({
    tabId,
    documentId,
    agentInstanceId: `agent-${tabId}`,
    pageEpoch: 1,
    sequence: 1,
    routeKey: `/c/${conversationId}`,
    conversationId,
    sentAt,
  });
}

function observe(registry, tabId, conversationId, sequence = 2, generation = "IDLE") {
  return registry.applyObservation({
    tabId,
    documentId: `doc-${tabId}`,
    agentInstanceId: `agent-${tabId}`,
    pageEpoch: 1,
    sequence,
    observation: observation(conversationId, `/c/${conversationId}`, generation),
    sentAt: 1000 + sequence,
  });
}

test("several tabs retain independent state during concurrent generation", () => {
  const registry = new SessionRegistry();
  assert.equal(register(registry, 1, "conv-a").accepted, true);
  assert.equal(register(registry, 2, "conv-b").accepted, true);
  assert.equal(observe(registry, 1, "conv-a", 2, "GENERATING").accepted, true);
  assert.equal(observe(registry, 2, "conv-b", 2, "GENERATING").accepted, true);

  assert.equal(registry.getTab(1)?.observation?.generation, "GENERATING");
  assert.equal(registry.getTab(2)?.observation?.generation, "GENERATING");

  assert.equal(observe(registry, 2, "conv-b", 3, "IDLE").accepted, true);
  assert.equal(registry.getTab(1)?.observation?.generation, "GENERATING");
  assert.equal(registry.getTab(2)?.observation?.generation, "IDLE");
  assert.equal(registry.getTab(1)?.controlEligibility, "OWNER");
  assert.equal(registry.getTab(2)?.controlEligibility, "OWNER");
});

test("duplicate conversation has one owner and fresh mirror takeover", () => {
  const registry = new SessionRegistry();
  register(registry, 10, "same", 100);
  register(registry, 20, "same", 200);
  observe(registry, 10, "same");
  observe(registry, 20, "same");

  assert.equal(registry.getTab(10)?.controlEligibility, "OWNER");
  assert.equal(registry.getTab(20)?.controlEligibility, "MIRROR");

  const navigation = registry.applyNavigation({
    tabId: 10,
    documentId: "doc-10",
    agentInstanceId: "agent-10",
    pageEpoch: 2,
    sequence: 3,
    routeKey: "/c/other",
    conversationId: "other",
    sentAt: 1200,
  });
  assert.equal(navigation.accepted, true);
  assert.equal(registry.getTab(10)?.controlEligibility, "NONE");
  assert.equal(registry.getTab(20)?.controlEligibility, "OWNER");
});

test("delayed observation after navigation cannot mutate current session", () => {
  const registry = new SessionRegistry();
  register(registry, 3, "old", 100);
  observe(registry, 3, "old");
  assert.equal(
    registry.applyNavigation({
      tabId: 3,
      documentId: "doc-3",
      agentInstanceId: "agent-3",
      pageEpoch: 2,
      sequence: 3,
      routeKey: "/c/new",
      conversationId: "new",
      sentAt: 1300,
    }).accepted,
    true,
  );

  const delayed = registry.applyObservation({
    tabId: 3,
    documentId: "doc-3",
    agentInstanceId: "agent-3",
    pageEpoch: 1,
    sequence: 4,
    observation: observation("old", "/c/old"),
    sentAt: 1400,
  });
  assert.deepEqual(delayed, { accepted: false, reason: "STALE_EPOCH" });
  assert.equal(registry.getTab(3)?.conversationId, "new");
  assert.equal(registry.getTab(3)?.observation, undefined);
});

test("wrong conversation and stale sequence are rejected", () => {
  const registry = new SessionRegistry();
  register(registry, 4, "conv-x", 100);

  const mismatch = registry.applyObservation({
    tabId: 4,
    documentId: "doc-4",
    agentInstanceId: "agent-4",
    pageEpoch: 1,
    sequence: 2,
    observation: observation("conv-y", "/c/conv-y"),
    sentAt: 200,
  });
  assert.deepEqual(mismatch, { accepted: false, reason: "IDENTITY_MISMATCH" });

  assert.equal(observe(registry, 4, "conv-x", 2).accepted, true);
  const stale = registry.applyInteraction({
    tabId: 4,
    documentId: "doc-4",
    agentInstanceId: "agent-4",
    pageEpoch: 1,
    sequence: 2,
    sentAt: 300,
  });
  assert.deepEqual(stale, { accepted: false, reason: "STALE_SEQUENCE" });
});

test("older document cannot replace a newer content agent", () => {
  const registry = new SessionRegistry();
  register(registry, 7, "first", 100, "doc-old");
  const current = registry.registerAgent({
    tabId: 7,
    documentId: "doc-new",
    agentInstanceId: "agent-new",
    pageEpoch: 1,
    sequence: 1,
    routeKey: "/c/second",
    conversationId: "second",
    sentAt: 200,
  });
  assert.equal(current.accepted, true);

  const stale = registry.registerAgent({
    tabId: 7,
    documentId: "doc-old",
    agentInstanceId: "agent-old-delayed",
    pageEpoch: 1,
    sequence: 99,
    routeKey: "/c/first",
    conversationId: "first",
    sentAt: 9999,
  });
  assert.deepEqual(stale, { accepted: false, reason: "STALE_DOCUMENT" });
  assert.equal(registry.getTab(7)?.documentId, "doc-new");
});

test("service-worker restore invalidates observation-based control eligibility", () => {
  const registry = new SessionRegistry();
  register(registry, 8, "restore-me", 100);
  observe(registry, 8, "restore-me");
  assert.equal(registry.getTab(8)?.controlEligibility, "OWNER");

  const restored = SessionRegistry.fromState(registry.exportState(), { invalidateObservations: true });
  assert.equal(restored.getTab(8)?.observation, undefined);
  assert.equal(restored.getTab(8)?.controlEligibility, "NONE");
});

test("loading invalidation drops live state but lets the same exact document reconnect", () => {
  const registry = new SessionRegistry();
  register(registry, 9, "before-refresh", 100, "doc-before");
  registry.invalidateTab(9);
  assert.equal(registry.getTab(9), undefined);

  const reconnected = registry.registerAgent({
    tabId: 9,
    documentId: "doc-before",
    agentInstanceId: "agent-9",
    pageEpoch: 1,
    sequence: 2,
    routeKey: "/c/before-refresh",
    conversationId: "before-refresh",
    sentAt: 200,
  });
  assert.equal(reconnected.accepted, true);
  assert.equal(registry.getTab(9)?.documentId, "doc-before");

  const fresh = registry.registerAgent({
    tabId: 9,
    documentId: "doc-after",
    agentInstanceId: "agent-after",
    pageEpoch: 1,
    sequence: 1,
    routeKey: "/c/after-refresh",
    conversationId: "after-refresh",
    sentAt: 300,
  });
  assert.equal(fresh.accepted, true);

  const staleOld = registry.registerAgent({
    tabId: 9,
    documentId: "doc-before",
    agentInstanceId: "agent-9",
    pageEpoch: 1,
    sequence: 99,
    routeKey: "/c/before-refresh",
    conversationId: "before-refresh",
    sentAt: 9999,
  });
  assert.deepEqual(staleOld, { accepted: false, reason: "STALE_DOCUMENT" });
});

test("retired document tombstones survive service-worker restore", () => {
  const registry = new SessionRegistry();
  register(registry, 11, "one", 100, "doc-one");
  registry.registerAgent({
    tabId: 11,
    documentId: "doc-two",
    agentInstanceId: "agent-two",
    pageEpoch: 1,
    sequence: 1,
    routeKey: "/c/two",
    conversationId: "two",
    sentAt: 200,
  });

  const restored = SessionRegistry.fromState(registry.exportState(), { invalidateObservations: true });
  const stale = restored.registerAgent({
    tabId: 11,
    documentId: "doc-one",
    agentInstanceId: "agent-old",
    pageEpoch: 1,
    sequence: 99,
    routeKey: "/c/one",
    conversationId: "one",
    sentAt: 9999,
  });
  assert.deepEqual(stale, { accepted: false, reason: "STALE_DOCUMENT" });
});

test("hidden diagnostics survive worker restore without retaining transcript text", () => {
  const registry = new SessionRegistry();
  register(registry, 30, "diag", 100);

  const visible = registry.applyObservation({
    tabId: 30,
    documentId: "doc-30",
    agentInstanceId: "agent-30",
    pageEpoch: 1,
    sequence: 2,
    observation: {
      ...observation("diag", "/c/diag", "GENERATING"),
      visibility: "visible",
      stopControlPresent: true,
      latestAssistant: {
        normalizedText: "SECRET VISIBLE TRANSCRIPT",
        textLength: 25,
        fingerprint: "a".repeat(64),
      },
    },
    sentAt: 1100,
  });
  assert.equal(visible.accepted, true);
  assert.equal(registry.markBackgrounded(30, 2000), true);

  const hidden = registry.applyObservation({
    tabId: 30,
    documentId: "doc-30",
    agentInstanceId: "agent-30",
    pageEpoch: 1,
    sequence: 3,
    observation: {
      ...observation("diag", "/c/diag", "GENERATING"),
      visibility: "hidden",
      stopControlPresent: true,
      observedAt: 2200,
      latestAssistant: {
        normalizedText: 'SECRET HIDDEN TRANSCRIPT\nAI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}',
        textLength: 81,
        fingerprint: "b".repeat(64),
      },
    },
    markerHealth: "DETECTED",
    sentAt: 2201,
  });
  assert.equal(hidden.accepted, true);

  const diagnostic = registry.getTab(30)?.hiddenDiagnostic;
  assert.deepEqual(diagnostic, {
    backgroundedAt: 2000,
    baselineAssistantFingerprint: "a".repeat(64),
    baselineAssistantTextLength: 25,
    hiddenObservationCount: 1,
    lastHiddenObservationAt: 2200,
    hiddenAssistantTextLength: 81,
    assistantChanged: true,
    hiddenGeneration: "GENERATING",
    hiddenStopControlPresent: true,
    hiddenMarkerHealth: "DETECTED",
  });
  assert.equal(JSON.stringify(diagnostic).includes("SECRET"), false);
  assert.equal(JSON.stringify(diagnostic).includes("normalizedText"), false);

  assert.equal(registry.markForegrounded(30, 3000), true);
  assert.equal(registry.getTab(30)?.hiddenDiagnostic?.foregroundedAt, 3000);

  const restored = SessionRegistry.fromState(registry.exportState(), { invalidateObservations: true });
  assert.equal(restored.getTab(30)?.observation, undefined);
  assert.equal(restored.getTab(30)?.hiddenDiagnostic?.hiddenMarkerHealth, "DETECTED");

  const reannounced = restored.registerAgent({
    tabId: 30,
    documentId: "doc-30",
    agentInstanceId: "agent-30",
    pageEpoch: 1,
    sequence: 4,
    routeKey: "/c/diag",
    conversationId: "diag",
    sentAt: 4000,
  });
  assert.equal(reannounced.accepted, true);
  assert.equal(restored.getTab(30)?.hiddenDiagnostic?.hiddenObservationCount, 1);
  assert.equal(JSON.stringify(restored.getTab(30)?.hiddenDiagnostic).includes("SECRET"), false);
});

test("tab background metadata does not erase a hidden observation that won the activation race", () => {
  const registry = new SessionRegistry();
  register(registry, 31, "race", 100);
  const hidden = registry.applyObservation({
    tabId: 31,
    documentId: "doc-31",
    agentInstanceId: "agent-31",
    pageEpoch: 1,
    sequence: 2,
    observation: {
      ...observation("race", "/c/race", "GENERATING"),
      visibility: "hidden",
      stopControlPresent: true,
      observedAt: 2100,
      latestAssistant: {
        normalizedText: "hidden progress",
        textLength: 15,
        fingerprint: "c".repeat(64),
      },
    },
    markerHealth: "MISSING",
    sentAt: 2101,
  });
  assert.equal(hidden.accepted, true);
  assert.equal(registry.getTab(31)?.hiddenDiagnostic?.hiddenObservationCount, 1);

  assert.equal(registry.markBackgrounded(31, 2110), false);
  assert.equal(registry.getTab(31)?.hiddenDiagnostic?.hiddenObservationCount, 1);
  assert.equal(registry.getTab(31)?.hiddenDiagnostic?.lastHiddenObservationAt, 2100);
});

test("visible observation closes the hidden diagnostic window when activation metadata is unavailable", () => {
  const registry = new SessionRegistry();
  register(registry, 32, "visible-fallback", 100);
  registry.markBackgrounded(32, 2000);
  const hidden = registry.applyObservation({
    tabId: 32,
    documentId: "doc-32",
    agentInstanceId: "agent-32",
    pageEpoch: 1,
    sequence: 2,
    observation: {
      ...observation("visible-fallback", "/c/visible-fallback", "GENERATING"),
      visibility: "hidden",
      observedAt: 2200,
    },
    markerHealth: "MISSING",
    sentAt: 2201,
  });
  assert.equal(hidden.accepted, true);
  assert.equal(registry.getTab(32)?.hiddenDiagnostic?.foregroundedAt, undefined);

  const visible = registry.applyObservation({
    tabId: 32,
    documentId: "doc-32",
    agentInstanceId: "agent-32",
    pageEpoch: 1,
    sequence: 3,
    observation: {
      ...observation("visible-fallback", "/c/visible-fallback", "IDLE"),
      visibility: "visible",
      observedAt: 3000,
    },
    sentAt: 3001,
  });
  assert.equal(visible.accepted, true);
  assert.equal(registry.getTab(32)?.hiddenDiagnostic?.foregroundedAt, 3000);
});

test("first hidden snapshot becomes the comparison baseline when no visible assistant snapshot exists", () => {
  const registry = new SessionRegistry();
  register(registry, 33, "no-baseline", 100);

  const first = registry.applyObservation({
    tabId: 33,
    documentId: "doc-33",
    agentInstanceId: "agent-33",
    pageEpoch: 1,
    sequence: 2,
    observation: {
      ...observation("no-baseline", "/c/no-baseline", "GENERATING"),
      visibility: "hidden",
      observedAt: 2000,
      latestAssistant: {
        normalizedText: "first hidden snapshot",
        textLength: 21,
        fingerprint: "d".repeat(64),
      },
    },
    markerHealth: "MISSING",
    sentAt: 2001,
  });
  assert.equal(first.accepted, true);
  assert.equal(registry.getTab(33)?.hiddenDiagnostic?.assistantChanged, false);
  assert.equal(registry.getTab(33)?.hiddenDiagnostic?.baselineAssistantTextLength, 21);

  const second = registry.applyObservation({
    tabId: 33,
    documentId: "doc-33",
    agentInstanceId: "agent-33",
    pageEpoch: 1,
    sequence: 3,
    observation: {
      ...observation("no-baseline", "/c/no-baseline", "GENERATING"),
      visibility: "hidden",
      observedAt: 2100,
      latestAssistant: {
        normalizedText: "second hidden snapshot is longer",
        textLength: 32,
        fingerprint: "e".repeat(64),
      },
    },
    markerHealth: "MISSING",
    sentAt: 2101,
  });
  assert.equal(second.accepted, true);
  assert.equal(registry.getTab(33)?.hiddenDiagnostic?.assistantChanged, true);
  assert.equal(registry.getTab(33)?.hiddenDiagnostic?.hiddenAssistantTextLength, 32);
});

test("same-session agent reannounce cannot erase a fresh accepted observation", () => {
  const registry = new SessionRegistry();
  register(registry, 34, "reannounce", 100);
  const accepted = registry.applyObservation({
    tabId: 34,
    documentId: "doc-34",
    agentInstanceId: "agent-34",
    pageEpoch: 1,
    sequence: 2,
    observation: {
      ...observation("reannounce", "/c/reannounce", "IDLE"),
      visibility: "hidden",
      observedAt: 2000,
      latestAssistant: {
        normalizedText: 'done\nAI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}',
        textLength: 54,
        fingerprint: "f".repeat(64),
      },
    },
    markerHealth: "DETECTED",
    sentAt: 2001,
  });
  assert.equal(accepted.accepted, true);

  const hello = registry.registerAgent({
    tabId: 34,
    documentId: "doc-34",
    agentInstanceId: "agent-34",
    pageEpoch: 1,
    sequence: 3,
    routeKey: "/c/reannounce",
    conversationId: "reannounce",
    sentAt: 2100,
  });
  assert.equal(hello.accepted, true);
  assert.equal(registry.getTab(34)?.observation?.latestAssistant?.fingerprint, "f".repeat(64));
  assert.equal(registry.getTab(34)?.hiddenDiagnostic?.hiddenMarkerHealth, "DETECTED");
});

test("reannounce with a new page epoch does not carry observation or hidden diagnostics across routes", () => {
  const registry = new SessionRegistry();
  register(registry, 35, "old-route", 100);
  registry.applyObservation({
    tabId: 35,
    documentId: "doc-35",
    agentInstanceId: "agent-35",
    pageEpoch: 1,
    sequence: 2,
    observation: {
      ...observation("old-route", "/c/old-route", "GENERATING"),
      visibility: "hidden",
      observedAt: 2000,
    },
    markerHealth: "MISSING",
    sentAt: 2001,
  });

  const hello = registry.registerAgent({
    tabId: 35,
    documentId: "doc-35",
    agentInstanceId: "agent-35",
    pageEpoch: 2,
    sequence: 3,
    routeKey: "/c/new-route",
    conversationId: "new-route",
    sentAt: 2200,
  });
  assert.equal(hello.accepted, true);
  assert.equal(registry.getTab(35)?.observation, undefined);
  assert.equal(registry.getTab(35)?.hiddenDiagnostic, undefined);
});

test("worker restore retains only last visibility metadata while invalidating observation authority", () => {
  const registry = new SessionRegistry();
  register(registry, 36, "visibility-meta", 100);
  const accepted = registry.applyObservation({
    tabId: 36,
    documentId: "doc-36",
    agentInstanceId: "agent-36",
    pageEpoch: 1,
    sequence: 2,
    observation: {
      ...observation("visibility-meta", "/c/visibility-meta", "GENERATING"),
      visibility: "visible",
      observedAt: 2000,
    },
    sentAt: 2001,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(registry.getTab(36)?.lastObservationVisibility, "visible");

  const restored = SessionRegistry.fromState(registry.exportState(), { invalidateObservations: true });
  assert.equal(restored.getTab(36)?.observation, undefined);
  assert.equal(restored.getTab(36)?.controlEligibility, "NONE");
  assert.equal(restored.getTab(36)?.lastObservationVisibility, "visible");
});
