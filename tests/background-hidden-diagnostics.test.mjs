import test from "node:test";
import assert from "node:assert/strict";
import { toHiddenMonitoringDiagnosticView } from "../dist/background/hidden-diagnostics.js";

test("public hidden diagnostics redact fingerprints and injected transcript-like fields", () => {
  const internal = {
    backgroundedAt: 100,
    foregroundedAt: 300,
    baselineAssistantFingerprint: "a".repeat(64),
    baselineAssistantTextLength: 10,
    hiddenObservationCount: 2,
    lastHiddenObservationAt: 250,
    hiddenAssistantFingerprint: "b".repeat(64),
    hiddenAssistantTextLength: 80,
    assistantChanged: true,
    hiddenGeneration: "IDLE",
    hiddenStopControlPresent: true,
    hiddenMarkerHealth: "DETECTED",
    normalizedText: "SECRET TRANSCRIPT MUST NOT ESCAPE",
  };

  const view = toHiddenMonitoringDiagnosticView(internal);
  assert.deepEqual(view, {
    backgroundedAt: 100,
    foregroundedAt: 300,
    baselineAssistantTextLength: 10,
    hiddenObservationCount: 2,
    lastHiddenObservationAt: 250,
    hiddenAssistantTextLength: 80,
    assistantChanged: true,
    hiddenGeneration: "IDLE",
    hiddenStopControlPresent: true,
    hiddenMarkerHealth: "DETECTED",
  });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("Fingerprint"), false);
  assert.equal(serialized.includes("normalizedText"), false);
  assert.equal(serialized.includes("SECRET"), false);
});
