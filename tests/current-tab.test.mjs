import test from "node:test";
import assert from "node:assert/strict";
import {
  currentTabIdentityMatches,
  desiredCurrentTabMode,
  ensureCurrentTabConnected,
  isSupportedChatGptUrl,
  shouldRefreshCurrentTabForUpdate,
} from "../dist/sidepanel/current-tab.js";

test("supported ChatGPT URL detection is exact and fail-closed", () => {
  assert.equal(isSupportedChatGptUrl("https://chatgpt.com/c/abc"), true);
  assert.equal(isSupportedChatGptUrl("https://chat.openai.com/c/abc"), true);
  assert.equal(isSupportedChatGptUrl("http://chatgpt.com/c/abc"), false);
  assert.equal(isSupportedChatGptUrl("https://evil.chatgpt.com/c/abc"), false);
  assert.equal(isSupportedChatGptUrl("https://example.com/?next=https://chatgpt.com"), false);
  assert.equal(isSupportedChatGptUrl(undefined), false);
});

test("current-tab identity requires exact route and conversation agreement", () => {
  const chat = { tabId: 7, conversationId: "conv-7", routeKey: "/c/conv-7", lastSeenAt: 100 };
  assert.equal(currentTabIdentityMatches(chat, { conversationId: "conv-7", routeKey: "/c/conv-7" }), true);
  assert.equal(currentTabIdentityMatches(chat, { conversationId: "conv-8", routeKey: "/c/conv-8" }), false);
  assert.equal(currentTabIdentityMatches(chat, { conversationId: "conv-7", routeKey: "/c/other" }), false);
  assert.equal(currentTabIdentityMatches(chat, { routeKey: "/" }), false);
  assert.equal(currentTabIdentityMatches(undefined, { conversationId: "conv-7", routeKey: "/c/conv-7" }), false);
});

test("current-tab ON starts in OBSERVE, preserves advanced modes, and OFF always disables", () => {
  assert.equal(desiredCurrentTabMode("OFF", true), "OBSERVE");
  assert.equal(desiredCurrentTabMode("OBSERVE", true), "OBSERVE");
  assert.equal(desiredCurrentTabMode("AUTO", true), "AUTO");
  assert.equal(desiredCurrentTabMode("NOTIFY_ONLY", true), "NOTIFY_ONLY");
  assert.equal(desiredCurrentTabMode("OBSERVE", false), "OFF");
  assert.equal(desiredCurrentTabMode("AUTO", false), "OFF");
  assert.equal(desiredCurrentTabMode("NOTIFY_ONLY", false), "OFF");
});

test("reactive tab refresh only follows meaningful updates for the active tab", () => {
  assert.equal(shouldRefreshCurrentTabForUpdate(7, 7, { status: "loading" }), true);
  assert.equal(shouldRefreshCurrentTabForUpdate(7, 7, { status: "complete" }), true);
  assert.equal(shouldRefreshCurrentTabForUpdate(7, 7, { url: "https://chatgpt.com/c/new" }), true);
  assert.equal(shouldRefreshCurrentTabForUpdate(7, 8, { status: "complete" }), false);
  assert.equal(shouldRefreshCurrentTabForUpdate(7, 7, {}), false);
  assert.equal(shouldRefreshCurrentTabForUpdate(undefined, 7, { status: "complete" }), false);
});

test("already connected exact tab does not reload or reconnect", async () => {
  const calls = [];
  const chat = { tabId: 7, conversationId: "conv-7", routeKey: "/c/conv-7", lastSeenAt: 100 };
  const result = await ensureCurrentTabConnected({
    now: () => 200,
    readChat: async (tabId) => { calls.push(["read", tabId]); return chat; },
    probe: async (tabId) => { calls.push(["probe", tabId]); return { conversationId: "conv-7", routeKey: "/c/conv-7" }; },
    requestReconnect: async (tabId) => { calls.push(["reconnect", tabId]); return true; },
    reload: async (tabId) => { calls.push(["reload", tabId]); },
    wait: async (delayMs) => { calls.push(["wait", delayMs]); },
  }, 7);

  assert.equal(result, chat);
  assert.deepEqual(calls, [["read", 7], ["probe", 7]]);
});

