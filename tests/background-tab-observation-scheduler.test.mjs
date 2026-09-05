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
  const windowListeners = new Map();
  const windowPosted = [];
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
    isComposerTarget(target) { return target?.composer === true; }
    isManualSendTarget(target) { return target?.manualSend === true; }
    isStopGenerationTarget(target) { return target?.stop === true; }
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
    addEventListener(type, callback) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(callback);
      windowListeners.set(type, listeners);
    },
    postMessage(data) { windowPosted.push(structuredClone(data)); },
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
          monitoringEnabled: true,
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
    pageMessage(message) {
      for (const listener of windowListeners.get("message") ?? []) {
        listener({ source: window, origin: "https://chatgpt.com", data: structuredClone(message) });
      }
    },
    manualSend() {
      const event = {
        type: "keydown",
        isTrusted: true,
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        target: { composer: true },
      };
      for (const listener of documentListeners.get("keydown") ?? []) listener(event);
    },
    get pageMessages() { return windowPosted; },
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

function armPageStream(agent) {
  const interaction = [...agent.sent].reverse().find((message) =>
    message.type === "content:user-interaction" && message.interaction === "MANUAL_SEND",
  );
  assert.ok(interaction);
  const episodeStartedAt = interaction.sentAt;
  agent.pageMessage({
    channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1",
    type: "stream-armed",
    protocolVersion: 1,
    episodeStartedAt,
  });
  return { episodeStartedAt };
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

test("manual send arms page-stream monitoring and keeps hidden transient IDLE observations generating", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.pageMessages.length = 0;
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

  agent.manualSend();
  await flushAsyncWork();

  const arm = armPageStream(agent);
  const observations = observationMessages(agent.sent);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].observation.generation, "GENERATING");
  assert.equal(observations[0].observation.responseCompletion, undefined);
  assert.equal(observations[0].observation.responseTerminalStatus, undefined);
});

test("matching page-stream DONE releases hidden generation and binds generic completion only", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.pageMessages.length = 0;
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
  agent.manualSend();
  await flushAsyncWork();
  const arm = armPageStream(agent);
  agent.sent.length = 0;

  agent.pageMessage({
    channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1",
    type: "response-complete",
    protocolVersion: 1,
    episodeStartedAt: arm.episodeStartedAt,
    completedAt: arm.episodeStartedAt + 2_000,
  });
  await flushAsyncWork();

  const completions = completionObservations(agent.sent);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].observation.generation, "IDLE");
  assert.deepEqual(completions[0].observation.responseCompletion, {
    serial: 1,
    transport: "CHATGPT_CONVERSATION_STREAM",
    visibility: "hidden",
    completedAt: arm.episodeStartedAt + 2_000,
  });
  assert.equal(completions[0].observation.responseTerminalStatus, undefined);
});

test("mismatched page-stream outcome cannot end the current hidden response", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.pageMessages.length = 0;
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
  agent.manualSend();
  await flushAsyncWork();
  const arm = armPageStream(agent);
  agent.sent.length = 0;

  agent.pageMessage({
    channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1",
    type: "response-complete",
    protocolVersion: 1,
    episodeStartedAt: arm.episodeStartedAt - 1,
    completedAt: arm.episodeStartedAt + 1_000,
  });
  agent.mutation();
  await flushAsyncWork();

  assert.equal(completionObservations(agent.sent).length, 0);
  assert.ok(observationMessages(agent.sent).every((message) => message.observation.generation === "GENERATING"));
});

test("terminal status from page stream suppresses generic completion evidence", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.pageMessages.length = 0;
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
  agent.manualSend();
  await flushAsyncWork();
  const arm = armPageStream(agent);
  agent.sent.length = 0;

  agent.pageMessage({
    channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1",
    type: "terminal-status",
    protocolVersion: 1,
    episodeStartedAt: arm.episodeStartedAt,
    completedAt: arm.episodeStartedAt + 3_000,
    decision: "COMPLETE",
  });
  await flushAsyncWork();

  const observations = observationMessages(agent.sent);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].observation.responseCompletion, undefined);
  assert.deepEqual(observations[0].observation.responseTerminalStatus, {
    serial: 1,
    source: "CHATGPT_RESPONSE_STREAM",
    visibility: "hidden",
    completedAt: arm.episodeStartedAt + 3_000,
    decision: "COMPLETE",
  });
});

test("monitoring-off state disables hidden response hold and ignores page-stream outcomes", async () => {
  const agent = await loadContentAgent("hidden");
  agent.sent.length = 0;
  agent.backgroundMessage({
    type: "background:monitoring-state",
    protocolVersion: 2,
    enabled: false,
  });
  agent.setObservation({
    ...observation(),
    generation: "IDLE",
    latestAssistant: {
      normalizedText: "unmonitored partial response",
      textLength: 28,
      fingerprint: "c".repeat(64),
      domMessageId: "assistant-unmonitored",
    },
  });

  agent.manualSend();
  await flushAsyncWork();
  const interaction = [...agent.sent].reverse().find((message) =>
    message.type === "content:user-interaction" && message.interaction === "MANUAL_SEND",
  );
  assert.ok(interaction);
  agent.pageMessage({
    channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1",
    type: "stream-armed",
    protocolVersion: 1,
    episodeStartedAt: interaction.sentAt,
  });
  agent.pageMessage({
    channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1",
    type: "response-complete",
    protocolVersion: 1,
    episodeStartedAt: interaction.sentAt,
    completedAt: interaction.sentAt + 1000,
  });
  agent.mutation();
  await flushAsyncWork();

  const observations = observationMessages(agent.sent);
  assert.ok(observations.length >= 1);
  assert.ok(observations.every((message) => message.observation.generation === "IDLE"));
  assert.equal(completionObservations(agent.sent).length, 0);
});
