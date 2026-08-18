import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

class FakeNode {
  parent = null;
  contains(node) {
    return node === this;
  }
}

class FakeElement extends FakeNode {
  constructor({ textContent = "", attrs = {}, value = "" } = {}) {
    super();
    this.textContent = textContent;
    this.attrs = new Map(Object.entries(attrs));
    this.value = value;
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
