import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRetryConfiguration, backoffDelay, retryAfterDelay, retryDecision } from "../src/retry-policy.ts";
import type { HttpObservation } from "../src/http-observation.ts";
import { observeHttp } from "../src/http-observation.ts";
import { parseHttpConfiguration } from "../src/http-config.ts";

const request = { target: "http://example.test/work" };
const policy = parseRetryConfiguration({ request }).policy;
test("retry configuration validates policy and explicitly gates repeated mutations", () => {
  assert.equal(policy.maxAttempts, 3);
  assert.equal(policy.jitter, "full");
  for (const input of [null, [], { request, unknown: true }, { request, policy: { maxAttempts: 0 } },
    { request, policy: { maxAttempts: 101 } }, { request, policy: { deadlineMs: 0 } },
    { request, policy: { baseDelayMs: -1 } }, { request, policy: { baseDelayMs: 20, maxDelayMs: 10 } },
    { request, policy: { jitter: "equal" } }, { request, policy: { retryableStatuses: [200] } },
    { request, policy: { retryableStatuses: [503, 503] } }, { request, policy: { retryOnTimeout: null } },
    { request, policy: { typo: true } }, { request, retrySafety: "idempotency-key" },
    { request: { ...request, method: "POST" } },
    { request: { ...request, method: "POST" }, retrySafety: "idempotency-key" },
    { request: { ...request, headers: { "Idempotency-Key": "fixed" } } },
  ]) assert.throws(() => parseRetryConfiguration(input));
});
test("exponential caps and full jitter are bounded and deterministic with an injected random source", () => {
  assert.deepEqual([0, 1, 2, 20].map((index) => backoffDelay({ ...policy, jitter: "none", baseDelayMs: 100, maxDelayMs: 250 }, index).delayMs), [100, 200, 250, 250]);
  assert.equal(backoffDelay(policy, 0, () => 0).delayMs, 0);
  assert.equal(backoffDelay(policy, 0, () => 0.5).delayMs, 50);
  assert.equal(backoffDelay(policy, 0, () => 0.9999).delayMs, 100);
  assert.throws(() => backoffDelay(policy, 0, () => 1));
});
test("Retry-After parses integer seconds and HTTP dates without interpreting malformed values", () => {
  const now = Date.parse("Thu, 01 Jan 2026 00:00:00 GMT");
  assert.equal(retryAfterDelay("2", now), 2000);
  assert.equal(retryAfterDelay("Thu, 01 Jan 2026 00:00:03 GMT", now), 3000);
  assert.equal(retryAfterDelay("Wed, 31 Dec 2025 00:00:00 GMT", now), 0);
  assert.equal(retryAfterDelay("Thursday, 01-Jan-26 00:00:03 GMT", now), 3000);
  assert.equal(retryAfterDelay("Thu Jan  1 00:00:03 2026", now), 3000);
  assert.equal(retryAfterDelay("Fri, 30 Feb 2026 00:00:00 GMT", now), null);
  for (const value of [null, "-1", "0.5", "tomorrow", "999x"]) assert.equal(retryAfterDelay(value, now), null);
  assert.equal(retryAfterDelay("9".repeat(120), now), Number.MAX_SAFE_INTEGER);
});
test("classification distinguishes configured transient statuses, known transport errors and permanent failures", () => {
  const observation: HttpObservation = { target: request.target, method: "GET", startedAt: "", endedAt: "", durationMs: 1, timeoutMs: 2000, outcome: "response", status: 503, contentType: null, location: null, error: null, failure: null, cleanup: "no-body", retryAfter: null, measurementBoundary: "response-headers" };
  assert.equal(retryDecision(observation, policy).retryable, true);
  assert.equal(retryDecision({ ...observation, status: 400 }, policy).retryable, false);
  assert.equal(retryDecision({ ...observation, outcome: "timeout", status: null }, policy).retryable, true);
  assert.equal(retryDecision({ ...observation, outcome: "timeout", status: null }, { ...policy, retryOnTimeout: false }).retryable, false);
  for (const [code, category, expected] of [["EAI_AGAIN", "dns", true], ["ECONNRESET", "connection", true], ["ENOTFOUND", "dns", false], ["CERT_HAS_EXPIRED", "tls", false]] as const) {
    assert.equal(retryDecision({ ...observation, outcome: "request-error", status: null, failure: { category, code } }, policy).retryable, expected);
  }
});

test("Retry-After metadata is not truncated into a different numeric value", async () => {
  const raw = "0".repeat(128) + "1";
  const evidence = await observeHttp(parseHttpConfiguration({ target: request.target }), { fetch: async () => new Response(null, { status: 503, headers: { "retry-after": raw } }) });
  assert.equal(evidence.retryAfter, raw);
  assert.equal(retryAfterDelay(evidence.retryAfter), 1000);
});
