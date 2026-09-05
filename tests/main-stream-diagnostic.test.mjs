import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function flushAsyncWork() {
  for (let index = 0; index < 12; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function loadDiagnostic(responseFactory) {
  const source = await readFile(new URL("../dist/content/main-stream-diagnostic.js", import.meta.url), "utf8");
  const windowListeners = new Map();
  const documentListeners = new Map();
  const posted = [];
  const calls = [];
  const originalFetch = async (input, init) => {
    calls.push({ input, init });
    return responseFactory(input, init);
  };
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
      return false;
    }
    closest(selector) { return this.matches(selector) ? this : null; }
  }
  const document = {
    visibilityState: "hidden",
    addEventListener(type, callback) {
      const existing = documentListeners.get(type) ?? [];
      existing.push(callback);
      documentListeners.set(type, existing);
    },
  };
  const location = {
    href: "https://chatgpt.com/c/diagnostic-test",
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
    ReadableStream,
    TextEncoder,
    TextDecoder,
    Date,
    Number,
    Object,
    Array,
    JSON,
    Math,
    Set,
    crypto: webcrypto,
    structuredClone,
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    calls,
    posted,
    get events() {
      return posted
        .filter((message) => message.type === "network-diagnostic")
        .map((message) => message.event);
    },
    setEnabled(enabled) {
      for (const listener of windowListeners.get("message") ?? []) {
        listener({
          source: window,
          origin: location.origin,
          data: {
            channel: "AI_CHAT_MONITOR_NETWORK_DIAGNOSTIC_V1",
            type: "control",
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

test("network diagnostic is disabled by default and preserves the original fetch contract", async () => {
  const response = new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
  const diagnostic = await loadDiagnostic(() => response);
  diagnostic.userSend();
  const init = { method: "POST", headers: { "x-test": "value" }, body: "opaque-request-body" };
  const result = await diagnostic.fetch("/backend-api/f/conversation?ignored=query", init);
  await flushAsyncWork();

  assert.equal(result, response);
  assert.equal(diagnostic.calls.length, 1);
  assert.equal(diagnostic.calls[0].input, "/backend-api/f/conversation?ignored=query");
  assert.equal(diagnostic.calls[0].init, init);
  assert.deepEqual(diagnostic.events, []);
});

test("diagnostic emits bounded stream identity metadata without response text", async () => {
  const marker = 'AI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}';
  const assistantText = `hello\n${marker}`;
  const payload = {
    conversation_id: "conversation-1",
    parent_id: "user-123",
    message: {
      id: "assistant-456",
      author: { role: "assistant" },
      content: { parts: [assistantText] },
    },
  };
  const diagnostic = await loadDiagnostic(() => sseResponse([
    `data: ${JSON.stringify(payload)}\n\n`,
    "data: [DONE]\n\n",
  ]));
  diagnostic.setEnabled(true);
  diagnostic.userSend();
  await diagnostic.fetch("/backend-api/f/conversation?token=must-not-be-recorded", { method: "POST" });
  await flushAsyncWork();

  const armed = diagnostic.events.find((event) => event.kind === "EPISODE_ARMED");
  const response = diagnostic.events.find((event) => event.kind === "FETCH_RESPONSE");
  const done = diagnostic.events.find((event) => event.kind === "STREAM_DONE");
  assert.ok(armed);
  assert.ok(response);
  assert.ok(done);
  assert.equal(response.path, "/backend-api/f/conversation");
  assert.equal(response.contentType, "text/event-stream; charset=utf-8");
  assert.equal(done.streamId, response.streamId);
  assert.equal(done.requestOrdinal, 1);
  assert.deepEqual(done.assistantMessageIds, ["assistant-456"]);
  assert.deepEqual(done.parentMessageIds, ["user-123"]);
  assert.deepEqual(done.conversationIds, ["conversation-1"]);
  assert.equal(done.assistantTextLength, assistantText.length);
  assert.equal(done.doneSeen, true);
  assert.equal(done.markerDecision, "COMPLETE");
  assert.equal(done.endReason, "DONE");
  assert.equal(JSON.stringify(done).includes("hello"), false);
  assert.equal(JSON.stringify(done).includes("AI_CHAT_MONITOR_STATUS"), false);
  assert.equal(JSON.stringify(diagnostic.events).includes("must-not-be-recorded"), false);
});

test("multiple same-episode SSE candidates stay distinct and none becomes completion authority", async () => {
  let call = 0;
  const diagnostic = await loadDiagnostic(() => {
    call += 1;
    const payload = {
      conversation_id: "conversation-2",
      parent_id: "user-222",
      message: {
        id: `assistant-${call}`,
        author: { role: "assistant" },
        content: { parts: [`candidate-${call}`] },
      },
    };
    return sseResponse([
      `data: ${JSON.stringify(payload)}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });
  diagnostic.setEnabled(true);
  diagnostic.userSend();
  await diagnostic.fetch("/backend-api/f/conversation", { method: "POST" });
  await diagnostic.fetch("/backend-api/f/conversation/resume", { method: "POST" });
  await flushAsyncWork();

  const responses = diagnostic.events.filter((event) => event.kind === "FETCH_RESPONSE");
  const done = diagnostic.events.filter((event) => event.kind === "STREAM_DONE");
  assert.equal(responses.length, 2);
  assert.equal(done.length, 2);
  assert.notEqual(responses[0].streamId, responses[1].streamId);
  assert.deepEqual(responses.map((event) => event.requestOrdinal), [1, 2]);
  assert.deepEqual(done.map((event) => event.assistantMessageIds?.[0]), ["assistant-1", "assistant-2"]);
});

test("non-SSE POSTs are identified but their bodies are never consumed as streams", async () => {
  const diagnostic = await loadDiagnostic(() => new Response('{"opaque":"body"}', {
    status: 202,
    headers: { "content-type": "application/json" },
  }));
  diagnostic.setEnabled(true);
  diagnostic.userSend();
  await diagnostic.fetch("/backend-api/other-path?secret=query", { method: "POST" });
  await flushAsyncWork();

  const responses = diagnostic.events.filter((event) => event.kind === "FETCH_RESPONSE");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].path, "/backend-api/other-path");
  assert.equal(responses[0].status, 202);
  assert.equal(responses[0].contentType, "application/json");
  assert.equal(diagnostic.events.some((event) => event.kind.startsWith("STREAM_")), false);
  assert.equal(JSON.stringify(diagnostic.events).includes("opaque"), false);
  assert.equal(JSON.stringify(diagnostic.events).includes("secret"), false);
});
