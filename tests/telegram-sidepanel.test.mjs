import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readDist(path) {
  return readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
}

test("Side Panel exposes Telegram v1 configuration without rendering the saved secret", async () => {
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
    "Assistant response completed",
    "HOLD / human attention required",
    "Provider error",
    "Extension / platform error",
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

test("Telegram draft actions preserve unsaved form state and Test uses the current form", async () => {
  const [ui, background] = await Promise.all([
    readDist("sidepanel/telegram-ui.js"),
    readDist("notifications/background.js"),
  ]);

  assert.match(ui, /let dirty = false/);
  assert.match(ui, /render\(settings, !dirty\)/);
  assert.match(ui, /function collectMutation\(\)/);
  assert.match(ui, /panel:telegram-test-notification[\s\S]*settings: mutation/);
  assert.match(ui, /Save settings to keep these values/);
  assert.match(ui, /ui\.save\.disabled = value/);
  assert.match(ui, /actions\.style\.gap = "0\.5rem"/);
  assert.match(background, /manager\.testTelegram\(request\.settings\)/);
});

test("Privacy disclosure is collapsed and moved to the bottom of the Side Panel at runtime", async () => {
  const ui = await readDist("sidepanel/telegram-ui.js");
  assert.match(ui, /relocatePrivacyDisclosure/);
  assert.match(ui, /"details", "panel-section disclosure privacy-disclosure"/);
  assert.match(ui, /details\.open = false/);
  assert.match(ui, /footer\.before\(details\)/);
});
