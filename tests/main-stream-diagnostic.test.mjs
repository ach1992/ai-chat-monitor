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
  const sockets = [];
  const originalFetch = async (input, init) => {
    calls.push({ input, init });
    return responseFactory(input, init);
  };
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, protocols) {
      this.url = String(url);
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(type, callback) {
      const existing = this.listeners.get(type) ?? [];
      existing.push(callback);
      this.listeners.set(type, existing);
    }

    emit(type, event = {}) {
      if (type === "open") this.readyState = FakeWebSocket.OPEN;
      if (type === "close") this.readyState = FakeWebSocket.CLOSED;
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  const window = {
    fetch: originalFetch,
    WebSocket: FakeWebSocket,
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
    Date,
    Number,
    Object,
    Array,
    JSON,
    Math,
    Map,
    Proxy,
    Reflect,
    crypto: webcrypto,
    structuredClone,
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    calls,
    posted,
    sockets,
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
    webSocket(url, protocols) {
      return new window.WebSocket(url, protocols);
    },
  };
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

test("diagnostic records only selected conversation lifecycle metadata", async () => {
  const diagnostic = await loadDiagnostic((input) => {
    if (String(input).includes("stream_status")) {
      return new Response('{"status":"IS_STREAMING","secret":"must-not-leak"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response('{"opaque":"body"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  diagnostic.setEnabled(true);
  diagnostic.userSend();

  const conversationResponse = await diagnostic.fetch(
    "/backend-api/f/conversation?token=must-not-be-recorded",
    { method: "POST", body: "opaque-request-body" },
  );
  const statusResponse = await diagnostic.fetch(
    "/backend-api/conversation/diagnostic-test/stream_status?token=must-not-be-recorded",
    { method: "GET" },
  );
  await diagnostic.fetch("/backend-api/models?token=must-not-be-recorded", { method: "GET" });
  await diagnostic.fetch("/ces/v1/t?token=must-not-be-recorded", { method: "POST" });
  await flushAsyncWork();

  assert.equal(await conversationResponse.text(), '{"opaque":"body"}');
  assert.equal(await statusResponse.text(), '{"status":"IS_STREAMING","secret":"must-not-leak"}');

  const responses = diagnostic.events.filter((event) => event.kind === "FETCH_RESPONSE");
  const lifecycle = diagnostic.events.filter((event) => event.kind === "LIFECYCLE_STATUS");
  assert.equal(responses.length, 2);
  assert.deepEqual(responses.map((event) => [event.method, event.path]), [
    ["POST", "/backend-api/f/conversation"],
    ["GET", "/backend-api/conversation/diagnostic-test/stream_status"],
  ]);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].serverStatus, "IS_STREAMING");
  assert.equal(lifecycle[0].path, "/backend-api/conversation/diagnostic-test/stream_status");
  assert.equal(JSON.stringify(diagnostic.events).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(diagnostic.events).includes("must-not-be-recorded"), false);
  assert.equal(JSON.stringify(diagnostic.events).includes("opaque-request-body"), false);
});

test("only the current conversation lifecycle GET paths are observed", async () => {
  const diagnostic = await loadDiagnostic(() => new Response('{"status":"DONE"}', {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  diagnostic.setEnabled(true);
  diagnostic.userSend();

  await diagnostic.fetch("/backend-api/conversation/other-chat/stream_status", { method: "GET" });
  await diagnostic.fetch("/backend-api/conversations/diagnostic-test", { method: "GET" });
  await diagnostic.fetch("/backend-api/conversation/diagnostic-test", { method: "GET" });
  await flushAsyncWork();

  const responses = diagnostic.events.filter((event) => event.kind === "FETCH_RESPONSE");
  assert.deepEqual(responses.map((event) => event.path), [
    "/backend-api/conversations/diagnostic-test",
    "/backend-api/conversation/diagnostic-test",
  ]);
  assert.equal(diagnostic.events.some((event) => event.kind === "LIFECYCLE_STATUS"), false);
});

test("websocket diagnostic records activity timing only and never reads message payloads", async () => {
  const diagnostic = await loadDiagnostic(() => new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  diagnostic.setEnabled(true);

  const socket = diagnostic.webSocket("wss://events.chatgpt.com/backend-api/realtime?token=must-not-be-recorded", ["chat"]);
  socket.emit("open");
  diagnostic.userSend();

  const poisonMessage = {};
  Object.defineProperty(poisonMessage, "data", {
    get() { throw new Error("message payload must not be read"); },
  });
  socket.emit("message", poisonMessage);
  socket.emit("message", poisonMessage);
  await diagnostic.fetch("/backend-api/f/conversation/prepare", { method: "POST" });
  await flushAsyncWork();

  const present = diagnostic.events.find((event) => event.kind === "WEBSOCKET_PRESENT");
  const activity = diagnostic.events.filter((event) => event.kind === "WEBSOCKET_ACTIVITY");
  assert.ok(present);
  assert.equal(present.socketHost, "events.chatgpt.com");
  assert.equal(present.socketPath, "/backend-api/realtime");
  assert.equal(present.readyState, 1);
  assert.ok(activity.length >= 2);
  assert.equal(activity.at(-1).messageCount, 2);
  assert.equal(typeof activity.at(-1).lastMessageAt, "number");
  assert.equal(JSON.stringify(diagnostic.events).includes("must-not-be-recorded"), false);
  assert.equal(JSON.stringify(diagnostic.events).includes("message payload must not be read"), false);
});

test("websocket diagnostic ignores non-OpenAI endpoints", async () => {
  const diagnostic = await loadDiagnostic(() => new Response("ok"));
  diagnostic.setEnabled(true);
  const socket = diagnostic.webSocket("wss://example.com/private?token=must-not-be-recorded");
  socket.emit("open");
  diagnostic.userSend();
  socket.emit("message", {});
  await flushAsyncWork();

  assert.equal(diagnostic.events.some((event) => event.kind.startsWith("WEBSOCKET_")), false);
  assert.equal(JSON.stringify(diagnostic.events).includes("example.com"), false);
  assert.equal(JSON.stringify(diagnostic.events).includes("must-not-be-recorded"), false);
});
