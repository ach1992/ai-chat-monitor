import test from "node:test";
import assert from "node:assert/strict";
import { AutomationCoordinator } from "../dist/automation/coordinator.js";
import {
  CONVERSATION_PROTOCOL_CONTINUE_RESPONSE,
  CONVERSATION_PROTOCOL_RECOVERY_RESPONSE,
  CONVERSATION_PROTOCOL_UNSURE_RESPONSE,
} from "../dist/classification/conversation-protocol.js";

const CONTINUE = {
  decision: "CONTINUE",
  reasonCode: "NEEDLESS_TURN_BOUNDARY",
  reason: "The assistant can safely continue without human input.",
  source: "PROVIDER",
  confidence: 0.99,
  providerId: "test-provider",
};

const guardianStatus = (decision) => `CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"${decision}"}`;

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
    ...(overrides.lastUserInteractionAt === undefined ? {} : { lastUserInteractionAt: overrides.lastUserInteractionAt }),
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
      blocking: { blocked: overrides.blocked ?? false, reasons: overrides.blockingReasons ?? [] },
      confidence: overrides.confidence ?? "HIGH",
      observedAt: 200,
    },
  };
}

function makeHarness({ mode = "AUTO", classifier, deterministic, sender } = {}) {
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
    hasGuard(conversationId, assistantFingerprint, assistantDomMessageId) {
      const exactKey = `${conversationId}:${assistantFingerprint}:${assistantDomMessageId ?? "none"}`;
      const fallbackKey = `${conversationId}:${assistantFingerprint}:none`;
      return guards.has(exactKey) || guards.has(fallbackKey);
    },
    async reserve(envelope) {
      const key = `${envelope.conversationId}:${envelope.assistantFingerprint}:${envelope.assistantDomMessageId ?? "none"}`;
      if (guards.has(key)) return false;
      guards.set(key, envelope.decisionId);
      decisions.set(envelope.decisionId, { key, state: "ATTEMPTED", envelope: structuredClone(envelope) });
      return true;
    },
    hasVerifiedProtocolBootstrapForUserTurn(conversationId, latestUserText, lastUserInteractionAt, version = 1) {
      return [...decisions.values()].some((decision) =>
        decision.state === "VERIFIED" &&
        decision.envelope.conversationId === conversationId &&
        decision.envelope.action === "PROTOCOL_BOOTSTRAP" &&
        decision.envelope.conversationProtocolVersion === version &&
        decision.envelope.continuationText === latestUserText &&
        (lastUserInteractionAt === undefined || decision.envelope.createdAt > lastUserInteractionAt),
      );
    },
    hasVerifiedStatusResponseSince(conversationId, continuationText, since) {
      return [...decisions.values()].some((decision) =>
        decision.state === "VERIFIED" &&
        decision.envelope.conversationId === conversationId &&
        decision.envelope.action === "STATUS_RESPONSE" &&
        decision.envelope.continuationText === continuationText &&
        (since === undefined || decision.envelope.createdAt > since),
      );
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
      ...(deterministic === undefined ? {} : {
        classifyDeterministic(input) {
          classifyCalls.push(structuredClone(input));
          return deterministic(input);
        },
      }),
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

test("human suppression is scoped to the exact assistant DOM response when identical text repeats", async () => {
  const harness = makeHarness({ mode: "OBSERVE" });
  harness.coordinator.handleHumanInteraction(harness.getSession());
  assert.equal(harness.coordinator.status(7).phase, "HOLD");

  harness.setSession(makeSession({
    user: "Ask for a fresh human choice again.",
    userMessageId: "user-2",
    assistantMessageId: "assistant-2",
    fingerprint: "a".repeat(64),
  }));
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();

  assert.equal(harness.classifyCalls.length, 1);
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
  assert.equal(harness.sendCalls[0].assistantDomMessageId, "assistant-1");
  assert.equal(harness.sendCalls[0].policyRevision, 11);
  assert.equal(typeof harness.sendCalls[0].evidenceKey, "string");
  assert.equal(harness.coordinator.status(7).phase, "COOLDOWN");
});

test("an ambiguous AUTO stop installs the protocol and uses its activation status", async () => {
  const harness = makeHarness({ deterministic: () => undefined });
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.sendCalls[0].action, "PROTOCOL_BOOTSTRAP");
  assert.equal(harness.sendCalls[0].conversationProtocolVersion, 1);
  assert.equal(harness.coordinator.status(7).phase, "WAITING_FOR_PROTOCOL_STATUS");

  harness.setSession(makeSession({
    user: harness.sendCalls[0].continuationText,
    userMessageId: "protocol-user-1",
    assistant: guardianStatus("CONTINUE"),
    assistantMessageId: "protocol-assistant-1",
    fingerprint: "b".repeat(64),
  }));
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();
  assert.equal(harness.coordinator.status(7).phase, "WAITING_TO_CONTINUE");

  harness.clock.advance(20);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 2);
  assert.equal(harness.sendCalls[1].action, "STATUS_RESPONSE");
  assert.equal(harness.sendCalls[1].continuationText, CONVERSATION_PROTOCOL_CONTINUE_RESPONSE);
  assert.equal(harness.sendCalls[1].assistantFingerprint, "b".repeat(64));
});

