import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { measureHttpLatency, type LatencySettings } from "../src/http-latency.ts";
import { formatLatencyReport } from "../src/latency-report.ts";

const target = "http://example.test/health";
test("default settings preserve five samples, the per-sample rule and sequential execution", async () => {
  let active = 0, maxActive = 0, requests = 0;
  const report = await measureHttpLatency(target, {}, { fetch: async () => {
    active++;
    maxActive = Math.max(active, maxActive);
    requests++;
    await delay(1);
    active--;
    return new Response(null, { status: requests === 3 ? 404 : 200 });
  } });
  assert.equal(maxActive, 1);
  assert.equal(requests, 5);
  assert.equal(report.configuration.maxDurationMs, 200);
  assert.equal(report.configuration.timeoutMs, 2000);
  assert.equal(report.result, "FAIL");
  assert.equal(report.samples[2].assertion.passed, false);
  assert.equal(report.samples[4].evidence?.status, 200);
  assert.equal(report.summary.responseCount, 5);
  assert.equal(report.completion.completedSampleCount, 5);
});

test("configured requirements and all successful attempts produce PASS", async () => {
  const report = await measureHttpLatency(`${target}?token=secret`, { sampleCount: 3, expectedStatus: 204, maxDurationMs: 500 }, {
    fetch: async () => new Response(null, { status: 204 }),
  });
  assert.equal(report.result, "PASS");
  assert.equal(report.assertion.passed, true);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.samples.length, 3);
  assert.deepEqual(report.completion, { reason: "completed", requestedSampleCount: 3, attemptedSampleCount: 3, completedSampleCount: 3, unstartedSampleCount: 0 });
  assert.ok(!JSON.stringify(report).includes("secret"));
  assert.equal(JSON.parse(formatLatencyReport(report, "json")).runId, report.runId);
  assert.match(formatLatencyReport(report, "text"), /p99/);
});

test("invalid sample and timing configuration is rejected before a request", async () => {
  let called = false;
  const invalid = [
    { sampleCount: 0 }, { sampleCount: -1 }, { sampleCount: 10001 }, { sampleCount: 1.5 },
    { sampleCount: null }, { sampleCount: "5" }, { sampleCount: NaN },
    { timeoutMs: 10, maxDurationMs: 20 }, { expectedStatus: 101 }, { samples: 5 },
  ];
  for (const settings of invalid) {
    await assert.rejects(measureHttpLatency(target, settings as LatencySettings, { fetch: async () => { called = true; return new Response(); } }));
  }
  assert.equal(called, false);
});

test("a pre-cancelled run has no fabricated attempts or response statistics", async () => {
  const controller = new AbortController();
  controller.abort();
  const report = await measureHttpLatency(target, {}, { signal: controller.signal, fetch: async () => { throw new Error("must not run"); } });
  assert.equal(report.result, "INCONCLUSIVE");
  assert.equal(report.assertion.passed, null);
  assert.equal(report.samples.length, 0);
  assert.equal(report.completion.unstartedSampleCount, 5);
  assert.equal(report.summary.responseDurations, null);
  assert.match(formatLatencyReport(report, "text"), /unavailable/);
});

test("cancellation between samples preserves the completed response and starts no next request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const report = await measureHttpLatency(target, {}, { signal: controller.signal, fetch: async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { controller.abort(); } }));
  } });
  assert.equal(calls, 1);
  assert.equal(report.result, "INCONCLUSIVE");
  assert.equal(report.samples[0].result, "PASS");
  assert.equal(report.summary.cancelledCount, 0);
  assert.equal(report.completion.completedSampleCount, 1);
  assert.equal(report.completion.unstartedSampleCount, 4);
});

test("in-flight cancellation preserves earlier failures rather than hiding them", async () => {
  for (const firstStatus of [200, 404]) {
    const controller = new AbortController();
    let calls = 0;
    const report = await measureHttpLatency(target, {}, { signal: controller.signal, fetch: async (_url, init) => {
      calls++;
      if (calls === 1) return new Response(null, { status: firstStatus });
      controller.abort();
      throw init!.signal!.reason;
    } });
    assert.equal(calls, 2);
    assert.equal(report.result, firstStatus === 404 ? "FAIL" : "INCONCLUSIVE");
    assert.equal(report.assertion.passed, firstStatus === 404 ? false : null);
    assert.equal(report.samples[1].evidence?.outcome, "cancelled");
    assert.equal(report.completion.reason, "cancelled");
    assert.equal(report.summary.responseCount, 1);
    assert.equal(report.summary.cancelledCount, 1);
    assert.equal(report.completion.unstartedSampleCount, 3);
  }
});

test("cancellation during cleanup of the final successful sample leaves the completed run intact", async () => {
  const controller = new AbortController();
  const report = await measureHttpLatency(target, { sampleCount: 1 }, { signal: controller.signal, fetch: async () =>
    new Response(new ReadableStream({ cancel() { controller.abort(); } })) });
  assert.equal(report.result, "PASS");
  assert.equal(report.completion.reason, "completed");
});

test("internal failures stop the run with ERROR and retain earlier samples", async () => {
  let calls = 0;
  const report = await measureHttpLatency(target, {}, { fetch: async () => {
    if (++calls === 2) throw new Error("secret internal exception");
    return new Response(null, { status: 404 });
  } });
  assert.equal(report.result, "ERROR");
  assert.equal(report.assertion.passed, null);
  assert.equal(report.samples.length, 2);
  assert.equal(report.samples[0].assertion.passed, false);
  assert.equal(report.summary.attemptCount, 2);
  assert.equal(report.summary.unobservedAttemptCount, 1);
  assert.equal(report.completion.reason, "execution-error");
  assert.ok(!JSON.stringify(report).includes("secret internal exception"));
});

test("all request failures are sampled and never become zero response latency", async () => {
  const report = await measureHttpLatency(target, { sampleCount: 3 }, { fetch: async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) });
  } });
  assert.equal(report.result, "FAIL");
  assert.equal(report.summary.requestErrorCount, 3);
  assert.equal(report.summary.responseDurations, null);
  assert.equal(report.completion.reason, "completed");
});

test("cleanup errors preserve received headers and stop further sampling", async () => {
  let calls = 0;
  const report = await measureHttpLatency(target, {}, { fetch: async () => {
    calls++;
    return calls === 1 ? new Response(null) : new Response(new ReadableStream({ cancel() { throw new Error("cleanup failed"); } }));
  } });
  assert.equal(calls, 2);
  assert.equal(report.result, "ERROR");
  assert.equal(report.error?.code, "HTTP_CLEANUP_FAILED");
  assert.equal(report.samples[1].evidence?.status, 200);
  assert.equal(report.summary.responseCount, 2);
  assert.equal(report.summary.unobservedAttemptCount, 0);
  assert.equal(report.completion.completedSampleCount, 1);
});

test("timeouts remain separate outcomes and do not stop subsequent samples", async () => {
  const report = await measureHttpLatency(target, { sampleCount: 2, timeoutMs: 10, maxDurationMs: 10 }, {
    fetch: async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })),
  });
  assert.equal(report.result, "FAIL");
  assert.equal(report.summary.timeoutCount, 2);
  assert.equal(report.summary.responseDurations, null);
  assert.equal(report.completion.completedSampleCount, 2);
});
