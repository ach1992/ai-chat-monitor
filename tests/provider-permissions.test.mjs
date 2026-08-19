import test from "node:test";
import assert from "node:assert/strict";

import { AutomationService } from "../dist/background/automation-service.js";

function memoryArea() {
  const values = {};
  return {
    async get(keys) {
      if (keys === undefined || keys === null) return structuredClone(values);
      if (typeof keys === "string") return Object.hasOwn(values, keys) ? { [keys]: structuredClone(values[keys]) } : {};
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, structuredClone(values[key])]));
    },
    async set(items) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      Object.assign(values, structuredClone(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async clear() {
      for (const key of Object.keys(values)) delete values[key];
    },
    async setAccessLevel() {},
  };
}

test("provider mutations serialize and unused exact-origin permissions are revoked", async () => {
  const removedOrigins = [];
  globalThis.chrome = {
    storage: { local: memoryArea(), session: memoryArea() },
    tabs: { async sendMessage() { throw new Error("not used"); } },
    permissions: {
      async remove(request) {
        removedOrigins.push(...(request.origins ?? []));
        return true;
      },
    },
    runtime: { lastError: undefined },
    notifications: { create() {} },
  };

  const service = new AutomationService(() => undefined, Promise.resolve());
  await service.ready();

  await Promise.all([
    service.upsertProviderProfile({
      kind: "OPENAI_COMPATIBLE",
      id: "first",
      baseUrl: "https://one.example/v1",
      apiKey: "key-one",
      model: "model-one",
    }),
    service.upsertProviderProfile({
      kind: "OPENAI_COMPATIBLE",
      id: "second",
      baseUrl: "https://two.example/v1",
      apiKey: "key-two",
      model: "model-two",
    }),
  ]);

  let settings = await service.providerSettings();
  assert.deepEqual(settings.profiles.map((profile) => profile.id).sort(), ["first", "second"]);
  assert.deepEqual(settings.order, ["first", "second"]);

  await service.removeProviderProfile("first");
  assert.equal(removedOrigins.includes("https://one.example/*"), true);

  await service.upsertProviderProfile({
    kind: "OPENAI_COMPATIBLE",
    id: "second",
    baseUrl: "https://three.example/v1",
    apiKey: "key-three",
    model: "model-three",
  });
  assert.equal(removedOrigins.includes("https://two.example/*"), true);

  settings = await service.providerSettings();
  assert.deepEqual(settings.profiles.map((profile) => profile.id), ["second"]);
  assert.equal(settings.profiles[0].baseUrl, "https://three.example/v1");
});
