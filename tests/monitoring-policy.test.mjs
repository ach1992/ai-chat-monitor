import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MONITORING_POLICY,
  MonitoringPolicyRepository,
  migrateLegacyAutomationPolicy,
} from "../dist/monitoring/policy.js";

test("legacy automation modes migrate to monitoring-only enablement", () => {
  const migrated = migrateLegacyAutomationPolicy({
    version: 1,
    revision: 7,
    defaults: { notificationTriggers: ["RESPONSE_FINISHED", "ERROR"] },
    chats: [
      { conversationId: "chat-off", mode: "OFF" },
      { conversationId: "chat-observe", mode: "OBSERVE", notificationTriggers: ["HOLD"] },
      { conversationId: "chat-notify", mode: "NOTIFY_ONLY" },
      { conversationId: "chat-auto", mode: "AUTO" },
    ],
  });

  assert.equal(migrated.version, 2);
  assert.equal(migrated.revision, 7);
  assert.equal(migrated.chats.find((chat) => chat.conversationId === "chat-off").enabled, false);
  assert.equal(migrated.chats.find((chat) => chat.conversationId === "chat-observe").enabled, true);
  assert.equal(migrated.chats.find((chat) => chat.conversationId === "chat-notify").enabled, true);
  assert.equal(migrated.chats.find((chat) => chat.conversationId === "chat-auto").enabled, true);
  assert.ok(migrated.defaults.browserEvents.includes("RESPONSE_COMPLETE"));
  assert.ok(migrated.defaults.browserEvents.includes("PLATFORM_ERROR"));
  assert.ok(migrated.chats.find((chat) => chat.conversationId === "chat-observe").browserEvents.includes("APPROVAL_REQUIRED"));
});

test("new monitoring defaults contain no continuation authority", () => {
  const serialized = JSON.stringify(DEFAULT_MONITORING_POLICY);
  assert.doesNotMatch(serialized, /AUTO|continuationText|continueDelay|cooldown|hardFuse|emergencyPaused/);
  assert.deepEqual(DEFAULT_MONITORING_POLICY.defaults.soundEvents, []);
  assert.equal(DEFAULT_MONITORING_POLICY.defaults.stallThresholdMs, 300_000);
});

test("repository resolves sparse per-chat monitoring overrides", async () => {
  let stored;
  const repository = new MonitoringPolicyRepository({
    load: async () => stored,
    save: async (state) => { stored = structuredClone(state); },
  });
  await repository.restore();
  await repository.updateChat("chat-1234", {
    enabled: true,
    soundEvents: ["TASK_COMPLETE"],
    stallThresholdMs: 90_000,
  });

  const resolved = repository.resolve("chat-1234");
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.soundEvents, ["TASK_COMPLETE"]);
  assert.equal(resolved.stallThresholdMs, 90_000);
  assert.deepEqual(resolved.browserEvents, DEFAULT_MONITORING_POLICY.defaults.browserEvents);
});
