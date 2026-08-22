import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TELEGRAM_SETTINGS,
  TelegramConfigurationError,
  TelegramSettingsStore,
  redactTelegramSettings,
  resolveTelegramSettingsMutation,
} from "../dist/notifications/settings.js";

const TOKEN_A = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc123";
const TOKEN_B = "654321:ZYXWVUTSRQPONMLKJIHGFEDCBA_xyz987";

function mutation(overrides = {}) {
  return {
    enabled: true,
    destination: "123456789",
    botToken: TOKEN_A,
    eventMode: "INHERIT",
    events: [],
    ...overrides,
  };
}

function memoryPersistence(initial) {
  let value = initial === undefined ? undefined : structuredClone(initial);
  return {
    async load() { return value === undefined ? undefined : structuredClone(value); },
    async save(next) { value = structuredClone(next); },
  };
}

test("Telegram redacted settings never disclose the saved bot token", () => {
  const saved = resolveTelegramSettingsMutation(DEFAULT_TELEGRAM_SETTINGS, mutation());
  const redacted = redactTelegramSettings(saved);
  assert.equal(redacted.configured, true);
  assert.equal(redacted.destination, "123456789");
  assert.equal(Object.hasOwn(redacted, "botToken"), false);
  assert.doesNotMatch(JSON.stringify(redacted), /ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
});

test("blank token retains only the same destination while explicit token replaces the credential", () => {
  const first = resolveTelegramSettingsMutation(DEFAULT_TELEGRAM_SETTINGS, mutation());
  const retained = resolveTelegramSettingsMutation(first, mutation({
    botToken: "",
    eventMode: "CUSTOM",
    events: ["HUMAN_OPERATION_REQUIRED"],
  }));
  assert.equal(retained.botToken, TOKEN_A);
  assert.equal(retained.eventMode, "CUSTOM");

  const replaced = resolveTelegramSettingsMutation(retained, mutation({ botToken: TOKEN_B }));
  assert.equal(replaced.botToken, TOKEN_B);
  assert.equal(replaced.health.status, "NEVER_TESTED");

  assert.throws(
    () => resolveTelegramSettingsMutation(first, mutation({ botToken: "", destination: "987654321" })),
    TelegramConfigurationError,
  );
});

test("Telegram settings persist across store instances without exposing the credential", async () => {
  const persistence = memoryPersistence();
  const firstStore = new TelegramSettingsStore(persistence);
  await firstStore.update(mutation({ eventMode: "CUSTOM", events: ["RESPONSE_COMPLETE", "PROVIDER_ERROR"] }));

  const restartedStore = new TelegramSettingsStore(persistence);
  const loaded = await restartedStore.load();
  assert.equal(loaded.botToken, TOKEN_A);
  assert.deepEqual(loaded.events, ["RESPONSE_COMPLETE", "PROVIDER_ERROR"]);
  assert.equal(redactTelegramSettings(loaded).configured, true);
});

test("legacy v1 notification selections migrate without discarding the saved Telegram credential", async () => {
  const persistence = memoryPersistence({
    version: 1,
    enabled: true,
    destination: "123456789",
    eventMode: "CUSTOM",
    events: ["HUMAN_ATTENTION_REQUIRED", "UNSURE", "STAGNATION"],
    health: { status: "HEALTHY", checkedAt: 12 },
    botToken: TOKEN_A,
  });
  const store = new TelegramSettingsStore(persistence);
  const loaded = await store.load();

  assert.equal(loaded.botToken, TOKEN_A);
  assert.equal(loaded.enabled, true);
  assert.ok(loaded.events.includes("APPROVAL_REQUIRED"));
  assert.ok(loaded.events.includes("DECISION_REQUIRED"));
  assert.ok(loaded.events.includes("HUMAN_OPERATION_REQUIRED"));
  assert.ok(loaded.events.includes("TASK_COMPLETE"));
  assert.ok(loaded.events.includes("SEMANTIC_UNKNOWN"));
  assert.ok(loaded.events.includes("REPEATED_RESPONSE"));
  assert.ok(loaded.events.includes("GENERATION_STALLED"));
});

test("stale delivery health cannot overwrite health for a replaced Telegram credential", async () => {
  const store = new TelegramSettingsStore(memoryPersistence());
  await store.update(mutation());
  const stale = await store.load();

  await store.update(mutation({ botToken: TOKEN_B }));
  const afterStaleHealth = await store.updateHealth(
    { status: "HEALTHY", checkedAt: 42 },
    { destination: stale.destination, botToken: stale.botToken },
  );

  assert.equal(afterStaleHealth.botToken, TOKEN_B);
  assert.deepEqual(afterStaleHealth.health, { status: "NEVER_TESTED" });
});

test("Telegram cannot be enabled without both credential and destination", () => {
  assert.throws(
    () => resolveTelegramSettingsMutation(DEFAULT_TELEGRAM_SETTINGS, mutation({ botToken: "" })),
    /Configure both/,
  );
  assert.throws(
    () => resolveTelegramSettingsMutation(DEFAULT_TELEGRAM_SETTINGS, mutation({ destination: "" })),
    /Chat ID is required/,
  );
});
