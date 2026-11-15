import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createConcurrencyTarget } from "../support/concurrency-target.ts";
import { createHttpTarget } from "../support/http-target.ts";
import { children, startCli } from "../support/cli-process.ts";

async function listen(t: TestContext, server: ReturnType<typeof createHttpTarget>) {
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("compiled concurrency command uses bounded real HTTP requests and preserves evidence", { timeout: 20000 }, async (t) => {
  await t.test("healthy overlap obeys the client limit and independently measured server overlap", async (t) => {
    const { server, metrics } = createConcurrencyTarget();
    const base = await listen(t, server);
    const output = await startCli(["concurrency", `${base}/work`, "--requests", "13", "--concurrency", "3", "--max-duration-ms", "2000", "--format", "json"]).completion;
    assert.equal(output.code, 0, output.stderr);
    const report = JSON.parse(output.stdout);
    assert.equal(report.requests.length, 13);
    assert.equal(report.summary.peakInFlight, 3);
    assert.equal(metrics.received, 13);
    assert.equal(metrics.peak, 3);
    assert.equal(report.summary.statusCounts[200], 13);
    assert.deepEqual(report.requests.map((request: { request: number }) => request.request), Array.from({ length: 13 }, (_, i) => i + 1));
    t.diagnostic(`Healthy: 13 responses; client peak ${report.summary.peakInFlight}, server peak ${metrics.peak}, ${report.result}`);
  });

  await t.test("busy targets yield explicit rejected status evidence and continue remaining requests", async (t) => {
    const { server, metrics } = createConcurrencyTarget({ capacity: 2, delayMs: 150 });
    const base = await listen(t, server);
    const output = await startCli(["concurrency", `${base}/work`, "--requests", "15", "--concurrency", "5", "--max-duration-ms", "2000", "--format", "json"]).completion;
    assert.equal(output.code, 1, output.stderr);
    const report = JSON.parse(output.stdout);
    assert.ok(report.summary.statusCounts[503] > 0);
    assert.equal(report.completion.completedRequestCount, 15);
    assert.equal(metrics.peak, 2);
    assert.equal(metrics.received, 15);
    t.diagnostic(`Busy: ${JSON.stringify(report.summary.statusCounts)}, server capacity/peak 2, ${report.result}`);
  });

  await t.test("POST configuration sends headers/body and supports text without leaking secrets", async (t) => {
    let bytes = 0;
    const base = await listen(t, createHttpTarget((event) => { if (event.event === "body-received") bytes += event.bodyBytes ?? 0; }));
    const directory = await mkdtemp(join(tmpdir(), "veriq-concurrency-config-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "http.json");
    await writeFile(path, JSON.stringify({ target: `${base}/echo?token=querySecret`, method: "POST", headers: { authorization: "Bearer headerSecret" }, body: "bodySecret", expectedStatus: 201, requests: 4, concurrency: 2, maxDurationMs: 2000 }));
    const output = await startCli(["concurrency", "--config", path, "--format", "json"]).completion;
    assert.equal(output.code, 0, output.stderr);
    assert.equal(bytes, 4 * 10);
    for (const secret of ["querySecret", "headerSecret", "bodySecret"]) assert.ok(!output.stdout.includes(secret));
    const text = await startCli(["concurrency", `${base}/health`, "--requests", "2", "--concurrency", "8"]).completion;
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /peak client-side in-flight 2/);
  });

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    await t.test(`${signal} cancels active requests without starting queued work`, async (t) => {
      const { server, metrics } = createConcurrencyTarget({ delayMs: 5000 });
      const base = await listen(t, server);
      const { child, completion } = startCli(["concurrency", `${base}/work`, "--requests", "30", "--concurrency", "3", "--timeout-ms", "10000", "--format", "json"]);
      for (let i = 0; i < 500 && metrics.received < 3; i++) await delay(5);
      assert.equal(metrics.received, 3);
      child.kill(signal);
      const output = await completion;
      assert.equal(output.code, code, output.stderr);
      const report = JSON.parse(output.stdout);
      assert.equal(report.result, "INCONCLUSIVE");
      assert.equal(report.summary.cancelledCount, 3);
      assert.equal(report.completion.attemptedRequestCount, 3);
      assert.equal(report.completion.unstartedRequestCount, 27);
      assert.equal(metrics.received, 3);
    });
  }

  await t.test("timeouts and refused connections keep complete failure evidence", async (t) => {
    const { server } = createConcurrencyTarget({ delayMs: 1000 });
    const base = await listen(t, server);
    const timeout = await startCli(["concurrency", `${base}/work`, "--requests", "5", "--concurrency", "2", "--timeout-ms", "50", "--max-duration-ms", "50", "--format", "json"]).completion;
    assert.equal(timeout.code, 1, timeout.stderr);
    const report = JSON.parse(timeout.stdout);
    assert.equal(report.summary.timeoutCount, 5);
    assert.equal(report.summary.responseDurations, null);
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    const refused = await startCli(["concurrency", `${base}/work`, "--requests", "4", "--concurrency", "2", "--format", "json"]).completion;
    assert.equal(refused.code, 1, refused.stderr);
    assert.equal(JSON.parse(refused.stdout).summary.requestErrorCount, 4);
  });
});
