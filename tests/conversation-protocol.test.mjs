import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_CHAT_MONITOR_STATUS_PREFIX,
  conversationProtocolDecision,
  hasValidConversationProtocolStatus,
  inspectConversationStatusMarker,
  parseConversationProtocolStatus,
  stripConversationProtocolStatus,
} from "../dist/classification/conversation-protocol.js";

const status = (decision) => `${AI_CHAT_MONITOR_STATUS_PREFIX}{"decision":"${decision}"}`;

test("canonical standalone status maps every terminal decision", () => {
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
    const raw = `Normal response.\n\n${status(value)}`;
    const marker = inspectConversationStatusMarker(raw);
    assert.equal(marker.health, "DETECTED");
    assert.equal(marker.decision, value);
    assert.equal(marker.prefix, AI_CHAT_MONITOR_STATUS_PREFIX);
    assert.equal(conversationProtocolDecision(raw), value);
    assert.equal(hasValidConversationProtocolStatus(raw), true);
    const parsed = parseConversationProtocolStatus(raw);
    assert.equal(parsed.decision, decision);
    assert.equal(parsed.reasonCode, reasonCode);
    assert.equal(parsed.source, "CONVERSATION_PROTOCOL");
  }
});

test("retired product markers are not recognized", () => {
  const retiredMarkers = [
    'CHAT_TURN_GUARDIAN_STATUS={"decision":"COMPLETE"}',
    'CHAT_TURN_GUARDIAN_STATUS_V1={"decision":"CONTINUE"}',
    'AI_CHAT_MONITOR_STATUS_V1={"decision":"HOLD_DECISION"}',
  ];

  for (const retiredMarker of retiredMarkers) {
    const raw = `Normal response.\n\n${retiredMarker}`;
    assert.deepEqual(inspectConversationStatusMarker(raw), { health: "MISSING" });
    assert.equal(conversationProtocolDecision(raw), undefined);
    assert.equal(hasValidConversationProtocolStatus(raw), false);
    assert.equal(stripConversationProtocolStatus(raw), raw);
  }
});

test("missing status is a valid fallback condition rather than a fabricated decision", () => {
  const marker = inspectConversationStatusMarker("A normal response with no status metadata.");
  assert.deepEqual(marker, { health: "MISSING" });
  assert.equal(conversationProtocolDecision("A normal response with no status metadata."), undefined);
  assert.equal(hasValidConversationProtocolStatus("A normal response with no status metadata."), false);
  assert.equal(parseConversationProtocolStatus("A normal response with no status metadata.").decision, "UNSURE");
});

test("status must be the unique standalone terminal line and outside fenced code", () => {
  const malformed = [
    `${status("CONTINUE")}\ntrailing text`,
    `prefix ${status("CONTINUE")}`,
    `> ${status("CONTINUE")}`,
    `| ${status("CONTINUE")} |`,
    `\`\`\`json\n${status("CONTINUE")}\n\`\`\``,
    `\`\`\`text\n${status("CONTINUE")}`,
    `~~~json\n${status("CONTINUE")}\n~~~`,
    `~~~~text\n${status("CONTINUE")}`,
    `${status("CONTINUE")}\n${status("COMPLETE")}`,
    `${AI_CHAT_MONITOR_STATUS_PREFIX}{"decision":"CONTINUE","extra":true}`,
    `${AI_CHAT_MONITOR_STATUS_PREFIX}{"decision":"continue"}`,
    `${AI_CHAT_MONITOR_STATUS_PREFIX}{"decision":"UNKNOWN"}`,
    `${AI_CHAT_MONITOR_STATUS_PREFIX}{bad json}`,
  ];

  for (const raw of malformed) {
    assert.equal(inspectConversationStatusMarker(raw).health, "MALFORMED", raw);
    assert.equal(hasValidConversationProtocolStatus(raw), false, raw);
    assert.equal(parseConversationProtocolStatus(raw).decision, "UNSURE", raw);
  }
});

test("terminal status stripping preserves the answer body and never strips invalid markers", () => {
  const response = `Implemented the requested change.\n\n${status("COMPLETE")}`;
  assert.equal(stripConversationProtocolStatus(response), "Implemented the requested change.");
  assert.equal(stripConversationProtocolStatus(status("COMPLETE")), "");
  assert.equal(stripConversationProtocolStatus("Unmarked response."), "Unmarked response.");
  const embedded = `Output: ${status("COMPLETE")}`;
  assert.equal(stripConversationProtocolStatus(embedded), embedded);
});
