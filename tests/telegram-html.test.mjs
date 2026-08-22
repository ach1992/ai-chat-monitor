import test from "node:test";
import assert from "node:assert/strict";

import { telegramNotificationText } from "../dist/notifications/manager.js";
import { TelegramBotApiTransport } from "../dist/notifications/telegram.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc123";

function notification(overrides = {}) {
  return {
    id: "guardian:test-html",
    event: "APPROVAL_REQUIRED",
    title: "Approval required",
    message: "The monitored chat is waiting for human approval.",
    browserEnabled: true,
    conversationId: "conversation-1234567890",
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Telegram notification HTML emphasizes event and conversation identity", () => {
  const text = telegramNotificationText(notification());
  assert.match(text, /^<b>🛡️ Chat Turn Guardian<\/b>/);
  assert.match(text, /<b>👤 Approval required<\/b>/);
  assert.match(text, /<b>💬 Conversation<\/b>\n<code>conversation-1234567890<\/code>/);
  assert.ok(text.length <= 700);
});

test("Telegram notification HTML escapes dynamic text and keeps markup balanced", () => {
  const text = telegramNotificationText(notification({
    title: 'Needs <review> & "approval"',
    message: "Unsafe <b>injected</b> & details",
    conversationId: "chat<&>42",
  }));
  assert.match(text, /Needs &lt;review&gt; &amp; &quot;approval&quot;/);
  assert.match(text, /Unsafe &lt;b&gt;injected&lt;\/b&gt; &amp; details/);
  assert.match(text, /<code>chat&lt;&amp;&gt;42<\/code>/);
  assert.doesNotMatch(text, /<b>injected<\/b>/);
  assert.ok(text.length <= 700);
});

test("Telegram transport requests HTML parse mode", async () => {
  const calls = [];
  const transport = new TelegramBotApiTransport(async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ ok: true, result: { message_id: 1 } });
  });

  await transport.send(TOKEN, "123456789", "<b>Guardian</b>");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    chat_id: "123456789",
    text: "<b>Guardian</b>",
    parse_mode: "HTML",
  });
});
