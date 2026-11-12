import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHttpResponse } from "../src/http-assertion.ts";
import type { HttpEvidence } from "../src/http-probe.ts";

const evidence: HttpEvidence = {
  target: "http://example.test/checkout", method: "GET",
  startedAt: "2026-10-10T00:00:00.000Z", endedAt: "2026-10-10T00:00:00.500Z",
  durationMs: 500, timeoutMs: 2000, outcome: "response", status: 504,
  contentType: "application/json", location: null, error: null,
};

test("a timely expected error response passes a failure-handling requirement", () => {
  assert.equal(assertHttpResponse(evidence, 1000, 504).passed, true);
  assert.equal(assertHttpResponse({ ...evidence, durationMs: 1000 }, 1000, 504).passed, true);
  assert.equal(assertHttpResponse({ ...evidence, durationMs: 1001 }, 1000, 504).passed, false);
  assert.equal(assertHttpResponse({ ...evidence, status: 502 }, 1000, 504).passed, false);
});

test("timeouts fail and the original default still requires 200", () => {
  assert.equal(assertHttpResponse({ ...evidence, outcome: "timeout", status: null }, 1000, 504).passed, false);
  assert.equal(assertHttpResponse(evidence).passed, false);
  assert.equal(assertHttpResponse({ ...evidence, status: 200 }).passed, true);
});

test("reject requirements the observer cannot wait long enough to evaluate", () => {
  assert.throws(() => assertHttpResponse(evidence, 2001, 504));
  assert.throws(() => assertHttpResponse(evidence, 0, 504));
  assert.throws(() => assertHttpResponse(evidence, 1000, 600));
});
