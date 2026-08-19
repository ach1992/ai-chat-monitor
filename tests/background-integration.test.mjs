import test from "node:test";
import assert from "node:assert/strict";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("background persists concurrent tab registrations without cross-tab loss", async () => {
  const values = {};
  const accessLevels = [];
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
    async setAccessLevel(options) {
      accessLevels.push(options.accessLevel);
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

  function dispatch(message, sender) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("response timeout")), 1000);
      const keepAlive = messageListener(message, sender, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      if (keepAlive !== true) {
        clearTimeout(timeout);
        resolve(undefined);
      }
    });
  }

  const dispatchContent = (message, tabId, documentId) =>
    dispatch(message, { tab: { id: tabId }, documentId });
  const dispatchPanel = (message) => dispatch(message, {});

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
    dispatchContent(hello(1), 1, "doc-1"),
    dispatchContent(hello(2), 2, "doc-2"),
  ]);
  assert.equal(first.type, "background:agent-ack");
  assert.equal(second.type, "background:agent-ack");
  assert.equal(accessLevels.includes("TRUSTED_CONTEXTS"), true);

  const persisted = values["guardian:session-registry:runtime"];
  assert.deepEqual(
    persisted.sessions.map((session) => session.tabId).sort((left, right) => left - right),
    [1, 2],
  );

  const status1 = await dispatchPanel(
    { type: "panel:status-request", protocolVersion: 2, tabId: 1 },
  );
  const status2 = await dispatchPanel(
    { type: "panel:status-request", protocolVersion: 2, tabId: 2 },
  );
  assert.equal(status1.connected, true);
  assert.equal(status2.connected, true);
  assert.equal(status1.documentId, "doc-1");
  assert.equal(status2.documentId, "doc-2");

  const initialOverview = await dispatchPanel({
    type: "panel:overview-request",
    protocolVersion: 2,
  });
  assert.equal(initialOverview.type, "background:overview");
  assert.deepEqual(initialOverview.chats.map((chat) => chat.tabId), [1, 2]);
  assert.equal(initialOverview.chats.find((chat) => chat.tabId === 1).policy.mode, "OFF");
  assert.equal(initialOverview.chats.find((chat) => chat.tabId === 2).policy.mode, "OFF");

  const update = await dispatchPanel({
    type: "panel:automation-policy-update",
    protocolVersion: 2,
    tabId: 1,
    conversationId: "conv-1",
    patch: {
      mode: "OBSERVE",
      settleDelayMs: 2500,
      notificationTriggers: ["HOLD", "UNSURE"],
    },
  });
  assert.equal(update.type, "background:automation-policy");
  assert.equal(update.policy.mode, "OBSERVE");
  assert.equal(update.policy.timing.settleDelayMs, 2500);

  const updatedOverview = await dispatchPanel({
    type: "panel:overview-request",
    protocolVersion: 2,
  });
  const chat1 = updatedOverview.chats.find((chat) => chat.tabId === 1);
  const chat2 = updatedOverview.chats.find((chat) => chat.tabId === 2);
  assert.equal(chat1.policy.mode, "OBSERVE");
  assert.equal(chat1.overrides.settleDelayMs, 2500);
  assert.deepEqual(chat1.overrides.notificationTriggers, ["HOLD", "UNSURE"]);
  assert.equal(chat2.policy.mode, "OFF", "updating one conversation must not change another chat");
  assert.equal(chat2.overrides, undefined);

  const untrustedStatus = await dispatchContent(
    { type: "panel:status-request", protocolVersion: 2, tabId: 1 },
    99,
    "content-doc",
  );
  assert.equal(untrustedStatus.type, "background:error");
  assert.equal(untrustedStatus.code, "INVALID_SENDER");
});
