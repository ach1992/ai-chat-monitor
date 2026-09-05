import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function flushAsyncWork() {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function canonicalPayload({ text, status = "finished_successfully", endTurn = true } = {}) {
  return {
    current_node: "assistant-1",
    mapping: {
      "user-1": {
        id: "user-1",
        parent: null,
        message: {
          id: "user-1",
          author: { role: "user" },
          status: "finished_successfully",
          end_turn: false,
          content: { parts: ["user prompt"] },
        },
      },
      "assistant-1": {
        id: "assistant-1",
        parent: "user-1",
        message: {
          id: "assistant-1",
          author: { role: "assistant" },
          status,
          end_turn: endTurn,
          content: { parts: [text ?? "plain response"] },
        },
      },
    },
  };
}

async function loadBridge(payload, visibilityState = "hidden") {
  const source = await readFile(new URL("../dist/content/hidden-response-bridge.js", import.meta.url), "utf8");
  const listeners = new Map();
  const posted = [];
  const calls = [];
  const originalFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: structuredClone(init ?? {}) });
    if (url.includes("/backend-api/conversations/")) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const document = { visibilityState };
  const location = {
    href: "https://chatgpt.com/c/conv-1",
    origin: "https://chatgpt.com",
    hostname: "chatgpt.com",
  };
  const window = {
    fetch: originalFetch,
    addEventListener(type, callback) {
      const list = listeners.get(type) ?? [];
      list.push(callback);
      listeners.set(type, list);
    },
    postMessage(data) { posted.push(structuredClone(data)); },
  };
  const context = {
    window,
    document,
    location,
    Request,
    Response,
    URL,
    Set,
    structuredClone,
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    calls,
    posted,
    document,
    enable(conversationId = "conv-1") {
      for (const listener of listeners.get("message") ?? []) {
        listener({
          source: window,
          origin: location.origin,
          data: {
            channel: "AI_CHAT_MONITOR_HIDDEN_RESPONSE_V1",
            type: "control",
            protocolVersion: 1,
            enabled: true,
            conversationId,
          },
        });
      }
    },
    async prepare() {
      const response = await window.fetch("/backend-api/f/conversation/prepare", { method: "POST" });
      await flushAsyncWork();
      return response;
    },
    evidence() {
      return posted
        .filter((message) => message.type === "server-completion-evidence")
        .map((message) => message.evidence);
    },
  };
}

test("hidden prepare triggers one canonical readback and emits only exact sanitized semantic completion evidence", async () => {
  const secret = "TOP_SECRET_TRANSCRIPT_TEXT";
  const bridge = await loadBridge(canonicalPayload({
    text: `answer ${secret}\n\nAI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}`,
  }));
  bridge.enable();
  await bridge.prepare();
  await bridge.prepare();

  const readbacks = bridge.calls.filter((call) => call.url.includes("/backend-api/conversations/conv-1"));
  assert.equal(readbacks.length, 1);
  assert.equal(readbacks[0].init.method, "GET");
  assert.equal(readbacks[0].init.credentials, "same-origin");
  assert.equal(readbacks[0].init.cache, "no-store");

  assert.deepEqual(bridge.evidence(), [{
    conversationId: "conv-1",
    assistantMessageId: "assistant-1",
    parentUserMessageId: "user-1",
    messageStatus: "finished_successfully",
    endTurn: true,
    markerHealth: "DETECTED",
    semanticDecision: "COMPLETE",
    assistantTextLength: `answer ${secret}\n\nAI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}`.length,
  }]);
  assert.equal(JSON.stringify(bridge.posted).includes(secret), false, "raw canonical assistant text is never emitted");
});

test("canonical finished assistant with no marker produces completion evidence without fabricated semantics", async () => {
  const bridge = await loadBridge(canonicalPayload({ text: "ordinary completed response" }));
  bridge.enable();
  await bridge.prepare();

  assert.deepEqual(bridge.evidence(), [{
    conversationId: "conv-1",
    assistantMessageId: "assistant-1",
    parentUserMessageId: "user-1",
    messageStatus: "finished_successfully",
    endTurn: true,
    markerHealth: "MISSING",
    assistantTextLength: "ordinary completed response".length,
  }]);
});

test("canonical readback fails closed unless hidden, armed, finished successfully, and end-turn", async () => {
  const visible = await loadBridge(canonicalPayload({
    text: 'answer\nAI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}',
  }), "visible");
  visible.enable();
  await visible.prepare();
  assert.equal(visible.calls.some((call) => call.url.includes("/backend-api/conversations/")), false);
  assert.deepEqual(visible.evidence(), []);

  const unfinished = await loadBridge(canonicalPayload({
    text: 'answer\nAI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}',
    status: "in_progress",
    endTurn: false,
  }));
  unfinished.enable();
  await unfinished.prepare();
  assert.deepEqual(unfinished.evidence(), []);
});
