import test from "node:test";
import assert from "node:assert/strict";

import { NotificationManager, telegramNotificationText } from "../dist/notifications/manager.js";
import { TelegramDeliveryError } from "../dist/notifications/telegram.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc123";

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
    event: "TASK_COMPLETE",
    title: "Task complete",
    message: "The monitored chat reports that the requested work is complete.",
    browserEnabled: true,
    soundEnabled: false,
    conversationId: "conversation-1234567890",
    tabId: 8,
    ...overrides,
  };
}

test("Telegram text is structured, event-aware, HTML-safe, and bounded", () => {
  const text = telegramNotificationText(notification());
  assert.match(text, /<b>🛡️ Chat Turn Guardian<\/b>/);
  assert.match(text, /<b>🏁 Task complete<\/b>/);
  assert.match(text, /<b>💬 Conversation<\/b>/);
  assert.match(text, /<code>conversation-1234567890<\/code>/);

  const eventIcons = new Map([
    ["RESPONSE_COMPLETE", "✅"],
    ["CONTINUE_READY", "▶️"],
    ["APPROVAL_REQUIRED", "👤"],
    ["DECISION_REQUIRED", "🧭"],
    ["HUMAN_OPERATION_REQUIRED", "🛠️"],
    ["TASK_COMPLETE", "🏁"],
    ["RETRY_AVAILABLE", "🔄"],
    ["PLATFORM_ERROR", "🚨"],
    ["RATE_LIMIT", "⏳"],
    ["SEMANTIC_UNKNOWN", "❓"],
    ["PROVIDER_ERROR", "⚠️"],
  ]);
  for (const [event, icon] of eventIcons) {
    assert.match(telegramNotificationText(notification({ event })), new RegExp(`\\n<b>${icon} `, "u"));
  }

  const bounded = telegramNotificationText(notification({
    title: " <title>& ".repeat(100),
    message: " <details>& ".repeat(200),
    conversationId: "conversation-<&>".repeat(100),
  }));
  assert.ok(bounded.length <= 700);
  assert.doesNotMatch(bounded, /<title>|<details>/);
});

test("browser, sound, and inherited Telegram can coexist for one monitoring event", async () => {
  const settings = settingsAccess(state());
  const browser = [];
  const sound = [];
  const telegram = [];
  const manager = new NotificationManager({
    settings,
    browser: { async send(event) { browser.push(event); } },
    sound: { async send(event) { sound.push(event); } },
    telegram: { async send(token, destination, text) { telegram.push({ token, destination, text }); } },
    now: () => 42,
  });

  await manager.deliver(notification({ soundEnabled: true }));
  assert.equal(browser.length, 1);
  assert.equal(sound.length, 1);
  assert.equal(telegram.length, 1);
  assert.equal(settings.snapshot().health.status, "HEALTHY");
});

test("custom Telegram selection remains independent from Browser enablement", async () => {
  const settings = settingsAccess(state({ eventMode: "CUSTOM", events: ["PROVIDER_ERROR"] }));
  let browserCalls = 0;
  const telegramEvents = [];
  const manager = new NotificationManager({
    settings,
    browser: { async send() { browserCalls += 1; } },
    telegram: { async send(_token, _destination, text) { telegramEvents.push(text); } },
  });

  await manager.deliver(notification({ event: "PROVIDER_ERROR", browserEnabled: false }));
  await manager.deliver(notification({ event: "SEMANTIC_UNKNOWN", browserEnabled: false }));
  assert.equal(browserCalls, 0);
  assert.equal(telegramEvents.length, 1);
});

test("notification channel failure is isolated from monitoring state", async () => {
  const settings = settingsAccess(state());
  let browserCalls = 0;
  const manager = new NotificationManager({
    settings,
    browser: { async send() { browserCalls += 1; } },
    telegram: { async send() { throw new TelegramDeliveryError("RATE_LIMIT"); } },
    now: () => 99,
  });

  await assert.rejects(() => manager.deliver(notification()), /monitoring state was not changed/);
  assert.equal(browserCalls, 1);
  assert.deepEqual(settings.snapshot().health, { status: "ERROR", checkedAt: 99, code: "RATE_LIMIT" });
});

test("Telegram Test delivery remains explicit and never uses Browser or chat content", async () => {
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
  assert.match(sent[0].text, /Telegram test successful/);
  assert.match(sent[0].text, /No chat content was included/);
  assert.equal(response.health.status, "HEALTHY");
  assert.equal(Object.hasOwn(response, "botToken"), false);
});
