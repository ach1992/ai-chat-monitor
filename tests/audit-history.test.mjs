import test from "node:test";
import assert from "node:assert/strict";

import {
  AuditHistoryRepository,
  MAX_AUDIT_EVENTS,
} from "../dist/reliability/audit.js";

function persistence() {
  let state;
  return {
    adapter: {
      async load() { return state === undefined ? undefined : structuredClone(state); },
      async save(next) { state = structuredClone(next); },
    },
    snapshot() { return state === undefined ? undefined : structuredClone(state); },
  };
}

test("audit history is bounded redacted and clearable", async () => {
  const store = persistence();
  const audit = new AuditHistoryRepository(store.adapter);
  await audit.restore();

  for (let index = 0; index < MAX_AUDIT_EVENTS + 12; index += 1) {
    await audit.append({
      id: `event-${index}`,
      at: 1000 + index,
      tabId: index % 3,
      conversationId: `conv-${index % 2}`,
      kind: "ERROR",
      mode: "OBSERVE",
      phase: "UNSURE",
      reason: `Authorization: Bearer secret-token-${index} provider failure`,
      providerId: "provider-main",
      assistantFingerprint: "a".repeat(64),
    });
  }

  const history = audit.snapshot();
  assert.equal(history.length, MAX_AUDIT_EVENTS);
  assert.equal(history[0].id, "event-12");
  assert.equal(history.at(-1).id, `event-${MAX_AUDIT_EVENTS + 11}`);
  for (const event of history) {
    assert.doesNotMatch(event.reason ?? "", /secret-token/);
    assert.ok((event.reason?.length ?? 0) <= 240);
    assert.equal(Object.hasOwn(event, "content"), false);
    assert.equal(Object.hasOwn(event, "apiKey"), false);
  }

  await audit.clear();
  assert.deepEqual(audit.snapshot(), []);
  assert.deepEqual(store.snapshot(), { version: 1, events: [] });
});
