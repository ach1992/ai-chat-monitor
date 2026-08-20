import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { AutomationCoordinator } from "../dist/automation/coordinator.js";
import { ConservativeStopClassifier } from "../dist/classification/classifier.js";

class FakeNode {
  static DOCUMENT_POSITION_DISCONNECTED = 1;
  static DOCUMENT_POSITION_PRECEDING = 2;
  static DOCUMENT_POSITION_FOLLOWING = 4;
  parent = null;
  order = 0;

  contains(node) {
    return node === this;
  }

  compareDocumentPosition(node) {
    if (this.order < node.order) return FakeNode.DOCUMENT_POSITION_FOLLOWING;
    if (this.order > node.order) return FakeNode.DOCUMENT_POSITION_PRECEDING;
    return 0;
  }
}

class FakeElement extends FakeNode {
  constructor({ textContent = "", attrs = {}, value = "", order = 0 } = {}) {
    super();
    this.textContent = textContent;
    this.attrs = new Map(Object.entries(attrs));
    this.value = value;
    this.order = order;
    this.clickCount = 0;
    this.disabled = false;
  }

  getAttribute(name) {
    return this.attrs.get(name) ?? null;
  }

  matches(selector) {
    if (selector === 'button[data-testid="send-button"]') {
      return this.getAttribute("data-testid") === "send-button";
    }
    if (selector === 'button[data-testid="stop-button"]') {
      return this.getAttribute("data-testid") === "stop-button";
    }
    if (selector.startsWith("button[aria-label")) {
      const label = (this.getAttribute("aria-label") ?? "").toLowerCase();
      if (selector.toLowerCase().includes("send")) return label.includes("send");
      if (selector.toLowerCase().includes("stop")) return label.includes("stop");
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

  click() {
    this.clickCount += 1;
  }
}

class FakeTextAreaElement extends FakeElement {}
class FakeInputElement extends FakeElement {}
class FakeButtonElement extends FakeElement {}

class FakeDocument {
  constructor(entries = []) {
    this.entries = entries;
    this.activeElement = null;
    this.title = "";
    this.documentElement = new FakeElement();
  }

  querySelector(selector) {
    return this.entries.find(([candidate]) => candidate === selector)?.[1]?.[0] ?? null;
  }

  querySelectorAll(selector) {
    return this.entries.find(([candidate]) => candidate === selector)?.[1] ?? [];
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
    HTMLButtonElement: FakeButtonElement,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.GuardianContent;
}

function attachToTurn(element, id) {
  const turn = new FakeElement({ attrs: { "data-testid": `conversation-turn-${id}` } });
  element.parent = turn;
  return element;
}

function coordinatorSession({ latestAssistant = true, blocked = false } = {}) {
  const user = "Please continue the safe work.";
  const assistant = "I can continue without human input.";
  return {
    tabId: 71,
    documentId: "doc-rev7",
    agentInstanceId: "agent-rev7",
    pageEpoch: 1,
    lastSequence: 7,
    routeKey: "/c/rev7-chat",
    conversationId: "rev7-chat",
    registeredAt: 100,
    lastSeenAt: 200,
    controlEligibility: "OWNER",
    observation: {
      conversationId: "rev7-chat",
      routeKey: "/c/rev7-chat",
      generation: "IDLE",
      latestUser: {
        normalizedText: user,
        textLength: user.length,
        domMessageId: "user-rev7",
      },
      ...(latestAssistant ? {
        latestAssistant: {
          normalizedText: assistant,
          textLength: assistant.length,
          fingerprint: "a".repeat(64),
          domMessageId: "assistant-rev7",
        },
      } : {}),
      composer: { present: true, hasText: false, focused: false },
      blocking: { blocked, reasons: blocked ? ["ERROR"] : [] },
      confidence: "HIGH",
      observedAt: 200,
    },
  };
}

function coordinatorHarness(session, { inChatSelfCheck = false } = {}) {
  let classifyCalls = 0;
  let sendCalls = 0;
  const reserved = new Set();
  const coordinator = new AutomationCoordinator({
    policies: {
      resolve(conversationId) {
        return {
          conversationId,
          revision: 7,
          mode: "AUTO",
          emergencyPaused: false,
          continuationText: "Continue.",
          timing: { settleDelayMs: 1, continueDelayMs: 1, cooldownMs: 1 },
        };
      },
    },
    journal: {
      hasGuard() { return false; },
      async reserve(envelope) {
        if (reserved.has(envelope.decisionId)) return false;
        reserved.add(envelope.decisionId);
        return true;
      },
      async releaseNotStarted(decisionId) { reserved.delete(decisionId); },
      async mark() {},
    },
    sessions: { getTab: () => session },
    classifier: {
      ...(inChatSelfCheck ? { classifyDeterministic() { return undefined; } } : {}),
      async classify() {
        classifyCalls += 1;
        return {
          decision: "CONTINUE",
          reasonCode: "NEEDLESS_TURN_BOUNDARY",
          reason: "Test provider says continue.",
          source: "PROVIDER",
          confidence: 0.99,
          providerId: "test-provider",
        };
      },
    },
    sender: {
      async send(envelope) {
        sendCalls += 1;
        return {
          decisionId: envelope.decisionId,
          status: "VERIFIED",
          reason: "Unexpected test send.",
          observedConversationId: envelope.conversationId,
          observedAssistantFingerprint: envelope.assistantFingerprint,
        };
      },
    },
  });
  return {
    coordinator,
    classifyCalls: () => classifyCalls,
    sendCalls: () => sendCalls,
  };
}

test("I1 silent terminal does not expose an older assistant after a newer user turn", async () => {
  const GuardianContent = await loadAdapter();
  const oldUser = attachToTurn(new FakeElement({ textContent: "Earlier request", order: 1 }), "user-old");
  const oldAssistant = attachToTurn(new FakeElement({ textContent: "Earlier answer", order: 2 }), "assistant-old");
  const currentUser = attachToTurn(new FakeElement({ textContent: "Run the next step", order: 3 }), "user-current");
  const composer = new FakeTextAreaElement({ value: "", order: 4 });
  const document = new FakeDocument([
    ['[data-message-author-role="user"]', [oldUser, currentUser]],
    ['[data-message-author-role="assistant"]', [oldAssistant]],
    ["#prompt-textarea", [composer]],
  ]);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/rev7-chat" });
  const observation = await adapter.observe(1_000);

  assert.equal(observation.generation, "IDLE");
  assert.equal(observation.confidence, "HIGH");
  assert.equal(observation.latestAssistant, undefined);
  assert.equal(observation.latestUser, undefined);

  const harness = coordinatorHarness({
    ...coordinatorSession({ latestAssistant: false }),
    observation: {
      ...coordinatorSession({ latestAssistant: false }).observation,
      latestUser: undefined,
    },
  });
  harness.coordinator.handleSession({
    ...coordinatorSession({ latestAssistant: false }),
    observation,
    tabId: 71,
    documentId: "doc-rev7",
    agentInstanceId: "agent-rev7",
    pageEpoch: 1,
    lastSequence: 7,
    routeKey: "/c/rev7-chat",
    conversationId: "rev7-chat",
    registeredAt: 100,
    lastSeenAt: 200,
    controlEligibility: "OWNER",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.classifyCalls(), 0);
  assert.equal(harness.sendCalls(), 0);
  assert.equal(harness.coordinator.status(71).phase, "IDLE");
});

test("I2 red Retry never clicks Retry and allows only one guarded self-check probe", async () => {
  const GuardianContent = await loadAdapter();
  const user = attachToTurn(new FakeElement({ textContent: "Do the next step", order: 1 }), "user-1");
  const assistant = attachToTurn(new FakeElement({ textContent: "Partial result", order: 2 }), "assistant-1");
  const composer = new FakeTextAreaElement({ value: "", order: 3 });
  const sendButton = new FakeButtonElement({ attrs: { "data-testid": "send-button", "aria-label": "Send prompt" }, order: 4 });
  const retryButton = new FakeButtonElement({ attrs: { "aria-label": "Retry" }, order: 5 });
  const error = new FakeElement({
    textContent: "There was an error generating a response. Retry",
    attrs: { role: "alert", "data-testid": "conversation-turn-error" },
    order: 6,
  });
  const document = new FakeDocument([
    ['[data-message-author-role="user"]', [user]],
    ['[data-message-author-role="assistant"]', [assistant]],
    ["#prompt-textarea", [composer]],
    ['button[data-testid="send-button"]', [sendButton]],
    ['[role="alert"]', [error]],
    ['[data-testid*="error"]', [error]],
  ]);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/rev7-chat" });
  const observation = await adapter.observe(2_000);

  assert.equal(observation.blocking.blocked, true);
  assert.equal(observation.blocking.reasons.includes("ERROR"), true);

  const blockedHarness = coordinatorHarness({
    ...coordinatorSession({ blocked: true }),
    observation,
  }, { inChatSelfCheck: true });
  blockedHarness.coordinator.handleSession({
    ...coordinatorSession({ blocked: true }),
    observation,
    tabId: 71,
    documentId: "doc-rev7",
    agentInstanceId: "agent-rev7",
    pageEpoch: 1,
    lastSequence: 7,
    routeKey: "/c/rev7-chat",
    conversationId: "rev7-chat",
    registeredAt: 100,
    lastSeenAt: 200,
    controlEligibility: "OWNER",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(blockedHarness.classifyCalls(), 0);
  assert.equal(blockedHarness.sendCalls(), 1);
  assert.equal(blockedHarness.coordinator.status(71).phase, "WAITING_FOR_SELF_CHECK_RESPONSE");

  const fingerprint = await GuardianContent.fingerprintText("Partial result");
  const result = await adapter.guardedSend({
    decisionId: "decision-retry-blocker",
    conversationId: "rev7-chat",
    routeKey: "/c/rev7-chat",
    assistantFingerprint: fingerprint,
    assistantDomMessageId: "assistant-1",
    continuationText: "Continue.",
  });
  assert.equal(result.status, "NOT_STARTED");
  assert.equal(sendButton.clickCount, 0);
  assert.equal(retryButton.clickCount, 0);
});

test("D2 independent-review human relay holds deterministically before provider classification", async () => {
  const provider = {
    calls: 0,
    async classify() {
      this.calls += 1;
      return {
        decision: "CONTINUE",
        reasonCode: "NEEDLESS_TURN_BOUNDARY",
        reason: "Unsafe provider result that must not be reached.",
        source: "PROVIDER",
        confidence: 0.99,
        providerId: "test-provider",
      };
    },
  };
  const classifier = new ConservativeStopClassifier(provider);
  const result = await classifier.classify({
    turns: [
      { role: "user", content: "Prepare the independent-review handoff I asked for." },
      {
        role: "assistant",
        content: "INDEPENDENT REVIEW CHAT\nCopy the ready-to-use prompt below into a separate independent review chat, run it there, and bring the result back here.",
      },
    ],
  });

  assert.equal(result.decision, "HOLD");
  assert.equal(result.reasonCode, "HUMAN_OPERATION_REQUIRED");
  assert.equal(result.source, "RULE");
  assert.equal(provider.calls, 0);
});
