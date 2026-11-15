import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { parseConcurrencyConfiguration, runHttpConcurrency } from "../src/http-concurrency.ts";
import { formatConcurrencyReport } from "../src/concurrency-report.ts";

const target = "http://example.test/work";
const waitingFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
  const signal = init!.signal!;
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

test("configuration validates scheduling and HTTP settings before sending requests", () => {
  const config = parseConcurrencyConfiguration({ target });
  assert.equal(config.requests, 20);
  assert.equal(config.concurrency, 5);
  assert.equal(config.maxDurationMs, 500);
  for (const input of [null, [], {}, { target, requests: 0 }, { target, requests: null }, { target, requests: 10001 },
    { target, requests: 1.5 }, { target, concurrency: 0 }, { target, concurrency: 257 }, { target, concurrency: "2" },
    { target, concurrency: null }, { target, unknown: true }, { target, method: "CONNECT" },
    { target, timeoutMs: 100, maxDurationMs: 200 }]) assert.throws(() => parseConcurrencyConfiguration(input));
});

test("workers never exceed their limit, reuse slots and claim each request exactly once", { timeout: 3000 }, async () => {
  let calls = 0, active = 0, peak = 0, released = false;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const gates: (() => void)[] = [];
  const pending = runHttpConcurrency({ target, requests: 17, concurrency: 4 }, { fetch: async () => {
    calls++; active++; peak = Math.max(peak, active);
    if (calls === 4) ready();
    if (!released) await new Promise<void>((resolve) => gates.push(resolve));
    active--;
    return new Response(null);
  } });
  await started;
  assert.equal(calls, 4);
  released = true;
  for (const release of gates) release();
  const report = await pending;
  assert.equal(calls, 17);
  assert.equal(peak, 4);
  assert.equal(report.summary.peakInFlight, 4);
  assert.equal(report.result, "PASS");
  assert.deepEqual(report.requests.map((request) => request.request), Array.from({ length: 17 }, (_, i) => i + 1));
  assert.equal(report.completion.unstartedRequestCount, 0);
  assert.equal(JSON.parse(formatConcurrencyReport(report, "json")).runId, report.runId);
  assert.match(formatConcurrencyReport(report, "text"), /peak client-side in-flight 4/);
});

test("requests fewer than the worker limit allocate only the needed workers", async () => {
  const report = await runHttpConcurrency({ target, requests: 2, concurrency: 256 }, { fetch: async () => new Response(null) });
  assert.equal(report.summary.peakInFlight, 2);
  assert.equal(report.requests.length, 2);
});

test("out-of-order completions remain indexed by request start order", async () => {
  const gates: ((response: Response) => void)[] = [];
  const pending = runHttpConcurrency({ target, requests: 3, concurrency: 3 }, { fetch: async () => new Promise((resolve) => gates.push(resolve)) });
  assert.equal(gates.length, 3);
  gates[2](new Response(null, { status: 203 }));
  gates[0](new Response(null, { status: 201 }));
  gates[1](new Response(null, { status: 202 }));
  const report = await pending;
  assert.deepEqual(report.requests.map((request) => request.evidence!.status), [201, 202, 203]);
  assert.deepEqual(report.summary.statusCounts, { 201: 1, 202: 1, 203: 1 });
});

test("target failures do not stop sampling and HTTP errors remain responses", async () => {
  let calls = 0;
  const report = await runHttpConcurrency({ target, requests: 9, concurrency: 3 }, { fetch: async () => {
    const index = calls++;
    await delay(1);
    return new Response(null, { status: index === 0 ? 503 : 200 });
  } });
  assert.equal(calls, 9);
  assert.equal(report.result, "FAIL");
  assert.equal(report.summary.responseCount, 9);
  assert.equal(report.summary.statusCounts[503], 1);
  assert.equal(report.completion.reason, "completed");
});

