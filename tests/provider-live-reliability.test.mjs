import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../dist/providers/openai-compatible.js";
import { ProviderManager } from "../dist/providers/manager.js";
import {
  createNaraRouterProfile,
  createOpenAICompatibleProfile,
  createOpenRouterProfile,
} from "../dist/providers/settings.js";
import { ProviderFailure } from "../dist/providers/types.js";

const request = {
  context: {
    turns: [
      {
        role: "user",
        content: "Finish the already-authorized two-stage task.",
        originalLength: 45,
        truncated: false,
      },
      {
        role: "assistant",
        content: "Stage 1 complete. Say continue for Stage 2.",
        originalLength: 43,
        truncated: false,
      },
    ],
    totalCharacters: 88,
    truncated: false,
  },
};

function classificationContent(overrides = {}) {
  return JSON.stringify({
    decision: "CONTINUE",
    reasonCode: "NEEDLESS_TURN_BOUNDARY",
    reason: "The requested outcome is incomplete and no human boundary is present.",
    confidence: 0.99,
    ...overrides,
  });
}

function chatResponse(content) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("OpenRouter classifier requests strict structured output and capability-aware routing", async () => {
  let captured;
  const provider = new OpenAICompatibleProvider(
    createOpenRouterProfile({
      id: "main",
      apiKey: "openrouter-secret",
      model: "openrouter/free",
    }),
    async (url, init) => {
      captured = { url: String(url), init };
      return chatResponse(classificationContent());
    },
  );

  const result = await provider.classify(request);
  assert.equal(result.decision, "CONTINUE");
  assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.name, "guardian_stop_classification");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(body.response_format.json_schema.schema.properties.reason.maxLength, 240);
  assert.deepEqual(body.response_format.json_schema.schema.required, [
    "decision",
    "reasonCode",
    "reason",
    "confidence",
  ]);
  assert.deepEqual(body.provider, { require_parameters: true });
});

test("NaraRouter classifier uses low reasoning effort and accepts only a fenced wrapper around valid schema JSON", async () => {
  let capturedBody;
  const provider = new OpenAICompatibleProvider(
    createNaraRouterProfile({
      id: "backup",
      apiKey: "nara-secret",
      model: "mimo-v2.5-free",
    }),
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return chatResponse(`\`\`\`json\n${classificationContent({
        decision: "HOLD",
        reasonCode: "PROJECT_COMPLETE",
        reason: "The requested outcome is complete.",
      })}\n\`\`\``);
    },
  );

  const result = await provider.classify(request);
  assert.equal(result.decision, "HOLD");
  assert.equal(result.reasonCode, "PROJECT_COMPLETE");
  assert.equal(capturedBody.reasoning_effort, "low");
  assert.equal("response_format" in capturedBody, false, "NaraRouter docs do not guarantee structured-output support");
  assert.equal("provider" in capturedBody, false);
});

test("generic OpenAI-compatible providers keep the portable request shape", async () => {
  let capturedBody;
  const provider = new OpenAICompatibleProvider(
    createOpenAICompatibleProfile({
      id: "generic",
      baseUrl: "https://api.example.test/v1",
      apiKey: "generic-secret",
      model: "generic-model",
    }),
    async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return chatResponse(classificationContent());
    },
  );

  await provider.classify(request);
  assert.equal("response_format" in capturedBody, false);
  assert.equal("reasoning_effort" in capturedBody, false);
  assert.equal("provider" in capturedBody, false);
});

test("schema failure on the primary provider falls through to the configured backup", async () => {
  let backupCalls = 0;
  const primary = new OpenAICompatibleProvider(
    createOpenRouterProfile({ id: "main", apiKey: "main-secret", model: "openrouter/free" }),
    async () => chatResponse("not-json"),
  );
  const backup = new OpenAICompatibleProvider(
    createNaraRouterProfile({ id: "backup", apiKey: "backup-secret", model: "mimo-v2.5-free" }),
    async () => {
      backupCalls += 1;
      return chatResponse(classificationContent({
        decision: "HOLD",
        reasonCode: "MATERIAL_DECISION_REQUIRED",
        reason: "A material human choice is required.",
      }));
    },
  );

  const result = await new ProviderManager([primary, backup]).classify(request);
  assert.equal(backupCalls, 1);
  assert.equal(result.decision, "HOLD");
  assert.equal(result.reasonCode, "MATERIAL_DECISION_REQUIRED");
  assert.equal(result.providerId, "backup");
});

test("HTTP 408 is normalized as a provider timeout and remains fail-closed", async () => {
  const provider = new OpenAICompatibleProvider(
    createOpenAICompatibleProfile({
      id: "timeout",
      baseUrl: "https://api.example.test/v1",
      apiKey: "timeout-secret",
      model: "model",
    }),
    async () => new Response("", { status: 408 }),
  );

  await assert.rejects(
    provider.classify(request),
    (error) => error instanceof ProviderFailure && error.code === "TIMEOUT",
  );
});
