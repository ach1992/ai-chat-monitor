import test from "node:test";
import assert from "node:assert/strict";
import { toHiddenMonitoringDiagnosticView } from "../dist/background/hidden-diagnostics.js";

test("public hidden diagnostics expose bounded timing while redacting fingerprints and transcript-like fields", () => {
  const internal = {
    backgroundedAt: 100,
    foregroundedAt: 300,
    tabActivatedAt: 280,
    visibleObservedAt: 305,
    baselineAssistantFingerprint: "a".repeat(64),
    baselineAssistantTextLength: 10,
    hiddenObservationCount: 2,
    firstHiddenObservationAt: 120,
    lastHiddenObservationAt: 250,
    firstAssistantChangeAt: 150,
    firstMarkerDetectedAt: 240,
    hiddenAssistantFingerprint: "b".repeat(64),
    hiddenAssistantTextLength: 80,
    assistantChanged: true,
    hiddenGeneration: "IDLE",
    hiddenStopControlPresent: true,
    hiddenMarkerHealth: "DETECTED",
    transportCompletedAt: 230,
    normalizedText: "SECRET TRANSCRIPT MUST NOT ESCAPE",
  };

  const view = toHiddenMonitoringDiagnosticView(internal);
  assert.deepEqual(view, {
    backgroundedAt: 100,
    foregroundedAt: 300,
    tabActivatedAt: 280,
    visibleObservedAt: 305,
    baselineAssistantTextLength: 10,
    hiddenObservationCount: 2,
    firstHiddenObservationAt: 120,
    lastHiddenObservationAt: 250,
    firstAssistantChangeAt: 150,
    firstMarkerDetectedAt: 240,
    hiddenAssistantTextLength: 80,
    assistantChanged: true,
    hiddenGeneration: "IDLE",
    hiddenStopControlPresent: true,
    hiddenMarkerHealth: "DETECTED",
    transportCompletedAt: 230,
  });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("Fingerprint"), false);
  assert.equal(serialized.includes("normalizedText"), false);
  assert.equal(serialized.includes("SECRET"), false);
});
