import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeLoadStage, type LoadAttempt } from "../src/load-summary.ts";
import type { HttpObservation } from "../src/http-observation.ts";
function attempt(outcome: HttpObservation["outcome"], status: number | null, duration: number, passed: boolean | null): LoadAttempt {
  return { request: 1, worker: 1, startedElapsedMs: 0, observedElapsedMs: duration, passed, evidence: {
    target: "http://example.test", method: "GET", startedAt: "", endedAt: "", durationMs: duration, timeoutMs: 1000,
    outcome, status, contentType: null, location: null, error: null, measurementBoundary: "response-headers", failure: null, cleanup: "no-body", retryAfter: null,
  } };
}
test("load summaries separate fast rejections, passed throughput and missing response times", () => {
  const result = summarizeLoadStage([attempt("response", 200, 50, true), attempt("response", 200, 100, false), attempt("response", 503, 1, false), attempt("timeout", null, 1000, false), attempt("cancelled", null, 10, null), { request: 6, worker: 1, startedElapsedMs: 0, observedElapsedMs: null, evidence: null, passed: null }], { admissionMs: 500, durationMs: 2000, peakInFlight: 3 }, 200);
  assert.equal(result.attemptCount, 6); assert.equal(result.responseCount, 3); assert.equal(result.expectedStatusResponseCount, 2);
  assert.equal(result.passedCount, 1); assert.equal(result.failedCount, 3); assert.equal(result.unknownCount, 2);
  assert.equal(result.evaluatedFailureFraction, 0.75); assert.equal(result.responseDurations!.p50Ms, 50);
  assert.equal(result.expectedStatusResponseDurations!.p95Ms, 100);
  assert.deepEqual(result.rates, { startedPerSecond: 12, responseHeadersPerSecond: 1.5, expectedStatusResponsesPerSecond: 1, passedRequestsPerSecond: 0.5, admissionDenominatorMs: 500, completionDenominatorMs: 2000 });
  assert.equal(result.timeoutCount, 1); assert.equal(result.unobservedAttemptCount, 1);
});
test("empty stage summaries have unavailable rates and latency rather than fabricated capacity", () => {
  const result = summarizeLoadStage([], { admissionMs: 0, durationMs: 0, peakInFlight: 0 }, 200);
  assert.equal(result.responseDurations, null); assert.equal(result.expectedStatusResponseDurations, null);
  assert.equal(result.rates.passedRequestsPerSecond, null); assert.equal(result.evaluatedFailureFraction, null);
});
