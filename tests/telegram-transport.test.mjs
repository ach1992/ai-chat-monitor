import test from "node:test";
import assert from "node:assert/strict";

import { TelegramBotApiTransport, TelegramDeliveryError } from "../dist/notifications/telegram.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc123";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Telegram transport uses HTTPS sendMessage POST with JSON chat_id, text, and HTML parse mode", async () => {
  const calls = [];
  const transport = new TelegramBotApiTransport(async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ ok: true, result: { message_id: 1 } });
  });

  await transport.send(TOKEN, "123456789", "bounded message");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    chat_id: "123456789",
    text: "bounded message",
    parse_mode: "HTML",
  });
  assert.equal(calls[0].init.redirect, "error");
});

test("Telegram default transport binds fetch to the global service-worker receiver", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let observedReceiver;
  globalThis.fetch = async function () {
    observedReceiver = this;
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return jsonResponse({ ok: true, result: { message_id: 1 } });
  };

  const transport = new TelegramBotApiTransport();
  await transport.send(TOKEN, "123456789", "bounded message");
  assert.equal(observedReceiver, globalThis);
});

test("Telegram rate limit and API descriptions are sanitized", async () => {
  const transport = new TelegramBotApiTransport(async () => jsonResponse({
    ok: false,
    error_code: 429,
    description: `secret ${TOKEN}`,
  }, 429));

  await assert.rejects(
    () => transport.send(TOKEN, "123456789", "test"),
    (error) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.code, "RATE_LIMIT");
      assert.doesNotMatch(error.message, /ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
      return true;
    },
  );
});

test("Telegram invalid destination remains a generic sanitized failure", async () => {
  const transport = new TelegramBotApiTransport(async () => jsonResponse({
    ok: false,
    error_code: 400,
    description: `Bad Request for ${TOKEN}: chat not found`,
  }, 400));

  await assert.rejects(
    () => transport.send(TOKEN, "123456789", "test"),
    (error) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.code, "DESTINATION");
      assert.equal(error.message, "Telegram rejected the configured destination or bot access.");
      assert.doesNotMatch(error.message, /chat not found|ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
      return true;
    },
  );
});

test("Telegram missing bot path is treated as a sanitized credential failure", async () => {
  const transport = new TelegramBotApiTransport(async () => jsonResponse({
    ok: false,
    error_code: 404,
    description: `Not Found for ${TOKEN}`,
  }, 404));

  await assert.rejects(
    () => transport.send(TOKEN, "123456789", "test"),
    (error) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.code, "AUTHENTICATION");
      assert.equal(error.message, "Telegram rejected the bot credential.");
      assert.doesNotMatch(error.message, /Not Found|ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
      return true;
    },
  );
});

test("Telegram timeout is bounded and does not retry", async () => {
  let attempts = 0;
  const transport = new TelegramBotApiTransport((_url, init) => {
    attempts += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }, 5);

  await assert.rejects(
    () => transport.send(TOKEN, "123456789", "test"),
    (error) => error instanceof TelegramDeliveryError && error.code === "TIMEOUT",
  );
  assert.equal(attempts, 1);
});
