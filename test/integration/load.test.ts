import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLoadTarget } from "../support/load-target.ts";
import { startCli, children } from "../support/cli-process.ts";

async function setup(t: TestContext, options: Parameters<typeof createLoadTarget>[0] = {}) {
  const fixture = createLoadTarget(options), directory = await mkdtemp(join(tmpdir(), "veriq-load-"));
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    fixture.stopWork(); fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  });
  fixture.server.listen(0, "127.0.0.1"); await once(fixture.server, "listening");
  const address = fixture.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`, path = join(directory, "load.json");
  const config = { request: { target: `${base}/work`, timeoutMs: 1000, maxDurationMs: 75 }, stages: [1, 2, 8], stageDurationMs: 250, pauseMs: 20, minSamplesPerStage: 3, maxRequestsPerStage: 1000, deadlineMs: 5000 };
  async function run(extra: Record<string, unknown> = {}, format = "json") { await writeFile(path, JSON.stringify({ ...config, ...extra })); return startCli(["load", "--config", path, "--format", format]).completion; }
  return { ...fixture, base, path, config, run };
}
test("load command observes timed ramp stages, overload and low-concurrency recovery over real HTTP", { timeout: 25000 }, async (t) => {
  await t.test("a bounded queue plateaus while latency rises, then recovers", async (t) => {
    const fixture = await setup(t);
    const output = await fixture.run(); assert.equal(output.code, 1, output.stderr || output.stdout);
    const report = JSON.parse(output.stdout); assert.equal(report.result, "FAIL");
    assert.deepEqual(report.stages.map((s: {result: string}) => s.result), ["PASS", "PASS", "FAIL", "PASS"]);
    assert.equal(report.comparison.firstObservedFailingConcurrency, 8); assert.equal(report.comparison.recoveryResult, "PASS");
    assert.equal(fixture.metrics.peakActive, 2); assert.ok(fixture.metrics.peakQueued > 0); assert.equal(fixture.metrics.active, 0);
    assert.equal(fixture.metrics.received, report.attemptedRequests);
    const medium = report.stages[1], high = report.stages[2];
    assert.ok(high.summary.expectedStatusResponseDurations.meanMs > medium.summary.expectedStatusResponseDurations.meanMs * 1.5);
    assert.ok(high.summary.rates.expectedStatusResponsesPerSecond < medium.summary.rates.expectedStatusResponsesPerSecond * 1.6);
    for (const stage of report.stages) {
      assert.equal(stage.completion.fullAdmissionWindow, true); assert.ok(stage.requests.every((r: {startedElapsedMs: number}) => r.startedElapsedMs < 250));
      assert.ok(stage.summary.peakInFlight <= stage.concurrency); assert.equal(stage.summary.unknownCount, 0);
    }
    t.diagnostic(report.stages.map((s: {phase: string; concurrency: number; summary: {rates: {expectedStatusResponsesPerSecond: number}; expectedStatusResponseDurations: {p95Ms: number}}; result: string}) => `${s.phase}/${s.concurrency}: ${s.summary.rates.expectedStatusResponsesPerSecond.toFixed(1)} expected-status/s, p95 ${s.summary.expectedStatusResponseDurations.p95Ms.toFixed(1)} ms, ${s.result}`).join("; "));
  });
  await t.test("unbounded simulated I/O handles the declared levels and text output", async (t) => {
    const fixture = await setup(t, { mode: "unbounded" }); const output = await fixture.run({}, "text");
    assert.equal(output.code, 0, output.stderr || output.stdout); assert.match(output.stdout, /PASS/); assert.match(output.stdout, /recovery/);
    assert.ok(fixture.metrics.peakActive > 2);
  });
  await t.test("fast rejections increase header completions but not passed throughput", async (t) => {
    const fixture = await setup(t, { mode: "reject" }); const output = await fixture.run({ stages: [1, 4], stageDurationMs: 100 });
    assert.equal(output.code, 1, output.stderr || output.stdout); const report = JSON.parse(output.stdout), high = report.stages[1];
    assert.ok(high.summary.statusCounts[503] > 0); assert.ok(fixture.metrics.rejected > 0);
    assert.ok(high.summary.rates.responseHeadersPerSecond > high.summary.rates.passedRequestsPerSecond);
    assert.equal(report.comparison.recoveryResult, "PASS");
  });
  await t.test("persistent overload damage fails the low-concurrency recovery requirement", async (t) => {
    const fixture = await setup(t, { mode: "sticky" }); const output = await fixture.run({ stages: [1, 4] });
    assert.equal(output.code, 1, output.stderr || output.stdout); const report = JSON.parse(output.stdout);
    assert.equal(report.stages[0].result, "PASS"); assert.equal(report.comparison.recoveryResult, "FAIL"); assert.equal(fixture.metrics.degraded, true);
  });
  await t.test("request cap and insufficient samples cannot yield a capacity PASS", async (t) => {
    const fixture = await setup(t, { mode: "unbounded" });
    const capped = await fixture.run({ stages: [1], maxRequestsPerStage: 3 }); assert.equal(capped.code, 3);
    const report = JSON.parse(capped.stdout); assert.equal(report.completion.reason, "request-cap"); assert.equal(report.attemptedRequests, 6);
    const sparse = await fixture.run({ stages: [1], minSamplesPerStage: 100, recovery: false }); assert.equal(sparse.code, 3);
    assert.equal(JSON.parse(sparse.stdout).stages[0].completion.fullAdmissionWindow, true);
  });
  await t.test("POST transmits the configured request while reports omit private values", async (t) => {
    const fixture = await setup(t, { mode: "unbounded", serviceMs: 10 });
    const output = await fixture.run({ stages: [1], stageDurationMs: 75, recovery: false, request: { target: `${fixture.base}/work?token=privateQuery`, method: "POST", headers: { authorization: "Bearer privateHeader" }, body: "privateBody", maxDurationMs: 200 } });
    assert.equal(output.code, 0, output.stderr || output.stdout);
    assert.ok(fixture.arrivals.every((a) => a.method === "POST" && a.body === "privateBody" && a.authorization === "Bearer privateHeader"));
    for (const value of ["privateQuery", "privateHeader", "privateBody"]) assert.ok(!output.stdout.includes(value));
  });
  await t.test("per-request timeouts are failures and server work may outlive their observations", async (t) => {
    const fixture = await setup(t, { serviceMs: 120 });
    const output = await fixture.run({ stages: [1], stageDurationMs: 100, recovery: false, request: { target: fixture.base + "/work", timeoutMs: 35, maxDurationMs: 25 } });
    assert.equal(output.code, 1, output.stderr || output.stdout); const stage = JSON.parse(output.stdout).stages[0];
    assert.ok(stage.summary.timeoutCount > 0); assert.equal(stage.summary.responseDurations, null); assert.equal(stage.summary.expectedStatusResponseDurations, null);
    await delay(150); assert.ok(fixture.metrics.completed > 0); assert.ok(fixture.metrics.clientClosed > 0);
  });
  await t.test("one overall deadline clips the active stage and skips recovery", async (t) => {
    const fixture = await setup(t, { serviceMs: 300 }); const output = await fixture.run({ deadlineMs: 50 });
    assert.equal(output.code, 3, output.stderr || output.stdout); const report = JSON.parse(output.stdout);
    assert.equal(report.completion.reason, "deadline"); assert.equal(report.stages.length, 1);
    assert.equal(report.stages[0].summary.failedCount, 0); assert.ok(report.stages[0].summary.unknownCount > 0);
  });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    await t.test(`${signal} stops new work and preserves a partial report`, async (t) => {
      const fixture = await setup(t, { serviceMs: 200 }); await writeFile(fixture.path, JSON.stringify(fixture.config));
      const { child, completion } = startCli(["load", "--config", fixture.path, "--format", "json"]);
      for (let i = 0; i < 400 && fixture.metrics.received === 0; i++) await delay(5);
      assert.equal(fixture.metrics.received, 1); child.kill(signal); const output = await completion;
      assert.equal(output.code, code, output.stderr || output.stdout); const report = JSON.parse(output.stdout);
      assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "cancelled"); assert.equal(report.stages.length, 1);
    });
  }
});
