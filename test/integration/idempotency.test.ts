import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createIdempotencyTarget } from "../support/idempotency-target.ts";
import { children, startCli } from "../support/cli-process.ts";

async function setup(t: TestContext, options: Parameters<typeof createIdempotencyTarget>[0] = {}, overrides: Record<string, unknown> = {}) {
  const target = createIdempotencyTarget(options);
  const directory = await mkdtemp(join(tmpdir(), "veriq-idempotency-config-"));
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    target.server.closeAllConnections();
    await new Promise<void>((resolve) => target.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  target.server.listen(0, "127.0.0.1"); await once(target.server, "listening");
  const address = target.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const config = {
    request: { target: `${base}/operations`, headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: '{"amount":10}', expectedStatus: 201, timeoutMs: 500, maxDurationMs: 500 },
    state: { target: `${base}/effects/{key}` }, conflictBody: '{"amount":20}', responsePointer: "/operationId", ...overrides,
  };
  const path = join(directory, "experiment.json"); await writeFile(path, JSON.stringify(config));
  return { ...target, path };
}

test("compiled idempotency command verifies real HTTP replay and observed effects", { timeout: 30000 }, async (t) => {
  for (const [mode, expected, sequentialCount, concurrentCount] of [["atomic", "PASS", 1, 1], ["naive", "FAIL", 3, 5], ["racy", "FAIL", 1, 5]] as const) {
    await t.test(`${mode} produces ${expected} with distinct sequential/concurrent evidence`, async (t) => {
      const target = await setup(t, { mode });
      const output = await startCli(["idempotency", "--config", target.path, "--format", "json"]).completion;
      assert.equal(output.code, expected === "PASS" ? 0 : 1, output.stderr || output.stdout);
      const report = JSON.parse(output.stdout);
      assert.equal(report.result, expected);
      assert.equal(report.stateCounts.afterSequential, sequentialCount);
      assert.equal(report.stateCounts.afterConcurrent, concurrentCount);
      assert.equal(report.completion.concurrentPeakInFlight, 5);
      assert.ok(target.metrics.peak >= 2);
      assert.ok(!output.stdout.includes("Bearer secret"));
      t.diagnostic(`${mode}: sequential effects ${sequentialCount}, concurrent effects ${concurrentCount}, ${report.result}`);
    });
  }
  await t.test("unavailable or undeclared state cannot produce PASS and sends no mutations", async (t) => {
    const target = await setup(t, { unavailableState: true });
    const output = await startCli(["idempotency", "--config", target.path]).completion;
    assert.equal(output.code, 3, output.stderr);
    assert.match(output.stdout, /INCONCLUSIVE/);
    assert.equal(target.metrics.operations, 0);
  });
  for (const option of ["malformedResponse", "oversizedResponse", "stalledResponse", "loseFirstResponse"] as const) {
    await t.test(`${option} preserves uncertainty rather than inventing completed JSON evidence`, async (t) => {
      const target = await setup(t, { [option]: true });
      const output = await startCli(["idempotency", "--config", target.path, "--format", "json"]).completion;
      assert.equal(output.code, 3, output.stderr || output.stdout);
      const report = JSON.parse(output.stdout);
      assert.equal(report.result, "INCONCLUSIVE");
      assert.equal(report.stateCounts.afterConcurrent, 1);
      assert.equal(report.error, null);
    });
  }
  await t.test("different replay values fail even when the observed effect count stays one", async (t) => {
    const target = await setup(t, { unstableResponse: true });
    const output = await startCli(["idempotency", "--config", target.path, "--format", "json"]).completion;
    assert.equal(output.code, 1, output.stderr);
    const report = JSON.parse(output.stdout);
    assert.equal(report.stateCounts.afterConcurrent, 1);
    assert.equal(report.assertions.find((item: { name: string }) => item.name === "concurrent-replay").passed, false);
  });
  await t.test("SIGINT cancels an active JSON observation and prevents later phases", async (t) => {
    const target = await setup(t, { delayMs: 4000 });
    const { child, completion } = startCli(["idempotency", "--config", target.path, "--format", "json"]);
    for (let attempt = 0; attempt < 500 && target.metrics.operations < 1; attempt++) await delay(5);
    assert.equal(target.metrics.operations, 1);
    child.kill("SIGINT");
    const output = await completion;
    assert.equal(output.code, 130, output.stderr || output.stdout);
    const report = JSON.parse(output.stdout);
    assert.equal(report.result, "INCONCLUSIVE");
    assert.equal(report.completion.reason, "cancelled");
    assert.equal(report.completion.concurrentAttempted, 0);
  });
  await t.test("SIGTERM fans out during concurrent first use and retains unstarted counts", async (t) => {
    const target = await setup(t, { delayMs: 200 }, { concurrentRequests: 12, concurrency: 3 });
    const { child, completion } = startCli(["idempotency", "--config", target.path, "--format", "json"]);
    for (let attempt = 0; attempt < 500 && target.metrics.operations < 7; attempt++) await delay(5);
    assert.equal(target.metrics.operations, 7);
    child.kill("SIGTERM");
    const output = await completion;
    assert.equal(output.code, 143, output.stderr || output.stdout);
    const report = JSON.parse(output.stdout);
    assert.equal(report.result, "INCONCLUSIVE");
    assert.equal(report.completion.concurrentAttempted, 3);
    assert.equal(report.completion.concurrentUnstarted, 9);
    assert.equal(report.completion.reason, "cancelled");
  });
});
