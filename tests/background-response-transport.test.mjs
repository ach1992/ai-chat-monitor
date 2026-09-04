import test from "node:test";
import assert from "node:assert/strict";

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function loadTransportObserver() {
  const listeners = {};
  const storage = {};
  const messages = [];
  const registrations = {};
  const previousChrome = globalThis.chrome;

  globalThis.chrome = {
    storage: {
      session: {
        async get(key) { return key in storage ? { [key]: structuredClone(storage[key]) } : {}; },
        async set(items) { Object.assign(storage, structuredClone(items)); },
      },
    },
    tabs: {
      async sendMessage(tabId, message, options) {
        messages.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        return undefined;
      },
    },
    webRequest: {
      onResponseStarted: {
        addListener(callback, filter, extraInfoSpec) {
          listeners.started = callback;
          registrations.started = { filter: structuredClone(filter), extraInfoSpec: structuredClone(extraInfoSpec) };
        },
      },
      onCompleted: {
        addListener(callback, filter, extraInfoSpec) {
          listeners.completed = callback;
          registrations.completed = { filter: structuredClone(filter), extraInfoSpec: structuredClone(extraInfoSpec) };
        },
      },
      onErrorOccurred: {
        addListener(callback, filter) {
          listeners.error = callback;
          registrations.error = { filter: structuredClone(filter) };
        },
      },
    },
  };

  await import(new URL(`../dist/background/response-transport.js?test=${Date.now()}`, import.meta.url));

  return {
    listeners,
    storage,
    messages,
    registrations,
    restore() { globalThis.chrome = previousChrome; },
  };
}

function startedDetails(overrides = {}) {
  return {
    requestId: "request-1",
    url: "https://chatgpt.com/backend-api/f/conversation",
    method: "POST",
    frameId: 0,
    parentFrameId: -1,
    tabId: 7,
    type: "xmlhttprequest",
    timeStamp: 1_000,
    documentId: "document-7",
    statusCode: 200,
    statusLine: "HTTP/2 200",
    fromCache: false,
    responseHeaders: [{ name: "Content-Type", value: "text/event-stream; charset=utf-8" }],
    ...overrides,
  };
}

function completedDetails(overrides = {}) {
  return {
    requestId: "request-1",
    url: "https://chatgpt.com/backend-api/f/conversation",
    method: "POST",
    frameId: 0,
    parentFrameId: -1,
    tabId: 7,
    type: "xmlhttprequest",
    timeStamp: 2_000,
    documentId: "document-7",
    statusCode: 200,
    statusLine: "HTTP/2 200",
    fromCache: false,
    ...overrides,
  };
}

test("webRequest observer accepts only a correlated successful ChatGPT SSE lifecycle", async () => {
  const observer = await loadTransportObserver();
  try {
    assert.equal(typeof observer.listeners.started, "function");
    assert.equal(typeof observer.listeners.completed, "function");
    assert.equal(typeof observer.listeners.error, "function");
    assert.deepEqual(observer.registrations.started.extraInfoSpec, ["responseHeaders"]);
    assert.deepEqual(observer.registrations.started.filter.types, ["xmlhttprequest"]);

    observer.listeners.started(startedDetails({ method: "GET", requestId: "initial-get" }));
    observer.listeners.started(startedDetails({
      requestId: "json-post",
      responseHeaders: [{ name: "content-type", value: "application/json" }],
    }));
    observer.listeners.started(startedDetails({ requestId: "subframe", frameId: 2 }));
    observer.listeners.started(startedDetails({ requestId: "failed", statusCode: 500 }));
    await flushAsyncWork();
    assert.equal(observer.messages.length, 0);

    observer.listeners.started(startedDetails());
    await flushAsyncWork();
    assert.equal(observer.messages.length, 1);
    assert.deepEqual(observer.messages[0], {
      tabId: 7,
      options: { documentId: "document-7" },
      message: {
        type: "background:response-stream-started",
        protocolVersion: 2,
        requestId: "request-1",
        startedAt: 1_000,
      },
    });

    observer.listeners.completed(completedDetails({ requestId: "other-request" }));
    await flushAsyncWork();
    assert.equal(observer.messages.length, 1);

    observer.listeners.completed(completedDetails());
    await flushAsyncWork();
    assert.equal(observer.messages.length, 2);
    assert.deepEqual(observer.messages[1], {
      tabId: 7,
      options: { documentId: "document-7" },
      message: {
        type: "background:response-stream-completed",
        protocolVersion: 2,
        requestId: "request-1",
        startedAt: 1_000,
        completedAt: 2_000,
      },
    });
    assert.deepEqual(observer.storage["guardian:response-transport:inflight"], { version: 1, requests: [] });
  } finally {
    observer.restore();
  }
});

test("webRequest observer persists in-flight identity and aborts only the matching request", async () => {
  const observer = await loadTransportObserver();
  try {
    observer.listeners.started(startedDetails({ requestId: "request-abort", timeStamp: 3_000 }));
    await flushAsyncWork();
    assert.equal(observer.storage["guardian:response-transport:inflight"].requests[0].requestId, "request-abort");

    observer.listeners.error({
      requestId: "request-abort",
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      frameId: 0,
      parentFrameId: -1,
      tabId: 7,
      type: "xmlhttprequest",
      timeStamp: 3_500,
      documentId: "document-7",
      error: "net::ERR_ABORTED",
      fromCache: false,
    });
    await flushAsyncWork();

    assert.equal(observer.messages.at(-1)?.message.type, "background:response-stream-aborted");
    assert.equal(observer.messages.at(-1)?.message.requestId, "request-abort");
    assert.deepEqual(observer.storage["guardian:response-transport:inflight"], { version: 1, requests: [] });
  } finally {
    observer.restore();
  }
});
