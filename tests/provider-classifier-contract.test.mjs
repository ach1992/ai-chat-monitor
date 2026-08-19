import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../dist/providers/openai-compatible.js";
import { ProviderManager } from "../dist/providers/manager.js";
import { createOpenAICompatibleProfile } from "../dist/providers/settings.js";
import { ProviderFailure } from "../dist/providers/types.js";

const request = {
  context: {
    turns: [
      {
        role: "user",
        content: "A real human choice is required before proceeding.",
        originalLength: 49,
        truncated: false,
      },
      {
        role: "assistant",
        content: "Please choose A or B before I continue.",
        originalLength: 39,
        truncated: false,
      },
    ],
    totalCharacters: 88,
    truncated: false,
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function profile() {
  return createOpenAICompatibleProfile({
    id: "contract",
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-secret",
    model: "reasoning-model",
  });
}

test("classifier request budgets reasoning output and pins the legal reason-code vocabulary", async () => {
  let capturedBody;
  const provider = new OpenAICompatibleProvider(profile(), async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return jsonResponse({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              decision: "HOLD",
              reasonCode: "MATERIAL_DECISION_REQUIRED",
              reason: "A real human choice is required.",
              confidence: 0.99,
            }),
          },
        },
      ],
    });
  });

  const result = await provider.classify(request);
  assert.equal(result.decision, "HOLD");
  assert.equal(capturedBody.temperature, 0);
  assert.equal(capturedBody.max_tokens, 1024);

  const prompt = capturedBody.messages[0].content;
  assert.equal(typeof prompt, "string");
  assert.equal(prompt.includes("Infer the user's active requested outcome"), true);
  assert.equal(prompt.includes("asking the user to say \"continue\" / \"go ahead\""), true);
  assert.equal(prompt.includes("another chat, person, or tool"), true);
  assert.equal(prompt.includes("Never turn uncertainty into CONTINUE"), true);
  assert.equal(prompt.includes("HUMAN_APPROVAL_REQUIRED"), true);
  assert.equal(prompt.includes("MATERIAL_DECISION_REQUIRED"), true);
  assert.equal(prompt.includes("HUMAN_OPERATION_REQUIRED"), true);
  assert.equal(prompt.includes("PROJECT_COMPLETE"), true);
  assert.equal(prompt.includes("RATE_LIMIT"), true);
  assert.equal(prompt.includes("NEEDLESS_TURN_BOUNDARY"), true);
  assert.equal(prompt.includes("AMBIGUOUS"), true);
  assert.equal(prompt.includes("HUMAN_CHOICE_REQUIRED"), false);
  assert.equal(prompt.includes('"reasonCode":"..."'), false);
});

test("output-budget exhaustion is a concrete invalid-response failure", async () => {
  const provider = new OpenAICompatibleProvider(profile(), async () =>
    jsonResponse({
      choices: [
        {
          finish_reason: "length",
          message: { content: null },
        },
      ],
    }),
  );

  await assert.rejects(
    provider.classify(request),
    (error) =>
      error instanceof ProviderFailure &&
      error.code === "INVALID_RESPONSE" &&
      error.message.includes("output budget"),
  );
});

test("all-provider failure preserves the last sanitized provider code and cause", async () => {
  const manager = new ProviderManager([
    {
      id: "router",
      async classify() {
        throw new ProviderFailure("RATE_LIMITED", "Provider rate limit was reached.");
      },
      async testConnection() {
        return { ok: false, code: "RATE_LIMITED", message: "Provider rate limit was reached." };
      },
    },
  ]);

  const result = await manager.classify(request);
  assert.equal(result.decision, "UNSURE");
  assert.equal(result.reasonCode, "PROVIDER_FAILURE");
  assert.equal(result.reason.includes("router"), true);
  assert.equal(result.reason.includes("RATE_LIMITED"), true);
  assert.equal(result.reason.includes("Provider rate limit was reached."), true);
});

test("unexpected provider exceptions never echo their raw error text", async () => {
  const manager = new ProviderManager([
    {
      id: "router",
      async classify() {
        throw new Error("do-not-leak-raw-provider-error");
      },
      async testConnection() {
        return { ok: false, code: "NETWORK_ERROR", message: "Provider connection failed." };
      },
    },
  ]);

  const result = await manager.classify(request);
  assert.equal(result.decision, "UNSURE");
  assert.equal(result.reasonCode, "PROVIDER_FAILURE");
  assert.equal(result.reason.includes("UNKNOWN"), true);
  assert.equal(result.reason.includes("do-not-leak-raw-provider-error"), false);
});
