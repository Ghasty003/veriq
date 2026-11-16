import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHttpConfiguration } from "../src/http-config.ts";
import { captureHttpJson } from "../src/http-json.ts";
import { getEventListeners } from "node:events";

const input = parseHttpConfiguration({ target: "http://example.test/json?token=secret" });
test("bounded JSON capture preserves value without putting bodies into evidence", async () => {
  const result = await captureHttpJson(input, { fetch: async () => Response.json({ private: "bodySecret" }) });
  assert.equal(result.evidence.outcome, "response");
  assert.deepEqual(result.value, { private: "bodySecret" });
  assert.ok(!JSON.stringify(result.evidence).includes("bodySecret"));
  assert.ok(!JSON.stringify(result.evidence).includes("token=secret"));
  assert.equal(result.evidence.measurementBoundary, "response-json");
});
test("invalid JSON, invalid UTF-8 and oversized bodies are distinct target observations", async () => {
  for (const [body, outcome] of [["invalid", "invalid-json"], [new Uint8Array([255]), "invalid-json"], ["x".repeat(65537), "body-limit"]] as const) {
    const result = await captureHttpJson(input, { fetch: async () => new Response(body) });
    assert.equal(result.evidence.outcome, outcome);
    assert.equal(result.value, undefined);
  }
});
test("pre-cancellation sends no request and releases listeners", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await captureHttpJson(input, { signal: controller.signal, fetch: async () => { throw new Error("must not run"); } });
  assert.equal(result.evidence.outcome, "cancelled");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
test("runtime errors retain transport codes while unrelated exceptions are execution errors", async () => {
  const transport = await captureHttpJson(input, { fetch: async () => { throw new TypeError("private", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) }); } });
  assert.equal(transport.evidence.outcome, "request-error");
  assert.equal(transport.evidence.error?.code, "ECONNREFUSED");
  const internal = await captureHttpJson(input, { fetch: async () => { throw new Error("private"); } });
  assert.equal(internal.evidence.outcome, "execution-error");
  assert.ok(!JSON.stringify(internal).includes("private"));
});

test("the JSON timeout remains active after headers arrive without becoming a cleanup error", async () => {
  const result = await captureHttpJson({ ...input, timeoutMs: 15, maxDurationMs: 15 }, { fetch: async (_url, init) =>
    new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
    } })) });
  assert.equal(result.evidence.status, 200);
  assert.equal(result.evidence.outcome, "timeout");
  assert.equal(result.value, undefined);
});

test("unexpected cleanup rejection, even without an Error object, is an execution failure", async () => {
  const result = await captureHttpJson(input, { fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() { return Promise.reject(undefined); },
  })) });
  assert.equal(result.evidence.status, 200);
  assert.equal(result.evidence.outcome, "execution-error");
  assert.equal(result.evidence.error?.code, "JSON_CLEANUP_FAILED");
});
