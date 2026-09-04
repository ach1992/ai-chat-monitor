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
  let resourceCallback;
  const state = { visibilityState: initialVisibility, observation: observation(), rejectNextObservation: false };

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

  class FakePerformanceResourceTiming {
    constructor(overrides = {}) {
      Object.assign(this, {
        entryType: "resource",
        name: "https://chatgpt.com/backend-api/f/conversation",
        initiatorType: "fetch",
        responseEnd: 250,
        responseStatus: 200,
        contentType: "text/event-stream",
      }, overrides);
    }
  }

  class FakePerformanceObserver {
    constructor(callback) { resourceCallback = callback; }
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
        if (message.type === "content:observation" && state.rejectNextObservation) {
          state.rejectNextObservation = false;
          return {
            type: "background:error",
            protocolVersion: 2,
            code: "STALE_EVENT",
            message: "Session event rejected: NO_SESSION.",
          };
        }
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
    PerformanceObserver: FakePerformanceObserver,
    PerformanceResourceTiming: FakePerformanceResourceTiming,
    URL,
    chrome,
    crypto: { randomUUID: () => "agent-test" },
    Date,
    document,
    location: { href: "https://chatgpt.com/c/chat-bg", origin: "https://chatgpt.com", pathname: "/c/chat-bg" },
    performance: { now: () => 0, timeOrigin: 1_000 },
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
    resource(overrides = {}) {
      assert.equal(typeof resourceCallback, "function");
      const entry = new FakePerformanceResourceTiming(overrides);
      resourceCallback({ getEntries: () => [entry] }, undefined);
    },
    setVisibility(value) { state.visibilityState = value; },
    setObservation(value) { state.observation = structuredClone(value); },
    rejectNextObservation() { state.rejectNextObservation = true; },
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

function responseCompleteMessages(sent) {
  return sent.filter((message) => message.type === "content:response-complete");
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

test("hidden agent self-heals a lost background session without tab activation", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.rejectNextObservation();

  agent.mutation();
  await flushAsyncWork();

  assert.deepEqual(
    agent.sent.map((message) => message.type),
    ["content:observation", "content:hello", "content:observation"],
  );
});

test("conversation transport completion is emitted while hidden even when assistant DOM stays stale", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.setObservation({
    ...observation(),
    generation: "IDLE",
    latestAssistant: {
      normalizedText: "old",
      textLength: 3,
      fingerprint: "b".repeat(64),
      domMessageId: "assistant-old",
    },
  });

  agent.resource();
  await flushAsyncWork();

  const completions = responseCompleteMessages(agent.sent);
  assert.equal(completions.length, 1);
  assert.deepEqual(
    {
      routeKey: completions[0].routeKey,
      conversationId: completions[0].conversationId,
      transport: completions[0].transport,
      visibility: completions[0].visibility,
      completedAt: completions[0].completedAt,
    },
    {
      routeKey: "/c/chat-bg",
      conversationId: "chat-bg",
      transport: "CHATGPT_CONVERSATION_STREAM",
      visibility: "hidden",
      completedAt: 1_250,
    },
  );
});

test("transport observer ignores prepare, cross-origin, non-stream, and failed resources", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;

  agent.resource({ name: "https://chatgpt.com/backend-api/f/conversation/prepare" });
  agent.resource({ name: "https://example.com/backend-api/f/conversation" });
  agent.resource({ contentType: "application/json" });
  agent.resource({ responseStatus: 500 });
  await flushAsyncWork();

  assert.equal(responseCompleteMessages(agent.sent).length, 0);
});
