import test from "node:test";
import assert from "node:assert/strict";
import { directCurrentTabMode } from "../dist/sidepanel/current-tab.js";

test("healthy current-tab policy transitions are direct while stale enable still requires recovery", () => {
  assert.equal(directCurrentTabMode("OFF", true, true, "conv-7"), "OBSERVE");
  assert.equal(directCurrentTabMode("OBSERVE", true, true, "conv-7"), "OBSERVE");
  assert.equal(directCurrentTabMode("AUTO", true, true, "conv-7"), "AUTO");
  assert.equal(directCurrentTabMode("OFF", true, false, "conv-7"), undefined);
  assert.equal(directCurrentTabMode("OBSERVE", false, false, "conv-7"), "OFF");
  assert.equal(directCurrentTabMode("OBSERVE", false, true, "conv-7"), "OFF");
  assert.equal(directCurrentTabMode("OFF", true, true, undefined), undefined);
});
