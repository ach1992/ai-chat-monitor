import test from "node:test";
import assert from "node:assert/strict";
import { AutomationService } from "../dist/background/automation-service.js";

function createStorageArea(readLog, name) {
  return {
    async get(key) {
      readLog.push(`${name}:get:${String(key)}`);
      return {};
    },
    async set() {},
    async remove() {},
  };
}

test("automation restore waits until durable storage has been restricted to trusted contexts", async () => {
  const reads = [];
  globalThis.chrome = {
    storage: {
      local: createStorageArea(reads, "local"),
      session: createStorageArea(reads, "session"),
    },
    tabs: { sendMessage: async () => undefined },
  };

  let releaseStorageRestriction;
  const storageRestriction = new Promise((resolve) => {
    releaseStorageRestriction = resolve;
  });
  const service = new AutomationService(() => undefined, storageRestriction);

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(reads, []);

  releaseStorageRestriction();
  await service.ready();
  assert.equal(reads.some((entry) => entry.startsWith("local:get:guardian:automation-policy:")), true);
  assert.equal(reads.some((entry) => entry.startsWith("session:get:guardian:automation-write-journal:")), true);
});

test("failed durable storage restriction fails closed without reading automation state", async () => {
  const reads = [];
  globalThis.chrome = {
    storage: {
      local: createStorageArea(reads, "local"),
      session: createStorageArea(reads, "session"),
    },
    tabs: { sendMessage: async () => undefined },
  };

  const service = new AutomationService(
    () => undefined,
    Promise.reject(new Error("storage restriction failed")),
  );

  await assert.rejects(service.ready(), /storage restriction failed/);
  assert.deepEqual(reads, []);
});