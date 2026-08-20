import test from "node:test";
import assert from "node:assert/strict";

import { NotificationManager } from "../dist/notifications/manager.js";
import { TelegramDeliveryError } from "../dist/notifications/telegram.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc123";
const DRAFT_TOKEN = "654321:ZYXWVUTSRQPONMLKJIHGFEDCBA_987";

function state(overrides = {}) {
  return {
    version: 1,
    enabled: true,
    destination: "123456789",
    eventMode: "INHERIT",
    events: [],
    health: { status: "NEVER_TESTED" },
    botToken: TOKEN,
    ...overrides,
  };
}

function settingsAccess(initial) {
  let current = structuredClone(initial);
  return {
    async load() { return structuredClone(current); },
    async update() { return structuredClone(current); },
    async updateHealth(health) {
      current = { ...current, health: structuredClone(health) };
      return structuredClone(current);
    },
    snapshot() { return structuredClone(current); },
  };
}

function notification(overrides = {}) {
  return {
    id: "guardian:test",
    event: "RESPONSE_COMPLETE",
    title: "ChatGPT response finished",
    message: "A selected assistant response finished.",
    browserEnabled: true,
    conversationId: "conversation-1234567890",
    ...overrides,
  };
}

test("browser and inherited Telegram channels coexist for the same Guardian event", async () => {
  const settings = settingsAccess(state());
  const browser = [];
  const telegram = [];
  const manager = new NotificationManager({
    settings,
    browser: { async send(event) { browser.push(event); } },
    telegram: { async send(token, destination, text) { telegram.push({ token, destination, text }); } },
    now: () => 42,
  });

  await manager.deliver(notification());
  assert.equal(browser.length, 1);
  assert.equal(telegram.length, 1);
  assert.equal(telegram[0].token, TOKEN);
  assert.equal(telegram[0].destination, "123456789");
  assert.match(telegram[0].text, /Chat Turn Guardian/);
  assert.match(telegram[0].text, /Conversation: conversation-1234567890/);
  assert.equal(settings.snapshot().health.status, "HEALTHY");
});

test("disabled Telegram never sends and browser behavior remains unchanged", async () => {
  const settings = settingsAccess(state({ enabled: false }));
  let browserCalls = 0;
  let telegramCalls = 0;
  const manager = new NotificationManager({
    settings,
    browser: { async send() { browserCalls += 1; } },
    telegram: { async send() { telegramCalls += 1; } },
  });

  await manager.deliver(notification());
  assert.equal(browserCalls, 1);
  assert.equal(telegramCalls, 0);
});

test("custom Telegram event selection can notify without enabling the browser event", async () => {
  const settings = settingsAccess(state({
    eventMode: "CUSTOM",
    events: ["PROVIDER_ERROR"],
  }));
  let browserCalls = 0;
  const telegramEvents = [];
  const manager = new NotificationManager({
    settings,
    browser: { async send() { browserCalls += 1; } },
    telegram: { async send(_token, _destination, text) { telegramEvents.push(text); } },
  });

  await manager.deliver(notification({ event: "PROVIDER_ERROR", browserEnabled: false }));
  await manager.deliver(notification({ event: "UNSURE", browserEnabled: false }));
  assert.equal(browserCalls, 0);
  assert.equal(telegramEvents.length, 1);
});

test("Telegram failure is isolated after browser delivery and records only sanitized health", async () => {
  const settings = settingsAccess(state());
  let browserCalls = 0;
  const manager = new NotificationManager({
    settings,
    browser: { async send() { browserCalls += 1; } },
    telegram: { async send() { throw new TelegramDeliveryError("RATE_LIMIT"); } },
    now: () => 99,
  });

  await assert.rejects(() => manager.deliver(notification()), /automation state was not changed/);
  assert.equal(browserCalls, 1);
  assert.deepEqual(settings.snapshot().health, { status: "ERROR", checkedAt: 99, code: "RATE_LIMIT" });
  assert.doesNotMatch(JSON.stringify(settings.snapshot().health), /ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
});

test("Test notification is bounded, explicit, and independent of the enabled toggle", async () => {
  const settings = settingsAccess(state({ enabled: false }));
  const sent = [];
  const manager = new NotificationManager({
    settings,
    browser: { async send() { throw new Error("browser must not be used by Telegram test"); } },
    telegram: { async send(token, destination, text) { sent.push({ token, destination, text }); } },
    now: () => 123,
  });

  const response = await manager.testTelegram();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, TOKEN);
  assert.equal(sent[0].destination, "123456789");
  assert.match(sent[0].text, /Test notification/);
  assert.doesNotMatch(sent[0].text, /conversation|assistant response/i);
  assert.equal(response.enabled, false);
  assert.equal(response.health.status, "HEALTHY");
  assert.equal(Object.hasOwn(response, "botToken"), false);
});

test("Test notification can use an unsaved Side Panel draft without persisting its credential", async () => {
  const settings = settingsAccess(state({ enabled: false }));
  const before = settings.snapshot();
  const sent = [];
  const manager = new NotificationManager({
    settings,
    browser: { async send() { throw new Error("browser must not be used by Telegram test"); } },
    telegram: { async send(token, destination, text) { sent.push({ token, destination, text }); } },
    now: () => 456,
  });

  const response = await manager.testTelegram({
    enabled: true,
    destination: "987654321",
    botToken: DRAFT_TOKEN,
    eventMode: "CUSTOM",
    events: ["HUMAN_ATTENTION_REQUIRED"],
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, DRAFT_TOKEN);
  assert.equal(sent[0].destination, "987654321");
  assert.match(sent[0].text, /Test notification/);
  assert.deepEqual(settings.snapshot(), before);
  assert.equal(response.configured, true);
  assert.equal(response.enabled, true);
  assert.equal(response.destination, "987654321");
  assert.equal(response.health.status, "HEALTHY");
  assert.equal(Object.hasOwn(response, "botToken"), false);
});
