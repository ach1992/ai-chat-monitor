import test from "node:test";
import assert from "node:assert/strict";
import { AutomationCoordinator } from "../dist/automation/coordinator.js";

const CONTINUE = {
  decision: "CONTINUE",
  reasonCode: "NEEDLESS_TURN_BOUNDARY",
  reason: "The assistant can safely continue without human input.",
  source: "PROVIDER",
  confidence: 0.99,
  providerId: "test-provider",
};

class FakeClock {
  #now = 1_000;
  #nextId = 1;
  #timers = new Map();

  now() { return this.#now; }

  setTimeout(callback, delayMs) {
    const id = this.#nextId++;
    this.#timers.set(id, { due: this.#now + delayMs, callback });
    return id;
  }

  clearTimeout(id) { this.#timers.delete(id); }

  advance(ms) {
    this.#now += ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.due <= this.#now)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0]);
      if (due.length === 0) return;
      const [id, timer] = due[0];
      this.#timers.delete(id);
      timer.callback();
    }
  }
}

function makeSession(overrides = {}) {
  const user = overrides.user ?? "Please finish the remaining safe work.";
  const assistant = overrides.assistant ?? "I can continue with the implementation.";
  const fingerprint = overrides.fingerprint ?? "a".repeat(64);
  const conversationId = overrides.conversationId ?? "chat-1";
  return {
    tabId: overrides.tabId ?? 7,
    documentId: overrides.documentId ?? "doc-1",
    agentInstanceId: overrides.agentInstanceId ?? "agent-1",
    pageEpoch: overrides.pageEpoch ?? 1,
    lastSequence: overrides.lastSequence ?? 4,
    routeKey: overrides.routeKey ?? `/c/${conversationId}`,
    conversationId,
    registeredAt: 100,
    lastSeenAt: 200,
    controlEligibility: overrides.controlEligibility ?? "OWNER",
    observation: {
      conversationId,
      routeKey: overrides.routeKey ?? `/c/${conversationId}`,
      generation: overrides.generation ?? "IDLE",
      latestUser: {
        normalizedText: user,
        textLength: user.length,
        domMessageId: overrides.userMessageId ?? "user-1",
      },
      latestAssistant: {
        normalizedText: assistant,
        textLength: assistant.length,
        fingerprint,
        domMessageId: overrides.assistantMessageId ?? "assistant-1",
      },
      composer: {
        present: true,
        hasText: overrides.composerHasText ?? false,
        focused: overrides.composerFocused ?? false,
      },
      blocking: { blocked: overrides.blocked ?? false, reasons: [] },
      confidence: overrides.confidence ?? "HIGH",
      observedAt: 200,
    },
  };
}

function makeHarness({ mode = "AUTO", classifier, sender } = {}) {
  const clock = new FakeClock();
  let currentSession = makeSession();
  const policyState = {
    revision: 11,
    mode,
    emergencyPaused: false,
    continuationText: "Continue.",
    timing: { settleDelayMs: 10, continueDelayMs: 20, cooldownMs: 30 },
  };
  const guards = new Map();
  const decisions = new Map();
  const sendCalls = [];
  const classifyCalls = [];

  const policies = {
    resolve(conversationId) {
      return { ...structuredClone(policyState), conversationId };
    },
  };

  const journal = {
    hasGuard(conversationId, assistantFingerprint) {
      return guards.has(`${conversationId}:${assistantFingerprint}`);
    },
    async reserve(envelope) {
      const key = `${envelope.conversationId}:${envelope.assistantFingerprint}`;
      if (guards.has(key)) return false;
      guards.set(key, envelope.decisionId);
      decisions.set(envelope.decisionId, { key, state: "ATTEMPTED" });
      return true;
    },
    async releaseNotStarted(decisionId) {
      const decision = decisions.get(decisionId);
      if (decision !== undefined) guards.delete(decision.key);
      decisions.delete(decisionId);
    },
    async mark(decisionId, state) {
      const decision = decisions.get(decisionId);
      if (decision === undefined) throw new Error("Unknown decision");
      decision.state = state;
    },
  };

  const coordinator = new AutomationCoordinator({
    policies,
    journal,
    sessions: { getTab: () => currentSession },
    classifier: {
      async classify(input) {
        classifyCalls.push(structuredClone(input));
        return classifier === undefined ? CONTINUE : classifier(input);
      },
    },
    sender: {
      async send(envelope) {
        sendCalls.push(structuredClone(envelope));
        if (sender !== undefined) return sender(envelope);
        return {
          decisionId: envelope.decisionId,
          status: "VERIFIED",
          reason: "Verified by test sender.",
          observedConversationId: envelope.conversationId,
          observedAssistantFingerprint: envelope.assistantFingerprint,
        };
      },
    },
    clock,
    createDecisionId: () => `decision-${sendCalls.length + decisions.size + 1}`,
  });

  return {
    clock,
    coordinator,
    policyState,
    classifyCalls,
    sendCalls,
    getSession: () => currentSession,
    setSession: (session) => { currentSession = session; },
  };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function reachPostClassification(harness) {
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();
}

test("OBSERVE classifies only bounded preceding user plus latest assistant context", async () => {
  const harness = makeHarness({ mode: "OBSERVE" });
  await reachPostClassification(harness);

  assert.deepEqual(harness.classifyCalls, [{
    turns: [
      { role: "user", content: "Please finish the remaining safe work." },
      { role: "assistant", content: "I can continue with the implementation." },
    ],
  }]);
  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "OBSERVING");
});

test("NOTIFY_ONLY never classifies or enters an automatic send state", async () => {
  const harness = makeHarness({ mode: "NOTIFY_ONLY" });
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(60_000);
  await flushAsync();

  assert.equal(harness.classifyCalls.length, 0);
  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "OBSERVING");
});

