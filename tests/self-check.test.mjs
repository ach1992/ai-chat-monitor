import test from "node:test";
import assert from "node:assert/strict";
import { parseInChatSelfCheckResponse } from "../dist/classification/self-check.js";

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
