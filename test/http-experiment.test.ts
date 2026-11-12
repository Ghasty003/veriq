import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { runHttpExperiment } from "../src/http-experiment.ts";
import { formatHttpReport } from "../src/report.ts";

const input = { target: "http://example.test/health", timeoutMs: 100, maxDurationMs: 100 };
const waitingFetch: typeof fetch = async (_url, init) => {
  const signal = init!.signal!;
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
};

test("response evidence, assertion, and versioned report are distinct", async () => {
  let cancelledBody = false;
  const body = new ReadableStream({ cancel() { cancelledBody = true; } });
  const report = await runHttpExperiment(input, { fetch: async () => new Response(body, { status: 200 }) });
  assert.equal(report.schemaVersion, 1);
  assert.match(report.runId, /^[a-f0-9-]{36}$/);
  assert.equal(report.result, "PASS");
  assert.equal(report.assertion.passed, true);
  assert.equal(report.evidence?.outcome, "response");
  assert.equal(report.evidence?.cleanup, "body-cancelled");
  assert.equal(cancelledBody, true);
  assert.ok(report.evidence!.durationMs >= 0);
  assert.ok(Date.parse(report.evidence!.endedAt) >= Date.parse(report.evidence!.startedAt));
  assert.equal(JSON.parse(formatHttpReport(report, "json")).runId, report.runId);
  assert.match(formatHttpReport(report, "text"), /PASS.*GET/);
});

test("deadline expiry is FAIL with an incomplete response measurement", async () => {
  const report = await runHttpExperiment({ ...input, timeoutMs: 20, maxDurationMs: 20 }, { fetch: waitingFetch });
  assert.equal(report.result, "FAIL");
  assert.equal(report.evidence?.outcome, "timeout");
  assert.equal(report.evidence?.status, null);
  assert.match(report.evidence!.error!.message, /No response headers were received within 20 milliseconds/);
});

test("already cancelled execution sends no request and is INCONCLUSIVE", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const report = await runHttpExperiment(input, {
    signal: controller.signal, fetch: async () => { called = true; throw new Error("must not run"); },
  });
  assert.equal(called, false);
  assert.equal(report.result, "INCONCLUSIVE");
  assert.equal(report.assertion.passed, null);
  assert.equal(report.evidence?.outcome, "cancelled");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("in-flight caller cancellation wins over a later deadline and releases listeners", async () => {
  const controller = new AbortController();
  const reportPromise = runHttpExperiment(input, { signal: controller.signal, fetch: waitingFetch });
  controller.abort();
  const report = await reportPromise;
  assert.equal(report.result, "INCONCLUSIVE");
  assert.equal(report.evidence?.failure?.category, "cancelled");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("cancellation after headers cannot replace completed evidence", async () => {
  const controller = new AbortController();
  const body = new ReadableStream({ cancel() { controller.abort(); } });
  const report = await runHttpExperiment(input, {
    signal: controller.signal, fetch: async () => new Response(body),
  });
  assert.equal(report.result, "PASS");
  assert.equal(report.evidence?.outcome, "response");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("a deadline that aborts first cannot be relabelled by simultaneous caller cancellation", async () => {
  const controller = new AbortController();
  const report = await runHttpExperiment({ ...input, timeoutMs: 10, maxDurationMs: 10 }, {
    signal: controller.signal,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => {
        controller.abort();
        reject(init!.signal!.reason);
      }, { once: true });
    }),
  });
  assert.equal(report.result, "FAIL");
  assert.equal(report.evidence?.outcome, "timeout");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("transport failures distinguish DNS, connection, TLS, and unknown transport", async () => {
  for (const [code, category] of [["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"], ["ECONNREFUSED", "connection"], ["CERT_HAS_EXPIRED", "tls"], ["UND_ERR_HEADERS_OVERFLOW", "transport"]]) {
    const cause = new TypeError("secret URL", { cause: Object.assign(new Error("secret"), { code }) });
    const report = await runHttpExperiment(input, { fetch: async () => { throw cause; } });
    assert.equal(report.result, "FAIL");
    assert.equal(report.evidence?.failure?.category, category);
    assert.equal(report.evidence?.failure?.code, code);
    assert.ok(!JSON.stringify(report).includes("secret"));
  }
});

test("unexpected execution failures are ERROR rather than a failed target assertion", async () => {
  const report = await runHttpExperiment(input, { fetch: async () => { throw new Error("internal secret"); } });
  assert.equal(report.result, "ERROR");
  assert.equal(report.evidence, null);
  assert.equal(report.assertion.passed, null);
  assert.ok(!JSON.stringify(report).includes("internal secret"));
});

test("failed or stalled body cleanup is bounded and surfaces ERROR with header evidence", async () => {
  for (const cancel of [() => Promise.reject(new Error("secret")), () => new Promise<void>(() => {})]) {
    const body = new ReadableStream({ cancel });
    const report = await runHttpExperiment(input, { fetch: async () => new Response(body) });
    assert.equal(report.result, "ERROR");
    assert.equal(report.evidence?.status, 200);
    assert.equal(report.evidence?.cleanup, "failed");
    assert.equal(report.error?.code, "HTTP_CLEANUP_FAILED");
    assert.equal(report.assertion.passed, null);
  }
});

test("each execution owns its cancellation state and request settings", async () => {
  const cancelled = new AbortController();
  const first = runHttpExperiment(input, { signal: cancelled.signal, fetch: waitingFetch });
  const second = runHttpExperiment(input, { fetch: async () => { await delay(5); return new Response(null, { status: 200 }); } });
  cancelled.abort();
  assert.equal((await first).result, "INCONCLUSIVE");
  assert.equal((await second).result, "PASS");
});

test("reports omit request secrets and redact redirect query values", async () => {
  const report = await runHttpExperiment({ ...input, target: `${input.target}?token=querySecret`, method: "POST", body: "bodySecret", headers: { authorization: "Bearer headerSecret" } }, {
    fetch: async (url, init) => {
      assert.match(String(url), /querySecret/);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer headerSecret");
      assert.equal(init?.body, "bodySecret");
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "/next?token=redirectSecret" } });
    },
  });
  const json = JSON.stringify(report);
  for (const secret of ["querySecret", "headerSecret", "bodySecret", "redirectSecret"]) assert.ok(!json.includes(secret));
  assert.equal(report.result, "FAIL");
});
