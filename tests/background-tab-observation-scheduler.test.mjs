import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function observation() {
  return {
    conversationId: "chat-bg",
    routeKey: "/c/chat-bg",
    pageTitle: "Background chat",
    generation: "IDLE",
    latestAssistant: {
      normalizedText: 'Done.\nAI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}',
      textLength: 56,
      fingerprint: "a".repeat(64),
      domMessageId: "assistant-bg",
    },
    composer: { present: true, hasText: false, focused: false },
    blocking: { blocked: false, reasons: [] },
    actions: { retryAvailable: false, continueGeneratingAvailable: false },
    confidence: "HIGH",
    observedAt: 123,
  };
}

async function flushAsyncWork() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function loadContentAgent(initialVisibility) {
  const source = await readFile(new URL("../dist/content/index.js", import.meta.url), "utf8");
  const sent = [];
  const timers = new Map();
  const documentListeners = new Map();
  let nextTimerId = 1;
  let mutationCallback;
  const state = { visibilityState: initialVisibility, observation: observation() };

  class FakeAdapter {
    currentRouteKey() { return "/c/chat-bg"; }
    currentConversationId() { return "chat-bg"; }
    async observe() { return structuredClone(state.observation); }
    isComposerTarget() { return false; }
    isManualSendTarget() { return false; }
    isStopGenerationTarget() { return false; }
    isEditTurnTarget() { return false; }
    isBlockingInteractionTarget() { return false; }
  }

  class FakeMutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
  }

  const document = {
    documentElement: {},
    get visibilityState() { return state.visibilityState; },
    addEventListener(type, callback) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(callback);
      documentListeners.set(type, listeners);
    },
  };

  const window = {
    addEventListener() {},
    setInterval() { return 1; },
    setTimeout(callback) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };

  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        sent.push(structuredClone(message));
        return {
          type: "background:agent-ack",
          protocolVersion: 2,
          accepted: true,
          tabId: 1,
          documentId: "document-test",
          controlEligibility: "OWNER",
        };
      },
    },
  };

  const context = {
    GuardianContent: { PROTOCOL_VERSION: 2, BrowserChatGPTAdapter: FakeAdapter },
    MutationObserver: FakeMutationObserver,
    chrome,
    crypto: { randomUUID: () => "agent-test" },
    Date,
    document,
    location: { pathname: "/c/chat-bg" },
    performance: { now: () => 0 },
    Promise,
    queueMicrotask,
    structuredClone,
    window,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await flushAsyncWork();

  return {
    sent,
    mutation() {
      assert.equal(typeof mutationCallback, "function");
      mutationCallback([], undefined);
    },
    setVisibility(value) { state.visibilityState = value; },
    fireDocumentEvent(type) {
      for (const listener of documentListeners.get(type) ?? []) listener({ type });
    },
    runTimers() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, callback] of pending) callback();
    },
  };
}

function observationMessages(sent) {
  return sent.filter((message) => message.type === "content:observation");
}

test("hidden-tab DOM mutations produce observations without timer callbacks", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;

  agent.mutation();
  await flushAsyncWork();

  assert.equal(observationMessages(agent.sent).length, 1);
});

test("foreground observation scheduling retains timer debounce", async () => {
  const agent = await loadContentAgent("visible");
  agent.runTimers();
  await flushAsyncWork();
  agent.sent.length = 0;

  agent.mutation();
  await flushAsyncWork();
  assert.equal(observationMessages(agent.sent).length, 0);

  agent.runTimers();
  await flushAsyncWork();
  assert.equal(observationMessages(agent.sent).length, 1);
});

test("visibility changes request an immediate catch-up observation", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;

  agent.setVisibility("visible");
  agent.fireDocumentEvent("visibilitychange");
  agent.runTimers();
  await flushAsyncWork();

  assert.equal(observationMessages(agent.sent).length, 1);
});
