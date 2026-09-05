import test from "node:test";
import assert from "node:assert/strict";
import { MonitoringHistoryRepository } from "../dist/monitoring/history.js";

function event(id, at = 1) {
  return {
    id,
    at,
    tabId: 7,
    conversationId: "chat-1234",
    type: "TASK_COMPLETE",
    pageState: "IDLE",
    semanticDecision: "COMPLETE",
    semanticSource: "STATUS_MARKER",
    markerHealth: "DETECTED",
    assistantFingerprint: "a".repeat(64),
    title: "Task complete",
    message: "The monitored chat reports that the requested work is complete.",
  };
}

test("history deduplicates an event identity before notification routing", async () => {
  let stored;
  const repository = new MonitoringHistoryRepository({
    load: async () => stored,
    save: async (state) => { stored = structuredClone(state); },
  });
  await repository.restore();

  assert.equal(await repository.append(event("same")), true);
  assert.equal(await repository.append(event("same", 2)), false);
  assert.equal(repository.snapshot().length, 1);
});

test("history restoration preserves dedupe identity across worker restart", async () => {
  let stored = { version: 1, events: [event("persisted")] };
  const repository = new MonitoringHistoryRepository({
    load: async () => stored,
    save: async (state) => { stored = structuredClone(state); },
  });
  await repository.restore();

  assert.equal(repository.has("persisted"), true);
  assert.equal(await repository.append(event("persisted", 3)), false);
});

test("history is bounded and clearable", async () => {
  let stored;
  const repository = new MonitoringHistoryRepository({
    load: async () => stored,
    save: async (state) => { stored = structuredClone(state); },
  });
  await repository.restore();
  for (let index = 0; index < 205; index += 1) {
    await repository.append(event(`event-${index}`, index));
  }
  assert.equal(repository.snapshot(500).length, 200);
  await repository.clear();
  assert.deepEqual(repository.snapshot(), []);
});
