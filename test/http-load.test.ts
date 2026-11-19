import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getEventListeners } from "node:events";
import { testHttpLoad } from "../src/http-load.ts";
import { formatLoadReport } from "../src/load-report.ts";
const config = { request: { target: "http://example.test/work", timeoutMs: 500, maxDurationMs: 200 }, stages: [1, 3], stageDurationMs: 70, minSamplesPerStage: 1, maxRequestsPerStage: 100, pauseMs: 0, deadlineMs: 3000 };
const normal: typeof fetch = async (_, init) => { await delay(8, undefined, { signal: init!.signal! }); return new Response(null); };
const hanging: typeof fetch = async (_, init) => new Promise((_, reject) => { const signal = init!.signal!; if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });

test("timed stages close admission, drain their work, and return to the first concurrency for recovery", async () => {
  const controller = new AbortController();
  const report = await testHttpLoad(config, { signal: controller.signal, fetch: normal });
  assert.equal(report.result, "PASS"); assert.deepEqual(report.stages.map((s) => s.concurrency), [1, 3, 1]);
  assert.deepEqual(report.stages.map((s) => s.phase), ["ramp", "ramp", "recovery"]);
  for (const stage of report.stages) {
    assert.equal(stage.completion.fullAdmissionWindow, true); assert.ok(stage.durationMs >= 70);
    assert.ok(stage.requests.every((r) => r.startedElapsedMs < 70)); assert.ok(stage.requests.every((r) => r.worker >= 1 && r.worker <= stage.concurrency));
    assert.ok(stage.summary.peakInFlight <= stage.concurrency); assert.equal(stage.summary.unknownCount, 0);
    assert.ok(stage.summary.rates.passedRequestsPerSecond! > 0);
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(report.comparison.recoveryResult, "PASS"); assert.equal(report.comparison.firstObservedFailingConcurrency, null);
  assert.match(formatLoadReport(report, "text"), /closed-loop/);
});
test("the finite request cap preserves evidence but cannot pass the full stage duration", async () => {
  const report = await testHttpLoad({ ...config, stages: [1], maxRequestsPerStage: 2, recovery: false }, { fetch: normal });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "request-cap");
  assert.equal(report.attemptedRequests, 2); assert.equal(report.stages[0].completion.fullAdmissionWindow, false);
  assert.equal(report.stages[0].assertions.find((a) => a.name === "request-requirements")!.passed, true);
});
test("too few evaluated samples are unknown rather than proof of capacity", async () => {
  const report = await testHttpLoad({ ...config, stages: [1], minSamplesPerStage: 50, recovery: false }, { fetch: normal });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.stages[0].completion.fullAdmissionWindow, true);
  assert.equal(report.stages[0].assertions.find((a) => a.name === "sample-count")!.passed, null);
});
test("an unmet declared passed-throughput floor fails a completed, adequately sampled stage", async () => {
  const report = await testHttpLoad({ ...config, stages: [1], recovery: false, minPassedRequestsPerSecond: 10000 }, { fetch: normal });
  assert.equal(report.result, "FAIL"); assert.equal(report.stages[0].summary.failedCount, 0);
  assert.equal(report.stages[0].assertions.find((a) => a.name === "passed-throughput")!.passed, false);
});
test("pre-cancellation creates no stage, request or fabricated baseline", async () => {
  const controller = new AbortController(); controller.abort();
  const report = await testHttpLoad(config, { signal: controller.signal, fetch: async () => { throw Error("must not send"); } });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "cancelled"); assert.equal(report.stages.length, 0);
  assert.equal(report.attemptedRequests, 0); assert.deepEqual(report.comparison.relativeToFirstStage, []);
});
test("an overall clipped timeout leaves the original waiting requirement unknown", async () => {
  const report = await testHttpLoad({ ...config, deadlineMs: 25 }, { fetch: hanging });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "deadline");
  assert.equal(report.stages.length, 1); assert.equal(report.stages[0].requests.length, 1);
  assert.equal(report.stages[0].requests[0].passed, null); assert.ok(report.stages[0].requests[0].evidence!.timeoutMs <= 25);
  assert.equal(report.comparison.recoveryResult, "INCONCLUSIVE");
});
test("a full per-request timeout is a known target failure, with no fabricated response percentile", async () => {
  const report = await testHttpLoad({ ...config, request: { ...config.request, timeoutMs: 15, maxDurationMs: 10 }, stages: [1], recovery: false }, { fetch: hanging });
  assert.equal(report.result, "FAIL"); assert.ok(report.stages[0].summary.timeoutCount > 0);
  assert.equal(report.stages[0].summary.responseDurations, null); assert.equal(report.comparison.firstObservedFailingConcurrency, 1);
});
test("known wrong status survives cancellation of a later attempt", async () => {
  const controller = new AbortController(); let calls = 0;
  const report = await testHttpLoad(config, { signal: controller.signal, fetch: async (_, init) => {
    if (++calls === 1) return new Response(null, { status: 503 });
    controller.abort(); return hanging("http://example.test", init);
  } });
  assert.equal(report.result, "FAIL"); assert.equal(report.completion.reason, "cancelled"); assert.equal(calls, 2);
  assert.equal(report.stages[0].summary.failedCount, 1); assert.equal(report.stages[0].summary.unknownCount, 1);
});
test("internal failure stops admission, settles peers and sanitizes report content", async () => {
  const controller = new AbortController(); let calls = 0, settled = false;
  const report = await testHttpLoad({ ...config, stages: [3], recovery: false, request: { ...config.request, headers: { authorization: "Bearer secret" }, target: config.request.target + "?token=private" } }, { signal: controller.signal, fetch: async (_, init) => {
    if (++calls === 2) throw Error("private implementation detail");
    try { return await hanging("http://example.test", init); } finally { settled = true; }
  } });
  assert.equal(report.result, "ERROR"); assert.equal(report.completion.reason, "execution-error"); assert.equal(settled, true);
  assert.ok(calls <= 3); assert.equal(report.stages.length, 1); assert.ok(report.stages[0].requests.some((r) => r.evidence === null));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const output = formatLoadReport(report, "json"); for (const secret of ["Bearer secret", "private implementation detail", "token=private"]) assert.ok(!output.includes(secret));
});
test("cleanup failures retain received headers and stop later stages with ERROR", async () => {
  const report = await testHttpLoad(config, { fetch: async () => new Response(new ReadableStream({ cancel() { throw Error("private cleanup"); } })) });
  assert.equal(report.result, "ERROR"); assert.equal(report.attemptedRequests, 1);
  assert.equal(report.stages[0].requests[0].evidence!.status, 200);
});
test("the overall deadline also interrupts inter-stage pauses", async () => {
  const report = await testHttpLoad({ ...config, stages: [1, 2], deadlineMs: 130, pauseMs: 1000 }, { fetch: normal });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "deadline");
  assert.equal(report.stages.length, 1); assert.equal(report.pauses.length, 1); assert.ok(report.pauses[0].actualMs < 500);
});

test("a classified connection failure violates the request rule rather than causing Veriq ERROR", async () => {
  const report = await testHttpLoad({ ...config, stages: [1], recovery: false }, { fetch: async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) });
  } });
  assert.equal(report.result, "FAIL"); assert.ok(report.stages[0].summary.requestErrorCount > 0);
  assert.equal(report.stages[0].summary.responseDurations, null); assert.equal(report.error, null);
});

test("early cancellation followed by slow cleanup cannot masquerade as a full admission window", async () => {
  const controller = new AbortController();
  const report = await testHttpLoad({ ...config, stages: [1], stageDurationMs: 50, recovery: false }, { signal: controller.signal, fetch: async () => new Response(new ReadableStream({
    async cancel() { controller.abort(); await delay(80); },
  })) });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "cancelled");
  assert.ok(report.stages[0].durationMs >= 80); assert.equal(report.stages[0].completion.fullAdmissionWindow, false);
  assert.ok(report.stages[0].admissionDurationMs < 50); assert.equal(report.stages[0].summary.passedCount, 1);
});
