import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readDist(path) {
  return readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
}

test("provider UI exposes real classifier readiness and bounded model catalog suggestions", async () => {
  const [html, providerScript, backgroundScript, styles] = await Promise.all([
    readDist("sidepanel/index.html"),
    readDist("sidepanel/provider-ui.js"),
    readDist("background/index.js"),
    readDist("sidepanel/styles.css"),
  ]);

  assert.match(html, /data-provider-model-catalog-field-v2/);
  assert.match(html, /data-provider-model-list-v2/);
  assert.match(html, /size="8"/);
  assert.doesNotMatch(html, /<datalist/i);
  assert.doesNotMatch(html, /list="provider-model-catalog-v2"/);
  assert.match(styles, /\.model-catalog-list/);
  assert.match(styles, /max-height:\s*14rem/);
  assert.match(providerScript, /Test classifier/);
  assert.match(providerScript, /panel:provider-classifier-readiness-request/);
  assert.match(backgroundScript, /isPanelProviderClassifierReadinessRequest/);
  assert.match(backgroundScript, /background:provider-classifier-readiness/);
  assert.equal(providerScript.includes(".innerHTML"), false);
});

test("individual open-chat cards are closed details disclosures by default", async () => {
  const [script, styles] = await Promise.all([
    readDist("sidepanel/index.js"),
    readDist("sidepanel/styles.css"),
  ]);
  assert.match(script, /createChatDisclosure/);
  assert.match(script, /"details", "chat-card-disclosure"/);
  assert.doesNotMatch(script, /disclosure\.open\s*=\s*true/);
  assert.match(styles, /\.chat-card-disclosure/);
  assert.match(styles, /content:\s*"Expand"/);
});

test("current-tab healthy toggles use the direct policy decision helper", async () => {
  const script = await readDist("sidepanel/current-tab-ui.js");
  assert.match(script, /directCurrentTabMode/);
  assert.doesNotMatch(script, /tryDirectDisable/);
});
