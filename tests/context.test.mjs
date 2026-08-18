import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, sanitizeContext } from "../dist/classification/context.js";

const longCode = `\`\`\`text\n${"log-line\n".repeat(300)}\`\`\``;

test("context sanitizer keeps only bounded recent context and minimizes large code blocks", () => {
  const turns = [
    { role: "user", content: "old one" },
    { role: "assistant", content: "old two" },
    { role: "user", content: `Here is a log:\n${longCode}` },
    { role: "assistant", content: "Latest assistant response\n" + "x".repeat(5000) },
  ];
  const context = sanitizeContext(turns, {
    maxTurns: 3,
    maxTurnCharacters: 1200,
    maxTotalCharacters: 1800,
    maxCodeBlockCharacters: 200,
  });

  assert.equal(context.turns.length <= 3, true);
  assert.equal(context.totalCharacters <= 1800, true);
  assert.equal(context.truncated, true);
  assert.equal(context.turns.some((turn) => turn.content.includes("[omitted")), true);
  assert.equal(context.turns.at(-1).role, "assistant");
  assert.equal(context.turns.at(-1).content.includes("[earlier content omitted]"), true);
});

test("secret redaction removes common auth and API-key forms before provider context", () => {
  const input = [
    "Authorization: Bearer super-secret-token-value",
    "api_key=abcdefghijklmnopqrstuvwxyz123456",
    "sk-abcdefghijklmnopqrstuv",
  ].join("\n");
  const output = redactSecrets(input);
  assert.equal(output.includes("super-secret-token-value"), false);
  assert.equal(output.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(output.includes("sk-abcdefghijklmnopqrstuv"), false);
  assert.match(output, /REDACTED/);
});
