import test from "node:test";
import assert from "node:assert/strict";

function storageArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(values);
      if (typeof keys === "string") return Object.hasOwn(values, keys) ? { [keys]: structuredClone(values[keys]) } : {};
      return Object.fromEntries(
        keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, structuredClone(values[key])]),
      );
    },
    async set(items) {
      Object.assign(values, structuredClone(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async clear() {
      for (const key of Object.keys(values)) delete values[key];
    },
    async setAccessLevel() {},
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("service-worker restore asks each exact stored document for fresh registration and observation", async () => {
  const reconnectCalls = [];
  let updatedListener;
  const session = {
    tabId: 17,
    documentId: "doc-restored",
    agentInstanceId: "agent-restored",
    pageEpoch: 3,
    lastSequence: 9,
    routeKey: "/c/conv-restored",
    conversationId: "conv-restored",
    registeredAt: 1000,
    lastSeenAt: 2000,
    observation: {
      observedAt: 2000,
      routeKey: "/c/conv-restored",
      conversationId: "conv-restored",
      generation: "IDLE",
      composer: { empty: true, sendAvailable: true },
      blockingUi: false,
      visibleTurns: [],
    },
  };
  const sessionStorage = storageArea({
    "guardian:session-registry:runtime": { version: 1, sessions: [session] },
  });
  const localStorage = storageArea();

  globalThis.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage() {
        throw new Error("not used");
      },
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: {
        addListener(listener) {
          updatedListener = listener;
        },
      },
      async sendMessage(tabId, message, options) {
        reconnectCalls.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        return { type: "content:agent-reconnected", protocolVersion: 2, accepted: true };
      },
      async query() {
        return [];
      },
    },
    storage: { local: localStorage, session: sessionStorage },
  };

  await import(`../dist/background/index.js?restart-recovery=${Date.now()}`);
  await settle();

  assert.equal(reconnectCalls.length >= 1, true);
  assert.deepEqual(reconnectCalls[0], {
    tabId: 17,
    message: { type: "panel:agent-reconnect", protocolVersion: 2 },
    options: { documentId: "doc-restored" },
  });
  assert.equal(typeof updatedListener, "function");

  reconnectCalls.length = 0;
  updatedListener(23, { status: "loading" });
  await settle();
  assert.equal(reconnectCalls.length, 0, "loading invalidates first and must not immediately re-register stale state");

  updatedListener(23, { status: "complete" });
  await settle();
  assert.deepEqual(reconnectCalls, [
    {
      tabId: 23,
      message: { type: "panel:agent-reconnect", protocolVersion: 2 },
      options: undefined,
    },
  ]);
});
