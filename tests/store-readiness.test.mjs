import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function readText(relativePath) {
  return readFile(resolve(repoRoot, relativePath), "utf8");
}

function pngDimensions(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function executableFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await executableFiles(absolute));
    else if ([".js", ".html"].includes(extname(entry.name))) files.push(absolute);
  }
  return files;
}

test("manifest and public release metadata stay aligned with the implemented permission model", async () => {
  const [packageJsonText, packageLockText, manifestText, listing, privacy] = await Promise.all([
    readText("package.json"),
    readText("package-lock.json"),
    readText("dist/manifest.json"),
    readText("docs/CHROME_WEB_STORE_LISTING.md"),
    readText("PRIVACY.md"),
  ]);
  const packageJson = JSON.parse(packageJsonText);
  const packageLock = JSON.parse(packageLockText);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Chat Turn Guardian");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.length > 0);
  assert.deepEqual(manifest.permissions, ["storage", "sidePanel", "notifications", "offscreen", "clipboardWrite"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "https://chat.openai.com/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);

  for (const required of [
    "**`storage`**",
    "**`sidePanel`**",
    "**`notifications`**",
    "**`offscreen`**",
    "**`clipboardWrite`**",
    "**Persistent host access: `https://chatgpt.com/*`, `https://chat.openai.com/*`**",
    "**Optional host envelope: `https://*/*`**",
    "**No, this extension does not use remotely hosted executable code.**",
  ]) {
    assert.match(listing, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(privacy, /read-only with respect to ChatGPT/);
  assert.match(privacy, /does not sell user data/);
  assert.match(privacy, /OpenAI-compatible provider/);
  assert.match(privacy, /Telegram support is outbound notification-only/);
  assert.match(privacy, /clipboardWrite/);
});

test("Side Panel prominently discloses read-only provider and Telegram data handling", async () => {
  const [html, telegramUi] = await Promise.all([
    readText("dist/sidepanel/index.html"),
    readText("dist/sidepanel/telegram-ui.js"),
  ]);

  assert.match(html, /Privacy &amp; data/);
  assert.match(html, /Full transcripts are not stored/);
  assert.match(html, /minimized, secret-redacted context/);
  assert.match(html, /Telegram receives bounded notification metadata by default/);
  assert.match(html, /Guardian never writes to ChatGPT/);
  assert.match(html, /github\.com\/ach1992\/chat-turn-guardian\/blob\/main\/PRIVACY\.md/);
  assert.match(telegramUi, /never sends full ChatGPT messages and accepts no inbound commands/);
});

test("packaged extension contains no obvious remotely hosted executable code patterns", async () => {
  const patterns = [
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\bimportScripts\s*\(\s*["']https?:\/\//,
    /\bimport\s*\(\s*["']https?:\/\//,
    /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i,
  ];

  for (const file of await executableFiles(resolve(repoRoot, "dist"))) {
    const content = await readFile(file, "utf8");
    for (const pattern of patterns) assert.doesNotMatch(content, pattern, file);
  }
});

test("Chrome Web Store promotional assets have the documented exact dimensions", async () => {
  const assets = [
    ["store-assets/small-promo-440x280.png", 440, 280],
    ["store-assets/marquee-1400x560.png", 1400, 560],
  ];
  for (const [relativePath, width, height] of assets) {
    const buffer = await readFile(resolve(repoRoot, relativePath));
    assert.deepEqual(pngDimensions(buffer), { width, height });
  }
});
