import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { DEFAULT_CONVERSATION_PROTOCOL_PROMPT } from "../dist/classification/conversation-protocol.js";

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
  constructor({ textContent = "", attrs = {}, value = "", order = 0, onClick, tagName = "DIV" } = {}) {
    super();
    this.textContent = textContent;
    this.childNodes = [];
    this.attrs = new Map(Object.entries(attrs));
    this.value = value;
    this.order = order;
    this.onClick = onClick;
    this.tagName = tagName;
    this.isContentEditable = false;
  }

  get innerText() {
    if (this.childNodes.length === 0) return this.textContent;
    return this.childNodes.map((node) => node.tagName === "BR" ? "\n" : node.textContent).join("");
  }

  replaceChildren(...nodes) {
    this.childNodes = nodes.length === 1 && Array.isArray(nodes[0]?.childNodes)
      ? [...nodes[0].childNodes]
      : [...nodes];
    this.textContent = this.childNodes.map((node) => node.textContent ?? "").join("");
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
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() {}
}

class FakeDocument {
  constructor() {
    this.entries = new Map();
    this.activeElement = null;
    this.documentElement = new FakeElement();
  }

  set(selector, elements) {
    for (const element of elements) element.ownerDocument = this;
    this.entries.set(selector, elements);
  }
  querySelector(selector) { return this.entries.get(selector)?.[0] ?? null; }
  querySelectorAll(selector) { return this.entries.get(selector) ?? []; }
  createDocumentFragment() {
    return { childNodes: [], append(node) { this.childNodes.push(node); } };
  }
  createElement(tagName) {
    const element = new FakeElement({ tagName: tagName.toUpperCase() });
    element.ownerDocument = this;
    return element;
  }
  createTextNode(textContent) { return { textContent, ownerDocument: this }; }
}

