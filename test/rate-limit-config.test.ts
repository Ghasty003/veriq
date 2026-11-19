import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRateLimitConfiguration } from "../src/rate-limit-config.ts";
const request = { target: "http://example.test/limited" };
test("rate-limit defaults define a bounded fresh-caller anchored-window contract", () => {
  const config = parseRateLimitConfiguration({ request });
  assert.equal(config.allowance, 3); assert.equal(config.windowMs, 1000);
  assert.equal(config.identityHeader, "x-ratelimit-client"); assert.equal(config.requireRetryAfter, false);
  assert.equal(config.algorithm, "anchored-fixed-window");
});
test("invalid rate-limit contracts are rejected before execution", () => {
  for (const extra of [{ allowance: 0 }, { allowance: 101 }, { windowMs: 99 }, { windowGuardMs: 600 }, { concurrency: 1 }, { deadlineMs: 0 }, { requireRetryAfter: "yes" }, { algorithm: "sliding" }, { rejectedStatus: 200 }, { secret: true }, { identityHeader: "host" }, { identityHeader: "bad\r\nheader" }]) {
    assert.throws(() => parseRateLimitConfiguration({ request, ...extra }));
  }
  assert.throws(() => parseRateLimitConfiguration({ request: { ...request, headers: { "X-RateLimit-Client": "existing" } } }));
  assert.throws(() => parseRateLimitConfiguration({ request: { ...request, expectedStatus: 429 } }));
});
