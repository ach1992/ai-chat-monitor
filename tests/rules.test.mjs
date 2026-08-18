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

test("ambiguous text with no provider fails closed", async () => {
  const classifier = new ConservativeStopClassifier();
  const result = await classifier.classify({
    turns: [{ role: "assistant", content: "I have reached a natural pause in the explanation." }],
  });
  assert.equal(result.decision, "UNSURE");
  assert.equal(result.reasonCode, "PROVIDER_FAILURE");
});
