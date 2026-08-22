import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readDist(path) {
  return readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
}

test("Side Panel exposes monitoring, compact protocol setup, notifications, providers, and event history", async () => {
  const [html, styles, script, providerScript, telegramScript, contentScript] = await Promise.all([
    readDist("sidepanel/index.html"),
    readDist("sidepanel/styles.css"),
    readDist("sidepanel/index.js"),
    readDist("sidepanel/provider-ui.js"),
    readDist("sidepanel/telegram-ui.js"),
    readDist("content/index.js"),
  ]);

  for (const marker of [
    "data-current-tab-live",
    "data-marker-health",
    "data-custom-instructions",
    "data-chat-instruction",
    "data-copy-custom",
    "data-copy-chat",
    "data-save-defaults",
    "data-browser-events",
    "data-sound-events",
    "data-chat-list",
    "data-reset-chats",
    "data-reset-status",
    "data-event-list",
    "data-history-clear",
    "data-provider-manager-v2",
  ]) {
    assert.match(html, new RegExp(marker));
  }

  assert.match(html, /Read-only chat monitor/i);
  assert.match(html, /Guardian still works when the marker is missing/i);
  assert.match(html, /Guardian only observes/i);
  assert.match(html, /never writes to ChatGPT/i);
  assert.match(html, /Only chats with monitoring enabled are shown here/i);
  assert.match(html, /protocol-preview/);
  assert.match(html, /Recommended/);
  assert.doesNotMatch(html, /Continuation text|Continue delay|hard fuse|Pause All|AUTO only sends/i);

  for (const messageType of [
    "panel:overview-request",
    "panel:monitoring-policy-update",
    "panel:monitoring-defaults-update",
    "panel:monitoring-chats-reset",
    "panel:history-clear",
  ]) {
    assert.match(script, new RegExp(messageType));
  }

  assert.match(script, /Confirm reset/);
  assert.match(script, /Copied/);
  assert.match(script, /Saving/);
  assert.match(script, /Refreshing/);
  assert.match(script, /CHAT_TURN_GUARDIAN_STATUS=\\?\{?[^\n]*decision/);
  assert.doesNotMatch(script, /CHAT_TURN_GUARDIAN_STATUS_V1=/);
  for (const decision of [
    "CONTINUE",
    "HOLD_APPROVAL",
    "HOLD_DECISION",
    "HOLD_HUMAN_OPERATION",
    "COMPLETE",
    "PLATFORM_ERROR",
    "RATE_LIMIT",
    "UNSURE",
  ]) {
    assert.match(script, new RegExp(decision));
  }
  assert.match(script, /exact, strict, or format-exclusive output/i);
  assert.match(script, /outside Markdown code fences/i);
  assert.match(script, /Do not use CONTINUE when a real human gate is required/i);

  for (const token of [
    "data-action-state",
    "badge[data-tone=",
    "--green:",
    "--amber:",
    "--red:",
    "--violet:",
    "--space-1:",
    "--space-4:",
    "chat-actions",
    "protocol-preview",
    "telegram-operation-status",
    "disclosure.panel-section",
    "disclosure[open] > summary",
    ":not(summary) + :not(summary)",
    "@media (max-width: 430px)",
    "@media (max-width: 350px)",
  ]) {
    assert.ok(styles.includes(token), `Expected responsive/color/spacing UX token: ${token}`);
  }
  assert.doesNotMatch(
    styles,
    /\.protocol-health-row\s*\{[^}]*margin-top:\s*-/s,
    "Protocol marker health must not use negative vertical spacing",
  );
  assert.match(styles, /\.panel-section\s*\{[^}]*gap:\s*0\.78rem/s);
  assert.match(styles, /\.disclosure\.panel-section\s*\{[^}]*gap:\s*0/s);
  assert.match(styles, /\.disclosure\[open\]\s*>\s*summary\s*\{[^}]*margin-bottom:\s*var\(--space-3\)/s);
  assert.match(styles, /\.disclosure\[open\]\s*>\s*:not\(summary\)\s*\+\s*:not\(summary\)\s*\{[^}]*margin-top:\s*var\(--space-3\)/s);
  assert.match(styles, /\.chat-list[^\{]*\{[^}]*gap:\s*0\.72rem/s);

  for (const messageType of [
    "panel:provider-model-catalog-request",
    "panel:provider-profile-upsert",
    "panel:provider-profile-remove",
    "panel:provider-order-update",
  ]) {
    assert.match(providerScript, new RegExp(messageType));
  }

  assert.match(telegramScript, /outbound-only/i);
  assert.match(telegramScript, /RETRY_AVAILABLE/);
  assert.match(telegramScript, /TASK_COMPLETE/);

  assert.match(contentScript, /panel:agent-probe/);
  assert.match(contentScript, /panel:agent-reconnect/);
  assert.doesNotMatch(contentScript, /background:guarded-send|continuationText|decisionId/);

  for (const source of [script, providerScript, telegramScript]) {
    assert.equal(source.includes(".innerHTML"), false, "Side Panel metadata must use textContent-safe DOM APIs");
  }
  assert.doesNotMatch(providerScript, /apiKeyInput\.value\s*=\s*profile/);
});