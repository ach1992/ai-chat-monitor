import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateProgressSafety,
  materiallySimilarOutcome,
  outcomeSignature,
} from "../dist/reliability/progress.js";

test("repeated materially similar wait outcomes trigger stagnation", () => {
  const first = outcomeSignature("Still waiting for deployment status. Check number 101 shows no change yet.");
  const second = outcomeSignature("Still waiting for deployment status. Check number 102 shows no change yet.");
  const current = outcomeSignature("Still waiting for deployment status. Check number 103 shows no change yet.");

  assert.equal(materiallySimilarOutcome(first, second), true);
  assert.deepEqual(
    evaluateProgressSafety(current, [first, second], 2, 50),
    { hold: true, reason: "REPEATED_OUTCOME" },
  );
});

test("useful new progress is not stopped solely by a large successful-auto count below the fuse", () => {
  const waiting = outcomeSignature("Waiting for the same external state with no material change.");
  const progress = outcomeSignature(
    "Implemented the guarded persistence layer, added race tests, and moved to the next independent work item.",
  );

  assert.equal(materiallySimilarOutcome(waiting, progress), false);
  assert.deepEqual(
    evaluateProgressSafety(progress, [waiting, waiting], 49, 50),
    { hold: false },
  );
});

test("the configurable hard fuse is a separate final safety boundary", () => {
  const current = outcomeSignature("Completed a distinct useful implementation step and can continue.");
  const prior = [
    outcomeSignature("Previous useful result alpha."),
    outcomeSignature("Previous useful result beta."),
  ];

  assert.deepEqual(
    evaluateProgressSafety(current, prior, 50, 50),
    { hold: true, reason: "HARD_FUSE" },
  );
});
