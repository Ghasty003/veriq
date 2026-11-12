import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHttpTarget, type TargetEvent } from "../support/http-target.ts";
import { children, startCli } from "../support/cli-process.ts";

async function target(t: TestContext, delays?: number[]) {
  const events: TargetEvent[] = [];
  const server = createHttpTarget((event) => events.push(event), delays);
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, events, base: `http://127.0.0.1:${address.port}` };
}

test("compiled latency command preserves configurable samples and real HTTP outcomes", { timeout: 20000 }, async (t) => {
  await t.test("default JSON, configurable samples and text output", async (t) => {
    const { base } = await target(t);
    const output = await startCli(["latency", `${base}/health`]).completion;
    assert.equal(output.code, 0, output.stderr);
    const report = JSON.parse(output.stdout);
    assert.equal(report.result, "PASS");
    assert.equal(report.samples.length, 5);
    assert.equal(report.configuration.maxDurationMs, 200);
    assert.equal(report.completion.reason, "completed");
    const text = await startCli(["latency", `${base}/health`, "--samples", "3", "--format", "text", "--max-duration-ms", "1000"]).completion;
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /3\/3 attempted/);
    assert.match(text.stdout, /p99/);
    t.diagnostic(`Immediate target: ${report.samples.length} responses, mean ${report.summary.responseDurations.meanMs.toFixed(1)} ms, ${report.result}`);
  });

  await t.test("consistent and occasional slow responses fail the per-sample rule", async (t) => {
    const { base } = await target(t, [0, 0, 300, 0, 0]);
    const steady = await startCli(["latency", `${base}/delay?ms=150`, "--samples", "2", "--max-duration-ms", "50", "--timeout-ms", "1000"]).completion;
    assert.equal(steady.code, 1, steady.stderr);
    const steadyReport = JSON.parse(steady.stdout);
    assert.equal(steadyReport.summary.responseCount, 2);
    assert.ok(steadyReport.samples.every((sample: { assertion: { passed: boolean } }) => sample.assertion.passed === false));
    const occasional = await startCli(["latency", `${base}/sequence`, "--samples", "5", "--max-duration-ms", "100", "--timeout-ms", "1000"]).completion;
    assert.equal(occasional.code, 1, occasional.stderr);
    const report = JSON.parse(occasional.stdout);
    assert.equal(report.samples[2].assertion.passed, false);
    assert.ok(report.samples[2].evidence.durationMs >= 300);
    assert.equal(report.samples.length, 5);
    assert.equal(report.completion.completedSampleCount, 5);
    t.diagnostic(`Occasional delay: ${report.samples.map((sample: { evidence: { durationMs: number } }) => sample.evidence.durationMs.toFixed(1)).join(", ")} ms; ${report.result}`);
  });

  await t.test("status expectations are configurable and timeouts are excluded from response statistics", async (t) => {
    const { base } = await target(t);
    const wrong = await startCli(["latency", `${base}/missing`, "--samples", "2"]).completion;
    assert.equal(wrong.code, 1);
    assert.equal(JSON.parse(wrong.stdout).summary.responseCount, 2);
    const expected = await startCli(["latency", `${base}/missing`, "--samples", "2", "--expected-status", "404", "--max-duration-ms", "1000"]).completion;
    assert.equal(expected.code, 0, expected.stderr);
    const timeout = await startCli(["latency", `${base}/hang`, "--samples", "3", "--max-duration-ms", "50", "--timeout-ms", "50"]).completion;
    assert.equal(timeout.code, 1, timeout.stderr);
    const report = JSON.parse(timeout.stdout);
    assert.equal(report.summary.timeoutCount, 3);
    assert.equal(report.summary.responseDurations, null);
    assert.equal(report.completion.completedSampleCount, 3);
  });

  for (const [signal, code, expectedStatus, result] of [
    ["SIGINT", 130, "200", "INCONCLUSIVE"],
    ["SIGTERM", 143, "200", "INCONCLUSIVE"],
    ["SIGINT", 130, "201", "FAIL"],
  ] as const) {
    await t.test(`${signal} preserves partial evidence and ${result} with expected ${expectedStatus}`, async (t) => {
      const { base, events } = await target(t, [0, 5000]);
      const { child, completion } = startCli(["latency", `${base}/sequence`, "--samples", "5", "--expected-status", expectedStatus, "--timeout-ms", "5000", "--max-duration-ms", "2000"]);
      for (let attempt = 0; attempt < 500 && events.filter((event) => event.event === "request").length < 2; attempt++) await delay(5);
      assert.equal(events.filter((event) => event.event === "request").length, 2);
      child.kill(signal);
      const output = await completion;
      assert.equal(output.code, code, output.stderr);
      const report = JSON.parse(output.stdout);
      assert.equal(report.result, result);
      assert.equal(report.completion.reason, "cancelled");
      assert.equal(report.completion.completedSampleCount, 1);
      assert.equal(report.completion.attemptedSampleCount, 2);
      assert.equal(report.completion.unstartedSampleCount, 3);
      assert.equal(report.summary.responseCount, 1);
      assert.equal(report.summary.cancelledCount, 1);
      assert.equal(events.filter((event) => event.event === "request").length, 2);
      t.diagnostic(`${signal}: ${result}, 1 completed / 1 cancelled / 3 unstarted`);
    });
  }

  await t.test("refused connections preserve all attempts without fabricated response latency", async (t) => {
    const { base, server } = await target(t);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const output = await startCli(["latency", `${base}/health`, "--samples", "3"]).completion;
    assert.equal(output.code, 1, output.stderr);
    const report = JSON.parse(output.stdout);
    assert.equal(report.summary.requestErrorCount, 3);
    assert.equal(report.summary.responseDurations, null);
    assert.equal(report.completion.reason, "completed");
  });
});
