import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readDist(path) {
  return readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
}

test("Side Panel exposes outbound-only Telegram monitoring configuration without rendering the saved secret", async () => {
  const [html, ui, background, transport, worker] = await Promise.all([
    readDist("sidepanel/index.html"),
    readDist("sidepanel/telegram-ui.js"),
    readDist("notifications/background.js"),
    readDist("notifications/telegram.js"),
    readDist("background/worker.js"),
  ]);

  assert.match(html, /telegram-ui\.js/);
  for (const marker of [
    "Enable Telegram notifications",
    "Chat ID / destination",
    "Bot Token",
    "Test notification",
    "Response completed",
    "Approval required",
    "Retry available",
    "Task complete",
    "Provider error",
    "@BotFather",
    "outbound-only",
  ]) {
    assert.match(ui, new RegExp(marker.replaceAll("/", "\\/")));
  }

  for (const messageType of [
    "panel:telegram-settings-request",
    "panel:telegram-settings-update",
    "panel:telegram-test-notification",
  ]) {
    assert.match(ui, new RegExp(messageType));
    assert.match(background, new RegExp(messageType));
  }

  assert.match(ui, /TELEGRAM_ORIGIN_PATTERN/);
  assert.match(transport, /https:\/\/api\.telegram\.org\/\*/);
  assert.match(ui, /chrome\.permissions\.request/);
  assert.match(background, /sender\.tab === undefined/);
  assert.match(worker, /notifications\/background\.js/);
  assert.equal(ui.includes(".innerHTML"), false);
  assert.doesNotMatch(ui, /token\.value\s*=\s*settings/);
  assert.doesNotMatch(ui, /getUpdates|webhook/i);
  assert.doesNotMatch(background, /getUpdates|webhook/i);
});

test("Telegram Test uses the current unsaved form while recurring refresh preserves dirty input", async () => {
  const [ui, background] = await Promise.all([
    readDist("sidepanel/telegram-ui.js"),
    readDist("notifications/background.js"),
  ]);

  assert.match(ui, /let dirty = false/);
  assert.match(ui, /render\(settings, !dirty\)/);
  assert.match(ui, /function collectMutation\(\)/);
  assert.match(ui, /panel:telegram-test-notification/);
  assert.match(ui, /settings: collectMutation\(\)/);
  assert.match(ui, /ui\.save\.disabled = value/);
  assert.match(background, /manager\.testTelegram\(request\.settings\)/);
});

test("Telegram Save and Test actions expose visible working, success, and error feedback", async () => {
  const ui = await readDist("sidepanel/telegram-ui.js");
  for (const marker of [
    "Saving Telegram settings",
    "Saved ✓",
    "Save failed",
    "Sending Telegram test notification",
    "Delivered ✓",
    "Test failed",
    "actionState",
    "operation-status telegram-operation-status",
  ]) {
    assert.match(ui, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Telegram UI keeps privacy disclosure near the bottom and collapsed", async () => {
  const ui = await readDist("sidepanel/telegram-ui.js");
  assert.match(ui, /relocatePrivacyDisclosure/);
  assert.match(ui, /details\.open = false/);
  assert.match(ui, /footer\.before\(details\)/);
});