import test from "node:test";
import assert from "node:assert/strict";
import { AutomationWriteJournal } from "../dist/automation/journal.js";

function fingerprint(index) {
  return index.toString(16).padStart(64, "0").slice(-64);
}

function envelope({ decisionId, assistantFingerprint = fingerprint(1), assistantDomMessageId }) {
  return {
    decisionId,
    tabId: 1,
    documentId: "doc-1",
    agentInstanceId: "agent-1",
    pageEpoch: 1,
    conversationId: "chat-1",
    routeKey: "/c/chat-1",
    assistantFingerprint,
    ...(assistantDomMessageId === undefined ? {} : { assistantDomMessageId }),
    policyRevision: 1,
    classification: {
      decision: "CONTINUE",
      reasonCode: "NEEDLESS_TURN_BOUNDARY",
      reason: "Continue.",
      source: "PROVIDER",
    },
    continuationText: "Continue.",
    createdAt: 100,
    expiresAt: 1_000,
  };
}

function persistence(initial) {
  let state = initial;
  return {
    async load() { return state === undefined ? undefined : structuredClone(state); },
    async save(next) { state = structuredClone(next); },
    snapshot() { return state === undefined ? undefined : structuredClone(state); },
  };
}

test("journal preserves no-retry guards beyond the former 64-record cap", async () => {
  const records = Array.from({ length: 80 }, (_, index) => ({
    conversationId: `chat-${index}`,
    assistantFingerprint: fingerprint(index + 1),
    decisionId: `decision-${index}`,
    documentId: `doc-${index}`,
    attemptedAt: index,
    disposition: index % 2 === 0 ? "VERIFIED" : "AMBIGUOUS",
  }));
  const store = persistence({ version: 1, records });
  const journal = new AutomationWriteJournal(store);

  await journal.restore();

  assert.equal(journal.snapshot().records.length, 80);
  assert.equal(journal.hasGuard("chat-0", fingerprint(1)), true);
  assert.equal(journal.hasGuard("chat-79", fingerprint(80)), true);
});

test("concurrent reservations for the same conversation fingerprint serialize to one write authority", async () => {
  const store = persistence();
  const journal = new AutomationWriteJournal(store);
  await journal.restore();

  const [first, second] = await Promise.all([
    journal.reserve(envelope({ decisionId: "decision-a" })),
    journal.reserve(envelope({ decisionId: "decision-b" })),
  ]);

  assert.deepEqual([first, second], [true, false]);
  assert.equal(journal.snapshot().records.length, 1);
  assert.equal(journal.hasGuard("chat-1", fingerprint(1)), true);
});

test("exact DOM response identity allows distinct identical-text assistant turns without weakening same-instance guards", async () => {
  const store = persistence();
  const journal = new AutomationWriteJournal(store);
  await journal.restore();

  assert.equal(await journal.reserve(envelope({
    decisionId: "decision-a",
    assistantDomMessageId: "assistant-1",
  })), true);
  assert.equal(await journal.reserve(envelope({
    decisionId: "decision-b",
    assistantDomMessageId: "assistant-2",
  })), true);
  assert.equal(await journal.reserve(envelope({
    decisionId: "decision-c",
    assistantDomMessageId: "assistant-1",
  })), false);

  assert.equal(journal.snapshot().records.length, 2);
  assert.equal(journal.hasGuard("chat-1", fingerprint(1), "assistant-1"), true);
  assert.equal(journal.hasGuard("chat-1", fingerprint(1), "assistant-2"), true);
  assert.equal(journal.hasGuard("chat-1", fingerprint(1), "assistant-3"), false);
});

test("legacy fingerprint-only guards remain conservative when exact DOM response identity was unavailable", async () => {
  const store = persistence({
    version: 1,
    records: [{
      conversationId: "chat-1",
      assistantFingerprint: fingerprint(1),
      decisionId: "legacy-decision",
      documentId: "doc-1",
      attemptedAt: 50,
      disposition: "AMBIGUOUS",
    }],
  });
  const journal = new AutomationWriteJournal(store);
  await journal.restore();

  assert.equal(journal.hasGuard("chat-1", fingerprint(1), "assistant-new"), true);
  assert.equal(await journal.reserve(envelope({
    decisionId: "decision-new",
    assistantDomMessageId: "assistant-new",
  })), false);
});

test("unbounded DOM response ids fall back to a durable fingerprint-only guard", async () => {
  const store = persistence();
  const journal = new AutomationWriteJournal(store);
  await journal.restore();

  const oversizedDomMessageId = "x".repeat(201);
  assert.equal(await journal.reserve(envelope({
    decisionId: "decision-long-id",
    assistantDomMessageId: oversizedDomMessageId,
  })), true);

  const stored = journal.snapshot().records[0];
  assert.equal(stored.assistantDomMessageId, undefined);
  assert.equal(journal.hasGuard("chat-1", fingerprint(1), "assistant-new"), true);

  const restored = new AutomationWriteJournal(store);
  await restored.restore();
  assert.equal(restored.snapshot().records.length, 1);
  assert.equal(restored.hasGuard("chat-1", fingerprint(1), "assistant-new"), true);
});

test("outcome reconciliation fails closed if its reserved guard is unexpectedly missing", async () => {
  const store = persistence();
  const journal = new AutomationWriteJournal(store);
  await journal.restore();

  await assert.rejects(
    journal.mark("missing-decision", "VERIFIED"),
    /guard disappeared/i,
  );
});

test("verified self-check control turns remain identifiable after journal restore", async () => {
  const store = persistence();
  const journal = new AutomationWriteJournal(store);
  await journal.restore();

  const probe = { ...envelope({ decisionId: "probe" }), action: "SELF_CHECK_PROBE", continuationText: "[Guardian control check]" };
  assert.equal(await journal.reserve(probe), true);
  await journal.mark("probe", "VERIFIED");

  const resume = {
    ...envelope({ decisionId: "resume", assistantFingerprint: fingerprint(2) }),
    action: "CONTINUATION",
    continuationText: "Continue the work from where you stopped.",
    classification: { decision: "CONTINUE", reasonCode: "NEEDLESS_TURN_BOUNDARY", reason: "Continue.", source: "SELF_CHECK" },
  };
  assert.equal(await journal.reserve(resume), true);
  await journal.mark("resume", "VERIFIED");

  const restored = new AutomationWriteJournal(store);
  await restored.restore();
  assert.equal(restored.hasVerifiedSelfCheckProbeForUserTurn("chat-1", probe.continuationText, 50), true);
  assert.equal(restored.hasVerifiedSelfCheckContinuationForUserTurn("chat-1", resume.continuationText, 50), true);
  assert.equal(restored.hasVerifiedSelfCheckContinuationForUserTurn("chat-1", resume.continuationText, 101), false);
});
