import test from "node:test";
import assert from "node:assert/strict";

function flushTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("Side Panel uses one global panel and only repairs legacy disabled tab overrides", async () => {
  const setOptionsCalls = [];
  const sendMessageCalls = [];
  const urls = new Map([
    [11, "https://github.com/ach1992/ai-chat-monitor"],
    [12, "https://chatgpt.com/c/test-conversation"],
  ]);
  const options = new Map([
    [11, { tabId: 11, enabled: false }],
    [12, { tabId: 12, path: "sidepanel/index.html", enabled: true }],
  ]);
  let activatedListener;
  let updatedListener;
  const previousChrome = globalThis.chrome;

  globalThis.chrome = {
    sidePanel: {
      async setPanelBehavior() {},
      async getOptions({ tabId }) {
        return structuredClone(options.get(tabId) ?? { path: "sidepanel/index.html", enabled: true });
      },
      async setOptions(value) {
        setOptionsCalls.push(structuredClone(value));
        if (value.tabId !== undefined) options.set(value.tabId, { ...options.get(value.tabId), ...value });
      },
    },
    tabs: {
      onActivated: {
        addListener(listener) { activatedListener = listener; },
      },
      onUpdated: {
        addListener(listener) { updatedListener = listener; },
      },
      async get(tabId) { return { id: tabId, url: urls.get(tabId) }; },
      async query() { return [{ id: 11, url: urls.get(11) }, { id: 12, url: urls.get(12) }]; },
      async sendMessage(tabId, message) {
        sendMessageCalls.push({ tabId, message: structuredClone(message) });
        return undefined;
      },
    },
  };

  try {
    await import(`../dist/background/sidepanel-availability.js?test=${Date.now()}`);
    await flushTasks();

    assert.deepEqual(setOptionsCalls[0], { path: "sidepanel/index.html", enabled: true });
    assert.deepEqual(setOptionsCalls[1], { tabId: 11, enabled: true });
    assert.equal(setOptionsCalls.some((call) => call.tabId === 12), false, "Already-enabled tabs must stay on the global/default panel path");
    assert.equal(typeof activatedListener, "function");
    assert.equal(typeof updatedListener, "function");

    const callCount = setOptionsCalls.length;
    activatedListener({ tabId: 12 });
    await flushTasks();
    assert.equal(setOptionsCalls.length, callCount, "Activation must not manufacture a tab-specific panel when the global panel is already enabled");

    updatedListener(11, { status: "complete" }, { id: 11, url: urls.get(11) });
    await flushTasks();
    assert.equal(sendMessageCalls.length, 0, "Non-ChatGPT tabs must not receive content-agent reconnect messages");

    updatedListener(12, { status: "complete" }, { id: 12, url: urls.get(12) });
    await flushTasks();
    assert.equal(sendMessageCalls.length, 1);
    assert.deepEqual(sendMessageCalls[0], {
      tabId: 12,
      message: { type: "panel:agent-reconnect", protocolVersion: 2 },
    });
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
