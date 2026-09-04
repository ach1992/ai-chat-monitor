import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const CANONICAL_STATUS = 'AI_CHAT_MONITOR_STATUS={"decision":"HOLD_HUMAN_OPERATION"}';
const RETIRED_STATUS = 'CHAT_TURN_GUARDIAN_STATUS={"decision":"HOLD_HUMAN_OPERATION"}';

class FakeNode {
  static DOCUMENT_POSITION_DISCONNECTED = 1;
  static DOCUMENT_POSITION_FOLLOWING = 4;
  constructor(order = 0) { this.order = order; }
  contains(node) { return node === this; }
  compareDocumentPosition(other) { return this.order < other.order ? FakeNode.DOCUMENT_POSITION_FOLLOWING : 0; }
}

class FakeElement extends FakeNode {
  constructor({ textContent = "", innerText = textContent, attrs = {}, order = 0, codeText } = {}) {
    super(order);
    this.textContent = textContent;
    this.innerText = innerText;
    this.attrs = new Map(Object.entries(attrs));
    this.parent = null;
    this.codeText = codeText;
  }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  matches() { return false; }
  closest(selector) {
    let current = this;
    while (current) {
      const testId = current.getAttribute?.("data-testid") ?? "";
      if (selector === '[data-testid^="conversation-turn-"]' && testId.startsWith("conversation-turn-")) return current;
      current = current.parent;
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector !== "pre, code" || this.codeText === undefined) return [];
    return [new FakeElement({ textContent: this.codeText, innerText: this.codeText })];
  }
}

class FakeTextAreaElement extends FakeElement { constructor(options = {}) { super(options); this.value = options.value ?? ""; } }
class FakeInputElement extends FakeElement { constructor(options = {}) { super(options); this.value = options.value ?? ""; } }

class FakeDocument {
  constructor({ assistant, composer, stop, visibilityState = "hidden" }) {
    this.assistant = assistant;
    this.composer = composer;
    this.stop = stop;
    this.visibilityState = visibilityState;
    this.activeElement = null;
    this.title = "Background chat";
  }
  querySelector(selector) {
    if (selector === "#prompt-textarea") return this.composer;
    if (selector === 'button[data-testid="stop-button"]') return this.stop ?? null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '[data-message-author-role="assistant"]') return [this.assistant];
    if (selector === 'article[data-turn="assistant"]') return [];
    if (selector === '[data-message-author-role="user"]' || selector === 'article[data-turn="user"]' || selector === "button") return [];
    return [];
  }
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
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.GuardianContent;
}

function makeDom(structuralStatus, { code = false, stop = false, visibilityState = "hidden" } = {}) {
  const turn = new FakeElement({ attrs: { "data-testid": "conversation-turn-assistant-bg" } });
  const assistant = new FakeElement({
    textContent: `Finished.\n${structuralStatus}`,
    innerText: "stale rendered assistant text",
    attrs: { "data-message-id": "assistant-bg" },
    order: 2,
    ...(code ? { codeText: structuralStatus } : {}),
  });
  assistant.parent = turn;
  return new FakeDocument({
    assistant,
    composer: new FakeTextAreaElement({ value: "" }),
    ...(stop ? { stop: new FakeElement({ attrs: { "data-testid": "stop-button" } }) } : {}),
    visibilityState,
  });
}

test("background-safe structural reading recovers canonical terminal status", async () => {
  const GuardianContent = await loadAdapter();
  const adapter = new GuardianContent.BrowserChatGPTAdapter(makeDom(CANONICAL_STATUS), { pathname: "/c/chat-bg" });
  const result = await adapter.observe(123);
  assert.equal(result.latestAssistant.normalizedText, `Finished.\n${CANONICAL_STATUS}`);
  assert.equal(result.latestAssistant.domMessageId, "assistant-bg");
});


test("canonical terminal status outranks a stale Stop control only while hidden", async () => {
  const GuardianContent = await loadAdapter();
  const hiddenAdapter = new GuardianContent.BrowserChatGPTAdapter(
    makeDom(CANONICAL_STATUS, { stop: true, visibilityState: "hidden" }),
    { pathname: "/c/chat-bg" },
  );
  const visibleAdapter = new GuardianContent.BrowserChatGPTAdapter(
    makeDom(CANONICAL_STATUS, { stop: true, visibilityState: "visible" }),
    { pathname: "/c/chat-bg" },
  );

  assert.equal((await hiddenAdapter.observe(123)).generation, "IDLE");
  assert.equal((await visibleAdapter.observe(123)).generation, "GENERATING");
});


test("malformed or code-rendered status never overrides a hidden Stop control", async () => {
  const GuardianContent = await loadAdapter();
  const malformed = new GuardianContent.BrowserChatGPTAdapter(
    makeDom('AI_CHAT_MONITOR_STATUS={"decision":"NOT_A_REAL_STATE"}', { stop: true }),
    { pathname: "/c/chat-bg" },
  );
  const codeRendered = new GuardianContent.BrowserChatGPTAdapter(
    makeDom(CANONICAL_STATUS, { stop: true, code: true }),
    { pathname: "/c/chat-bg" },
  );
  const duplicate = new GuardianContent.BrowserChatGPTAdapter(
    makeDom(`${CANONICAL_STATUS}\n${CANONICAL_STATUS}`, { stop: true }),
    { pathname: "/c/chat-bg" },
  );

  assert.equal((await malformed.observe(123)).generation, "GENERATING");
  assert.equal((await codeRendered.observe(123)).generation, "GENERATING");
  assert.equal((await duplicate.observe(123)).generation, "GENERATING");
});



test("background structural reading replaces a flattened rendered status prefix", async () => {
  const GuardianContent = await loadAdapter();
  const document = makeDom(CANONICAL_STATUS);
  document.assistant.innerText = `Finished. ${CANONICAL_STATUS}`;
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/chat-bg" });
  const result = await adapter.observe(123);
  assert.equal(result.latestAssistant.normalizedText, `Finished.\n${CANONICAL_STATUS}`);
});

test("background structural recovery restores a terminal line when textContent concatenates blocks", async () => {
  const GuardianContent = await loadAdapter();
  const document = makeDom(CANONICAL_STATUS);
  document.assistant.textContent = `Finished.${CANONICAL_STATUS}`;
  document.assistant.innerText = `Finished. ${CANONICAL_STATUS}`;
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/chat-bg" });
  const result = await adapter.observe(123);
  assert.equal(result.latestAssistant.normalizedText, `Finished.\n${CANONICAL_STATUS}`);
});

test("retired marker does not trigger background structural recovery", async () => {
  const GuardianContent = await loadAdapter();
  const adapter = new GuardianContent.BrowserChatGPTAdapter(makeDom(RETIRED_STATUS), { pathname: "/c/chat-bg" });
  const result = await adapter.observe(123);
  assert.equal(result.latestAssistant.normalizedText, "stale rendered assistant text");
});

test("status structurally rendered inside code is marked non-terminal for the parser", async () => {
  const GuardianContent = await loadAdapter();
  const adapter = new GuardianContent.BrowserChatGPTAdapter(makeDom(CANONICAL_STATUS, { code: true }), { pathname: "/c/chat-bg" });
  const result = await adapter.observe(123);
  assert.match(result.latestAssistant.normalizedText, /AI Chat Monitor status rendered inside a code block\]$/);
});
