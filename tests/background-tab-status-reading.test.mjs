import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const AMBIGUOUS_REASON = "The intended user turn and generation start could not both be verified.";
const STATUS = 'CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"HOLD_HUMAN_OPERATION"}';
const PROTOCOL_PROMPT = [
  "[Chat Turn Guardian — Conversation Status Protocol]",
  "",
  "Purpose",
  "This protocol must not change the current task.",
].join("\n");

class FakeNode {
  static DOCUMENT_POSITION_DISCONNECTED = 1;
  static DOCUMENT_POSITION_FOLLOWING = 4;
  constructor(order = 0) { this.order = order; }
  compareDocumentPosition(other) {
    return this.order < other.order ? FakeNode.DOCUMENT_POSITION_FOLLOWING : 0;
  }
}

class FakeElement extends FakeNode {
  constructor({ textContent = "", innerText = textContent, attrs = {}, order = 0, code = false } = {}) {
    super(order);
    this.textContent = textContent;
    this.innerText = innerText;
    this.attrs = new Map(Object.entries(attrs));
    this.code = code;
    this.parent = null;
  }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
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
    if (selector === "pre, code" && this.code) return [this];
    return [];
  }
}

class FakeDocument {
  constructor({ visibilityState = "hidden", users = [], assistants = [] } = {}) {
    this.visibilityState = visibilityState;
    this.users = users;
    this.assistants = assistants;
  }
  querySelectorAll(selector) {
    if (selector === '[data-message-author-role="user"]' || selector === 'article[data-turn="user"]') return this.users;
    if (selector === '[data-message-author-role="assistant"]' || selector === 'article[data-turn="assistant"]') return this.assistants;
    return [];
  }
}

function normalizeAssistantText(value) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fingerprintText(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadPatch({ document, observation }) {
  class FakeAdapter {
    currentConversationId() { return "chat-1"; }
    currentRouteKey() { return "/c/chat-1"; }
    async observe() { return structuredClone(observation); }
    async guardedSend(expectation) {
      return { decisionId: expectation.decisionId, status: "AMBIGUOUS", reason: AMBIGUOUS_REASON };
    }
  }

  const context = {
    GuardianContent: {
      BrowserChatGPTAdapter: FakeAdapter,
      normalizeAssistantText,
      fingerprintText,
    },
    document,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    Date,
    Set,
  };
  const source = await readFile(new URL("../dist/content/send-verification.js", import.meta.url), "utf8");
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.GuardianContent.BrowserChatGPTAdapter;
}

function baseObservation() {
  return {
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    generation: "IDLE",
    confidence: "HIGH",
    composer: { present: true, hasText: false, focused: false },
    blocking: { blocked: false, reasons: [] },
    latestUser: {
      normalizedText: "stale rendered user text",
      textLength: 24,
      domMessageId: "user-after",
    },
    latestAssistant: {
      normalizedText: "stale rendered assistant text",
      textLength: 29,
      fingerprint: "b".repeat(64),
      domMessageId: "assistant-after",
    },
    observedAt: 123,
  };
}

function conversationDom({ assistantCode = false } = {}) {
  const userTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-after" } });
  const assistantTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-assistant-after" } });
  const user = new FakeElement({
    textContent: PROTOCOL_PROMPT.replace(/\s+/g, ""),
    innerText: "stale layout user text",
    attrs: { "data-message-id": "user-after" },
    order: 2,
  });
  const assistant = new FakeElement({
    textContent: STATUS,
    innerText: "stale layout assistant text",
    attrs: { "data-message-id": "assistant-after" },
    order: 3,
    code: assistantCode,
  });
  user.parent = userTurn;
  assistant.parent = assistantTurn;
  return { user, assistant };
}

test("hidden-tab observation recovers a terminal HOLD status from structural DOM text", async () => {
  const { user, assistant } = conversationDom();
  const document = new FakeDocument({ users: [user], assistants: [assistant] });
  const Adapter = await loadPatch({ document, observation: baseObservation() });
  const result = await new Adapter().observe(123);

  assert.equal(result.latestAssistant.normalizedText, STATUS);
  assert.equal(result.latestAssistant.domMessageId, "assistant-after");
  assert.equal(result.latestAssistant.fingerprint, await fingerprintText(STATUS));
});

test("hidden-tab guarded send verifies the exact Guardian turn despite stale innerText", async () => {
  const { user, assistant } = conversationDom();
  const document = new FakeDocument({ users: [user], assistants: [assistant] });
  const Adapter = await loadPatch({ document, observation: baseObservation() });
  const adapter = new Adapter();
  const result = await adapter.guardedSend({
    decisionId: "decision-hidden",
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint: "a".repeat(64),
    assistantDomMessageId: "assistant-before",
    continuationText: PROTOCOL_PROMPT,
  }, () => true);

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.observedConversationId, "chat-1");
  assert.equal(result.observedAssistantFingerprint, "a".repeat(64));
  assert.match(result.reason, /background-safe DOM evidence/);
});

test("a Guardian marker inside code is never repaired into a terminal hidden-tab status", async () => {
  const { user, assistant } = conversationDom({ assistantCode: true });
  const document = new FakeDocument({ users: [user], assistants: [assistant] });
  const observation = baseObservation();
  const Adapter = await loadPatch({ document, observation });
  const result = await new Adapter().observe(123);

  assert.equal(result.latestAssistant.normalizedText, observation.latestAssistant.normalizedText);
  assert.equal(result.latestAssistant.fingerprint, observation.latestAssistant.fingerprint);
});

test("visible-tab observation keeps the existing rendered-text behavior unchanged", async () => {
  const { user, assistant } = conversationDom();
  const document = new FakeDocument({ visibilityState: "visible", users: [user], assistants: [assistant] });
  const observation = baseObservation();
  const Adapter = await loadPatch({ document, observation });
  const result = await new Adapter().observe(123);

  assert.equal(result.latestAssistant.normalizedText, observation.latestAssistant.normalizedText);
  assert.equal(result.latestAssistant.fingerprint, observation.latestAssistant.fingerprint);
});
