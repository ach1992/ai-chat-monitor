import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function loadObserver(responseFactory) {
  const source = await readFile(new URL("../dist/content/main-stream-observer.js", import.meta.url), "utf8");
  const windowListeners = new Map();
  const documentListeners = new Map();
  const posted = [];
  const originalFetch = async (input, init) => responseFactory(input, init);
  const window = {
    fetch: originalFetch,
    addEventListener(type, callback) {
      const existing = windowListeners.get(type) ?? [];
      existing.push(callback);
      windowListeners.set(type, existing);
    },
    postMessage(data) { posted.push(structuredClone(data)); },
  };
  class FakeElement {
    constructor(kind) { this.kind = kind; }
    matches(selector) {
      if (this.kind === "composer") return selector === "#prompt-textarea";
      if (this.kind === "send") return selector === 'button[data-testid="send-button"]';
      if (this.kind === "stop") return selector === 'button[data-testid="stop-button"]';
      return false;
    }
    closest(selector) { return this.matches(selector) ? this : null; }
  }
  const document = {
    addEventListener(type, callback) {
      const existing = documentListeners.get(type) ?? [];
      existing.push(callback);
      documentListeners.set(type, existing);
    },
  };
  const location = {
    href: "https://chatgpt.com/c/rev10-test",
    origin: "https://chatgpt.com",
    hostname: "chatgpt.com",
  };
  const context = {
    window,
    document,
    Element: FakeElement,
    location,
    Request,
    Response,
    URL,
    TextDecoder,
    Set,
    Date,
    Number,
    structuredClone,
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    posted,
    get outcomes() { return posted.filter((message) => message.type !== "stream-armed"); },
    setMonitoringEnabled(enabled) {
      for (const listener of windowListeners.get("message") ?? []) {
        listener({
          source: window,
          origin: location.origin,
          data: {
            channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1",
            type: "monitoring-state",
            protocolVersion: 1,
            enabled,
          },
        });
      }
    },
    userSend() {
      for (const listener of documentListeners.get("keydown") ?? []) {
        listener({
          isTrusted: true,
          key: "Enter",
          shiftKey: false,
          isComposing: false,
          target: new FakeElement("composer"),
        });
      }
      const armed = [...posted].reverse().find((message) => message.type === "stream-armed");
      assert.ok(armed);
      return armed.episodeStartedAt;
    },
    fetch(input = "/backend-api/f/conversation", init = { method: "POST" }) {
      return window.fetch(input, init);
    },
  };
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

test("page stream emits generic completion only after actual SSE DONE when no status marker exists", async () => {
  const observer = await loadObserver(() => sseResponse([
    'data: {"type":"message","text":"still working"}\n\n',
    'data: {"type":"message","text":"final answer"}\n\n',
    "data: [DONE]\n\n",
  ]));
  observer.setMonitoringEnabled(true);
  const startedAt = observer.userSend();
  await observer.fetch();
  await flushAsyncWork();

  assert.equal(observer.outcomes.length, 1);
  assert.deepEqual(observer.outcomes[0], {
    channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1",
    protocolVersion: 1,
    episodeStartedAt: startedAt,
    completedAt: observer.outcomes[0].completedAt,
    type: "response-complete",
  });
  assert.ok(observer.outcomes[0].completedAt >= startedAt);
});

test("terminal status in SSE outranks DONE and suppresses generic completion", async () => {
  const observer = await loadObserver(() => sseResponse([
    'data: {"type":"message","text":"answer\\nAI_CHAT_MONITOR_STATUS={\\"decision\\":\\"COMPLETE\\"}"}\n\n',
    "data: [DONE]\n\n",
  ]));
  observer.setMonitoringEnabled(true);
  const startedAt = observer.userSend();
  await observer.fetch();
  await flushAsyncWork();

  assert.equal(observer.outcomes.length, 1);
  assert.equal(observer.outcomes[0].type, "terminal-status");
  assert.equal(observer.outcomes[0].decision, "COMPLETE");
  assert.equal(observer.outcomes[0].episodeStartedAt, startedAt);
});

test("unarmed, non-SSE, GET, and unrelated requests cannot emit response completion", async () => {
  const observer = await loadObserver(() => new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }));
  await observer.fetch();
  await flushAsyncWork();
  assert.equal(observer.outcomes.length, 0);

  observer.setMonitoringEnabled(true);
  const startedAt = observer.userSend();
  await observer.fetch("/backend-api/f/conversation", { method: "GET" });
  await observer.fetch("/backend-api/accounts/check", { method: "POST" });
  await flushAsyncWork();
  assert.equal(observer.outcomes.length, 0);
});

test("SSE without DONE or terminal status fails closed", async () => {
  const observer = await loadObserver(() => sseResponse([
    'data: {"type":"message","text":"connection ended unexpectedly"}\n\n',
  ]));
  observer.setMonitoringEnabled(true);
  const startedAt = observer.userSend();
  await observer.fetch();
  await flushAsyncWork();
  assert.equal(observer.outcomes.length, 0);
});

test("MAIN-world observer delegates the original fetch unchanged and returns the original Response", async () => {
  const calls = [];
  const response = sseResponse(["data: [DONE]\n\n"]);
  const observer = await loadObserver((input, init) => {
    calls.push({ input, init });
    return response;
  });
  observer.setMonitoringEnabled(true);
  const startedAt = observer.userSend();
  const init = { method: "POST", headers: { "x-test": "value" }, body: "opaque-body" };
  const result = await observer.fetch("/backend-api/f/conversation", init);
  await flushAsyncWork();

  assert.equal(result, response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/backend-api/f/conversation");
  assert.equal(calls[0].init, init);
  assert.equal(observer.outcomes.length, 1);
  assert.equal(observer.outcomes[0].type, "response-complete");
});


test("unmonitored ChatGPT sends never arm or clone the response stream", async () => {
  let responseFactoryCalls = 0;
  const observer = await loadObserver(() => {
    responseFactoryCalls += 1;
    return sseResponse(["data: [DONE]\n\n"]);
  });

  // MAIN observer is disabled by default until trusted extension policy enables this chat.
  for (const listener of []) void listener;
  await observer.fetch();
  await flushAsyncWork();
  assert.equal(responseFactoryCalls, 1);
  assert.equal(observer.posted.some((message) => message.type === "stream-armed"), false);
  assert.equal(observer.outcomes.length, 0);
});

test("duplicate terminal status records are not accepted as semantic authority", async () => {
  const observer = await loadObserver(() => sseResponse([
    'data: {"text":"AI_CHAT_MONITOR_STATUS={\\"decision\\":\\"COMPLETE\\"}"}\n\n',
    'data: {"text":"AI_CHAT_MONITOR_STATUS={\\"decision\\":\\"HOLD_DECISION\\"}"}\n\n',
    "data: [DONE]\n\n",
  ]));
  observer.setMonitoringEnabled(true);
  const startedAt = observer.userSend();
  await observer.fetch();
  await flushAsyncWork();

  assert.equal(observer.outcomes.length, 1);
  assert.equal(observer.outcomes[0].type, "response-complete");
  assert.equal(observer.outcomes[0].episodeStartedAt, startedAt);
});
