import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function readTreeText(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(await readTreeText(path));
    else if (/\.(?:js|json)$/.test(entry.name)) chunks.push(await readFile(path, "utf8"));
  }
  return chunks.join("\n");
}

test("content and background runtime expose no ChatGPT write command or composer mutation path", async () => {
  const content = await readTreeText(fileURLToPath(new URL("../dist/content", import.meta.url)));
  const background = await readTreeText(fileURLToPath(new URL("../dist/background", import.meta.url)));
  const protocol = await readFile(new URL("../dist/shared/protocol.js", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../dist/manifest.json", import.meta.url), "utf8"));

  for (const text of [content, background, protocol]) {
    assert.doesNotMatch(text, /background:guarded-send/);
    assert.doesNotMatch(text, /PROTOCOL_BOOTSTRAP|STATUS_RESPONSE|STATUS_RECOVERY/);
  }

  assert.doesNotMatch(content, /\bguardedSend\b/);
  assert.doesNotMatch(content, /\bsetComposerText\b/);
  assert.doesNotMatch(content, /\.click\s*\(/);
  assert.doesNotMatch(content, /dispatchEvent\s*\(\s*new\s+InputEvent/);

  const scripts = manifest.content_scripts.flatMap((entry) => entry.js ?? []);
  assert.deepEqual(scripts, ["content/adapter.js", "content/index.js"]);
  assert.equal(scripts.some((path) => /send-verification|guarded/i.test(path)), false);
});

test("the extension may observe ChatGPT controls but never exposes an inbound mutation action", async () => {
  const adapter = await readFile(new URL("../dist/content/adapter.js", import.meta.url), "utf8");
  const agent = await readFile(new URL("../dist/content/index.js", import.meta.url), "utf8");

  assert.match(adapter, /retryAvailable/);
  assert.match(adapter, /continueGeneratingAvailable/);
  assert.match(agent, /content:observation/);
  assert.doesNotMatch(agent, /continuationText|decisionId|expiresAt/);
});
