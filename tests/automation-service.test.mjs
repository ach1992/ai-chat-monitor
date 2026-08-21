import test from "node:test";
import assert from "node:assert/strict";
import { AutomationService } from "../dist/background/automation-service.js";

function createStorageArea(readLog, name) {
  return {
    async get(key) {
      readLog.push(`${name}:get:${String(key)}`);
      return {};
    },
    async set() {},
    async remove() {},
  };
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function makeSession() {
  const user = "Please continue safely.";
  const assistant = "I have more work I can perform.";
  return {
    tabId: 7,
    documentId: "doc-1",
    agentInstanceId: "agent-1",
    pageEpoch: 1,
    lastSequence: 3,
    routeKey: "/c/chat-1",
    conversationId: "chat-1",
    registeredAt: 100,
    lastSeenAt: 200,
    controlEligibility: "OWNER",
    observation: {
      conversationId: "chat-1",
      routeKey: "/c/chat-1",
      generation: "IDLE",
      latestUser: { normalizedText: user, textLength: user.length, domMessageId: "user-1" },
      latestAssistant: {
        normalizedText: assistant,
        textLength: assistant.length,
        fingerprint: "a".repeat(64),
        domMessageId: "assistant-1",
      },
      composer: { present: true, hasText: false, focused: false },
      blocking: { blocked: false, reasons: [] },
      confidence: "HIGH",
      observedAt: 200,
    },
  };
}

test("automation restore waits until durable storage has been restricted to trusted contexts", async () => {
  const reads = [];
  globalThis.chrome = {
    storage: {
      local: createStorageArea(reads, "local"),
      session: createStorageArea(reads, "session"),
    },
    tabs: { sendMessage: async () => undefined },
  };

  let releaseStorageRestriction;
  const storageRestriction = new Promise((resolve) => {
    releaseStorageRestriction = resolve;
  });
  const service = new AutomationService(() => undefined, storageRestriction);

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(reads, []);

  releaseStorageRestriction();
  await service.ready();
  assert.equal(reads.some((entry) => entry.startsWith("local:get:guardian:automation-policy:")), true);
  assert.equal(reads.some((entry) => entry.startsWith("local:get:guardian:automation-write-journal:")), true);
});

test("failed durable storage restriction fails closed without reading automation state", async () => {
  const reads = [];
  globalThis.chrome = {
    storage: {
      local: createStorageArea(reads, "local"),
      session: createStorageArea(reads, "session"),
    },
    tabs: { sendMessage: async () => undefined },
  };

  const service = new AutomationService(
    () => undefined,
    Promise.reject(new Error("storage restriction failed")),
  );

  await assert.rejects(service.ready(), /storage restriction failed/);
  assert.deepEqual(reads, []);
});

test("concurrent policy writes keep automation frozen until the final persisted policy is active", async () => {
  const reads = [];
  const gates = [deferred(), deferred()];
  let policyWriteCount = 0;
  const local = createStorageArea(reads, "local");
  local.set = async (items) => {
    if (!Object.hasOwn(items, "guardian:automation-policy:config")) return;
    const gate = gates[policyWriteCount++];
    if (gate === undefined) throw new Error("Unexpected policy write");
    await gate.promise;
  };
  globalThis.chrome = {
    storage: {
      local,
      session: createStorageArea(reads, "session"),
    },
    tabs: { sendMessage: async () => undefined },
  };

  const session = makeSession();
  const service = new AutomationService(() => session, Promise.resolve());
  await service.ready();
  await service.handleSession(session);
  assert.equal((await service.status(7)).runtime.phase, "DISABLED");

  const first = service.updateChat(7, "chat-1", { mode: "NOTIFY_ONLY" });
  while (policyWriteCount < 1) await new Promise((resolve) => setImmediate(resolve));
  const second = service.updateChat(7, "chat-1", { mode: "OFF" });

  gates[0].release();
  await first;
  while (policyWriteCount < 2) await new Promise((resolve) => setImmediate(resolve));

  await service.handleSession(session);
  const duringSecondWrite = await service.status(7);
  assert.match(duringSecondWrite.runtime.reason, /policy persistence is in progress/i);

  gates[1].release();
  await second;
  const finalStatus = await service.status(7);
  assert.equal(finalStatus.policy.mode, "OFF");
  assert.equal(finalStatus.runtime.phase, "DISABLED");
});
