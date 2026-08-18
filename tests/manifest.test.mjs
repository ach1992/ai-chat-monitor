import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../dist/manifest.json", import.meta.url), "utf8"));

test("manifest is MV3 with the expected Side Panel and storage permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "114");
  assert.deepEqual([...manifest.permissions].sort(), ["sidePanel", "storage"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal(manifest.side_panel.default_path, "sidepanel/index.html");
});

test("content scripts are constrained to ChatGPT hosts and load the adapter before the agent", () => {
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
  ]);
  assert.deepEqual(manifest.content_scripts[0].js, ["content/adapter.js", "content/index.js"]);
});
