import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function observation() {
  return {
    conversationId: "chat-bg",
    routeKey: "/c/chat-bg",
    pageTitle: "Background chat",
    visibility: "hidden",
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
  let runtimeCallback;
  const state = { visibilityState: initialVisibility, observation: observation(), rejectNextObservation: false };

  class FakeAdapter {
    currentRouteKey() { return "/c/chat-bg"; }
    currentConversationId() { return "chat-bg"; }
    async observe() {
      return { ...structuredClone(state.observation), visibility: state.visibilityState };
    }
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
      onMessage: { addListener(callback) { runtimeCallback = callback; } },
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
    chrome,
    crypto: { randomUUID: () => "agent-test" },
    Date,
    document,
    location: { href: "https://chatgpt.com/c/chat-bg", origin: "https://chatgpt.com", pathname: "/c/chat-bg" },
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
    backgroundMessage(message) {
      assert.equal(typeof runtimeCallback, "function");
      runtimeCallback(structuredClone(message), {}, () => undefined);
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

function completionObservations(sent) {
  return observationMessages(sent).filter((message) => message.observation?.responseCompletion !== undefined);
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

test("browser stream start keeps hidden transient IDLE observations in generation", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.setObservation({
    ...observation(),
    generation: "IDLE",
    latestAssistant: {
      normalizedText: "partial response",
      textLength: 16,
      fingerprint: "b".repeat(64),
      domMessageId: "assistant-new",
    },
  });

  agent.backgroundMessage({
    type: "background:response-stream-started",
    protocolVersion: 2,
    requestId: "request-1",
    startedAt: 1_000,
  });
  await flushAsyncWork();

  const observations = observationMessages(agent.sent);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].observation.generation, "GENERATING");
  assert.equal(observations[0].observation.responseCompletion, undefined);
});

test("matching browser stream completion releases hidden generation and binds completion evidence", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.setObservation({
    ...observation(),
    generation: "IDLE",
    latestAssistant: {
      normalizedText: "partial response",
      textLength: 16,
      fingerprint: "b".repeat(64),
      domMessageId: "assistant-new",
    },
  });

  agent.backgroundMessage({
    type: "background:response-stream-started",
    protocolVersion: 2,
    requestId: "request-2",
    startedAt: 2_000,
  });
  await flushAsyncWork();
  agent.sent.length = 0;

  agent.backgroundMessage({
    type: "background:response-stream-completed",
    protocolVersion: 2,
    requestId: "request-2",
    startedAt: 2_000,
    completedAt: 3_000,
  });
  await flushAsyncWork();

  const completions = completionObservations(agent.sent);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].observation.generation, "IDLE");
  assert.equal(completions[0].observation.latestAssistant.normalizedText, "partial response");
  assert.deepEqual(completions[0].observation.responseCompletion, {
    serial: 1,
    transport: "CHATGPT_CONVERSATION_STREAM",
    visibility: "hidden",
    completedAt: 3_000,
  });
});

test("mismatched browser stream completion cannot end the active hidden response", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.setObservation({
    ...observation(),
    generation: "IDLE",
    latestAssistant: {
      normalizedText: "partial response",
      textLength: 16,
      fingerprint: "b".repeat(64),
      domMessageId: "assistant-new",
    },
  });

  agent.backgroundMessage({
    type: "background:response-stream-started",
    protocolVersion: 2,
    requestId: "request-current",
    startedAt: 4_000,
  });
  await flushAsyncWork();
  agent.sent.length = 0;

  agent.backgroundMessage({
    type: "background:response-stream-completed",
    protocolVersion: 2,
    requestId: "request-old",
    startedAt: 3_000,
    completedAt: 4_500,
  });
  agent.mutation();
  await flushAsyncWork();

  assert.equal(completionObservations(agent.sent).length, 0);
  assert.ok(observationMessages(agent.sent).every((message) => message.observation.generation === "GENERATING"));
});

test("aborted browser stream clears the hidden generation hold without fabricating completion", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.setObservation({
    ...observation(),
    generation: "IDLE",
    latestAssistant: {
      normalizedText: "partial response",
      textLength: 16,
      fingerprint: "b".repeat(64),
      domMessageId: "assistant-new",
    },
  });

  agent.backgroundMessage({
    type: "background:response-stream-started",
    protocolVersion: 2,
    requestId: "request-abort",
    startedAt: 5_000,
  });
  await flushAsyncWork();
  agent.sent.length = 0;

  agent.backgroundMessage({
    type: "background:response-stream-aborted",
    protocolVersion: 2,
    requestId: "request-abort",
    startedAt: 5_000,
  });
  await flushAsyncWork();

  const observations = observationMessages(agent.sent);
  assert.equal(completionObservations(agent.sent).length, 0);
  assert.equal(observations.at(-1)?.observation.generation, "IDLE");
});
