import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../dist/providers/openai-compatible.js";
import { ProviderManager } from "../dist/providers/manager.js";
import { createOpenAICompatibleProfile } from "../dist/providers/settings.js";
import { ProviderFailure } from "../dist/providers/types.js";

const request = {
  context: {
    turns: [{ role: "assistant", content: "ambiguous", originalLength: 9, truncated: false }],
    totalCharacters: 9,
    truncated: false,
  },
};

function provider(fetchImpl, options = {}) {
  return new OpenAICompatibleProvider(
    createOpenAICompatibleProfile({
      id: options.id ?? "test",
      baseUrl: "https://api.example.test/v1",
      apiKey: "secret-key-value",
      model: "model",
      timeoutMs: options.timeoutMs ?? 1000,
    }),
    fetchImpl,
  );
}

test("invalid provider JSON/schema is an operational failure, never a continuation", async () => {
  const invalidJson = provider(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 }),
  );
  await assert.rejects(
    invalidJson.classify(request),
    (error) => error instanceof ProviderFailure && error.code === "INVALID_RESPONSE",
  );

  const invalidSchema = provider(async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: "CONTINUE",
                reasonCode: "NEEDLESS_TURN_BOUNDARY",
                reason: "x",
                confidence: 1,
                action: "send",
              }),
            },
          },
        ],
      }),
      { status: 200 },
    ),
  );
  await assert.rejects(
    invalidSchema.classify(request),
    (error) => error instanceof ProviderFailure && error.code === "INVALID_RESPONSE",
  );
});

test("network failures fail closed when no fallback provider succeeds", async () => {
  const networkFailure = provider(async () => {
    throw new Error("socket failed and secret-key-value should not escape");
  });
  const manager = new ProviderManager([networkFailure]);
  const result = await manager.classify(request);
  assert.equal(result.decision, "UNSURE");
  assert.equal(result.reasonCode, "PROVIDER_FAILURE");
  assert.equal(result.reason.includes("secret-key-value"), false);
});

test("timeout aborts the provider request and manager returns UNSURE", async () => {
  const timedOut = provider(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    { timeoutMs: 1000 },
  );
  const startedAt = Date.now();
  const manager = new ProviderManager([timedOut]);
  const result = await manager.classify(request);
  assert.equal(result.decision, "UNSURE");
  assert.equal(result.reasonCode, "PROVIDER_FAILURE");
  assert.equal(Date.now() - startedAt >= 900, true);
});

test("valid semantic UNSURE is terminal and does not ask a fallback provider to overrule ambiguity", async () => {
  let fallbackCalls = 0;
  const first = {
    id: "first",
    async classify() {
      return {
        decision: "UNSURE",
        reasonCode: "AMBIGUOUS",
        reason: "Evidence is ambiguous.",
        source: "PROVIDER",
        confidence: 0.91,
        providerId: "first",
      };
    },
    async testConnection() {
      return { ok: true, code: "OK", message: "ok" };
    },
  };
  const fallback = {
    id: "fallback",
    async classify() {
      fallbackCalls += 1;
      return {
        decision: "CONTINUE",
        reasonCode: "NEEDLESS_TURN_BOUNDARY",
        reason: "continue",
        source: "PROVIDER",
        confidence: 1,
        providerId: "fallback",
      };
    },
    async testConnection() {
      return { ok: true, code: "OK", message: "ok" };
    },
  };
  const result = await new ProviderManager([first, fallback]).classify(request);
  assert.equal(result.decision, "UNSURE");
  assert.equal(fallbackCalls, 0);
});

test("timeout remains active while reading the response body", async () => {
  const stalledBody = provider(
    async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      async text() {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      },
    }),
    { timeoutMs: 1000 },
  );
  const result = await new ProviderManager([stalledBody]).classify(request);
  assert.equal(result.decision, "UNSURE");
  assert.equal(result.reasonCode, "PROVIDER_FAILURE");
});

test("oversized provider response is rejected before classification", async () => {
  const oversized = provider(async () =>
    new Response("x".repeat(64_001), {
      status: 200,
      headers: { "Content-Length": "64001" },
    }),
  );
  await assert.rejects(
    oversized.classify(request),
    (error) => error instanceof ProviderFailure && error.code === "INVALID_RESPONSE",
  );
});