test("a valid terminal status is classified directly without a self-check", async () => {
  const harness = makeHarness({ deterministic: () => undefined });
  harness.setSession(makeSession({
    assistant: `More safe work remains.\n${guardianStatus("CONTINUE")}`,
  }));

  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "WAITING_TO_CONTINUE");
  harness.clock.advance(20);
  await flushAsync();
  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.sendCalls[0].action, "STATUS_RESPONSE");
  assert.equal(harness.sendCalls[0].continuationText, CONVERSATION_PROTOCOL_CONTINUE_RESPONSE);
});

test("each terminal protocol status sends only its configured response", async () => {
  const scenarios = [
    ["CONTINUE", CONVERSATION_PROTOCOL_CONTINUE_RESPONSE, "COOLDOWN"],
    ["HOLD_APPROVAL", undefined, "HOLD"],
    ["HOLD_DECISION", undefined, "HOLD"],
    ["HOLD_HUMAN_OPERATION", undefined, "HOLD"],
    ["COMPLETE", undefined, "HOLD"],
    ["PLATFORM_ERROR", CONVERSATION_PROTOCOL_RECOVERY_RESPONSE, "COOLDOWN"],
    ["RATE_LIMIT", CONVERSATION_PROTOCOL_RECOVERY_RESPONSE, "COOLDOWN"],
    ["UNSURE", CONVERSATION_PROTOCOL_UNSURE_RESPONSE, "COOLDOWN"],
  ];

  for (const [decision, expectedText, expectedPhase] of scenarios) {
    const harness = makeHarness({ deterministic: () => undefined });
    harness.setSession(makeSession({ assistant: guardianStatus(decision) }));
    await reachPostClassification(harness);
    harness.clock.advance(20);
    await flushAsync();

    assert.equal(harness.sendCalls.length, expectedText === undefined ? 0 : 1, decision);
    if (expectedText !== undefined) {
      assert.equal(harness.sendCalls[0].action, "STATUS_RESPONSE", decision);
      assert.equal(harness.sendCalls[0].continuationText, expectedText, decision);
    }
    assert.equal(harness.coordinator.status(7).phase, expectedPhase, decision);
  }
});

