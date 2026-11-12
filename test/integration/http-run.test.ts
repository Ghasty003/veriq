import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHttpTarget, type TargetEvent } from "../support/http-target.ts";
import { children, startCli } from "../support/cli-process.ts";


test("compiled CLI executes real HTTP requests and preserves lifecycle boundaries", { timeout: 30000 }, async (t) => {
  const events: TargetEvent[] = [];
  const server = createHttpTarget((event) => events.push(event));
  const directory = await mkdtemp(join(tmpdir(), "veriq-http-run-"));
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  async function jsonRun(path: string, code: number, extra: string[] = []) {
    const output = await startCli(["run", `${base}${path}`, "--format", "json", ...extra]).completion;
    assert.equal(output.code, code, output.stderr || output.stdout);
    assert.equal(output.stderr, "");
    return JSON.parse(output.stdout);
  }

  await t.test("success, wrong status, text, and legacy probe", async () => {
    const report = await jsonRun("/health", 0);
    assert.equal(report.result, "PASS");
    assert.equal(report.evidence.status, 200);
    assert.equal(report.evidence.measurementBoundary, "response-headers");
    assert.equal((await jsonRun("/missing", 1)).evidence.status, 404);
    const text = await startCli(["run", `${base}/health`]).completion;
    assert.equal(text.code, 0);
    assert.match(text.stdout, /PASS.*GET/);
    const legacy = await startCli(["probe", `${base}/health`]).completion;
    assert.equal(legacy.code, 0);
    assert.equal(JSON.parse(legacy.stdout).result, "PASS");
  });

  await t.test("redirects are recorded without following and query values are redacted", async () => {
    const count = events.filter((event) => event.event === "request" && event.path === "/health").length;
    const report = await jsonRun("/redirect?token=request-secret", 1);
    assert.equal(report.evidence.status, 302);
    assert.ok(!JSON.stringify(report).includes("fixture-secret"));
    assert.ok(!JSON.stringify(report).includes("request-secret"));
    assert.equal(events.filter((event) => event.event === "request" && event.path === "/health").length, count);
  });

  await t.test("headers complete a streaming response observation without waiting for the body", async () => {
    const report = await jsonRun("/stream", 0);
    assert.equal(report.evidence.cleanup, "body-cancelled");
    for (let attempt = 0; attempt < 100 && !events.some((event) => event.path === "/stream" && event.event === "closed"); attempt++) await delay(5);
    assert.ok(events.some((event) => event.path === "/stream" && event.event === "closed"));
  });

  await t.test("late responses and observation timeouts are different failures", async () => {
    const late = await jsonRun("/delay?ms=150", 1, ["--max-duration-ms", "50", "--timeout-ms", "1000"]);
    assert.equal(late.evidence.outcome, "response");
    assert.equal(late.evidence.status, 200);
    assert.ok(late.evidence.durationMs > 50);
    const timeout = await jsonRun("/hang", 1, ["--timeout-ms", "50"]);
    assert.equal(timeout.evidence.outcome, "timeout");
    assert.equal(timeout.evidence.status, null);
    assert.equal(timeout.result, "FAIL");
  });

  await t.test("config files drive real methods, headers and request bodies without logging their values", async () => {
    const path = join(directory, "http.json");
    await writeFile(path, JSON.stringify({ target: `${base}/echo?token=url-secret`, method: "POST", headers: { authorization: "Bearer header-secret", "content-type": "text/plain" }, body: "body-secret", expectedStatus: 201 }));
    const output = await startCli(["run", "--config", path, "--format", "json"]).completion;
    assert.equal(output.code, 0, output.stderr);
    for (const secret of ["url-secret", "header-secret", "body-secret"]) assert.ok(!output.stdout.includes(secret));
    assert.equal(JSON.parse(output.stdout).evidence.method, "POST");
    assert.ok(events.some((event) => event.path === "/echo" && event.event === "body-received" && event.bodyBytes === 11));
    assert.ok(events.some((event) => event.path === "/echo" && event.headerNames?.includes("authorization")));
    const head = await jsonRun("/health", 0, ["--method", "HEAD"]);
    assert.equal(head.evidence.cleanup, "no-body");
  });

  await t.test("SIGINT and SIGTERM cancel an active request, preserve evidence, and exit predictably", async () => {
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const before = events.filter((event) => event.path === "/hang" && event.event === "request").length;
      const { child, completion } = startCli(["run", `${base}/hang`, "--timeout-ms", "5000", "--format", "json"]);
      for (let attempt = 0; attempt < 300 && events.filter((event) => event.path === "/hang" && event.event === "request").length === before; attempt++) await delay(5);
      assert.ok(events.filter((event) => event.path === "/hang" && event.event === "request").length > before);
      child.kill(signal);
      const output = await completion;
      assert.equal(output.code, code, output.stderr);
      const report = JSON.parse(output.stdout);
      assert.equal(report.result, "INCONCLUSIVE");
      assert.equal(report.evidence.outcome, "cancelled");
      assert.equal(report.assertion.passed, null);
    }
  });

  await t.test("a closed socket and a refused connection are target transport evidence", async () => {
    const reset = await jsonRun("/reset", 1);
    assert.equal(reset.evidence.outcome, "request-error");
    assert.equal(reset.result, "FAIL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const refused = await jsonRun("/health", 1);
    assert.equal(refused.evidence.failure.category, "connection");
    assert.equal(refused.evidence.failure.code, "ECONNREFUSED");
  });
});
