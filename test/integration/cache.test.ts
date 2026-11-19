import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheConfiguration, createCacheTarget } from "../support/cache-target.ts";
import { startCli, children } from "../support/cli-process.ts";
import { testHttpCache } from "../../src/http-cache.ts";

async function setup(t: TestContext, options: Parameters<typeof createCacheTarget>[0] = {}) {
  const fixture = createCacheTarget(options);
  const directory = await mkdtemp(join(tmpdir(), "veriq-cache-"));
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    fixture.server.closeAllConnections(); await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  fixture.server.listen(0, "127.0.0.1"); await once(fixture.server, "listening");
  const address = fixture.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`, config = cacheConfiguration(base, options.ttlMs ?? 700), path = join(directory, "cache.json");
  async function run(extra: Record<string, unknown> = {}, format = "json") {
    await writeFile(path, JSON.stringify({ ...config, ...extra }));
    return startCli(["cache", "--config", path, "--format", format]).completion;
  }
  return { ...fixture, base, config, path, run };
}
const verdict = (report: Awaited<ReturnType<typeof testHttpCache>>, name: string) => report.assertions.find((a) => a.name === name)!.passed;
test("cache experiment verifies real reuse, freshness, isolation and coalescing", { timeout: 45000 }, async (t) => {
  for (const [mode, failed] of [["single-flight", null], ["no-cache", "warm-source-reuse"], ["never-expire", "expiry-value"], ["no-invalidation", "invalidation-value"], ["shared-key", "caller-isolation"], ["shared-entry", "key-isolation"], ["stampede", "burst-source-coalescing"], ["write-through", null]] as const) {
    await t.test(mode, async (t) => {
      const fixture = await setup(t, { mode });
      const output = await fixture.run();
      assert.equal(output.code, failed ? 1 : 0, output.stderr || output.stdout);
      const report = JSON.parse(output.stdout);
      assert.equal(report.result, failed ? "FAIL" : "PASS");
      if (failed) assert.equal(verdict(report, failed), false);
      if (mode === "single-flight") {
        assert.equal(report.attemptedReads, 18); assert.equal(fixture.metrics.sourceLoads, 9); assert.equal(fixture.metrics.joined, 4);
        assert.equal(report.observations.length, 53);
        assert.equal(report.expectedValues.length, 6);
        assert.equal(report.observations.find((o: {phase: string}) => o.phase === "cold").valueFingerprint, report.expectedValues.find((e: {bucket: string}) => e.bucket === "ttl").initialFingerprint);
        assert.equal(report.preconditions.length, 6); assert.ok(report.preconditions.every((p: {seeded: boolean}) => p.seeded));
        assert.ok(report.peakInFlight > 1); assert.ok(report.peakInFlight <= 5);
        assert.equal(fixture.metrics.peakLoads, 1);
        assert.ok(report.observations.every((o: {evidence: {measurementBoundary: string}}) => o.evidence.measurementBoundary === "response-json"));
      }
      if (mode === "stampede") { assert.equal(verdict(report, "burst-values"), true); assert.ok(fixture.metrics.peakLoads > 1); }
      t.diagnostic(`${mode}: ${report.result}; source loads=${fixture.metrics.sourceLoads}; failing assertions=${report.assertions.filter((a: {passed: boolean}) => a.passed === false).map((a: {name: string}) => a.name).join(", ")}`);
    });
  }
  await t.test("TTL-only policy permits waiting for expiry rather than immediate invalidation", async (t) => {
    const fixture = await setup(t, { mode: "no-invalidation" });
    const output = await fixture.run({ invalidation: "ttl-only", write: undefined }, "text");
    assert.equal(output.code, 0, output.stderr || output.stdout); assert.match(output.stdout, /PASS/);
    assert.match(output.stdout, /reads: 16\/16/); assert.doesNotMatch(output.stdout, /invalidation-value/);
  });
  await t.test("unavailable or malformed source counts prevent mutations and yield unknown evidence", async (t) => {
    const fixture = await setup(t, { invalidCounts: true });
    const report = await testHttpCache(fixture.config);
    assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "precondition");
    assert.equal(fixture.metrics.cacheRequests, 0); assert.ok(fixture.events.every((e) => e.action === "GET:source"));
  });
  await t.test("late warm reads do not become false expiry or reuse failures", async (t) => {
    const fixture = await setup(t, { ttlMs: 100, hitDelayMs: 120, sourceDelayMs: 5 });
    const report = await testHttpCache(fixture.config);
    assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "ttl-window-overrun");
    assert.equal(verdict(report, "warm-source-reuse"), null); assert.equal(verdict(report, "expiry-source-refresh"), null);
  });
  for (const malformed of ["malformedReads", "oversizedReads", "stalledReads"] as const) {
    await t.test(`${malformed} preserves unavailable JSON evidence`, async (t) => {
      const fixture = await setup(t, { [malformed]: true, sourceDelayMs: 5 });
      const report = await testHttpCache({ ...fixture.config, read: { ...fixture.config.read, timeoutMs: 70, maxDurationMs: 60 } });
      assert.equal(report.result, "INCONCLUSIVE"); assert.equal(verdict(report, "burst-source-coalescing"), null);
      assert.ok(report.observations.some((o) => o.action === "read" && o.evidence!.outcome === ({ malformedReads: "invalid-json", oversizedReads: "body-limit", stalledReads: "timeout" } as const)[malformed]));
    });
  }
  await t.test("observed extra burst loads remain FAIL when the JSON bodies are missing", async (t) => {
    const fixture = await setup(t, { mode: "stampede", sourceDelayMs: 5, stalledReadsAfter: 13 });
    const report = await testHttpCache({ ...fixture.config, read: { ...fixture.config.read, timeoutMs: 70, maxDurationMs: 60 } });
    assert.equal(report.result, "FAIL"); assert.equal(verdict(report, "burst-source-coalescing"), false);
    assert.equal(verdict(report, "burst-values"), null);
  });
  await t.test("a decreasing source counter remains unknown evidence", async (t) => {
    const fixture = await setup(t, { invalidateCounter: true, sourceDelayMs: 5 });
    const report = await testHttpCache(fixture.config);
    assert.equal(report.result, "INCONCLUSIVE"); assert.equal(verdict(report, "expiry-source-refresh"), null);
    assert.equal(verdict(report, "burst-source-coalescing"), null);
  });
  await t.test("counter resets during out-of-band writes cannot masquerade as reuse", async (t) => {
    const fixture = await setup(t, { resetCounterOnOriginWrite: true, sourceDelayMs: 5 });
    const report = await testHttpCache(fixture.config);
    assert.equal(report.result, "INCONCLUSIVE"); assert.ok(report.counterIssues.length > 0);
    assert.equal(verdict(report, "warm-source-reuse"), null);
    assert.equal(verdict(report, "cold-source-read"), null);
  });
  await t.test("a known bad read status fails the HTTP requirement", async (t) => {
    const fixture = await setup(t, { readStatus: 503, sourceDelayMs: 5 });
    const report = await testHttpCache(fixture.config);
    assert.equal(report.result, "FAIL"); assert.equal(verdict(report, "read-responses"), false);
  });
  await t.test("the overall deadline clips body observation and prevents later phases", async (t) => {
    const fixture = await setup(t, { sourceDelayMs: 200 });
    const output = await fixture.run({ deadlineMs: 60 });
    assert.equal(output.code, 3, output.stderr || output.stdout);
    const report = JSON.parse(output.stdout); assert.equal(report.completion.reason, "deadline");
    assert.ok(report.durationMs < 1000); assert.ok(report.observations.some((o: {evidence: {outcome: string}}) => ["timeout", "cancelled"].includes(o.evidence.outcome)));
  });
  for (const [signal, exit, mode, result] of [["SIGINT", 130, "single-flight", "INCONCLUSIVE"], ["SIGTERM", 143, "no-cache", "FAIL"]] as const) {
    await t.test(`${signal} interrupts expiry waiting and preserves ${result}`, async (t) => {
      const fixture = await setup(t, { mode }); await writeFile(fixture.path, JSON.stringify(fixture.config));
      const { child, completion } = startCli(["cache", "--config", fixture.path, "--format", "json"]);
      for (let i = 0; i < 500 && fixture.metrics.cacheRequests < 3; i++) await delay(5);
      assert.equal(fixture.metrics.cacheRequests, 3); await delay(60); child.kill(signal);
      const output = await completion; assert.equal(output.code, exit, output.stderr || output.stdout);
      const report = JSON.parse(output.stdout); assert.equal(report.result, result); assert.equal(report.completion.reason, "cancelled");
      assert.equal(report.peakInFlight, 0);
    });
  }
  await t.test("an old in-flight fill cannot overwrite a normal write's refreshed entry", async (t) => {
    const fixture = await setup(t, { sourceDelayMs: 120 });
    async function put(path: string, value: string) { const response = await fetch(fixture.base + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) }); assert.equal(response.status, 200); await response.json(); }
    await put("/origin/caller/key", "old");
    const old = fetch(fixture.base + "/cache/caller/key").then(async (r) => await r.json() as { value: string });
    for (let i = 0; i < 200 && !fixture.metrics.activeLoads; i++) await delay(2);
    assert.equal(fixture.metrics.activeLoads, 1);
    await put("/source/caller/key", "new");
    const fresh = fetch(fixture.base + "/cache/caller/key").then(async (r) => await r.json() as { value: string });
    assert.equal((await old).value, "old"); assert.equal((await fresh).value, "new");
    assert.equal((await (await fetch(fixture.base + "/cache/caller/key")).json() as { value: string }).value, "new");
    assert.equal(fixture.metrics.sourceLoads, 2);
  });
});
