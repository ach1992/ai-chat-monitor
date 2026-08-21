import test from "node:test";
import assert from "node:assert/strict";
import {
  CONVERSATION_PROTOCOL_CONTINUE_RESPONSE,
  CONVERSATION_PROTOCOL_RECOVERY_RESPONSE,
  CONVERSATION_PROTOCOL_UNSURE_RESPONSE,
  DEFAULT_CONVERSATION_PROTOCOL_PROMPT,
  GUARDIAN_STATUS_PREFIX,
  conversationProtocolDecision,
  conversationProtocolResponseText,
  hasValidConversationProtocolStatus,
  parseConversationProtocolStatus,
  stripConversationProtocolStatus,
} from "../dist/classification/conversation-protocol.js";
import { DEFAULT_AUTOMATION_POLICY } from "../dist/automation/policy.js";

const status = (decision) => `${GUARDIAN_STATUS_PREFIX}{"decision":"${decision}"}`;

test("the conversation protocol maps every strict terminal decision", () => {
  const expected = new Map([
    ["CONTINUE", ["CONTINUE", "NEEDLESS_TURN_BOUNDARY"]],
    ["HOLD_APPROVAL", ["HOLD", "HUMAN_APPROVAL_REQUIRED"]],
    ["HOLD_DECISION", ["HOLD", "MATERIAL_DECISION_REQUIRED"]],
    ["HOLD_HUMAN_OPERATION", ["HOLD", "HUMAN_OPERATION_REQUIRED"]],
    ["COMPLETE", ["HOLD", "PROJECT_COMPLETE"]],
    ["PLATFORM_ERROR", ["HOLD", "PLATFORM_ERROR"]],
    ["RATE_LIMIT", ["HOLD", "RATE_LIMIT"]],
    ["UNSURE", ["UNSURE", "AMBIGUOUS"]],
  ]);

  for (const [value, [decision, reasonCode]] of expected) {
    const parsed = parseConversationProtocolStatus(`Normal response.\n${status(value)}`);
    assert.equal(parsed.decision, decision);
    assert.equal(parsed.reasonCode, reasonCode);
    assert.equal(parsed.source, "CONVERSATION_PROTOCOL");
    assert.equal(hasValidConversationProtocolStatus(status(value)), true);
  }
});

test("the terminal marker is exact, unique, strict, and must be the final suffix", () => {
  for (const malformed of [
    "CONTINUE",
    '{"decision":"CONTINUE"}',
    `${status("CONTINUE")}\ntrailing text`,
    `\`\`\`text\n${status("CONTINUE")}\n\`\`\``,
    `\`\`\`text\n${status("CONTINUE")}`,
    `${status("CONTINUE")}\n${status("CONTINUE")}`,
    `${GUARDIAN_STATUS_PREFIX}{"decision":"CONTINUE","extra":true}`,
    `${GUARDIAN_STATUS_PREFIX}{"decision":"HOLD_APPROVAL","decision":"CONTINUE"}`,
    `${GUARDIAN_STATUS_PREFIX}{"decision":"continue"}`,
    `${GUARDIAN_STATUS_PREFIX}{"decision":"UNKNOWN"}`,
    `${GUARDIAN_STATUS_PREFIX}{bad json}`,
  ]) {
    assert.equal(hasValidConversationProtocolStatus(malformed), false);
    assert.equal(parseConversationProtocolStatus(malformed).decision, "UNSURE");
  }

  assert.equal(hasValidConversationProtocolStatus(`${status("CONTINUE")}  \n`), true);
  assert.equal(hasValidConversationProtocolStatus(`Rendered prose.${status("CONTINUE")}`), true);
});

test("the machine marker can be stripped without changing normal assistant text", () => {
  const response = `Implemented the requested change.\n\n${status("COMPLETE")}`;
  assert.equal(stripConversationProtocolStatus(response), "Implemented the requested change.");
  assert.equal(stripConversationProtocolStatus(`Flattened DOM.${status("COMPLETE")}`), "Flattened DOM.");
  assert.equal(stripConversationProtocolStatus("Unmarked response."), "Unmarked response.");
  assert.equal(stripConversationProtocolStatus(status("COMPLETE")), "");
});

test("the one-time protocol prompt is readable, bounded, and explains future replies", () => {
  assert.match(DEFAULT_CONVERSATION_PROTOCOL_PROMPT, /^\[Chat Turn Guardian — Conversation Status Protocol\]\n\nPurpose\n/);
  assert.match(DEFAULT_CONVERSATION_PROTOCOL_PROMPT, /\n\nThis reply\n-/);
  assert.match(DEFAULT_CONVERSATION_PROTOCOL_PROMPT, /\n\nFuture replies\n-/);
  assert.match(DEFAULT_CONVERSATION_PROTOCOL_PROMPT, /\n\nValues\n-/);
  assert.match(DEFAULT_CONVERSATION_PROTOCOL_PROMPT, /Remember the protocol for this conversation/i);
  assert.match(DEFAULT_CONVERSATION_PROTOCOL_PROMPT, /Add nothing after it/i);
  assert.match(DEFAULT_CONVERSATION_PROTOCOL_PROMPT, /must not change, restart, reframe, summarize, reprioritize, or continue/i);
  assert.ok(DEFAULT_CONVERSATION_PROTOCOL_PROMPT.length <= 1_000);
});

test("the strict status selects only its dedicated automatic response", () => {
  const expected = new Map([
    ["CONTINUE", CONVERSATION_PROTOCOL_CONTINUE_RESPONSE],
    ["HOLD_APPROVAL", undefined],
    ["HOLD_DECISION", undefined],
    ["HOLD_HUMAN_OPERATION", undefined],
    ["COMPLETE", undefined],
    ["PLATFORM_ERROR", CONVERSATION_PROTOCOL_RECOVERY_RESPONSE],
    ["RATE_LIMIT", CONVERSATION_PROTOCOL_RECOVERY_RESPONSE],
    ["UNSURE", CONVERSATION_PROTOCOL_UNSURE_RESPONSE],
  ]);

  for (const [decision, response] of expected) {
    assert.equal(conversationProtocolDecision(status(decision)), decision);
    assert.equal(conversationProtocolResponseText(decision), response);
  }
  assert.equal(conversationProtocolDecision("malformed"), undefined);
});

test("the default resume prompt remains contextual and preserves human-precedence boundaries", () => {
  const text = DEFAULT_AUTOMATION_POLICY.defaults.continuationText;
  assert.notEqual(text, "Continue.");
  assert.match(text, /where you stopped/i);
  assert.match(text, /approval, a decision, information, or an action from the human/i);
});
