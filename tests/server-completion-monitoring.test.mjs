import test from "node:test";
import assert from "node:assert/strict";

import { MonitoringService } from "../dist/monitoring/service.js";

function memoryArea() {
  const values = {};
  return {
    async get(keys) {
      if (keys === undefined || keys === null) return structuredClone(values);
      if (typeof keys === "string") return Object.hasOwn(values, keys) ? { [keys]: structuredClone(values[keys]) } : {};
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, structuredClone(values[key])]));
    },
    async set(items) { Object.assign(values, structuredClone(items)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    async clear() { for (const key of Object.keys(values)) delete values[key]; },
    async setAccessLevel() {},
  };
}

function installChrome(notifications) {
  globalThis.chrome = {
    storage: { local: memoryArea(), session: memoryArea() },
    runtime: {
      lastError: undefined,
      getURL(path) { return `chrome-extension://test/${path}`; },
    },
    notifications: {
      async create(id, options) {
        notifications.push({ id, ...structuredClone(options) });
        return id;
      },
    },
    permissions: {
      async remove() { return true; },
    },
  };
}

function observation({ conversationId, userId, assistantId, generation = "GENERATING", assistantText = "partial" }) {
  return {
    conversationId,
    routeKey: `/c/${conversationId}`,
    generation,
    latestUser: {
      normalizedText: "user prompt",
      textLength: 11,
      fingerprint: "u".repeat(64),
      domMessageId: userId,
    },
    latestAssistant: {
      normalizedText: assistantText,
      textLength: assistantText.length,
      fingerprint: assistantText === "partial" ? "p".repeat(64) : "f".repeat(64),
      domMessageId: assistantId,
    },
    composer: { present: true, hasText: false, focused: false },
    blocking: { blocked: false, reasons: [] },
    actions: { retryAvailable: false, continueGeneratingAvailable: false },
    confidence: "HIGH",
    observedAt: Date.now(),
  };
}

function session({ tabId, conversationId, userId, assistantId, generation = "GENERATING", assistantText = "partial" }) {
  return {
    tabId,
    documentId: `doc-${tabId}`,
    agentInstanceId: `agent-${tabId}`,
    pageEpoch: 1,
    lastSequence: 10,
    routeKey: `/c/${conversationId}`,
    conversationId,
    registeredAt: 1,
    lastSeenAt: 2,
    observation: observation({ conversationId, userId, assistantId, generation, assistantText }),
    controlEligibility: "OWNER",
  };
}

const browserEvents = ["TASK_COMPLETE", "RESPONSE_COMPLETE", "SEMANTIC_UNKNOWN"];

test("exact server completion emits semantic/generic events while hidden partial DOM cannot duplicate on foreground catch-up", async () => {
  const notifications = [];
  installChrome(notifications);

  const sessions = new Map();
  const first = session({
    tabId: 1,
    conversationId: "conv-1",
    userId: "user-1",
    assistantId: "assistant-1",
  });
  sessions.set(1, first);

  const service = new MonitoringService((tabId) => sessions.get(tabId), Promise.resolve());
  await service.ready();
  await service.updateChat(1, "conv-1", { enabled: true, browserEvents, soundEvents: [] });
  assert.equal(notifications.length, 0);

  assert.equal(await service.handleServerCompletion(first, {
    assistantMessageId: "assistant-1",
    parentUserMessageId: "user-1",
    markerHealth: "DETECTED",
    semanticDecision: "COMPLETE",
  }), true);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "Task complete");
  assert.equal(service.history(10).at(-1)?.type, "TASK_COMPLETE");

  first.observation = observation({
    conversationId: "conv-1",
    userId: "user-1",
    assistantId: "assistant-1",
    generation: "IDLE",
    assistantText: 'full answer\nAI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}',
  });
  await service.handleSession(first);
  assert.equal(notifications.length, 1, "foreground DOM catch-up for the same assistant must not duplicate the semantic event");
  assert.equal(service.history(10).length, 1);

  const second = session({
    tabId: 2,
    conversationId: "conv-2",
    userId: "user-2",
    assistantId: "assistant-2",
  });
  sessions.set(2, second);
  await service.updateChat(2, "conv-2", { enabled: true, browserEvents, soundEvents: [] });

  assert.equal(await service.handleServerCompletion(second, {
    assistantMessageId: "assistant-2",
    parentUserMessageId: "user-2",
    markerHealth: "MISSING",
  }), true);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].title, "ChatGPT response finished");
  assert.equal(service.history(10).at(-1)?.type, "RESPONSE_COMPLETE");

  second.observation = observation({
    conversationId: "conv-2",
    userId: "user-2",
    assistantId: "assistant-2",
    generation: "IDLE",
    assistantText: "ordinary completed response",
  });
  await service.handleSession(second);
  assert.equal(notifications.length, 2, "foreground DOM catch-up for no-status completion must not emit semantic uncertainty");
});

test("server completion evidence fails closed on response-identity mismatch", async () => {
  const notifications = [];
  installChrome(notifications);
  const current = session({
    tabId: 3,
    conversationId: "conv-3",
    userId: "user-3",
    assistantId: "assistant-3",
  });
  const service = new MonitoringService(() => current, Promise.resolve());
  await service.ready();
  await service.updateChat(3, "conv-3", { enabled: true, browserEvents, soundEvents: [] });

  assert.equal(await service.handleServerCompletion(current, {
    assistantMessageId: "different-assistant",
    parentUserMessageId: "user-3",
    markerHealth: "DETECTED",
    semanticDecision: "COMPLETE",
  }), false);
  assert.equal(await service.handleServerCompletion(current, {
    assistantMessageId: "assistant-3",
    parentUserMessageId: "different-user",
    markerHealth: "MISSING",
  }), false);
  assert.equal(notifications.length, 0);
  assert.equal(service.history(10).length, 0);
});
