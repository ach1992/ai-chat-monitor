import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/background/index.ts", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../src/manifest.json", import.meta.url), "utf8"));

test("background investigation trace is bounded, ephemeral, and metadata-only", () => {
  assert.match(source, /createEphemeralStorage<BackgroundMonitoringDiagnosticTrace>\(\s*"background-monitoring-diagnostic"/);
  assert.match(source, /MAX_BACKGROUND_MONITORING_DIAGNOSTIC_ENTRIES = 256/);
  assert.match(source, /\.slice\(-MAX_BACKGROUND_MONITORING_DIAGNOSTIC_ENTRIES\)/);
  assert.doesNotMatch(source, /normalizedText/);
  assert.doesNotMatch(source, /chrome\.webRequest/);
  assert.doesNotMatch(source, /PerformanceResourceTiming/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test("background investigation trace does not expand Chrome permissions", () => {
  assert.deepEqual(manifest.permissions, ["storage", "sidePanel", "notifications", "offscreen", "clipboardWrite"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "https://chat.openai.com/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
});
