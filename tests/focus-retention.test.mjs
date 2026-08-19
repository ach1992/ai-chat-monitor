import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { AutomationCoordinator } from "../dist/automation/coordinator.js";

class FakeClock {
  #now = 1_000;
  #nextId = 1;
  #timers = new Map();
  now() { return this.#now; }
  setTimeout(callback, delayMs) {
    const id = this.#nextId++;
    this.#timers.set(id, { due: this.#now + delayMs, callback });
    return id;
  }
  clearTimeout(id) { this.#timers.delete(id); }
  advance(ms) {
    this.#now += ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.due <= this.#now)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0]);
      if (due.length === 0) return;
      const [id, timer] = due[0];
      this.#timers.delete(id);
      timer.callback();
    }
  }
}

function focusedSession() {
  return {
    tabId: 7,
    documentId: "doc-1",
    agentInstanceId: "agent-1",
    pageEpoch: 1,
    lastSequence: 4,
    routeKey: "/c/chat-1",
    conversationId: "chat-1",
    registeredAt: 100,
    lastSeenAt: 200,
    lastUserInteractionAt: 150,
    controlEligibility: "OWNER",
    observation: {
      conversationId: "chat-1",
      routeKey: "/c/chat-1",
      generation: "IDLE",
      latestUser: {
        normalizedText: "Finish the remaining safe work.",
        textLength: 31,
        domMessageId: "user-1",
      },
      latestAssistant: {
        normalizedText: "I can continue without further input.",
        textLength: 37,
        fingerprint: "a".repeat(64),
        domMessageId: "assistant-1",
      },
      composer: { present: true, hasText: false, focused: true },
      blocking: { blocked: false, reasons: [] },
      confidence: "HIGH",
      observedAt: 200,
    },
  };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("retained empty composer focus does not block OBSERVE classification", async () => {
  const clock = new FakeClock();
  const session = focusedSession();
  const classifyCalls = [];
  const coordinator = new AutomationCoordinator({
    policies: {
      resolve: (conversationId) => ({
        conversationId,
        revision: 1,
        mode: "OBSERVE",
        emergencyPaused: false,
        continuationText: "Continue.",
        timing: { settleDelayMs: 10, continueDelayMs: 20, cooldownMs: 30 },
      }),
    },
    journal: {
      hasGuard: () => false,
      reserve: async () => true,
      releaseNotStarted: async () => undefined,
      mark: async () => undefined,
    },
    sessions: { getTab: () => session },
    classifier: {
      classify: async (input) => {
        classifyCalls.push(structuredClone(input));
        return {
          decision: "CONTINUE",
          reasonCode: "NEEDLESS_TURN_BOUNDARY",
          reason: "Safe to continue.",
          source: "PROVIDER",
          confidence: 0.99,
          providerId: "test",
        };
      },
    },
    sender: { send: async () => { throw new Error("OBSERVE must not send"); } },
    clock,
  });

  coordinator.handleSession(session);
  clock.advance(10);
  await flushAsync();

  assert.equal(classifyCalls.length, 1);
  assert.equal(coordinator.status(7)?.phase, "OBSERVING");
});

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
    if (selector === 'button[data-testid="send-button"]') return this.getAttribute("data-testid") === "send-button";
    if (selector === 'button[data-testid="stop-button"]') return this.getAttribute("data-testid") === "stop-button";
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
class FakeButtonElement extends FakeElement { disabled = false; }
class FakeEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
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
    this.title = "Test chat";
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

test("guarded send accepts retained empty focus while preserving the other final guards", async () => {
  const GuardianContent = await loadAdapter();
  const document = new FakeDocument();
  const userTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-1" } });
  const assistantTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-assistant-1" } });
  const user = new FakeElement({ textContent: "Continue safely.", order: 1 });
  const assistant = new FakeElement({ textContent: "I can keep working.", attrs: { "data-message-id": "assistant-1" }, order: 2 });
  user.parent = userTurn;
  assistant.parent = assistantTurn;
  const composer = new FakeTextAreaElement({ value: "", order: 3 });
  const send = new FakeButtonElement({
    attrs: { "data-testid": "send-button" },
    order: 4,
    onClick: () => {
      const sentTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-2" } });
      const sentUser = new FakeElement({ textContent: composer.value, order: 5 });
      sentUser.parent = sentTurn;
      document.set('[data-message-author-role="user"]', [user, sentUser]);
      document.set('button[data-testid="stop-button"]', [
        new FakeButtonElement({ attrs: { "data-testid": "stop-button" }, order: 6 }),
      ]);
    },
  });
  document.set('[data-message-author-role="user"]', [user]);
  document.set('[data-message-author-role="assistant"]', [assistant]);
  document.set("#prompt-textarea", [composer]);
  document.set('button[data-testid="send-button"]', [send]);
  document.activeElement = composer;

  const assistantFingerprint = await sha256(assistant.textContent);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/chat-1" });
  const result = await adapter.guardedSend({
    decisionId: "decision-focused",
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint,
    assistantDomMessageId: "assistant-1",
    continuationText: "Continue.",
  });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.observedConversationId, "chat-1");
  assert.equal(result.observedAssistantFingerprint, assistantFingerprint);
});
