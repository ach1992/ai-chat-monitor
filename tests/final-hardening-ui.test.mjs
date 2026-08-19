import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readDist(path) {
  return readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
}

test("provider UI exposes real classifier readiness and a searchable bounded model combobox", async () => {
  const [html, providerScript, backgroundScript, styles] = await Promise.all([
    readDist("sidepanel/index.html"),
    readDist("sidepanel/provider-ui.js"),
    readDist("background/index.js"),
    readDist("sidepanel/styles.css"),
  ]);

  assert.match(html, /data-provider-model-catalog-field-v2/);
  assert.match(html, /data-provider-model-list-v2/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-autocomplete="list"/);
  assert.match(html, /size="6"/);
  assert.doesNotMatch(html, /<datalist/i);
  assert.doesNotMatch(html, /list="provider-model-catalog-v2"/);
  assert.match(styles, /\.model-catalog-field\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.model-catalog-list\s*\{[^}]*max-height:\s*10rem/s);
  assert.match(providerScript, /matchingCatalogModels/);
  assert.match(providerScript, /toLowerCase\(\)\.includes\(query\)/);
  assert.match(providerScript, /modelInput\.addEventListener\("input"/);
  assert.match(providerScript, /setCatalogExpanded/);
  assert.match(providerScript, /Test classifier/);
  assert.match(providerScript, /panel:provider-classifier-readiness-request/);
  assert.match(backgroundScript, /isPanelProviderClassifierReadinessRequest/);
  assert.match(backgroundScript, /background:provider-classifier-readiness/);
  assert.equal(providerScript.includes(".innerHTML"), false);
});

test("automatic composer refocus is gated while explicit human focus intent remains observable", async () => {
  const contentScript = await readDist("content/index.js");

  assert.match(contentScript, /FOCUS_INTENT_WINDOW_MS/);
  assert.match(contentScript, /consumeRecentKeyboardFocusIntent/);
  assert.match(contentScript, /consumeRecentKeyboardFocusIntent\(performance\.now\(\)\)/);
  assert.match(contentScript, /event\.key === "Tab"/);
  assert.match(contentScript, /lastKeyboardFocusIntentAt = performance\.now\(\)/);
  assert.match(contentScript, /adapter\.isComposerTarget\(event\.target\).*emitUserInteraction\("COMPOSER_FOCUS"\)/s);
  assert.match(contentScript, /"beforeinput", "input", "paste", "compositionstart"/);
  assert.match(contentScript, /emitUserInteraction\("MANUAL_SEND"\)/);
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

test("final spacing pass keeps explanatory text separated from following controls", async () => {
  const styles = await readDist("sidepanel/styles.css");
  assert.match(styles, /\.disclosure > \.section-note\s*\{[^}]*margin-bottom:\s*0\.15rem/s);
  assert.match(styles, /\.provider-editor-v2 \.section-note\s*\{[^}]*margin-top:\s*0\.35rem/s);
});