test("reachable agent with missing registry re-announces once and waits for fresh identity", async () => {
  const calls = [];
  const reads = [undefined, { tabId: 11, conversationId: "old", routeKey: "/c/old", lastSeenAt: 499 }, { tabId: 11, conversationId: "fresh", routeKey: "/c/fresh", lastSeenAt: 500 }];
  const result = await ensureCurrentTabConnected({
    now: () => 500,
    readChat: async (tabId) => { calls.push(["read", tabId]); return reads.shift(); },
    probe: async (tabId) => { calls.push(["probe", tabId]); return { conversationId: "fresh", routeKey: "/c/fresh" }; },
    requestReconnect: async (tabId) => { calls.push(["reconnect", tabId]); return true; },
    reload: async (tabId) => { calls.push(["reload", tabId]); },
    wait: async (delayMs) => { calls.push(["wait", delayMs]); },
  }, 11, { attempts: 3, intervalMs: 25 });

  assert.equal(result.conversationId, "fresh");
  assert.equal(calls.filter(([name]) => name === "reconnect").length, 1);
  assert.equal(calls.filter(([name]) => name === "reload").length, 0);
});

test("reachable route mismatch cannot trust stale registry and forces re-registration", async () => {
  const calls = [];
  const stale = { tabId: 19, conversationId: "conv-a", routeKey: "/c/conv-a", lastSeenAt: 700 };
  const fresh = { tabId: 19, conversationId: "conv-b", routeKey: "/c/conv-b", lastSeenAt: 801 };
  const reads = [stale, fresh];
  const result = await ensureCurrentTabConnected({
    now: () => 800,
    readChat: async (tabId) => { calls.push(["read", tabId]); return reads.shift(); },
    probe: async (tabId) => { calls.push(["probe", tabId]); return { conversationId: "conv-b", routeKey: "/c/conv-b" }; },
    requestReconnect: async (tabId) => { calls.push(["reconnect", tabId]); return true; },
    reload: async (tabId) => { calls.push(["reload", tabId]); },
    wait: async (delayMs) => { calls.push(["wait", delayMs]); },
  }, 19, { attempts: 2, intervalMs: 0 });

  assert.equal(result, fresh);
  assert.deepEqual(calls.filter(([name]) => name === "reconnect"), [["reconnect", 19]]);
  assert.equal(calls.filter(([name]) => name === "reload").length, 0);
});

test("stale registry with unreachable agent reloads once and rejects pre-reload state", async () => {
  const calls = [];
  const reads = [
    { tabId: 23, conversationId: "stale", routeKey: "/c/stale", lastSeenAt: 800 },
    { tabId: 23, conversationId: "stale", routeKey: "/c/stale", lastSeenAt: 800 },
    { tabId: 23, conversationId: "current", routeKey: "/c/current", lastSeenAt: 900 },
  ];
  const result = await ensureCurrentTabConnected({
    now: () => 900,
    readChat: async (tabId) => { calls.push(["read", tabId]); return reads.shift(); },
    probe: async (tabId) => { calls.push(["probe", tabId]); return undefined; },
    requestReconnect: async (tabId) => { calls.push(["reconnect", tabId]); return true; },
    reload: async (tabId) => { calls.push(["reload", tabId]); },
    wait: async (delayMs) => { calls.push(["wait", delayMs]); },
  }, 23, { attempts: 3, intervalMs: 25 });

  assert.equal(result.conversationId, "current");
  assert.deepEqual(calls.filter(([name]) => name === "reload"), [["reload", 23]]);
  assert.equal(calls.filter(([name]) => name === "reconnect").length, 0);
});

test("reconnect timeout is bounded and never falls through to a second recovery mutation", async () => {
  let reads = 0;
  let reloads = 0;
  let reconnects = 0;
  await assert.rejects(
    ensureCurrentTabConnected({
      now: () => 1000,
      readChat: async () => { reads += 1; return undefined; },
      probe: async () => undefined,
      requestReconnect: async () => { reconnects += 1; return true; },
      reload: async () => { reloads += 1; },
      wait: async () => undefined,
    }, 31, { attempts: 2, intervalMs: 0 }),
    /did not reconnect/,
  );
  assert.equal(reads, 3);
  assert.equal(reloads, 1);
  assert.equal(reconnects, 0);
});
