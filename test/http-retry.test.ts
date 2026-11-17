import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { testHttpRetry, type RetryOptions } from "../src/http-retry.ts";
import { formatRetryReport } from "../src/retry-report.ts";

const request = { target: "http://example.test/work" };
function clock() {
  let elapsed = 0; const waits: number[] = [];
  const options: RetryOptions = { now: () => elapsed, wait: async (ms, signal) => { signal.throwIfAborted(); waits.push(ms); elapsed += ms; } };
  return { options, waits };
}
test("transient failures recover, preserving attempts and exponential waits", async () => {
  const time = clock(); let calls = 0;
  const report = await testHttpRetry({ request, policy: { jitter: "none" } }, { ...time.options, fetch: async () => new Response(null, { status: ++calls < 3 ? 503 : 200 }) });
  assert.equal(report.result, "PASS");
  assert.deepEqual(time.waits, [100, 200]);
  assert.deepEqual(report.attempts.map((attempt) => attempt.evidence!.status), [503, 503, 200]);
  assert.equal(report.completion.reason, "success");
  assert.equal(JSON.parse(formatRetryReport(report, "json")).runId, report.runId);
  assert.match(formatRetryReport(report, "text"), /3\/3/);
});
test("permanent status does not retry, while exhausted transient failures stop at the cap", async () => {
  for (const [status, expectedCalls, reason] of [[400, 1, "non-retryable"], [401, 1, "non-retryable"], [503, 3, "attempts-exhausted"]] as const) {
    let calls = 0; const time = clock();
    const report = await testHttpRetry({ request }, { ...time.options, fetch: async () => { calls++; return new Response(null, { status }); } });
    assert.equal(report.result, "FAIL"); assert.equal(calls, expectedCalls); assert.equal(report.completion.reason, reason);
    assert.equal(time.waits.length, expectedCalls - 1);
  }
});
test("Retry-After is a lower bound even when it exceeds the backoff cap", async () => {
  const time = clock(); let calls = 0;
  const report = await testHttpRetry({ request, policy: { baseDelayMs: 10, maxDelayMs: 20 } }, { ...time.options, random: () => 0, fetch: async () => new Response(null, { status: ++calls === 1 ? 429 : 200, headers: { "retry-after": "1" } }) });
  assert.equal(report.result, "PASS"); assert.deepEqual(time.waits, [1000]);
  assert.equal(report.attempts[0].retryAfterMs, 1000);
});
test("insufficient budget stops without shortening Retry-After or starting another attempt", async () => {
  const time = clock(); let calls = 0;
  const report = await testHttpRetry({ request, policy: { deadlineMs: 500 } }, { ...time.options, fetch: async () => { calls++; return new Response(null, { status: 503, headers: { "retry-after": "10" } }); } });
  assert.equal(report.result, "FAIL"); assert.equal(calls, 1); assert.equal(report.completion.reason, "insufficient-budget"); assert.deepEqual(time.waits, []);
});
test("cancellation during backoff preserves uncertainty and releases caller listeners", async () => {
  const controller = new AbortController(); let calls = 0;
  const report = await testHttpRetry({ request }, { signal: controller.signal, fetch: async () => { calls++; return new Response(null, { status: 503 }); }, wait: async (_ms, signal) => { controller.abort(); signal.throwIfAborted(); } });
  assert.equal(calls, 1); assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "cancelled");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
test("pre-cancellation sends no request and execution exceptions are not retried", async () => {
  const controller = new AbortController(); controller.abort();
  const cancelled = await testHttpRetry({ request }, { signal: controller.signal, fetch: async () => { throw new Error("must not run"); } });
  assert.equal(cancelled.result, "INCONCLUSIVE"); assert.equal(cancelled.attempts.length, 0);
  const failed = await testHttpRetry({ request }, { fetch: async () => { throw new Error("private internal details"); } });
  assert.equal(failed.result, "ERROR"); assert.ok(!JSON.stringify(failed).includes("private internal details"));
  assert.equal(failed.attempts.length, 1); assert.equal(failed.attempts[0].evidence, null);
});
test("full jitter uses the supplied random source and wait failures become ERROR", async () => {
  const time = clock(); let calls = 0;
  const report = await testHttpRetry({ request }, { ...time.options, random: () => 0.5, fetch: async () => new Response(null, { status: ++calls < 3 ? 503 : 200 }) });
  assert.equal(report.result, "PASS"); assert.deepEqual(time.waits, [50, 100]);
  const error = await testHttpRetry({ request }, { fetch: async () => new Response(null, { status: 503 }), wait: async () => { throw new Error("private"); } });
  assert.equal(error.result, "ERROR"); assert.ok(!JSON.stringify(error).includes("private"));
});

const write = { request: { target: "http://example.test/operations", method: "POST", headers: { authorization: "Bearer secret" }, body: "same-payload", expectedStatus: 201 }, retrySafety: "idempotency-key", state: { target: "http://example.test/effects/{key}" }, policy: { baseDelayMs: 0, maxDelayMs: 0 } };
test("lost write response reuses one key and audits one effect; broken deduplication fails", async () => {
  for (const deduplicate of [true, false]) {
    let effects = 0, calls = 0; const keys: string[] = [];
    const report = await testHttpRetry(write, { fetch: async (url, init) => {
      if (String(url).includes("/effects/")) return Response.json({ effectCount: effects });
      const key = new Headers(init?.headers).get("idempotency-key")!; keys.push(key); calls++;
      assert.equal(init?.body, "same-payload");
      if (!deduplicate || effects === 0) effects++;
      if (calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) });
      return new Response(null, { status: 201 });
    } });
    assert.equal(report.result, deduplicate ? "PASS" : "FAIL");
    assert.equal(new Set(keys).size, 1); assert.equal(keys[0], report.key);
    assert.equal(report.state.after?.count, deduplicate ? 1 : 2);
    assert.ok(!JSON.stringify(report).includes("Bearer secret")); assert.ok(!JSON.stringify(report).includes("same-payload"));
  }
});
test("unavailable fresh-key state prevents all writes", async () => {
  const report = await testHttpRetry(write, { fetch: async (url) => { assert.match(String(url), /effects/); return Response.json({ unknown: true }); } });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "precondition"); assert.equal(report.attempts.length, 0);
});
test("successful writes with unavailable audit state are INCONCLUSIVE", async () => {
  let stateReads = 0;
  const report = await testHttpRetry(write, { fetch: async (url) => String(url).includes("/effects/") ? Response.json(++stateReads === 1 ? { effectCount: 0 } : { unavailable: true }) : new Response(null, { status: 201 }) });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "state-unavailable");
  assert.equal(report.assertions[0].passed, true); assert.equal(report.assertions[1].passed, null);
});

