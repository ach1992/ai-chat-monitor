import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderClassification, ProviderOutputError } from "../dist/classification/output.js";

test("strict output parser accepts only schema-consistent high-confidence continuation", () => {
  const result = parseProviderClassification(
    JSON.stringify({
      decision: "CONTINUE",
      reasonCode: "NEEDLESS_TURN_BOUNDARY",
      reason: "The response stopped mid-work without asking for human input.",
      confidence: 0.96,
    }),
    "primary",
    0.9,
  );
  assert.equal(result.decision, "CONTINUE");
  assert.equal(result.providerId, "primary");
});

test("low confidence or semantic inconsistency normalizes to UNSURE", () => {
  const low = parseProviderClassification(
    JSON.stringify({
      decision: "CONTINUE",
      reasonCode: "NEEDLESS_TURN_BOUNDARY",
      reason: "Maybe continue.",
      confidence: 0.6,
    }),
    "primary",
  );
  assert.equal(low.decision, "UNSURE");
  assert.equal(low.reasonCode, "AMBIGUOUS");

  const inconsistent = parseProviderClassification(
    JSON.stringify({
      decision: "CONTINUE",
      reasonCode: "HUMAN_APPROVAL_REQUIRED",
      reason: "Continue even though approval is required.",
      confidence: 0.99,
    }),
    "primary",
  );
  assert.equal(inconsistent.decision, "UNSURE");
});

test("markdown wrappers, extra fields, and invalid reason codes are rejected", () => {
  assert.throws(
    () =>
      parseProviderClassification(
        '```json\n{"decision":"UNSURE","reasonCode":"AMBIGUOUS","reason":"x","confidence":1}\n```',
        "primary",
      ),
    ProviderOutputError,
  );
  assert.throws(
    () =>
      parseProviderClassification(
        JSON.stringify({
          decision: "HOLD",
          reasonCode: "HUMAN_APPROVAL_REQUIRED",
          reason: "approval",
          confidence: 1,
          browserAction: "click send",
        }),
        "primary",
      ),
    ProviderOutputError,
  );
  assert.throws(
    () =>
      parseProviderClassification(
        JSON.stringify({ decision: "HOLD", reasonCode: "DO_WHATEVER", reason: "x", confidence: 1 }),
        "primary",
      ),
    ProviderOutputError,
  );
});
