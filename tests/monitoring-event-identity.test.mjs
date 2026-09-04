import test from "node:test";
import assert from "node:assert/strict";
import { monitoringEventIdentity, responseEpisodeAssistantState } from "../dist/monitoring/service.js";

function session(latestAssistant) {
  return {
    tabId: 1,
    documentId: "doc-1",
    agentInstanceId: "agent-1",
    pageEpoch: 2,
    lastSequence: 3,
    routeKey: "/c/chat-1234",
    conversationId: "chat-1234",
    registeredAt: 1,
    lastSeenAt: 2,
    controlEligibility: "OWNER",
    observation: {
      conversationId: "chat-1234",
      routeKey: "/c/chat-1234",
      generation: "IDLE",
      latestAssistant,
      composer: { present: true, hasText: false, focused: false },
      blocking: { blocked: false, reasons: [] },
      actions: { retryAvailable: false, continueGeneratingAvailable: false },
      confidence: "HIGH",
      observedAt: 2,
    },
  };
}

const runtime = {
  tabId: 1,
  conversationId: "chat-1234",
  enabled: true,
  generation: "IDLE",
  pageState: "IDLE",
  blockingReasons: [],
  semanticSource: "UNKNOWN",
  markerHealth: "MISSING",
  assistantFingerprint: "a".repeat(64),
  updatedAt: 2,
};

test("stable DOM message identity outranks an identical assistant fingerprint", () => {
  const first = monitoringEventIdentity(session({
    normalizedText: "yes",
    textLength: 3,
    fingerprint: "a".repeat(64),
    domMessageId: "assistant-turn-1",
  }), runtime);
  const second = monitoringEventIdentity(session({
    normalizedText: "yes",
    textLength: 3,
    fingerprint: "a".repeat(64),
    domMessageId: "assistant-turn-2",
  }), runtime);

  assert.equal(first, "assistant-turn-1");
  assert.equal(second, "assistant-turn-2");
  assert.notEqual(first, second);
});

test("fingerprint remains the bounded fallback when no DOM message identity exists", () => {
  assert.equal(monitoringEventIdentity(session({
    normalizedText: "yes",
    textLength: 3,
    fingerprint: "a".repeat(64),
  }), runtime), "a".repeat(64));
});


test("response episode rejects the previous assistant and pre-send observations", () => {
  const current = session({
    normalizedText: "previous",
    textLength: 8,
    fingerprint: "b".repeat(64),
    domMessageId: "assistant-old",
  });
  current.observation.observedAt = 20;
  current.pendingResponse = {
    startedAt: 10,
    baselineAssistantFingerprint: "b".repeat(64),
    baselineAssistantDomMessageId: "assistant-old",
  };
  assert.equal(responseEpisodeAssistantState(current), "WAITING_FOR_FRESH_ASSISTANT");

  current.observation.observedAt = 9;
  current.observation.latestAssistant = {
    normalizedText: "new but sampled too early",
    textLength: 25,
    fingerprint: "c".repeat(64),
    domMessageId: "assistant-new",
  };
  assert.equal(responseEpisodeAssistantState(current), "WAITING_FOR_FRESH_ASSISTANT");
});

test("response episode accepts only a demonstrably fresh assistant identity", () => {
  const current = session({
    normalizedText: "fresh partial",
    textLength: 13,
    fingerprint: "c".repeat(64),
    domMessageId: "assistant-new",
  });
  current.observation.observedAt = 20;
  current.pendingResponse = {
    startedAt: 10,
    baselineAssistantFingerprint: "b".repeat(64),
    baselineAssistantDomMessageId: "assistant-old",
  };
  assert.equal(responseEpisodeAssistantState(current), "FRESH_ASSISTANT");
});