test("pre-cancelled runs make no requests and have no invented response statistics", async () => {
  const controller = new AbortController(); controller.abort();
  const report = await runHttpConcurrency({ target }, { signal: controller.signal, fetch: async () => { throw new Error("must not run"); } });
  assert.equal(report.result, "INCONCLUSIVE");
  assert.equal(report.requests.length, 0);
  assert.equal(report.completion.unstartedRequestCount, 20);
  assert.equal(report.summary.peakInFlight, 0);
  assert.equal(report.summary.responseDurations, null);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("cancellation fans out to all active workers and leaves queued work unstarted", async () => {
  const controller = new AbortController();
  const pending = runHttpConcurrency({ target, requests: 100, concurrency: 12 }, { signal: controller.signal, fetch: waitingFetch });
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  const report = await pending;
  assert.equal(report.result, "INCONCLUSIVE");
  assert.equal(report.summary.cancelledCount, 12);
  assert.equal(report.requests.length, 12);
  assert.equal(report.completion.unstartedRequestCount, 88);
  assert.equal(report.assertion.passed, null);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("an internal error stops scheduling, cancels peers and waits for their evidence", async () => {
  let calls = 0;
  const report = await runHttpConcurrency({ target, requests: 20, concurrency: 3 }, { fetch: async (url, init) => {
    if (++calls === 1) throw new Error("private exception");
    return waitingFetch(url, init);
  } });
  assert.equal(report.result, "ERROR");
  assert.equal(calls, 3);
  assert.equal(report.summary.cancelledCount, 2);
  assert.equal(report.summary.unobservedAttemptCount, 1);
  assert.equal(report.completion.reason, "execution-error");
  assert.equal(report.completion.unstartedRequestCount, 17);
  assert.ok(!JSON.stringify(report).includes("private exception"));
});

test("cleanup failures preserve response evidence and cancel peers", async () => {
  let calls = 0;
  const report = await runHttpConcurrency({ target, requests: 20, concurrency: 2 }, { fetch: async (url, init) => {
    if (++calls === 1) return new Response(new ReadableStream({ cancel() { throw new Error("cleanup"); } }));
    return waitingFetch(url, init);
  } });
  assert.equal(report.result, "ERROR");
  assert.equal(report.error?.code, "HTTP_CLEANUP_FAILED");
  assert.equal(report.summary.responseCount, 1);
  assert.equal(report.summary.cancelledCount, 1);
});

test("observed failure survives later cancellation", async () => {
  const controller = new AbortController(); let calls = 0;
  const report = await runHttpConcurrency({ target, requests: 10, concurrency: 1 }, { signal: controller.signal, fetch: async (url, init) => {
    if (++calls === 1) return new Response(null, { status: 404 });
    controller.abort(); return waitingFetch(url, init);
  } });
  assert.equal(report.result, "FAIL");
  assert.equal(report.assertion.passed, false);
  assert.equal(report.completion.reason, "cancelled");
  assert.equal(report.completion.unstartedRequestCount, 8);
});

test("timeouts keep their own counters and never become response latencies", async () => {
  const report = await runHttpConcurrency({ target, requests: 5, concurrency: 2, timeoutMs: 10, maxDurationMs: 10 }, { fetch: waitingFetch });
  assert.equal(report.result, "FAIL");
  assert.equal(report.summary.timeoutCount, 5);
  assert.equal(report.summary.responseDurations, null);
  assert.equal(report.completion.completedRequestCount, 5);
});

test("request settings reach the HTTP boundary while reports omit secrets", async () => {
  const report = await runHttpConcurrency({ target: `${target}?token=urlSecret`, method: "POST", headers: { authorization: "Bearer headerSecret" }, body: "bodySecret", requests: 2, concurrency: 2, expectedStatus: 201 }, { fetch: async (url, init) => {
    assert.match(String(url), /urlSecret/);
    assert.equal(init?.method, "POST"); assert.equal(init?.body, "bodySecret");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer headerSecret");
    return new Response(null, { status: 201 });
  } });
  assert.equal(report.result, "PASS");
  for (const secret of ["urlSecret", "headerSecret", "bodySecret"]) assert.ok(!JSON.stringify(report).includes(secret));
});

test("cancellation during final cleanup preserves completed header evidence", async () => {
  const controller = new AbortController();
  const report = await runHttpConcurrency({ target, requests: 1, concurrency: 1 }, { signal: controller.signal, fetch: async () =>
    new Response(new ReadableStream({ cancel() { controller.abort(); } })) });
  assert.equal(report.result, "PASS");
  assert.equal(report.completion.reason, "completed");
  assert.equal(report.requests[0].evidence?.outcome, "response");
});
