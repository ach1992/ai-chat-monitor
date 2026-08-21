import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

class FakeNode {
  static DOCUMENT_POSITION_FOLLOWING = 4;
  parent = null;
  order = 0;

  contains(node) {
    return node === this;
  }

  compareDocumentPosition(node) {
    return this.order < node.order ? FakeNode.DOCUMENT_POSITION_FOLLOWING : 0;
  }
}

class FakeElement extends FakeNode {
  constructor({ textContent = "", innerText, attrs = {}, value = "", order = 0 } = {}) {
    super();
    this.textContent = textContent;
    if (innerText !== undefined) this.innerText = innerText;
    this.attrs = new Map(Object.entries(attrs));
    this.value = value;
    this.order = order;
  }

  getAttribute(name) {
    return this.attrs.get(name) ?? null;
  }

  matches(selector) {
    if (selector === 'button[data-testid="send-button"]') {
      return this.getAttribute("data-testid") === "send-button";
    }
    if (selector.startsWith("button[aria-label")) {
      return (this.getAttribute("aria-label") ?? "")
        .toLowerCase()
        .includes(selector.includes("Send") ? "send" : "stop");
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

class FakeDocument {
  constructor(entries = []) {
    this.entries = entries;
    this.activeElement = null;
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
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.GuardianContent;
}

test("adapter normalizes and fingerprints assistant text without DOM payloads", async () => {
  const GuardianContent = await loadAdapter();
  const turn = new FakeElement({ attrs: { "data-testid": "conversation-turn-42" } });
  const assistant = new FakeElement({ textContent: "Hello\u00a0world  \r\n\r\n\r\nDone  " });
  assistant.parent = turn;
  const composer = new FakeTextAreaElement({ value: "draft" });
  const stop = new FakeElement({ attrs: { "data-testid": "stop-button" } });
  const document = new FakeDocument([
    ['[data-message-author-role="assistant"]', [assistant]],
    ["#prompt-textarea", [composer]],
    ['button[data-testid="stop-button"]', [stop]],
  ]);
  document.activeElement = composer;
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/abc-1234" });
  const result = await adapter.observe(1234);

  assert.equal(result.conversationId, "abc-1234");
  assert.equal(result.generation, "GENERATING");
  assert.equal(result.composer.hasText, true);
  assert.equal(result.composer.focused, true);
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.latestAssistant.normalizedText, "Hello world\n\nDone");
  assert.equal(result.latestAssistant.textLength, "Hello world\n\nDone".length);
  assert.match(result.latestAssistant.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result.latestAssistant, "outerHTML"), false);
});

test("adapter preserves rendered block boundaries for a terminal Guardian status", async () => {
  const GuardianContent = await loadAdapter();
  const marker = 'CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"CONTINUE"}';
  const assistant = new FakeElement({
    textContent: `Human-readable result.${marker}`,
    innerText: `Human-readable result.\n${marker}`,
  });
  const composer = new FakeTextAreaElement();
  const document = new FakeDocument([
    ['[data-message-author-role="assistant"]', [assistant]],
    ["#prompt-textarea", [composer]],
  ]);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/abc-1234" });

  const result = await adapter.observe(1234);

  assert.equal(result.latestAssistant.normalizedText, `Human-readable result.\n${marker}`);
});

test("adapter makes a Guardian marker rendered in a code block non-terminal", async () => {
  const GuardianContent = await loadAdapter();
  const marker = 'CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"CONTINUE"}';
  const assistant = new FakeElement({ textContent: marker, innerText: marker });
  const code = new FakeElement({ textContent: marker, innerText: marker });
  assistant.querySelectorAll = (selector) => selector === "pre, code" ? [code] : [];
  const document = new FakeDocument([
    ['[data-message-author-role="assistant"]', [assistant]],
    ["#prompt-textarea", [new FakeTextAreaElement()]],
  ]);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/abc-1234" });

  const result = await adapter.observe(1234);

  assert.match(result.latestAssistant.normalizedText, /rendered inside a code block\]$/);
});

test("adapter exposes the latest user turn preceding the current assistant", async () => {
  const GuardianContent = await loadAdapter();
  const olderTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-0" } });
  const precedingTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-1" } });
  const assistantTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-assistant-1" } });
  const olderUser = new FakeElement({ textContent: "Earlier context that must not be paired.", order: 0 });
  const precedingUser = new FakeElement({ textContent: "Please finish the remaining safe work.", order: 1 });
  const assistant = new FakeElement({ textContent: "I can continue with the implementation.", order: 2 });
  olderUser.parent = olderTurn;
  precedingUser.parent = precedingTurn;
  assistant.parent = assistantTurn;
  const composer = new FakeTextAreaElement({ value: "", order: 3 });
  const document = new FakeDocument([
    ['[data-message-author-role="user"]', [olderUser, precedingUser]],
    ['[data-message-author-role="assistant"]', [assistant]],
    ["#prompt-textarea", [composer]],
  ]);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/abc-1234" });
  const result = await adapter.observe(4321);

  assert.equal(result.latestUser.normalizedText, "Please finish the remaining safe work.");
  assert.equal(result.latestUser.textLength, "Please finish the remaining safe work.".length);
  assert.equal(result.latestUser.domMessageId, "user-1");
  assert.equal(result.latestAssistant.normalizedText, "I can continue with the implementation.");
});

test("bounded turn snapshots retain the recent tail of oversized user and assistant turns", async () => {
  const GuardianContent = await loadAdapter();
  const userTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-user-long" } });
  const assistantTurn = new FakeElement({ attrs: { "data-testid": "conversation-turn-assistant-long" } });
  const userText = `USER-START-${"u".repeat(12_500)}-USER-END`;
  const assistantText = `ASSISTANT-START-${"a".repeat(12_500)}-ASSISTANT-END`;
  const user = new FakeElement({ textContent: userText, order: 1 });
  const assistant = new FakeElement({ textContent: assistantText, order: 2 });
  user.parent = userTurn;
  assistant.parent = assistantTurn;
  const composer = new FakeTextAreaElement({ value: "", order: 3 });
  const document = new FakeDocument([
    ['[data-message-author-role="user"]', [user]],
    ['[data-message-author-role="assistant"]', [assistant]],
    ["#prompt-textarea", [composer]],
  ]);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/c/abc-1234" });
  const result = await adapter.observe(5555);

  assert.equal(result.latestUser.normalizedText.length, 12_000);
  assert.equal(result.latestAssistant.normalizedText.length, 12_000);
  assert.equal(result.latestUser.normalizedText.endsWith("-USER-END"), true);
  assert.equal(result.latestAssistant.normalizedText.endsWith("-ASSISTANT-END"), true);
  assert.equal(result.latestUser.textLength, userText.length);
  assert.equal(result.latestAssistant.textLength, assistantText.length);
});

test("adapter represents blocking conditions conservatively", async () => {
  const GuardianContent = await loadAdapter();
  const alert = new FakeElement({
    textContent: "Too many requests. Verify you are human before continuing.",
    attrs: { role: "alert" },
  });
  const document = new FakeDocument([['[role="alert"]', [alert]]]);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, { pathname: "/" });
  const result = await adapter.observe(22);

  assert.equal(result.blocking.blocked, true);
  assert.equal(result.blocking.reasons.includes("RATE_LIMIT"), true);
  assert.equal(result.blocking.reasons.includes("CAPTCHA"), true);
  assert.equal(result.confidence, "LOW");
  assert.equal(result.generation, "UNKNOWN");
});

test("adapter ignores inert ChatGPT accessibility alert regions but keeps real alerts fail-closed", async () => {
  const GuardianContent = await loadAdapter();
  const inert = new FakeElement({
    textContent: "",
    attrs: {
      role: "alert",
      id: "aria-notify-live-region-assertive",
      class: "sr-only",
      "aria-live": "assertive",
    },
  });
  const inertDocument = new FakeDocument([['[role="alert"]', [inert]]]);
  const inertAdapter = new GuardianContent.BrowserChatGPTAdapter(inertDocument, { pathname: "/" });
  const inertResult = await inertAdapter.observe(23);
  assert.equal(inertResult.blocking.blocked, false);
  assert.equal(inertResult.blocking.reasons.length, 0);

  const real = new FakeElement({
    textContent: "This action is blocked by platform policy.",
    attrs: { role: "alert", class: "visible-banner" },
  });
  const realDocument = new FakeDocument([['[role="alert"]', [real]]]);
  const realAdapter = new GuardianContent.BrowserChatGPTAdapter(realDocument, { pathname: "/" });
  const realResult = await realAdapter.observe(24);
  assert.equal(realResult.blocking.blocked, true);
  assert.equal(realResult.blocking.reasons.includes("ERROR"), true);
});
