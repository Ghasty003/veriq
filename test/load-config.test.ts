import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLoadConfiguration } from "../src/load-config.ts";
const request = { target: "http://example.test/work" };
test("load defaults define increasing closed-loop stages, bounded duration and recovery", () => {
  const config = parseLoadConfiguration({ request });
  assert.deepEqual(config.stages, [1, 5, 10, 20]); assert.equal(config.stageDurationMs, 2000);
  assert.equal(config.request.maxDurationMs, 200); assert.equal(config.recovery, true);
  const stages = [1, 2]; const input = { request, stages }; const parsed = parseLoadConfiguration(input); stages.push(4);
  assert.deepEqual(parsed.stages, [1, 2]);
});
test("invalid load policies, request settings and excessive evidence budgets are rejected", () => {
  for (const extra of [{ stages: [] }, { stages: [0] }, { stages: [2, 1] }, { stages: [1, 1] }, { stages: [257] }, { stages: ["2"] }, { stages: Array.from({ length: 17 }, (_, i) => i + 1) }, { stageDurationMs: 49 }, { stageDurationMs: 60001 }, { pauseMs: -1 }, { deadlineMs: 0 }, { maxRequestsPerStage: 2 }, { minSamplesPerStage: 2001 }, { maxRequestsPerStage: 10001 }, { stages: [1, 2, 3, 4, 5], maxRequestsPerStage: 10000 }, { minPassedRequestsPerSecond: -1 }, { minPassedRequestsPerSecond: Infinity }, { minPassedRequestsPerSecond: "10" }, { recovery: "yes" }, { unknown: true }]) assert.throws(() => parseLoadConfiguration({ request, ...extra }));
  assert.throws(() => parseLoadConfiguration({ request: { ...request, timeoutMs: 100 } }));
  assert.throws(() => parseLoadConfiguration({ request: { ...request, method: "CONNECT" } }));
  assert.throws(() => parseLoadConfiguration(null));
});
