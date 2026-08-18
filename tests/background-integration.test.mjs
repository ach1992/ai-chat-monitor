import test from "node:test";
import assert from "node:assert/strict";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("background persists concurrent tab registrations without cross-tab loss", async () => {
  const values = {};
  let messageListener;
  const fakeArea = {
    async get(keys) {
      await delay(1);
      if (keys === null || keys === undefined) return { ...values };
      if (typeof keys === "string") return Object.hasOwn(values, keys) ? { [keys]: values[keys] } : {};
      return Object.fromEntries(
        keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]),
      );
    },
    async set(items) {
      await delay(Object.keys(values).length === 0 ? 8 : 2);
      Object.assign(values, structuredClone(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async clear() {
      for (const key of Object.keys(values)) delete values[key];
    },
  };

  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        },
      },
      async sendMessage() {
        throw new Error("not used");
      },
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      async query() {
        return [];
      },
    },
    storage: { local: fakeArea, session: fakeArea },
  };

  await import(`../dist/background/index.js?test=${Date.now()}`);
  assert.equal(typeof messageListener, "function");

  function dispatch(message, tabId, documentId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("response timeout")), 1000);
      const keepAlive = messageListener(message, { tab: { id: tabId }, documentId }, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      if (keepAlive !== true) {
        clearTimeout(timeout);
        resolve(undefined);
      }
    });
  }

  const hello = (id) => ({
    type: "content:hello",
    protocolVersion: 2,
    agentInstanceId: `agent-${id}`,
    pageEpoch: 1,
    sequence: 1,
    routeKey: `/c/conv-${id}`,
    conversationId: `conv-${id}`,
    sentAt: 1000 + id,
  });

  const [first, second] = await Promise.all([
    dispatch(hello(1), 1, "doc-1"),
    dispatch(hello(2), 2, "doc-2"),
  ]);
  assert.equal(first.type, "background:agent-ack");
  assert.equal(second.type, "background:agent-ack");

  const status1 = await dispatch(
    { type: "panel:status-request", protocolVersion: 2, tabId: 1 },
    99,
    "panel-doc",
  );
  const status2 = await dispatch(
    { type: "panel:status-request", protocolVersion: 2, tabId: 2 },
    99,
    "panel-doc",
  );
  assert.equal(status1.connected, true);
  assert.equal(status2.connected, true);
  assert.equal(status1.documentId, "doc-1");
  assert.equal(status2.documentId, "doc-2");
});
