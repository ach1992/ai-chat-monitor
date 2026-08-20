import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

class FakeNode {
  static DOCUMENT_POSITION_FOLLOWING = 4;
  parent = null;
  order = 0;

  contains(node) { return node === this; }
  compareDocumentPosition(node) {
    return this.order < node.order ? FakeNode.DOCUMENT_POSITION_FOLLOWING : 0;
  }
}

class FakeElement extends FakeNode {
  constructor({ textContent = "", attrs = {}, value = "", order = 0, onClick } = {}) {
    super();
    this.textContent = textContent;
    this.attrs = new Map(Object.entries(attrs));
    this.value = value;
    this.order = order;
    this.onClick = onClick;
    this.isContentEditable = false;
  }

  getAttribute(name) { return this.attrs.get(name) ?? null; }
  dispatchEvent() { return true; }
  click() { this.onClick?.(); }

  matches(selector) {
    if (selector === 'button[data-testid="send-button"]') {
      return this.getAttribute("data-testid") === "send-button";
    }
    if (selector === 'button[data-testid="stop-button"]') {
      return this.getAttribute("data-testid") === "stop-button";
    }
    return false;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (selector === '[data-testid^="conversation-turn-"]') {
        if ((node.getAttribute?.("data-testid") ?? "").startsWith("conversation-turn-")) return node;
      } else if (node.matches?.(selector)) {
        return node;
      }
      node = node.parent;
    }
    return null;
  }
}

class FakeTextAreaElement extends FakeElement {}
class FakeInputElement extends FakeElement {}
class FakeButtonElement extends FakeElement {
  disabled = false;
}
class FakeEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
}
class FakeInputEvent extends FakeEvent {}
class FakeMutationObserver {
  static active = new Set();

  constructor(callback) { this.callback = callback; }
  observe() { FakeMutationObserver.active.add(this); }
  disconnect() { FakeMutationObserver.active.delete(this); }
  static trigger() {
    for (const observer of [...FakeMutationObserver.active]) observer.callback([], observer);
  }
}

class FakeDocument {
  constructor() {
    this.entries = new Map();
    this.activeElement = null;
    this.documentElement = new FakeElement();
    this.title = "";
  }

  set(selector, elements) { this.entries.set(selector, elements); }
  querySelector(selector) { return this.entries.get(selector)?.[0] ?? null; }
  querySelectorAll(selector) { return this.entries.get(selector) ?? []; }
}

