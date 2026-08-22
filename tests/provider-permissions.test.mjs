import test from "node:test";
import assert from "node:assert/strict";

import { MonitoringService } from "../dist/monitoring/service.js";

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

function installChrome(removedOrigins) {
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
}

test("provider mutations serialize, blank-key edits retain the stored secret, and unused origins are revoked", async () => {
  const removedOrigins = [];
  installChrome(removedOrigins);

  const service = new MonitoringService(() => undefined, Promise.resolve());
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

  await Promise.all([
    service.upsertProviderProfile({
      kind: "OPENAI_COMPATIBLE",
      id: "first",
      baseUrl: "https://one.example/v2",
      apiKey: "",
      model: "model-one-updated",
    }),
    service.upsertProviderProfile({
      kind: "OPENAI_COMPATIBLE",
      id: "second",
      baseUrl: "https://two.example/v1",
      model: "model-two-updated",
    }),
  ]);

  settings = await service.providerSettings();
  const first = settings.profiles.find((profile) => profile.id === "first");
  const second = settings.profiles.find((profile) => profile.id === "second");
  assert.equal(first.apiKey, "key-one");
  assert.equal(first.model, "model-one-updated");
  assert.equal(first.baseUrl, "https://one.example/v2");
  assert.equal(second.apiKey, "key-two");
  assert.equal(second.model, "model-two-updated");

  await assert.rejects(
    service.upsertProviderProfile({
      kind: "OPENAI_COMPATIBLE",
      id: "second",
      baseUrl: "https://different-origin.example/v1",
      apiKey: "",
      model: "must-not-save",
    }),
    /Enter a new API key when changing provider type or origin/,
  );
  settings = await service.providerSettings();
  assert.equal(settings.profiles.find((profile) => profile.id === "second").baseUrl, "https://two.example/v1");
  assert.equal(settings.profiles.find((profile) => profile.id === "second").apiKey, "key-two");

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
  assert.equal(settings.profiles[0].apiKey, "key-three");
});

test("catalog failure with a retained secret does not mutate or expose the saved profile", async () => {
  const removedOrigins = [];
  installChrome(removedOrigins);
  const service = new MonitoringService(() => undefined, Promise.resolve());
  await service.ready();
  await service.upsertProviderProfile({
    kind: "NARAROUTER",
    id: "nara",
    apiKey: "stored-nara-secret",
    model: "saved-alias",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("stored-nara-secret echoed", { status: 500 });
  try {
    await assert.rejects(
      service.providerModelCatalog({ kind: "NARAROUTER", providerId: "nara", apiKey: "" }),
      (error) => !error.message.includes("stored-nara-secret"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const settings = await service.providerSettings();
  assert.equal(settings.profiles.length, 1);
  assert.equal(settings.profiles[0].id, "nara");
  assert.equal(settings.profiles[0].model, "saved-alias");
  assert.equal(settings.profiles[0].apiKey, "stored-nara-secret");
  assert.deepEqual(removedOrigins, []);
});
