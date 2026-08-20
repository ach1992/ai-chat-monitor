import test from "node:test";
import assert from "node:assert/strict";
import { parseInChatSelfCheckResponse } from "../dist/classification/self-check.js";
import { DEFAULT_AUTOMATION_POLICY } from "../dist/automation/policy.js";

test("in-chat self-check accepts only the compact strict decision schema", () => {
  const continuation = parseInChatSelfCheckResponse('{"decision":"CONTINUE"}');
  assert.equal(continuation.decision, "CONTINUE");
  assert.equal(continuation.source, "SELF_CHECK");

  const approval = parseInChatSelfCheckResponse('{"decision":"HOLD_APPROVAL","reason":"Need approval."}');
  assert.equal(approval.decision, "HOLD");
  assert.equal(approval.reasonCode, "HUMAN_APPROVAL_REQUIRED");

  for (const malformed of [
    "CONTINUE",
    '```json\n{"decision":"CONTINUE"}\n```',
    '{"decision":"CONTINUE","extra":true}',
    '{"decision":"UNKNOWN"}',
  ]) {
    assert.equal(parseInChatSelfCheckResponse(malformed).decision, "UNSURE");
  }
});

test("the default resume prompt remains contextual and preserves human-precedence boundaries", () => {
  const text = DEFAULT_AUTOMATION_POLICY.defaults.continuationText;
  assert.notEqual(text, "Continue.");
  assert.match(text, /where you stopped/i);
  assert.match(text, /approval, a decision, information, or an action from the human/i);
});
