import test from "node:test";
import assert from "node:assert/strict";
import { ConservativeStopClassifier } from "../dist/classification/classifier.js";

class NeverProviderManager {
  calls = 0;
  async classify() {
    this.calls += 1;
    throw new Error("provider must not be called");
  }
}

class FixedProviderManager {
  calls = 0;
  constructor(result) {
    this.result = result;
  }
  async classify() {
    this.calls += 1;
    return this.result;
  }
}

test("high-confidence approval boundary holds without a provider call", async () => {
  const providers = new NeverProviderManager();
  const classifier = new ConservativeStopClassifier(providers);
  const result = await classifier.classify({
    turns: [{ role: "assistant", content: "APPROVAL_REQUIRED: I need your approval before I can proceed." }],
  });
  assert.equal(result.decision, "HOLD");
  assert.equal(result.reasonCode, "HUMAN_APPROVAL_REQUIRED");
  assert.equal(result.source, "RULE");
  assert.equal(providers.calls, 0);
});

test("explicit user stop holds before any model classification", async () => {
  const providers = new NeverProviderManager();
  const classifier = new ConservativeStopClassifier(providers);
  const result = await classifier.classify({
    turns: [
      { role: "assistant", content: "I can keep working." },
      { role: "user", content: "ادامه نده" },
    ],
  });
  assert.equal(result.decision, "HOLD");
  assert.equal(result.reasonCode, "USER_STOP");
  assert.equal(providers.calls, 0);
});

test("explicitly pre-authorized generic continue boundary continues deterministically", async () => {
  const providers = new NeverProviderManager();
  const classifier = new ConservativeStopClassifier(providers);
  const result = await classifier.classify({
    turns: [
      {
        role: "user",
        content: "Complete the requested work in exactly two stages without asking me any question, approval, choice, credential, or new information. Stage 2 follows after the next user message.",
      },
      {
        role: "assistant",
        content: "81\n\nStage 1 complete. Say continue for Stage 2.",
      },
    ],
  });

  assert.equal(result.decision, "CONTINUE");
  assert.equal(result.reasonCode, "NEEDLESS_TURN_BOUNDARY");
  assert.equal(result.source, "RULE");
  assert.equal(result.confidence, 1);
  assert.equal(providers.calls, 0);
});

test("deterministic HOLD keeps precedence over an explicit continue token", async () => {
  const providers = new NeverProviderManager();
  const classifier = new ConservativeStopClassifier(providers);
  const result = await classifier.classify({
    turns: [
      {
        role: "user",
        content: "Continue the work without asking me for routine approval or confirmation.",
      },
      {
        role: "assistant",
        content: "I need your approval before I can continue. Say continue to approve.",
      },
    ],
  });

  assert.equal(result.decision, "HOLD");
  assert.equal(result.reasonCode, "HUMAN_APPROVAL_REQUIRED");
  assert.equal(result.source, "RULE");
  assert.equal(providers.calls, 0);
});

test("generic continue wording does not override a real human condition", async () => {
  const providers = new FixedProviderManager({
    decision: "HOLD",
    reasonCode: "MATERIAL_DECISION_REQUIRED",
    reason: "A real human choice is still required.",
    source: "PROVIDER",
    confidence: 0.99,
    providerId: "test-provider",
  });
  const classifier = new ConservativeStopClassifier(providers);
  const result = await classifier.classify({
    turns: [
      {
        role: "user",
        content: "Continue the work without asking me for routine approval or confirmation.",
      },
      {
        role: "assistant",
        content: "Stage 1 is done. Say continue after you choose A or B.",
      },
    ],
  });

  assert.equal(result.decision, "HOLD");
  assert.equal(result.reasonCode, "MATERIAL_DECISION_REQUIRED");
  assert.equal(result.source, "PROVIDER");
  assert.equal(providers.calls, 1);
});

test("ambiguous text with no provider fails closed", async () => {
  const classifier = new ConservativeStopClassifier();
  const result = await classifier.classify({
    turns: [{ role: "assistant", content: "I have reached a natural pause in the explanation." }],
  });
  assert.equal(result.decision, "UNSURE");
  assert.equal(result.reasonCode, "PROVIDER_FAILURE");
});
