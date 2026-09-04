import test from "node:test";
import assert from "node:assert/strict";
import { MonitoredTabLifecycle } from "../dist/background/tab-lifecycle.js";

function harness(initial = true, stored) {
  let autoDiscardable = initial;
  let state = stored === undefined ? undefined : structuredClone(stored);
  const updates = [];
  const manager = new MonitoredTabLifecycle(
    {
      async get() { return { autoDiscardable }; },
      async update(tabId, patch) {
        updates.push({ tabId, patch: structuredClone(patch) });
        if (patch.autoDiscardable !== undefined) autoDiscardable = patch.autoDiscardable;
        return { autoDiscardable };
      },
    },
    {
      async load() { return state === undefined ? undefined : structuredClone(state); },
      async save(next) { state = structuredClone(next); },
    },
  );
  return { manager, updates, autoDiscardable: () => autoDiscardable, state: () => structuredClone(state) };
}

test("monitoring protection disables automatic discard and restores the original tab value", async () => {
  const h = harness(true);
  await h.manager.protect(7);
  assert.equal(h.autoDiscardable(), false);
  assert.deepEqual(h.state(), { version: 1, tabs: [{ tabId: 7, originalAutoDiscardable: true }] });
  await h.manager.release(7);
  assert.equal(h.autoDiscardable(), true);
  assert.deepEqual(h.state(), { version: 1, tabs: [] });
});

test("pre-existing discard opt-out is preserved after monitoring is disabled", async () => {
  const h = harness(false);
  await h.manager.protect(9);
  assert.equal(h.autoDiscardable(), false);
  assert.equal(h.updates.length, 0);
  await h.manager.release(9);
  assert.equal(h.autoDiscardable(), false);
  assert.equal(h.updates.length, 0);
});

test("service-worker restore keeps a monitored tab protected idempotently", async () => {
  const h = harness(true, { version: 1, tabs: [{ tabId: 11, originalAutoDiscardable: true }] });
  await h.manager.protect(11);
  assert.equal(h.autoDiscardable(), false);
  assert.equal(h.updates.length, 1);
  assert.deepEqual(h.state(), { version: 1, tabs: [{ tabId: 11, originalAutoDiscardable: true }] });
});

test("removed tabs are forgotten without attempting a restore write", async () => {
  const h = harness(false, { version: 1, tabs: [{ tabId: 13, originalAutoDiscardable: true }] });
  await h.manager.forget(13);
  assert.equal(h.updates.length, 0);
  assert.deepEqual(h.state(), { version: 1, tabs: [] });
});
