import assert from "node:assert/strict";
import { test } from "node:test";
import { testHttpRateLimit } from "../src/http-rate-limit.ts";
import { formatRateLimitReport } from "../src/rate-limit-report.ts";
const input = { request: { target: "http://example.test/limited?token=private", headers: { authorization: "Bearer secret" } }, allowance: 1, excessRequests: 1, windowMs: 100, resetGraceMs: 0 };
test("pre-cancelled rate experiment preserves unknown assertions and sends nothing", async () => {
  const controller = new AbortController(); controller.abort();
  const report = await testHttpRateLimit(input, { signal: controller.signal, fetch: async () => { throw Error("must not send"); } });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "cancelled"); assert.equal(report.attempts.length, 0);
  assert.ok(report.assertions.every((a) => a.passed === null));
});
test("unexpected observer exceptions become sanitized ERROR with attempted evidence", async () => {
  const report = await testHttpRateLimit(input, { fetch: async () => { throw new Error("private implementation failure"); } });
  assert.equal(report.result, "ERROR"); assert.equal(report.attempts.length, 1); assert.equal(report.attempts[0].evidence, null);
  const output = formatRateLimitReport(report, "json");
  assert.ok(!output.includes("Bearer secret")); assert.ok(!output.includes("private implementation failure")); assert.ok(!output.includes("token=private"));
});
test("transport failure is unknown admission evidence, not proof of limiter rejection", async () => {
  const report = await testHttpRateLimit(input, { fetch: async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) }); } });
  assert.equal(report.result, "INCONCLUSIVE"); assert.ok(report.attempts.every((a) => a.evidence?.outcome === "request-error"));
});
test("observed over-admission remains FAIL after cancellation", async () => {
  const controller = new AbortController(); let calls = 0;
  const report = await testHttpRateLimit(input, { signal: controller.signal, fetch: async () => {
    calls++; if (calls === 3) queueMicrotask(() => controller.abort()); return new Response(null, { status: 200 });
  } });
  assert.equal(report.result, "FAIL"); assert.equal(report.completion.reason, "cancelled");
  assert.equal(report.assertions.find((a) => a.name === "primary-cap")?.passed, false);
});