test("a recovery or unsure response is sent only once until human interaction changes", async () => {
  for (const decision of ["PLATFORM_ERROR", "RATE_LIMIT", "UNSURE"]) {
    const harness = makeHarness({ deterministic: () => undefined });
    harness.setSession(makeSession({ assistant: guardianStatus(decision) }));
    await reachPostClassification(harness);
    harness.clock.advance(20);
    await flushAsync();
    assert.equal(harness.sendCalls.length, 1, decision);

    harness.setSession(makeSession({
      user: harness.sendCalls[0].continuationText,
      userMessageId: `status-response-user-${decision}`,
      assistant: guardianStatus(decision),
      assistantMessageId: `status-response-assistant-${decision}`,
      fingerprint: "b".repeat(64),
    }));
    harness.clock.advance(30);
    await flushAsync();
    harness.clock.advance(10);
    await flushAsync();
    harness.clock.advance(20);
    await flushAsync();

    assert.equal(harness.sendCalls.length, 1, decision);
    assert.equal(harness.coordinator.status(7).phase, decision === "UNSURE" ? "UNSURE" : "HOLD", decision);
  }
});

test("a valid terminal status does not call an optional provider when local rules are unavailable", async () => {
  const harness = makeHarness();
  harness.setSession(makeSession({ assistant: guardianStatus("COMPLETE") }));
  await reachPostClassification(harness);

  assert.equal(harness.classifyCalls.length, 0);
  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "HOLD");
  assert.equal(harness.coordinator.status(7).lastDecision.reasonCode, "PROJECT_COMPLETE");
});

test("a missing status falls back to one self-check and a malformed reply cannot recurse", async () => {
  const harness = makeHarness({ deterministic: () => undefined });
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();
  assert.equal(harness.sendCalls[0].action, "PROTOCOL_BOOTSTRAP");

  harness.setSession(makeSession({
    user: harness.sendCalls[0].continuationText,
    userMessageId: "protocol-user-1",
    assistant: "I could not produce the requested status.",
    assistantMessageId: "protocol-assistant-1",
    fingerprint: "b".repeat(64),
  }));
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(60_000);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.coordinator.status(7).phase, "UNSURE");
});

test("a deterministic HOLD overrides a contradictory CONTINUE marker", async () => {
  const hold = {
    decision: "HOLD",
    reasonCode: "HUMAN_APPROVAL_REQUIRED",
    reason: "Human approval is explicitly required.",
    source: "RULE",
  };
  const harness = makeHarness({ deterministic: () => hold });
  harness.setSession(makeSession({ assistant: guardianStatus("CONTINUE") }));
  await reachPostClassification(harness);

  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "HOLD");
  assert.equal(harness.coordinator.status(7).lastDecision.source, "RULE");
});

test("an obvious deterministic CONTINUE avoids an unnecessary self-check when status is absent", async () => {
  const harness = makeHarness({ deterministic: () => CONTINUE });
  await reachPostClassification(harness);

  assert.equal(harness.sendCalls.length, 0);
  assert.equal(harness.coordinator.status(7).phase, "WAITING_TO_CONTINUE");
});

test("a terminal status on a continued response avoids another protocol bootstrap", async () => {
  const harness = makeHarness({ deterministic: () => undefined });
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();

  harness.setSession(makeSession({
    user: harness.sendCalls[0].continuationText,
    userMessageId: "protocol-user-1",
    assistant: guardianStatus("CONTINUE"),
    assistantMessageId: "protocol-assistant-1",
    fingerprint: "b".repeat(64),
  }));
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();
  harness.clock.advance(20);
  await flushAsync();
  assert.equal(harness.sendCalls.length, 2);

  harness.setSession(makeSession({
    user: harness.sendCalls[1].continuationText,
    userMessageId: "guardian-resume-user-1",
    assistant: `Implementation is still running.\n${guardianStatus("CONTINUE")}`,
    assistantMessageId: "assistant-after-resume-1",
    fingerprint: "c".repeat(64),
  }));
  harness.clock.advance(30);
  await flushAsync();
  harness.clock.advance(10);
  await flushAsync();
  harness.clock.advance(20);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 3);
  assert.equal(harness.sendCalls[2].action, "STATUS_RESPONSE");
  assert.equal(harness.coordinator.status(7).phase, "COOLDOWN");
});

