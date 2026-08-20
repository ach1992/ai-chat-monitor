import test from "node:test";
import assert from "node:assert/strict";

import { AuditHistoryRepository } from "../dist/reliability/audit.js";
import { ReliabilityService } from "../dist/reliability/service.js";

function memoryPersistence(initial) {
  let state = initial === undefined ? undefined : structuredClone(initial);
  return {
    async load() { return state === undefined ? undefined : structuredClone(state); },
    async save(next) { state = structuredClone(next); },
  };
}

function resolvedPolicy(conversationId, notificationTriggers, mode = "NOTIFY_ONLY") {
  return {
    revision: 1,
    conversationId,
    mode,
    timing: { settleDelayMs: 1200, continueDelayMs: 800, cooldownMs: 3000 },
    continuationText: "Continue.",
    notificationTriggers,
    hardFuseMaxAutoContinues: 50,
    emergencyPaused: false,
  };
}

function session(tabId, conversationId, fingerprint, domMessageId) {
  return {
    tabId,
    documentId: `doc-${tabId}`,
    agentInstanceId: `agent-${tabId}`,
    pageEpoch: 1,
    lastSequence: 2,
    routeKey: `/c/${conversationId}`,
    conversationId,
    registeredAt: 100,
    lastSeenAt: 200,
    controlEligibility: "OWNER",
    observation: {
      conversationId,
      routeKey: `/c/${conversationId}`,
      generation: "IDLE",
      composer: { present: true, hasText: false, focused: false },
      blocking: { blocked: false, reasons: [] },
      confidence: "HIGH",
      observedAt: 200,
      latestAssistant: {
        normalizedText: "Finished response",
        textLength: 17,
        fingerprint,
        ...(domMessageId === undefined ? {} : { domMessageId }),
      },
    },
  };
}

function createService({ policies, notify }) {
  const audit = new AuditHistoryRepository(memoryPersistence());
  const service = new ReliabilityService({
    audit,
    runtimePersistence: memoryPersistence(),
    resolvePolicy: (conversationId) => policies.get(conversationId),
    notify,
    now: () => 5000,
  });
  return { audit, service };
}

test("NOTIFY_ONLY response-finished notification is deduplicated and never depends on automation send state", async () => {
  const notifications = [];
  const policies = new Map([
    ["conv-a", resolvedPolicy("conv-a", ["RESPONSE_FINISHED"], "NOTIFY_ONLY")],
  ]);
  const { service } = createService({
    policies,
    notify: async (notification) => { notifications.push(notification); },
  });
  await service.restore();

  const observed = session(1, "conv-a", "a".repeat(64));
  service.captureSession(observed);
  service.captureSession(observed);
  await service.flush();

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "ChatGPT response finished");
  assert.equal(notifications[0].event, "RESPONSE_COMPLETE");
  assert.equal(notifications[0].browserEnabled, true);
  assert.deepEqual(service.history().map((event) => event.kind), ["RESPONSE_COMPLETE"]);
});

test("distinct assistant DOM response ids do not collapse identical-text response fingerprints", async () => {
  const notifications = [];
  const policies = new Map([
    ["conv-a", resolvedPolicy("conv-a", ["RESPONSE_FINISHED"], "NOTIFY_ONLY")],
  ]);
  const { service } = createService({
    policies,
    notify: async (notification) => { notifications.push(notification); },
  });
  await service.restore();

  const fingerprint = "f".repeat(64);
  service.captureSession(session(1, "conv-a", fingerprint, "assistant-1"));
  service.captureSession(session(1, "conv-a", fingerprint, "assistant-1"));
  service.captureSession(session(1, "conv-a", fingerprint, "assistant-2"));
  await service.flush();

  assert.equal(notifications.length, 2);
  assert.equal(service.history().filter((event) => event.kind === "RESPONSE_COMPLETE").length, 2);
  assert.notEqual(notifications[0].id, notifications[1].id);
});

test("notification delivery failure is observational and records a generic audit error", async () => {
  const policies = new Map([
    ["conv-a", resolvedPolicy("conv-a", ["RESPONSE_FINISHED"], "NOTIFY_ONLY")],
  ]);
  const { service } = createService({
    policies,
    notify: async () => { throw new Error("secret transport detail"); },
  });
  await service.restore();

  service.captureSession(session(1, "conv-a", "b".repeat(64)));
  await service.flush();

  const history = service.history();
  assert.deepEqual(history.map((event) => event.kind), ["RESPONSE_COMPLETE", "NOTIFICATION_ERROR"]);
  assert.doesNotMatch(history.at(-1).reason ?? "", /secret transport detail/);
});

test("per-chat browser policy remains isolated while generic routing exposes events to optional channels", async () => {
  const notifications = [];
  const policies = new Map([
    ["conv-a", resolvedPolicy("conv-a", ["RESPONSE_FINISHED", "STAGNATION"], "AUTO")],
    ["conv-b", resolvedPolicy("conv-b", [], "OBSERVE")],
  ]);
  const { service } = createService({
    policies,
    notify: async (notification) => { notifications.push(notification); },
  });
  await service.restore();

  service.captureSession(session(1, "conv-a", "c".repeat(64)));
  service.captureSession(session(2, "conv-b", "d".repeat(64)));
  service.captureRuntime({
    tabId: 1,
    conversationId: "conv-a",
    mode: "AUTO",
    phase: "HOLD",
    policyRevision: 1,
    assistantFingerprint: "e".repeat(64),
    decisionId: "decision-stagnation",
    reason: "STAGNATION: repeated no-progress outcomes require human review.",
    updatedAt: 5000,
  });
  await service.flush();

  assert.equal(notifications.length, 3);
  assert.deepEqual(
    notifications.map((item) => [item.event, item.browserEnabled]),
    [
      ["RESPONSE_COMPLETE", true],
      ["RESPONSE_COMPLETE", false],
      ["STAGNATION", true],
    ],
  );
  assert.equal(notifications[2].title, "Chat needs attention: stagnation");
  assert.equal(service.history().some((event) => event.kind === "STAGNATION"), true);
  assert.equal(service.history().filter((event) => event.conversationId === "conv-b").length, 1);
});
