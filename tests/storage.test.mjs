import test from "node:test";
import assert from "node:assert/strict";
import { NamespacedStorage } from "../dist/storage/namespaced-storage.js";

class MemoryStorageArea {
  values = new Map();

  async get(keys = null) {
    if (keys === null) {
      return Object.fromEntries(this.values.entries());
    }

    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requested.filter((key) => this.values.has(key)).map((key) => [key, this.values.get(key)]),
    );
  }

  async set(items) {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, value);
    }
  }

  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.values.delete(key);
    }
  }
}

test("namespaces isolate storage keys", async () => {
  const area = new MemoryStorageArea();
  const config = new NamespacedStorage("config", area);
  const runtime = new NamespacedStorage("runtime", area);

  await config.set("mode", "OBSERVE");
  await runtime.set("mode", "GENERATING");

  assert.equal(await config.get("mode"), "OBSERVE");
  assert.equal(await runtime.get("mode"), "GENERATING");
});

test("clearNamespace removes only owned keys", async () => {
  const area = new MemoryStorageArea();
  const first = new NamespacedStorage("first", area);
  const second = new NamespacedStorage("second", area);

  await first.set("a", 1);
  await first.set("b", 2);
  await second.set("a", 3);
  await first.clearNamespace();

  assert.equal(await first.get("a"), undefined);
  assert.equal(await first.get("b"), undefined);
  assert.equal(await second.get("a"), 3);
});
