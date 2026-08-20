import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorageArea {
  values = new Map();
  accessLevels = [];

  async get(keys = null) {
    if (keys === null) return Object.fromEntries(this.values);
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(requested.filter((key) => this.values.has(key)).map((key) => [key, this.values.get(key)]));
  }

  async set(items) {
    for (const [key, value] of Object.entries(items)) this.values.set(key, structuredClone(value));
  }

  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  async clear() { this.values.clear(); }

  async setAccessLevel(options) {
    this.accessLevels.push(options.accessLevel);
  }
}

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc123";

test("Telegram bot token persists only in durable trusted extension storage across service-worker restart", async () => {
  const local = new MemoryStorageArea();
  globalThis.chrome = { storage: { local, session: new MemoryStorageArea() } };
  const { TelegramSettingsStore, redactTelegramSettings } = await import(`../dist/notifications/settings.js?trusted=${Date.now()}`);

  const first = new TelegramSettingsStore();
  await first.update({
    enabled: true,
    destination: "123456789",
    botToken: TOKEN,
    eventMode: "INHERIT",
    events: [],
  });
  assert.equal(local.accessLevels.at(-1), "TRUSTED_CONTEXTS");

  const restarted = new TelegramSettingsStore();
  const loaded = await restarted.load();
  assert.equal(local.accessLevels.at(-1), "TRUSTED_CONTEXTS");
  assert.equal(loaded.botToken, TOKEN);
  const redacted = redactTelegramSettings(loaded);
  assert.equal(redacted.configured, true);
  assert.equal(Object.hasOwn(redacted, "botToken"), false);
});
