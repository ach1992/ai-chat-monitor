import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../dist/manifest.json", import.meta.url), "utf8"));

test("manifest is MV3 with the expected Side Panel and storage permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "114");
  assert.deepEqual([...manifest.permissions].sort(), ["sidePanel", "storage"]);
  assert.equal(manifest.side_panel.default_path, "sidepanel/index.html");
});

test("content scripts are constrained to ChatGPT hosts and no provider host permissions exist yet", () => {
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
  ]);
  assert.equal("host_permissions" in manifest, false);
});
