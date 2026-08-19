import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

class FakeNode {
  static DOCUMENT_POSITION_FOLLOWING = 4;
  contains(node) { return node === this; }
  compareDocumentPosition() { return 0; }
}

class FakeElement extends FakeNode {
  constructor({ textContent = "", value = "", attrs = {} } = {}) {
    super();
    this.textContent = textContent;
    this.value = value;
    this.attrs = new Map(Object.entries(attrs));
    this.isContentEditable = false;
  }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  closest() { return null; }
  matches() { return false; }
  dispatchEvent() { return true; }
}

class FakeTextAreaElement extends FakeElement {}
class FakeInputElement extends FakeElement {}
class FakeButtonElement extends FakeElement { disabled = false; }
class FakeEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
class FakeInputEvent extends FakeEvent {}
class FakeMutationObserver { observe() {} disconnect() {} }

class FakeDocument {
  constructor() {
    this.entries = new Map();
    this.documentElement = new FakeElement();
    this.activeElement = null;
    this.title = "Guarded chat";
  }
  set(selector, elements) { this.entries.set(selector, elements); }
  querySelector(selector) { return this.entries.get(selector)?.[0] ?? null; }
  querySelectorAll(selector) { return this.entries.get(selector) ?? []; }
}

async function loadAdapter() {
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

async function sha256(value) {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("guarded send fails before mutation when trusted local human state changed", async () => {
  const GuardianContent = await loadAdapter();
  const document = new FakeDocument();
  const assistant = new FakeElement({
    textContent: "I can continue.",
    attrs: { "data-message-id": "assistant-1" },
  });
  const composer = new FakeTextAreaElement({ value: "" });
  document.set('[data-message-author-role="assistant"]', [assistant]);
  document.set("#prompt-textarea", [composer]);
  document.activeElement = composer;

  const assistantFingerprint = await sha256(assistant.textContent);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/chat-1" });
  const result = await adapter.guardedSend({
    decisionId: "decision-human-change",
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint,
    assistantDomMessageId: "assistant-1",
    continuationText: "Continue.",
  }, () => false);

  assert.equal(result.status, "NOT_STARTED");
  assert.match(result.reason, /human interaction|human state|guard/i);
  assert.equal(composer.value, "");
});
