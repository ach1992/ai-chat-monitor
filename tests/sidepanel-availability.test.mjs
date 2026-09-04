import test from "node:test";
import assert from "node:assert/strict";

function flushTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("Side Panel remains tab-scoped and allowlists only supported ChatGPT hosts", async () => {
  const setOptionsCalls = [];
  const sendMessageCalls = [];
  const urls = new Map([
    [11, "https://github.com/ach1992/ai-chat-monitor"],
    [12, "https://chatgpt.com/c/test-conversation"],
  ]);
  let activatedListener;
  let updatedListener;
  const previousChrome = globalThis.chrome;

  globalThis.chrome = {
    sidePanel: {
      async setPanelBehavior() {},
      async setOptions(options) {
        setOptionsCalls.push(structuredClone(options));
      },
    },
    tabs: {
      onActivated: { addListener(listener) { activatedListener = listener; } },
      onUpdated: { addListener(listener) { updatedListener = listener; } },
      async get(tabId) { return { id: tabId, url: urls.get(tabId) }; },
      async query() {
        return [
          { id: 11, url: urls.get(11) },
          { id: 12, url: urls.get(12) },
        ];
      },
      async sendMessage(tabId, message) {
        sendMessageCalls.push({ tabId, message: structuredClone(message) });
        return undefined;
      },
    },
  };

  try {
    await import(`../dist/background/sidepanel-availability.js?test=${Date.now()}`);
    await flushTasks();

    assert.deepEqual(setOptionsCalls[0], { enabled: false }, "There must be no global enabled panel");
    assert.deepEqual(setOptionsCalls[1], { tabId: 11, enabled: false });
    assert.deepEqual(setOptionsCalls[2], {
      tabId: 12,
      path: "sidepanel/index.html",
      enabled: true,
    });
    assert.equal(typeof activatedListener, "function");
    assert.equal(typeof updatedListener, "function");

    activatedListener({ tabId: 11, windowId: 1 });
    await flushTasks();
    assert.deepEqual(setOptionsCalls.at(-1), { tabId: 11, enabled: false });

    activatedListener({ tabId: 12, windowId: 1 });
    await flushTasks();
    assert.deepEqual(setOptionsCalls.at(-1), {
      tabId: 12,
      path: "sidepanel/index.html",
      enabled: true,
    });

    updatedListener(11, { status: "complete" }, { id: 11, url: urls.get(11) });
    await flushTasks();
    assert.deepEqual(setOptionsCalls.at(-1), { tabId: 11, enabled: false });
    assert.equal(sendMessageCalls.length, 0, "Unsupported tabs must not receive reconnect messages");

    updatedListener(12, { status: "complete" }, { id: 12, url: urls.get(12) });
    await flushTasks();
    assert.deepEqual(setOptionsCalls.at(-1), {
      tabId: 12,
      path: "sidepanel/index.html",
      enabled: true,
    });
    assert.deepEqual(sendMessageCalls.at(-1), {
      tabId: 12,
      message: { type: "panel:agent-reconnect", protocolVersion: 2 },
    });
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
