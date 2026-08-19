import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readDist(path) {
  return readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
}

test("Side Panel exposes the MVP management and reliability controls", async () => {
  const [html, script, reliabilityScript, currentTabScript, contentScript] = await Promise.all([
    readDist("sidepanel/index.html"),
    readDist("sidepanel/index.js"),
    readDist("sidepanel/reliability.js"),
    readDist("sidepanel/current-tab-ui.js"),
    readDist("content/index.js"),
  ]);

  for (const marker of [
    "data-pause-all",
    "data-current-tab",
    "data-current-tab-live",
    "data-chat-list",
    "data-defaults-form",
    "data-provider-list",
    "data-provider-form",
    "data-fuse-default-form",
    "data-fuse-chat-list",
    "data-audit-list",
    "data-audit-clear",
  ]) {
    assert.match(html, new RegExp(marker));
  }

  assert.match(html, /Guardian for this tab/);
  assert.match(html, /class="panel-section disclosure"/);
  assert.match(html, /current-tab-ui\.js/);

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

  for (const messageType of [
    "panel:overview-request",
    "panel:automation-policy-update",
    "panel:automation-defaults-update",
    "panel:audit-clear",
  ]) {
    assert.match(reliabilityScript, new RegExp(messageType));
  }

  for (const marker of [
    "Turn Guardian ON",
    "Turn Guardian OFF",
    "panel:agent-probe",
    "panel:agent-reconnect",
    "panel:automation-policy-update",
    "chrome.tabs.reload",
    "chrome.tabs.onActivated",
    "chrome.tabs.onUpdated",
    "setInterval",
  ]) {
    assert.match(currentTabScript, new RegExp(marker.replaceAll(".", "\\.")));
  }

  assert.match(contentScript, /panel:agent-probe/);
  assert.match(contentScript, /panel:agent-reconnect/);
  assert.match(contentScript, /content:agent-reconnected/);
  assert.match(script, /chrome\.permissions\.request/);
  assert.match(script, /chrome\.tabs\.update/);
  assert.equal(script.includes(".innerHTML"), false, "chat/provider metadata should be rendered with textContent-safe DOM APIs");
  assert.equal(currentTabScript.includes(".innerHTML"), false, "current-tab metadata should be rendered with textContent-safe DOM APIs");
  assert.equal(reliabilityScript.includes(".innerHTML"), false, "audit metadata should be rendered with textContent-safe DOM APIs");
  assert.doesNotMatch(reliabilityScript, /apiKey|normalizedText|latestAssistant/);
});
