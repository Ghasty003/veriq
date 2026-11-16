import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIdempotencyConfiguration, testHttpIdempotency } from "../src/http-idempotency.ts";
import { formatIdempotencyReport } from "../src/idempotency-report.ts";

const config = {
  request: { target: "http://example.test/operations", body: '{"amount":10}', expectedStatus: 201, headers: { authorization: "Bearer authSecret" } },
  conflictBody: '{"amount":20}', state: { target: "http://example.test/effects/{key}" },
};
function target(mode: "atomic" | "naive" | "racy" = "atomic", unavailable = false): typeof fetch {
  const effects = new Map<string, number>(), receipts = new Map<string, { body: string; id: number }>();
  let id = 0;
  return async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/effects/")) return Response.json(unavailable ? { missing: true } : { effectCount: effects.get(path.slice(9)) ?? 0 });
    const key = new Headers(init?.headers).get("idempotency-key")!;
    const body = String(init?.body), existing = receipts.get(key);
    if (existing && mode !== "naive") return existing.body === body ? Response.json({ operationId: existing.id }, { status: 201 }) : Response.json({}, { status: 409 });
    if (mode === "racy") await new Promise<void>((resolve) => setImmediate(resolve));
    const receipt = { body, id: ++id };
    effects.set(key, (effects.get(key) ?? 0) + 1); receipts.set(key, receipt);
    return Response.json({ operationId: receipt.id }, { status: 201 });
  };
}
test("idempotency configuration rejects invalid contracts before mutation", () => {
  for (const change of [ { extra: true }, { sequentialRequests: 1 }, { concurrentRequests: 101 }, { concurrency: 1 },
    { conflictBody: config.request.body }, { conflictBody: '{ "amount": 10 }' }, { conflictExpectedStatus: 201 },
    { state: { target: "http://example.test/count" } }, { responsePointer: "/~2" },
    { request: { ...config.request, method: "GET" } }, { request: { ...config.request, headers: { "idempotency-key": "fixed" } } }]) {
    assert.throws(() => parseIdempotencyConfiguration({ ...config, ...change }));
  }
});
test("correct sequential/concurrent replays and conflict rejection produce PASS", async () => {
  const report = await testHttpIdempotency(config, { fetch: target() });
  assert.equal(report.result, "PASS", JSON.stringify(report.assertions));
  assert.equal(report.stateCounts.afterSequential, 1);
  assert.equal(report.stateCounts.afterConcurrent, 1);
  assert.equal(report.stateCounts.afterConflict, 1);
  assert.notEqual(report.keys.sequential, report.keys.concurrent);
  assert.ok(report.assertions.every((assertion) => assertion.passed === true));
  assert.ok(!JSON.stringify(report).includes("authSecret"));
  assert.match(formatIdempotencyReport(report, "text"), /sequential-replay/);
  assert.equal(JSON.parse(formatIdempotencyReport(report, "json")).runId, report.runId);
});
test("ignoring keys fails saved-effect and conflict assertions", async () => {
  const report = await testHttpIdempotency(config, { fetch: target("naive") });
  assert.equal(report.result, "FAIL");
  assert.equal(report.stateCounts.afterSequential, 3);
  assert.equal(report.assertions.find((assertion) => assertion.name === "conflict-response")?.passed, false);
});
test("sequential cache success does not hide a concurrent first-use race", async () => {
  const report = await testHttpIdempotency(config, { fetch: target("racy") });
  assert.equal(report.stateCounts.afterSequential, 1);
  assert.equal(report.stateCounts.afterConcurrent, 5);
  assert.equal(report.result, "FAIL");
});
test("missing count evidence is INCONCLUSIVE and sends no operations", async () => {
  const report = await testHttpIdempotency(config, { fetch: target("atomic", true) });
  assert.equal(report.result, "INCONCLUSIVE");
  assert.equal(report.completion.reason, "precondition");
  assert.equal(report.completion.sequentialAttempted, 0);
});

test("non-fresh state is a failed precondition, not proof of an idempotency defect", async () => {
  const report = await testHttpIdempotency(config, { fetch: async (url) => {
    assert.match(String(url), /\/effects\//);
    return Response.json({ effectCount: 1 });
  } });
  assert.equal(report.result, "INCONCLUSIVE");
  assert.equal(report.completion.sequentialAttempted, 0);
  assert.equal(report.completion.reason, "precondition");
});
test("internal failure is ERROR and pre-cancellation is INCONCLUSIVE", async () => {
  const failed = await testHttpIdempotency(config, { fetch: async () => { throw new Error("private"); } });
  assert.equal(failed.result, "ERROR");
  assert.ok(!JSON.stringify(failed).includes("private"));
  const controller = new AbortController(); controller.abort();
  const cancelled = await testHttpIdempotency(config, { signal: controller.signal });
  assert.equal(cancelled.result, "INCONCLUSIVE");
  assert.equal(cancelled.completion.reason, "cancelled");
});

test("unknown original outcome does not make changed input the first accepted operation", async () => {
  const report = await testHttpIdempotency(config, { fetch: async (url, init) => {
    if (String(url).includes("/effects/")) return Response.json({ effectCount: 0 });
    assert.equal(init?.body, config.request.body, "conflicting input must not be sent without an observed prior effect");
    throw new TypeError("fetch failed");
  } });
  assert.equal(report.result, "INCONCLUSIVE");
  assert.equal(report.completion.conflictAttempted, false);
  assert.equal(report.assertions.find((item) => item.name === "conflict-response")?.passed, null);
});

test("a successful response without its declared effect is a known failure", async () => {
  const operation = target();
  const report = await testHttpIdempotency(config, { fetch: async (url, init) => String(url).includes("/effects/")
    ? Response.json({ effectCount: 0 }) : operation(url, init) });
  assert.equal(report.result, "FAIL");
  assert.equal(report.assertions.find((item) => item.name === "sequential-effect")?.passed, false);
});