test("a later ordinary response that forgets the marker receives one fallback self-check", async () => {
  const harness = makeHarness({ deterministic: () => undefined });
  harness.setSession(makeSession({ assistant: guardianStatus("CONTINUE") }));
  await reachPostClassification(harness);
  harness.clock.advance(20);
  await flushAsync();
  assert.equal(harness.sendCalls[0].action, "STATUS_RESPONSE");

  harness.setSession(makeSession({
    user: harness.sendCalls[0].continuationText,
    userMessageId: "guardian-resume-user-1",
    assistant: "I forgot the status marker but safe work may remain.",
    assistantMessageId: "assistant-after-resume-1",
    fingerprint: "b".repeat(64),
  }));
  harness.clock.advance(30);
  await flushAsync();
  harness.clock.advance(10);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 2);
  assert.equal(harness.sendCalls[1].action, "PROTOCOL_BOOTSTRAP");
  assert.equal(harness.coordinator.status(7).phase, "WAITING_FOR_PROTOCOL_STATUS");
});

test("a human interaction cancels old authority but its new marked response remains eligible", async () => {
  const harness = makeHarness({ deterministic: () => undefined });
  harness.coordinator.handleHumanInteraction(harness.getSession());

  harness.setSession(makeSession({
    user: "Please stop automation and answer this directly.",
    userMessageId: "human-user-2",
    assistant: `I handled the new request and safe work remains.\n${guardianStatus("CONTINUE")}`,
    assistantMessageId: "assistant-after-human-2",
    fingerprint: "d".repeat(64),
    lastUserInteractionAt: 1_100,
  }));
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();
  harness.clock.advance(20);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.sendCalls[0].action, "STATUS_RESPONSE");
  assert.equal(harness.coordinator.status(7).phase, "COOLDOWN");
});

test("a recoverable delivery error may send one protocol bootstrap but a hard blocker cannot", async () => {
  const recoverable = makeHarness({ deterministic: () => undefined });
  recoverable.setSession(makeSession({ blocked: true, blockingReasons: ["ERROR"] }));
  recoverable.coordinator.handleSession(recoverable.getSession());
  recoverable.clock.advance(10);
  await flushAsync();
  assert.equal(recoverable.sendCalls.length, 1);
  assert.equal(recoverable.sendCalls[0].action, "PROTOCOL_BOOTSTRAP");

  const hardBlocked = makeHarness({ deterministic: () => undefined });
  hardBlocked.setSession(makeSession({ blocked: true, blockingReasons: ["CONVERSATION_FULL"] }));
  hardBlocked.coordinator.handleSession(hardBlocked.getSession());
  hardBlocked.clock.advance(10);
  await flushAsync();
  assert.equal(hardBlocked.sendCalls.length, 0);
  assert.equal(hardBlocked.coordinator.status(7).phase, "HOLD");
});

test("an ambiguous protocol bootstrap write freezes without retry", async () => {
  const harness = makeHarness({
    deterministic: () => undefined,
    sender: async (envelope) => ({
      decisionId: envelope.decisionId,
      status: "AMBIGUOUS",
      reason: "The protocol message may have been sent.",
    }),
  });
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();

  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.sendCalls[0].action, "PROTOCOL_BOOTSTRAP");
  assert.equal(harness.coordinator.status(7).phase, "AMBIGUOUS_WRITE");

  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(60_000);
  await flushAsync();
  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.coordinator.status(7).phase, "AMBIGUOUS_WRITE");
});

test("a protocol HOLD status stays terminal", async () => {
  const harness = makeHarness({ deterministic: () => undefined });
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();

  harness.setSession(makeSession({
    user: harness.sendCalls[0].continuationText,
    userMessageId: "protocol-user-1",
    assistant: guardianStatus("HOLD_APPROVAL"),
    assistantMessageId: "protocol-assistant-1",
    fingerprint: "b".repeat(64),
  }));
  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(10);
  await flushAsync();
  assert.equal(harness.coordinator.status(7).phase, "HOLD");

  harness.coordinator.handleSession(harness.getSession());
  harness.clock.advance(60_000);
  await flushAsync();
  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.coordinator.status(7).phase, "HOLD");
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
