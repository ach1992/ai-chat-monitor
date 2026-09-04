import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readDist(path) {
  return readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
}

test("managed-chat diagnostic badges wrap inside the Side Panel card", async () => {
  const [html, css] = await Promise.all([
    readDist("sidepanel/index.html"),
    readDist("sidepanel/diagnostics.css"),
  ]);

  assert.match(html, /href="\.\/diagnostics\.css"/);
  assert.match(css, /\.chat-card \.meta-row \.badge/);
  assert.match(css, /max-width:\s*100%/);
  assert.match(css, /white-space:\s*normal/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});
