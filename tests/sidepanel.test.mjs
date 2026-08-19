import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readDist(path) {
  return readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
}

test("Side Panel exposes the MVP management controls", async () => {
  const [html, script] = await Promise.all([
    readDist("sidepanel/index.html"),
    readDist("sidepanel/index.js"),
  ]);

  for (const marker of [
    "data-pause-all",
    "data-current-tab",
    "data-chat-list",
    "data-defaults-form",
    "data-provider-list",
    "data-provider-form",
  ]) {
    assert.match(html, new RegExp(marker));
  }

  for (const messageType of [
    "panel:overview-request",
    "panel:automation-policy-update",
    "panel:automation-defaults-update",
    "panel:emergency-pause-update",
    "panel:provider-profile-upsert",
    "panel:provider-profile-remove",
    "panel:provider-order-update",
  ]) {
    assert.match(script, new RegExp(messageType));
  }

  assert.match(script, /chrome\.permissions\.request/);
  assert.match(script, /chrome\.tabs\.update/);
  assert.equal(script.includes(".innerHTML"), false, "chat/provider metadata should be rendered with textContent-safe DOM APIs");
});