async function sha256(value) {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadAdapter() {
  FakeMutationObserver.active.clear();
  const source = await readFile(new URL("../dist/content/adapter.js", import.meta.url), "utf8");
  const context = {
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    Set,
    Date,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLTextAreaElement: FakeTextAreaElement,
    HTMLInputElement: FakeInputElement,
    HTMLButtonElement: FakeButtonElement,
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    MutationObserver: FakeMutationObserver,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.GuardianContent;
}

function createAsyncSendPage({ enableDelayMs = 25, onEnable } = {}) {
  const document = new FakeDocument();
  const userTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-1" } });
  const assistantTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-assistant-1" } });
  const user = new FakeElement({ textContent: "Complete both stages without asking for more input.", order: 1 });
  const assistant = new FakeElement({
    textContent: "81\n\nStage 1 complete. Say continue for Stage 2.",
    attrs: { "data-message-id": "assistant-1" },
    order: 2,
  });
  user.parent = userTurn;
  assistant.parent = assistantTurn;
  const composer = new FakeTextAreaElement({ value: "", order: 3 });
  let clicks = 0;
  const send = new FakeButtonElement({
    attrs: { "data-testid": "send-button" },
    order: 4,
    onClick: () => {
      clicks += 1;
      const sentTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-2" } });
      const sentUser = new FakeElement({ textContent: composer.value, order: 5 });
      sentUser.parent = sentTurn;
      document.set('[data-message-author-role="user"]', [...document.querySelectorAll('[data-message-author-role="user"]'), sentUser]);
      document.set('button[data-testid="stop-button"]', [
        new FakeButtonElement({ attrs: { "data-testid": "stop-button" }, order: 6 }),
      ]);
    },
  });
  send.disabled = true;
  composer.dispatchEvent = () => {
    setTimeout(() => {
      onEnable?.();
      send.disabled = false;
      FakeMutationObserver.trigger();
    }, enableDelayMs);
    return true;
  };

  document.set('[data-message-author-role="user"]', [user]);
  document.set('[data-message-author-role="assistant"]', [assistant]);
  document.set("#prompt-textarea", [composer]);
  document.set('button[data-testid="send-button"]', [send]);
  return { document, composer, send, assistant, clicks: () => clicks };
}

test("guarded send waits for asynchronously enabled ChatGPT send control", async () => {
  const GuardianContent = await loadAdapter();
  const page = createAsyncSendPage();
  const assistantFingerprint = await sha256(page.assistant.textContent);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(page.document, { pathname: "/c/chat-1" });

  const result = await adapter.guardedSend({
    decisionId: "decision-react-settle",
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint,
    assistantDomMessageId: "assistant-1",
    continuationText: "Continue.",
  });

  assert.equal(page.clicks(), 1);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.observedConversationId, "chat-1");
  assert.equal(result.observedAssistantFingerprint, assistantFingerprint);
});

test("trusted human-state change during post-mutation settle still wins", async () => {
  const GuardianContent = await loadAdapter();
  let humanStateCurrent = true;
  const page = createAsyncSendPage({
    onEnable: () => { humanStateCurrent = false; },
  });
  const assistantFingerprint = await sha256(page.assistant.textContent);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(page.document, { pathname: "/c/chat-1" });

  const result = await adapter.guardedSend({
    decisionId: "decision-human-wins",
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint,
    assistantDomMessageId: "assistant-1",
    continuationText: "Continue.",
  }, () => humanStateCurrent);

  assert.equal(page.clicks(), 0);
  assert.equal(result.status, "AMBIGUOUS");
  assert.match(result.reason, /safety state changed/i);
});

test("content agent suppresses self-observation while guarded DOM transaction is active", async () => {
  const source = await readFile(new URL("../dist/content/index.js", import.meta.url), "utf8");
  let runtimeListener;
  let mutationCallback;
  let resolveGuardedSend;
  const sentMessages = [];

  class StubAdapter {
    currentRouteKey() { return "/c/chat-1"; }
    currentConversationId() { return "chat-1"; }
    async observe() {
      return {
        conversationId: "chat-1",
        routeKey: "/c/chat-1",
        generation: "IDLE",
        composer: { present: true, hasText: true, focused: false },
        blocking: { blocked: false, reasons: [] },
        confidence: "HIGH",
        observedAt: Date.now(),
      };
    }
    guardedSend(expectation) {
      return new Promise((resolve) => {
        resolveGuardedSend = () => resolve({
          decisionId: expectation.decisionId,
          status: "VERIFIED",
          reason: "verified",
          observedConversationId: expectation.conversationId,
          observedAssistantFingerprint: expectation.assistantFingerprint,
        });
      });
    }
    isComposerTarget() { return false; }
    isManualSendTarget() { return false; }
    isStopGenerationTarget() { return false; }
    isEditTurnTarget() { return false; }
    isBlockingInteractionTarget() { return false; }
  }

  const fakeDocument = {
    documentElement: {},
    addEventListener() {},
  };
  const fakeWindow = {
    setTimeout(callback, delay) { return setTimeout(callback, Math.min(delay, 5)); },
    setInterval() { return 1; },
    addEventListener() {},
  };
  class AgentMutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const context = {
    GuardianContent: {
      PROTOCOL_VERSION: 2,
      BrowserChatGPTAdapter: StubAdapter,
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) { runtimeListener = listener; },
        },
        async sendMessage(message) {
          sentMessages.push(structuredClone(message));
          return { type: "background:agent-ack", protocolVersion: 2, accepted: true };
        },
      },
    },
    crypto: webcrypto,
    document: fakeDocument,
    location: { pathname: "/c/chat-1" },
    window: fakeWindow,
    MutationObserver: AgentMutationObserver,
    performance: { now: () => 1 },
    Date,
    Math,
    structuredClone,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const hello = sentMessages.find((message) => message.type === "content:hello");
  assert.ok(hello);
  sentMessages.length = 0;

  const guardedResult = new Promise((resolve) => {
    const keepChannel = runtimeListener({
      type: "background:guarded-send",
      protocolVersion: 2,
      action: "CONTINUATION",
      decisionId: "decision-agent-transaction",
      agentInstanceId: hello.agentInstanceId,
      pageEpoch: 1,
      conversationId: "chat-1",
      routeKey: "/c/chat-1",
      assistantFingerprint: "a".repeat(64),
      continuationText: "Continue.",
      expiresAt: Date.now() + 60_000,
    }, {}, resolve);
    assert.equal(keepChannel, true);
  });

  while (resolveGuardedSend === undefined) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  mutationCallback();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sentMessages.some((message) => message.type === "content:observation"), false);

  resolveGuardedSend();
  const result = await guardedResult;
  assert.equal(result.status, "VERIFIED");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sentMessages.filter((message) => message.type === "content:observation").length, 1);
});
