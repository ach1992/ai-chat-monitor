import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../dist/providers/openai-compatible.js";
import { createOpenAICompatibleProfile } from "../dist/providers/settings.js";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("classifier prompt pins conservative turn-boundary semantics", async () => {
  let capturedBody;
  const provider = new OpenAICompatibleProvider(
    createOpenAICompatibleProfile({
      id: "classifier-contract",
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-secret",
      model: "test-model",
    }),
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              decision: "CONTINUE",
              reasonCode: "NEEDLESS_TURN_BOUNDARY",
              reason: "Requested work remains executable without human input.",
              confidence: 0.99,
            }),
          },
        }],
      });
    },
  );

  await provider.classify({
    context: {
      turns: [{
        role: "assistant",
        content: "Progress update: the first step is complete. Next I will finish the remaining requested work.",
        originalLength: 91,
        truncated: false,
      }],
      totalCharacters: 91,
      truncated: false,
    },
  });

  const prompt = capturedBody.messages[0].content;
  assert.equal(typeof prompt, "string");
  assert.equal(prompt.includes("Infer the user's active requested outcome"), true);
  assert.equal(prompt.includes("asking the user to say \"continue\" / \"go ahead\""), true);
  assert.equal(prompt.includes("another chat, person, or tool"), true);
  assert.equal(prompt.includes("explicitly requested a prompt, handoff packet, or review prompt as the deliverable"), true);
  assert.equal(prompt.includes("Do not CONTINUE merely because optional enhancements or imaginable extra work exist"), true);
  assert.equal(prompt.includes("Never turn uncertainty into CONTINUE"), true);
  assert.equal(prompt.includes("reasonCode AMBIGUOUS"), true);
  assert.equal(capturedBody.temperature, 0);
});
