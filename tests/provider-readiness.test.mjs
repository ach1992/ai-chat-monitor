import test from "node:test";
import assert from "node:assert/strict";
import { testProviderClassifierReadiness } from "../dist/providers/readiness.js";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  createOpenAICompatibleProfile,
} from "../dist/providers/settings.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("default provider timeout leaves bounded headroom beyond the live-proven 12 second response boundary", () => {
  assert.equal(DEFAULT_PROVIDER_TIMEOUT_MS, 30_000);
  assert.equal(DEFAULT_PROVIDER_TIMEOUT_MS <= 60_000, true);
});

test("classifier readiness uses the exact configured model and production chat-completions parser with synthetic context only", async () => {
  const profile = createOpenAICompatibleProfile({
    id: "readiness",
    baseUrl: "https://api.example.test/v1",
    apiKey: "readiness-secret-key",
    model: "configured-model",
  });
  let captured;
  const result = await testProviderClassifierReadiness(profile, async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: "HOLD",
            reasonCode: "MATERIAL_DECISION_REQUIRED",
            reason: "A human choice is required.",
            confidence: 0.99,
          }),
        },
      }],
    });
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, "readiness");
  assert.equal(result.model, "configured-model");
  assert.equal(result.decision, "HOLD");
  assert.equal(result.reasonCode, "MATERIAL_DECISION_REQUIRED");
  assert.equal(captured.url, "https://api.example.test/v1/chat/completions");
  assert.equal(captured.init.redirect, "error");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, "configured-model");
  assert.equal(body.messages[1].content.includes("Synthetic classifier readiness check only"), true);
  assert.equal(body.messages[1].content.includes("readiness-secret-key"), false);
  assert.equal(JSON.stringify(result).includes("readiness-secret-key"), false);
});

test("classifier readiness failures are sanitized and never echo provider response bodies or secrets", async () => {
  const profile = createOpenAICompatibleProfile({
    id: "readiness-failure",
    baseUrl: "https://api.example.test/v1",
    apiKey: "do-not-leak-readiness-key",
    model: "configured-model",
  });

  const rateLimited = await testProviderClassifierReadiness(
    profile,
    async () => new Response("do-not-leak-readiness-key echoed by provider", { status: 429 }),
  );
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.code, "RATE_LIMITED");
  assert.equal(JSON.stringify(rateLimited).includes("do-not-leak-readiness-key"), false);

  const networkFailure = await testProviderClassifierReadiness(profile, async () => {
    throw new Error("socket failure with do-not-leak-readiness-key");
  });
  assert.equal(networkFailure.ok, false);
  assert.equal(networkFailure.code, "NETWORK_ERROR");
  assert.equal(JSON.stringify(networkFailure).includes("do-not-leak-readiness-key"), false);
});