test("a changed preceding user turn stales a delayed provider result even when assistant fingerprint is unchanged", async () => {
  let resolveProvider;
  const providerResult = new Promise((resolve) => { resolveProvider = resolve; });
  const harness = makeHarness({ classifier: () => providerResult });

  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();
  assert.equal(harness.coordinator.status(7).phase, "EVALUATING");

  harness.setSession(makeSession({
    user: "Stop and wait for my approval.",
    userMessageId: "user-2",
    fingerprint: "a".repeat(64),
  }));
  resolveProvider(CONTINUE);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "HOLD");
  assert.match(harness.coordinator.status(7).reason, /bound evidence changed/i);
});

test("a changed preceding user turn during continue delay invalidates the decision envelope", async () => {
  const harness = makeHarness();
  await reachPostClassification(harness);
  assert.equal(harness.coordinator.status(7).phase, "WAITING_TO_CONTINUE");

  harness.setSession(makeSession({
    user: "Wait for me before doing anything else.",
    userMessageId: "user-2",
    fingerprint: "a".repeat(64),
  }));
  harness.clock.advance(20);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "HOLD");
  assert.match(harness.coordinator.status(7).reason, /pre-send revalidation/i);
});

test("AUTO sends only after settle and continue delays with the exact bound identity", async () => {
  const harness = makeHarness();
  await reachPostClassification(harness);

  assert.equal(harness.coordinator.status(7).phase, "WAITING_TO_CONTINUE");
  assert.equal(harness.sendCalls.length, 0);

  harness.clock.advance(20);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.sendCalls[0].tabId, 7);
  assert.equal(harness.sendCalls[0].documentId, "doc-1");
  assert.equal(harness.sendCalls[0].agentInstanceId, "agent-1");
  assert.equal(harness.sendCalls[0].pageEpoch, 1);
  assert.equal(harness.sendCalls[0].conversationId, "chat-1");
  assert.equal(harness.sendCalls[0].assistantFingerprint, "a".repeat(64));
  assert.equal(harness.sendCalls[0].policyRevision, 11);
  assert.equal(typeof harness.sendCalls[0].evidenceKey, "string");
  assert.equal(harness.coordinator.status(7).phase, "COOLDOWN");
});

test("user typing during the continue delay cancels the guarded send", async () => {
  const harness = makeHarness();
  await reachPostClassification(harness);

  harness.setSession(makeSession({ composerHasText: true }));
  harness.clock.advance(20);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "HOLD");
  assert.match(harness.coordinator.status(7).reason, /pre-send revalidation/i);
});

test("ownership loss during the continue delay cancels the guarded send", async () => {
  const harness = makeHarness();
  await reachPostClassification(harness);

  harness.setSession(makeSession({ controlEligibility: "MIRROR" }));
  harness.clock.advance(20);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "HOLD");
});

test("emergency pause becoming active before send cancels the decision", async () => {
  const harness = makeHarness();
  await reachPostClassification(harness);

  harness.policyState.emergencyPaused = true;
  harness.policyState.revision += 1;
  harness.clock.advance(20);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "HOLD");
});

test("an ambiguous send outcome freezes the response and cannot blind-retry", async () => {
  const harness = makeHarness({
    sender: async (envelope) => ({
      decisionId: envelope.decisionId,
      status: "AMBIGUOUS",
      reason: "Mutation may have occurred but verification timed out.",
    }),
  });
  await reachPostClassification(harness);
  harness.clock.advance(20);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.coordinator.status(7).phase, "AMBIGUOUS_WRITE");

  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(60_000);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.coordinator.status(7).phase, "AMBIGUOUS_WRITE");
});