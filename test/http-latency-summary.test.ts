import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpEvidence } from "../src/http-probe.ts";
import { summarizeHttpLatency } from "../src/http-latency-summary.ts";

function sample(
  durationMs: number,
  outcome: HttpEvidence["outcome"] = "response",
  status = 200,
): HttpEvidence {
  return {
    target: "http://example.test/health",
    method: "GET",
    startedAt: "2026-10-10T00:00:00.000Z",
    endedAt: new Date(Date.parse("2026-10-10T00:00:00.000Z") + durationMs).toISOString(),
    durationMs,
    timeoutMs: 2000,
    outcome,
    status: outcome === "response" ? status : null,
    contentType: null,
    location: null,
    error: null,
  };
}

test("known 100-response distribution uses nearest rank and preserves evidence order", () => {
  const durations = [800, ...Array(4).fill(300), ...Array(95).fill(40)];
  const evidence = durations.map((duration) => sample(duration));
  const summary = summarizeHttpLatency(evidence);

  assert.equal(summary.responseCount, 100);
  assert.equal(summary.percentileMethod, "nearest-rank");
  assert.deepEqual(summary.responseDurations, {
    meanMs: 58, minMs: 40, maxMs: 800, p50Ms: 40, p95Ms: 40, p99Ms: 300,
  });
  assert.deepEqual(evidence.map((item) => item.durationMs), durations);
});

test("timeouts and request errors are counted but excluded from response durations", () => {
  const summary = summarizeHttpLatency([
    sample(10), sample(20), sample(30), sample(40),
    sample(2000, "timeout"), sample(7, "request-error"),
  ]);

  assert.equal(summary.attemptCount, 6);
  assert.equal(summary.responseCount, 4);
  assert.equal(summary.timeoutCount, 1);
  assert.equal(summary.requestErrorCount, 1);
  assert.deepEqual(summary.responseDurations, {
    meanMs: 25, minMs: 10, maxMs: 40, p50Ms: 20, p95Ms: 40, p99Ms: 40,
  });
});

test("response durations are unavailable when no response headers arrived", () => {
  const summary = summarizeHttpLatency([sample(2000, "timeout"), sample(7, "request-error")]);
  assert.equal(summary.responseCount, 0);
  assert.equal(summary.responseDurations, null);
  assert.equal(summarizeHttpLatency([]).responseDurations, null);
});

test("HTTP error responses still belong to the received-response population", () => {
  const summary = summarizeHttpLatency([sample(5, "response", 404)]);
  assert.equal(summary.responseCount, 1);
  assert.equal(summary.requestErrorCount, 0);
  assert.equal(summary.responseDurations?.meanMs, 5);
});
