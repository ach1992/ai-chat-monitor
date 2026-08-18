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

  async setAccessLevel(options) {
    this.accessLevels.push(options.accessLevel);
  }
}

test("provider settings restrict durable storage to trusted extension contexts", async () => {
  const local = new MemoryStorageArea();
  globalThis.chrome = { storage: { local, session: new MemoryStorageArea() } };
  const { ProviderSettingsStore } = await import(`../dist/providers/settings-store.js?test=${Date.now()}`);
  const store = new ProviderSettingsStore();
  const settings = {
    version: 1,
    profiles: [{ kind: "OPENROUTER", id: "primary", apiKey: "sk-secret-1234567890", model: "test/model" }],
    order: ["primary"],
  };

  await store.save(settings);
  assert.equal(local.accessLevels.at(-1), "TRUSTED_CONTEXTS");
  const loaded = await store.load();
  assert.equal(local.accessLevels.at(-1), "TRUSTED_CONTEXTS");
  assert.equal(loaded.profiles[0].apiKey, "sk-secret-1234567890");
});
