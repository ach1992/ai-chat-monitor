import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ReliabilityService } from "../dist/reliability/service.js";

async function readDist(path) {
  return readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
}

test("browser notification uses a Chromium-compatible raster data URL", async () => {
  let captured;
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {},
    notifications: {
      create(notificationId, options, callback) {
        captured = { notificationId, options };
        callback?.(notificationId);
      },
    },
  };

  try {
    await ReliabilityService.browserNotify({
      id: "guardian:test",
      title: "Chat Turn Guardian",
      message: "Finished.",
    });
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }

  assert.equal(captured.notificationId, "guardian:test");
  assert.match(captured.options.iconUrl, /^data:image\/png;base64,/);
  assert.doesNotMatch(captured.options.iconUrl, /image\/svg\+xml/);
});

test("Side Panel live-hardening UX is wired without broadening browser authority", async () => {
  const [html, css, availability, worker, providerUi, currentTabUi, manifestText] = await Promise.all([
    readDist("sidepanel/index.html"),
    readDist("sidepanel/styles.css"),
    readDist("background/sidepanel-availability.js"),
    readDist("background/worker.js"),
    readDist("sidepanel/provider-ui.js"),
    readDist("sidepanel/current-tab-ui.js"),
    readDist("manifest.json"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.match(html, /id="provider-editor-v2"[^>]*hidden/);
  assert.match(html, /data-provider-add-v2[^>]*aria-expanded="false"/);
  assert.match(html, /pattern="\[-A-Za-z0-9_\]\+"/);
  assert.doesNotMatch(html, /pattern="\[A-Za-z0-9_-\]\+"/);
  assert.doesNotMatch(html, /availability\.js/);

  const listIndex = html.indexOf("data-provider-list-v2");
  const addIndex = html.indexOf("data-provider-add-v2");
  const formIndex = html.indexOf("id=\"provider-editor-v2\"");
  assert.equal(listIndex >= 0 && listIndex < addIndex && addIndex < formIndex, true);

  assert.match(providerUi, /setEditorVisible/);
  assert.match(providerUi, /resetEditor\(false\)/);
  assert.match(providerUi, /resetEditor\(true\)/);
  assert.match(currentTabUi, /clearStaleFailureIfRecovered/);
  assert.match(currentTabUi, /refreshButton\.addEventListener/);

  assert.equal(manifest.background.service_worker, "background/worker.js");
  assert.match(worker, /\.\/index\.js/);
  assert.match(worker, /\.\/sidepanel-availability\.js/);
  assert.match(availability, /chrome\.sidePanel\.setOptions/);
  assert.match(availability, /panel:agent-reconnect/);
  assert.match(availability, /changeInfo\.status\s*===\s*"complete"/);
  assert.match(availability, /chatgpt\.com/);
  assert.match(availability, /chat\.openai\.com/);
  assert.match(availability, /enabled/);
  assert.doesNotMatch(availability, /chrome\.scripting|executeScript/);

  assert.match(css, /\.provider-add-row\s*\{[^}]*justify-content:\s*stretch/s);
  assert.match(css, /\.audit-heading\s*\{[^}]*margin-bottom:\s*0\.4rem/s);
});
