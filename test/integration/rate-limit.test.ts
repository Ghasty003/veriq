import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createRateLimitTarget, type RateMode } from "../support/rate-limit-target.ts";
import { children, startCli } from "../support/cli-process.ts";
import { testHttpRateLimit } from "../../src/http-rate-limit.ts";

async function setup(t: TestContext, mode: RateMode = "atomic", responseDelayMs = 0) {
  const fixture = createRateLimitTarget({ mode, responseDelayMs, windowMs: 1000 });
  const directory = await mkdtemp(join(tmpdir(), "veriq-rate-"));
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    fixture.server.closeAllConnections(); await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  fixture.server.listen(0, "127.0.0.1"); await once(fixture.server, "listening");
  const address = fixture.server.address(); assert.ok(address && typeof address !== "string");
  const config = { request: { target: `http://127.0.0.1:${address.port}/limited`, headers: { authorization: "Bearer private" } }, windowMs: 1000, deadlineMs: 5000 };
  const path = join(directory, "rate.json");
  async function run(extra: Record<string, unknown> = {}, format = "json") {
    await writeFile(path, JSON.stringify({ ...config, ...extra }));
    return startCli(["rate-limit", "--config", path, "--format", format]).completion;
  }
  return { ...fixture, config, path, run };
}
test("rate-limit experiment verifies real HTTP admission, isolation, reset and concurrency", { timeout: 25000 }, async (t) => {
  for (const [mode, expected, failed] of [["atomic", "PASS", null], ["global", "FAIL", "caller-isolation"], ["racy", "FAIL", "concurrent-cap"], ["sticky", "FAIL", "reset-allowance"], ["deny-all", "FAIL", "primary-allowance"]] as const) {
    await t.test(mode, async (t) => {
      const fixture = await setup(t, mode);
      const output = await fixture.run({ requireRetryAfter: true });
      const report = JSON.parse(output.stdout);
      assert.equal(output.code, expected === "PASS" ? 0 : 1, output.stderr || output.stdout);
      assert.equal(report.result, expected);
      if (failed) assert.equal(report.assertions.find((a: {name: string}) => a.name === failed).passed, false);
      if (mode === "atomic") {
        assert.equal(report.attempts.length, 18); assert.equal(new Set(fixture.starts.map((s) => s.identity)).size, 3);
        assert.ok(report.peakInFlight > 1); assert.ok(report.peakInFlight <= 5);
        const a = fixture.starts.filter((s) => s.identity === fixture.starts[0].identity);
        assert.ok(a[5].time - a[0].time >= 1000);
        assert.equal(report.attempts.filter((a: {phase: string; evidence: {status: number}}) => a.phase === "concurrent" && a.evidence.status === 200).length, 3);
      }
      assert.ok(!output.stdout.includes("Bearer private"));
      t.diagnostic(`${mode}: ${report.result}; ${report.attempts.length} requests; failing assertions ${report.assertions.filter((a: {passed: boolean}) => a.passed === false).map((a: {name: string}) => a.name).join(", ")}`);
    });
  }
  await t.test("Retry-After is optional unless declared required", async (t) => {
    const fixture = await setup(t, "no-retry-after");
    assert.equal((await fixture.run()).code, 0);
    const output = await fixture.run({ requireRetryAfter: true });
    assert.equal(output.code, 1);
    assert.equal(JSON.parse(output.stdout).assertions.find((a: {name: string}) => a.name === "retry-after").passed, false);
  });
  await t.test("slow observations crossing a reset boundary are inconclusive", async (t) => {
    const fixture = await setup(t, "atomic", 140);
    const report = await testHttpRateLimit({ ...fixture.config, windowMs: 100, windowGuardMs: 10 });
    assert.equal(report.result, "INCONCLUSIVE"); assert.equal(report.completion.reason, "window-overrun");
    assert.ok(report.attempts.some((a) => !a.inWindow));
  });
  await t.test("shared deadline bounds active observations", async (t) => {
    const fixture = await setup(t, "atomic", 200);
    const output = await fixture.run({ deadlineMs: 50 });
    assert.equal(output.code, 3, output.stderr || output.stdout);
    const report = JSON.parse(output.stdout);
    assert.equal(report.completion.reason, "deadline"); assert.equal(report.attempts.length, 1);
    assert.ok(report.durationMs < 1000);
  });
  for (const [signal, exit] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    await t.test(`${signal} cancels the reset wait and starts no burst`, async (t) => {
      const fixture = await setup(t);
      await writeFile(fixture.path, JSON.stringify(fixture.config));
      const { child, completion } = startCli(["rate-limit", "--config", fixture.path]);
      for (let i = 0; i < 400 && fixture.starts.length < 8; i++) await delay(5);
      assert.equal(fixture.starts.length, 8); child.kill(signal);
      const output = await completion;
      assert.equal(output.code, exit, output.stderr || output.stdout); assert.match(output.stdout, /INCONCLUSIVE/);
      assert.match(output.stdout, /completion: cancelled/); assert.equal(fixture.starts.length, 8);
    });
  }
});
