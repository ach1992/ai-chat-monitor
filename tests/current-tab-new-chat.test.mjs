import test from "node:test";
import assert from "node:assert/strict";
import { ensureCurrentTabConnected } from "../dist/sidepanel/current-tab.js";

test("fresh ChatGPT new-chat identity fails with actionable guidance without reconnect or reload", async () => {
  let reconnects = 0;
  let reloads = 0;
  let reads = 0;
  let probes = 0;

  await assert.rejects(
    ensureCurrentTabConnected({
      now: () => 1000,
      readChat: async () => { reads += 1; return undefined; },
      probe: async () => { probes += 1; return { routeKey: "/" }; },
      requestReconnect: async () => { reconnects += 1; return true; },
      reload: async () => { reloads += 1; },
      wait: async () => undefined,
    }, 41, { expectedRouteKey: "/" }),
    /Send the first message.*conversation identity.*turn Guardian ON/i,
  );

  assert.equal(reads, 1);
  assert.equal(probes, 1);
  assert.equal(reconnects, 0);
  assert.equal(reloads, 0);
});
