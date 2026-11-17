import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRetryTarget } from "../support/retry-target.ts";
import { children, startCli } from "../support/cli-process.ts";

async function target(t: TestContext, options?: Parameters<typeof createRetryTarget>[0]) {
  const fixture = createRetryTarget(options);
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    fixture.server.closeAllConnections(); await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });
  fixture.server.listen(0, "127.0.0.1"); await once(fixture.server, "listening");
  const address = fixture.server.address(); assert.ok(address && typeof address !== "string");
  return { ...fixture, base: `http://127.0.0.1:${address.port}` };
}
test("compiled retry command exercises recovery, bounds, delays and write-state safety", { timeout: 20000 }, async (t) => {
  await t.test("transient recovery, persistent failure and permanent status classification", async (t) => {
    const fixture = await target(t);
    for (const [path, code, attempts, reason] of [["flaky", 0, 3, "success"], ["always", 1, 3, "attempts-exhausted"], ["permanent", 1, 1, "non-retryable"]] as const) {
      const output = await startCli(["retry", `${fixture.base}/${path}`, "--base-delay-ms", "5", "--max-delay-ms", "10", "--jitter", "none", "--format", "json"]).completion;
      assert.equal(output.code, code, output.stderr || output.stdout);
      const report = JSON.parse(output.stdout);
      assert.equal(report.attempts.length, attempts); assert.equal(fixture.attempts[`/${path}`], attempts); assert.equal(report.completion.reason, reason);
      t.diagnostic(`${path}: ${report.result}, ${attempts} attempts, ${reason}`);
    }
    const text = await startCli(["retry", `${fixture.base}/flaky`]).completion;
    assert.equal(text.code, 0); assert.match(text.stdout, /PASS/);
  });
  await t.test("Retry-After is honored over a smaller exponential cap", async (t) => {
    const fixture = await target(t);
    const output = await startCli(["retry", `${fixture.base}/rate`, "--base-delay-ms", "1", "--max-delay-ms", "5", "--deadline-ms", "4000", "--format", "json"]).completion;
    assert.equal(output.code, 0, output.stderr || output.stdout);
    const report = JSON.parse(output.stdout);
    assert.equal(report.attempts[0].plannedDelayMs, 1000);
    assert.ok(fixture.starts["/rate"][1] - fixture.starts["/rate"][0] >= 900);
  });
  await t.test("overall deadline clips an active wait and a late success is not retried", async (t) => {
    const fixture = await target(t);
    const timeout = await startCli(["retry", `${fixture.base}/hang`, "--deadline-ms", "120", "--timeout-ms", "2000", "--format", "json"]).completion;
    assert.equal(timeout.code, 1, timeout.stderr || timeout.stdout);
    const report = JSON.parse(timeout.stdout);
    assert.equal(report.attempts.length, 1);
    assert.ok(["deadline", "insufficient-budget"].includes(report.completion.reason));
    assert.ok(report.attempts[0].evidence.timeoutMs <= 120);
    const slow = await startCli(["retry", `${fixture.base}/slow`, "--max-duration-ms", "50", "--timeout-ms", "1000", "--format", "json"]).completion;
    assert.equal(slow.code, 1, slow.stderr);
    assert.equal(JSON.parse(slow.stdout).completion.reason, "response-too-slow");
    assert.equal(fixture.attempts["/slow"], 1);
  });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    await t.test(`${signal} cancels backoff without launching another request`, async (t) => {
      const fixture = await target(t);
      const { child, completion } = startCli(["retry", `${fixture.base}/always`, "--base-delay-ms", "4000", "--max-delay-ms", "4000", "--jitter", "none", "--format", "json"]);
      for (let i = 0; i < 500 && !fixture.attempts["/always"]; i++) await delay(5);
      assert.equal(fixture.attempts["/always"], 1); await delay(30);
      child.kill(signal);
      const output = await completion;
      assert.equal(output.code, code, output.stderr || output.stdout);
      const report = JSON.parse(output.stdout);
      assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "cancelled"); assert.equal(report.attempts.length, 1);
    });
  }
  for (const deduplicate of [true, false]) {
    await t.test(`lost write reply with deduplicate=${deduplicate} checks actual saved effects`, async (t) => {
      const fixture = await target(t, { deduplicate });
      const directory = await mkdtemp(join(tmpdir(), "veriq-retry-config-")); t.after(() => rm(directory, { recursive: true, force: true }));
      const path = join(directory, "retry.json");
      await writeFile(path, JSON.stringify({ request: { target: `${fixture.base}/operations`, method: "POST", headers: { authorization: "Bearer secret" }, body: "privateBody", expectedStatus: 201 }, retrySafety: "idempotency-key", state: { target: `${fixture.base}/effects/{key}` }, policy: { baseDelayMs: 1, maxDelayMs: 1 } }));
      const output = await startCli(["retry", "--config", path, "--format", "json"]).completion;
      assert.equal(output.code, deduplicate ? 0 : 1, output.stderr || output.stdout);
      const report = JSON.parse(output.stdout);
      assert.equal(report.attempts.length, 2); assert.equal(report.state.after.count, deduplicate ? 1 : 2);
      assert.equal(new Set(fixture.keys).size, 1);
      assert.ok(!output.stdout.includes("Bearer secret")); assert.ok(!output.stdout.includes("privateBody"));
      t.diagnostic(`lost reply: recovered=${report.assertions[0].passed}, effects=${report.state.after.count}, ${report.result}`);
    });
  }
});
