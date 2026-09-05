import test from "node:test";
import assert from "node:assert/strict";

function flushTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("Side Panel defaults closed and activation allowlists only supported ChatGPT hosts", async () => {
  const setOptionsCalls = [];
  const urls = new Map([
    [11, "https://github.com/ach1992/ai-chat-monitor"],
    [12, "https://chatgpt.com/c/test-conversation"],
  ]);
  let activatedListener;
  let updatedListener;
  const previousChrome = globalThis.chrome;

  globalThis.chrome = {
    sidePanel: {
      async setOptions(options) {
        setOptionsCalls.push(structuredClone(options));
      },
    },
    tabs: {
      onActivated: {
        addListener(listener) {
          activatedListener = listener;
        },
      },
      onUpdated: {
        addListener(listener) {
          updatedListener = listener;
        },
      },
      async get(tabId) {
        return { id: tabId, url: urls.get(tabId) };
      },
      async query() {
        return [];
      },
      async sendMessage() {
        return undefined;
      },
    },
  };

  try {
    await import(`../dist/background/sidepanel-availability.js?test=${Date.now()}`);
    await flushTasks();

    assert.deepEqual(setOptionsCalls[0], { enabled: false });
    assert.equal(typeof activatedListener, "function");
    assert.equal(typeof updatedListener, "function");

    activatedListener({ tabId: 11 });
    await flushTasks();
    assert.deepEqual(setOptionsCalls.at(-1), { tabId: 11, enabled: false });

    activatedListener({ tabId: 12 });
    await flushTasks();
    assert.deepEqual(setOptionsCalls.at(-1), {
      tabId: 12,
      path: "sidepanel/index.html",
      enabled: true,
    });
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
