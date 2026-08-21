import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const AMBIGUOUS_REASON = "The intended user turn and generation start could not both be verified.";

async function loadReconciliation(observation) {
  class FakeAdapter {
    async guardedSend(expectation) {
      return {
        decisionId: expectation.decisionId,
        status: "AMBIGUOUS",
        reason: AMBIGUOUS_REASON,
      };
    }

    async observe() {
      return structuredClone(observation);
    }
  }

  const context = {
    GuardianContent: {
      BrowserChatGPTAdapter: FakeAdapter,
      normalizeAssistantText(value) {
        return value.replace(/\s+/g, " ").trim();
      },
    },
  };
  const source = await readFile(new URL("../dist/content/send-verification.js", import.meta.url), "utf8");
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.GuardianContent.BrowserChatGPTAdapter;
}

function expectation() {
  return {
    decisionId: "decision-1",
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint: "a".repeat(64),
    assistantDomMessageId: "assistant-before",
    continuationText: "Continue safely.",
  };
}

function completedObservation(overrides = {}) {
  return {
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    generation: "IDLE",
    confidence: "HIGH",
    composer: { present: true, hasText: false, focused: false },
    blocking: { blocked: false, reasons: [] },
    latestUser: {
      normalizedText: "Continue safely.",
      textLength: 16,
      domMessageId: "user-after",
    },
    latestAssistant: {
      normalizedText: "Completed quickly.",
      textLength: 18,
      fingerprint: "b".repeat(64),
      domMessageId: "assistant-after",
    },
    observedAt: 123,
    ...overrides,
  };
}

test("fast completed response verifies when generation sampling was missed", async () => {
  const Adapter = await loadReconciliation(completedObservation());
  const adapter = new Adapter();
  const result = await adapter.guardedSend(expectation(), () => true);

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.observedConversationId, "chat-1");
  assert.equal(result.observedAssistantFingerprint, "a".repeat(64));
  assert.match(result.reason, /fresh assistant response/);
});

test("ambiguous send stays fail-closed without a fresh assistant response", async () => {
  const Adapter = await loadReconciliation(completedObservation({
    latestAssistant: {
      normalizedText: "Old response.",
      textLength: 13,
      fingerprint: "a".repeat(64),
      domMessageId: "assistant-before",
    },
  }));
  const adapter = new Adapter();
  const result = await adapter.guardedSend(expectation(), () => true);

  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.reason, AMBIGUOUS_REASON);
});

test("human state change cannot be reconciled into a verified send", async () => {
  const Adapter = await loadReconciliation(completedObservation());
  const adapter = new Adapter();
  let current = true;
  const humanStateIsCurrent = () => {
    const result = current;
    current = false;
    return result;
  };
  const result = await adapter.guardedSend(expectation(), humanStateIsCurrent);

  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.reason, AMBIGUOUS_REASON);
});