async function sha256(value) {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadAdapter(crypto = webcrypto) {
  const source = await readFile(new URL("../dist/content/adapter.js", import.meta.url), "utf8");
  const context = {
    crypto,
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

function createSafePage({ onSend, sendInitiallyDisabled = false, contentEditable = false } = {}) {
  const document = new FakeDocument();
  const userTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-1" } });
  const assistantTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-assistant-1" } });
  const user = new FakeElement({ textContent: "Continue the implementation safely.", order: 1 });
  const assistant = new FakeElement({
    textContent: "I still have bounded implementation work I can perform.",
    attrs: { "data-message-id": "assistant-1" },
    order: 2,
  });
  user.parent = userTurn;
  assistant.parent = assistantTurn;
  const composer = contentEditable
    ? new FakeElement({ textContent: "", order: 3 })
    : new FakeTextAreaElement({ value: "", order: 3 });
  composer.isContentEditable = contentEditable;
  const send = new FakeButtonElement({
    attrs: { "data-testid": "send-button" },
    order: 4,
    onClick: () => onSend?.({ document, composer }),
  });
  send.disabled = sendInitiallyDisabled;
  if (sendInitiallyDisabled) {
    composer.dispatchEvent = () => {
      send.disabled = false;
      return true;
    };
  }

  document.set('[data-message-author-role="user"]', [user]);
  document.set('[data-message-author-role="assistant"]', [assistant]);
  document.set("#prompt-textarea", [composer]);
  document.set('button[data-testid="send-button"]', [send]);
  return { document, composer, send, assistant };
}

test("guarded send rejects human typing that occurs during the final assistant fingerprint await", async () => {
  let digestCall = 0;
  let releaseSecondDigest;
  const controlledCrypto = {
    subtle: {
      digest(algorithm, data) {
        digestCall += 1;
        if (digestCall !== 2) return webcrypto.subtle.digest(algorithm, data);
        return new Promise((resolve, reject) => {
          releaseSecondDigest = () => {
            webcrypto.subtle.digest(algorithm, data).then(resolve, reject);
          };
        });
      },
    },
  };
  const GuardianContent = await loadAdapter(controlledCrypto);
  let clicks = 0;
  const page = createSafePage({ onSend: () => { clicks += 1; } });
  const assistantFingerprint = await sha256(page.assistant.textContent);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(page.document, { pathname: "/c/chat-1" });

  const resultPromise = adapter.guardedSend({
    decisionId: "decision-race",
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint,
    assistantDomMessageId: "assistant-1",
    continuationText: "Continue.",
  });

  while (releaseSecondDigest === undefined) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  page.composer.value = "Human typing wins";
  releaseSecondDigest();
  const result = await resultPromise;

  assert.equal(result.status, "NOT_STARTED");
  assert.match(result.reason, /synchronous pre-mutation revalidation/i);
  assert.equal(page.composer.value, "Human typing wins");
  assert.equal(clicks, 0);
});

test("guarded send can activate a send control that is disabled while the composer is empty", async () => {
  const GuardianContent = await loadAdapter();
  let clicks = 0;
  const page = createSafePage({
    sendInitiallyDisabled: true,
    onSend: ({ document, composer }) => {
      clicks += 1;
      const sentTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-2" } });
      const sentUser = new FakeElement({ textContent: composer.value, order: 5 });
      sentUser.parent = sentTurn;
      const existingUsers = document.querySelectorAll('[data-message-author-role="user"]');
      document.set('[data-message-author-role="user"]', [...existingUsers, sentUser]);
      document.set('button[data-testid="stop-button"]', [
        new FakeButtonElement({ attrs: { "data-testid": "stop-button" }, order: 6 }),
      ]);
    },
  });
  const assistantFingerprint = await sha256(page.assistant.textContent);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(page.document, { pathname: "/c/chat-1" });

  const result = await adapter.guardedSend({
    decisionId: "decision-verified",
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint,
    assistantDomMessageId: "assistant-1",
    continuationText: "Continue.",
  });

  assert.equal(clicks, 1);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.observedConversationId, "chat-1");
  assert.equal(result.observedAssistantFingerprint, assistantFingerprint);
});

test("guarded send preserves the exact multiline protocol layout in a contenteditable composer", async () => {
  const GuardianContent = await loadAdapter();
  let sentText;
  const page = createSafePage({
    contentEditable: true,
    onSend: ({ document, composer }) => {
      sentText = composer.innerText;
      const sentTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-2" } });
      const sentUser = new FakeElement({ textContent: sentText, order: 5 });
      sentUser.parent = sentTurn;
      document.set('[data-message-author-role="user"]', [
        ...document.querySelectorAll('[data-message-author-role="user"]'),
        sentUser,
      ]);
      document.set('button[data-testid="stop-button"]', [
        new FakeButtonElement({ attrs: { "data-testid": "stop-button" }, order: 6 }),
      ]);
    },
  });
  const assistantFingerprint = await sha256(page.assistant.textContent);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(page.document, { pathname: "/c/chat-1" });

  const result = await adapter.guardedSend({
    purpose: "PROTOCOL_BOOTSTRAP",
    decisionId: "decision-multiline-protocol",
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint,
    assistantDomMessageId: "assistant-1",
    continuationText: DEFAULT_CONVERSATION_PROTOCOL_PROMPT,
  });

  assert.equal(result.status, "VERIFIED");
  assert.equal(sentText, DEFAULT_CONVERSATION_PROTOCOL_PROMPT);
  assert.match(sentText, /\n\nPurpose\n/);
  assert.match(sentText, /\n\nFuture replies\n/);
  assert.match(sentText, /\n\nValues\n/);
});

test("protocol bootstrap may use a safe composer during a recoverable delivery error without clicking Retry", async () => {
  const GuardianContent = await loadAdapter();
  let clicks = 0;
  const page = createSafePage({
    onSend: ({ document, composer }) => {
      clicks += 1;
      const sentTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-2" } });
      const sentUser = new FakeElement({ textContent: composer.value, order: 5 });
      sentUser.parent = sentTurn;
      document.set('[data-message-author-role="user"]', [
        ...document.querySelectorAll('[data-message-author-role="user"]'),
        sentUser,
      ]);
      document.set('button[data-testid="stop-button"]', [
        new FakeButtonElement({ attrs: { "data-testid": "stop-button" }, order: 6 }),
      ]);
    },
  });
  page.document.set('[role="alert"]', [
    new FakeElement({ textContent: "Message delivery timed out", attrs: { role: "alert" }, order: 5 }),
  ]);
  const assistantFingerprint = await sha256(page.assistant.textContent);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(page.document, { pathname: "/c/chat-1" });

  const result = await adapter.guardedSend({
    purpose: "PROTOCOL_BOOTSTRAP",
    decisionId: "protocol-recovery",
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint,
    assistantDomMessageId: "assistant-1",
    continuationText: "Classify this stop only.",
  });

  assert.equal(clicks, 1);
  assert.equal(result.status, "VERIFIED");
});
