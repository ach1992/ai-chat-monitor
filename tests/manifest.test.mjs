import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../dist/manifest.json", import.meta.url), "utf8"));

test("manifest is MV3 with bounded monitoring and local notification permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "114");
  assert.deepEqual([...manifest.permissions].sort(), ["clipboardWrite", "notifications", "offscreen", "sidePanel", "storage"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
  ]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.permissions.includes("tabs"), false, "tab URL access remains host-scoped rather than requesting broad tabs permission");
  assert.equal(manifest.side_panel.default_path, "sidepanel/index.html");
  assert.match(manifest.description, /Monitors selected ChatGPT conversations/i);
  assert.match(manifest.description, /without sending chat messages/i);
});

test("content scripts are constrained to ChatGPT hosts and contain no send-verification runtime", () => {
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
  ]);
  assert.deepEqual(manifest.content_scripts[0].js, [
    "content/adapter.js",
    "content/index.js",
  ]);
  assert.equal(manifest.content_scripts[0].js.some((file) => /send|guarded/i.test(file)), false);
});
