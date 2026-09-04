import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readDist(path, encoding) {
  return readFile(new URL(`../dist/${path}`, import.meta.url), encoding);
}

function pngDimensions(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

test("toolbar action opens one global Side Panel while ChatGPT reconnect gating remains explicit", async () => {
  const [manifestText, availability] = await Promise.all([
    readDist("manifest.json", "utf8"),
    readDist("background/sidepanel-availability.js", "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.minimum_chrome_version, "114");
  assert.equal(manifest.side_panel.default_path, "sidepanel/index.html");
  assert.equal(manifest.action.default_title, "Open AI Chat Monitor");
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "https://chat.openai.com/*"]);
  assert.match(availability, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/);
  assert.match(availability, /setOptions\(\{ path: SIDE_PANEL_PATH, enabled: true \}\)/);
  assert.doesNotMatch(availability, /setOptions\(\{ enabled: false \}\)/);
  assert.match(availability, /new Set\(\["chatgpt\.com", "chat\.openai\.com"\]\)/);
  assert.match(availability, /if \(tabId === undefined \|\| !isSupportedChatGptUrl\(tab\.url\)\)/);
  assert.doesNotMatch(availability, /sidePanel\.open/);
});

test("manifest extension and action icons exist at their declared PNG dimensions", async () => {
  const manifest = JSON.parse(await readDist("manifest.json", "utf8"));
  const expected = {
    "16": "assets/icon-16.png",
    "32": "assets/icon-32.png",
    "48": "assets/icon-48.png",
    "128": "assets/icon-128.png",
  };
  assert.deepEqual(manifest.icons, expected);
  assert.deepEqual(manifest.action.default_icon, expected);

  for (const [sizeText, path] of Object.entries(expected)) {
    const size = Number(sizeText);
    const buffer = await readDist(path);
    assert.deepEqual(pngDimensions(buffer), { width: size, height: size });
  }
});