test("an attempt timeout may recover on the next try, and the timeout retry switch is honored", async () => {
  for (const enabled of [true, false]) {
    let calls = 0;
    const report = await testHttpRetry({ request: { ...request, timeoutMs: 15 }, policy: { retryOnTimeout: enabled, baseDelayMs: 0, maxDelayMs: 0 } }, { fetch: async (_url, init) => {
      if (++calls > 1) return new Response(null);
      return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    } });
    assert.equal(report.result, enabled ? "PASS" : "FAIL"); assert.equal(calls, enabled ? 2 : 1);
    assert.equal(report.attempts[0].evidence?.outcome, "timeout");
  }
});
test("backoff consumes the same budget and overscheduling cannot create a fresh deadline", async () => {
  let elapsed = 0, calls = 0;
  const report = await testHttpRetry({ request, policy: { deadlineMs: 500, jitter: "none" } }, { now: () => elapsed, wait: async () => { elapsed += 600; }, fetch: async () => { calls++; return new Response(null, { status: 503 }); } });
  assert.equal(report.result, "FAIL"); assert.equal(report.completion.reason, "deadline"); assert.equal(calls, 1);
});
test("deadline during the write precondition is insufficient evidence, not a failed write", async () => {
  const report = await testHttpRetry({ ...write, policy: { deadlineMs: 20 } }, { fetch: async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })) });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.attempts.length, 0);
  assert.equal(report.assertions[0].passed, null);
});
test("cancelling the write audit preserves recovery but leaves safety unknown", async () => {
  const controller = new AbortController(); let reads = 0;
  const report = await testHttpRetry(write, { signal: controller.signal, fetch: async (url) => {
    if (!String(url).includes("/effects/")) return new Response(null, { status: 201 });
    if (++reads === 2) controller.abort();
    return Response.json({ effectCount: reads === 1 ? 0 : 1 });
  } });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.assertions[0].passed, true);
  assert.equal(report.completion.cancelled, true); assert.equal(report.completion.reason, "cancelled");
});
test("body cleanup failures stop retries with preserved header evidence", async () => {
  const report = await testHttpRetry({ request }, { fetch: async () => new Response(new ReadableStream({ cancel() { throw new Error("private"); } }), { status: 503 }) });
  assert.equal(report.result, "ERROR"); assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0].evidence?.status, 503);
  assert.equal(report.error?.code, "HTTP_CLEANUP_FAILED");
});

test("success is checked on the workflow observation clock rather than an estimated offset", async () => {
  let elapsed = 0;
  const report = await testHttpRetry({ request, policy: { deadlineMs: 100 } }, { now: () => elapsed, fetch: async () => { elapsed = 101; return new Response(null); } });
  assert.equal(report.result, "FAIL"); assert.equal(report.completion.reason, "deadline");
  assert.equal(report.attempts[0].observedElapsedMs, 101);
});
