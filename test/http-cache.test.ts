import assert from "node:assert/strict";
import { test } from "node:test";
import { testHttpCache } from "../src/http-cache.ts";
import { formatCacheReport } from "../src/cache-report.ts";
import { cacheConfiguration } from "./support/cache-target.ts";
const config = cacheConfiguration("http://example.test");
test("pre-cancelled cache experiment sends no requests and retains unknown assertions", async () => {
  const controller = new AbortController(); controller.abort();
  const report = await testHttpCache(config, { signal: controller.signal, fetch: async () => { throw Error("must not send"); } });
  assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "cancelled"); assert.equal(report.observations.length, 0);
  assert.ok(report.assertions.every((a) => a.passed === null));
});
test("cache observer exceptions become sanitized ERROR with preserved attempted observation", async () => {
  const report = await testHttpCache({ ...config, source: { ...config.source, headers: { authorization: "Bearer private" }, target: config.source.target + "?token=secret" } }, { fetch: async () => { throw new Error("private failure"); } });
  assert.equal(report.result, "ERROR"); assert.equal(report.observations.length, 1); assert.equal(report.observations[0].evidence!.outcome, "execution-error");
  const text = formatCacheReport(report, "json");
  for (const secret of ["Bearer private", "private failure", "token=secret"]) assert.ok(!text.includes(secret));
});
test("unknown or non-fresh source preconditions cause no mutations", async () => {
  for (const body of [{ value: "existing", reads: 3 }, { value: null }, { value: null, reads: -1 }, { value: null, reads: Number.MAX_SAFE_INTEGER + 1 }]) {
    const methods: string[] = [];
    const report = await testHttpCache(config, { fetch: async (_, init) => { methods.push(init!.method!); return Response.json(body); } });
    assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "precondition"); assert.ok(methods.every((m) => m === "GET"));
    assert.equal(report.attemptedReads, 0);
  }
});
test("a connection failure cannot be interpreted as cache reuse", async () => {
  const report = await testHttpCache(config, { fetch: async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) }); } });
  assert.equal(report.result, "INCONCLUSIVE"); assert.ok(report.observations.every((o) => o.evidence!.outcome === "request-error"));
});

test("a known bad warm value survives cancellation before the remaining samples and count audit", async () => {
  const states = new Map<string, { value: string | null; reads: number }>();
  const controller = new AbortController(); let reads = 0;
  const report = await testHttpCache(config, { signal: controller.signal, fetch: async (input, init) => {
    const url = new URL(String(input)), [, kind, caller, key] = url.pathname.split("/"), id = `${caller}/${key}`;
    const state = states.get(id) ?? { value: null, reads: 0 }; states.set(id, state);
    if (init!.method === "PUT") { state.value = JSON.parse(init!.body as string).value; return Response.json({ ok: true }); }
    if (kind === "source") return Response.json(state);
    reads++; state.reads++;
    if (reads === 3) controller.abort();
    return Response.json({ value: state.value });
  } });
  assert.equal(report.result, "FAIL"); assert.equal(report.completion.reason, "cancelled");
  assert.equal(report.assertions.find((a) => a.name === "warm-values")!.passed, false);
});
