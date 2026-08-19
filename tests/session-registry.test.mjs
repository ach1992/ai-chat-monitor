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
