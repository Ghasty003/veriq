import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCacheConfiguration } from "../src/cache-config.ts";
import { cacheConfiguration } from "./support/cache-target.ts";
const settings = cacheConfiguration("http://example.test");
test("cache contracts normalize endpoint roles and generated JSON writes", () => {
  const config = parseCacheConfiguration(settings);
  assert.equal(config.read.method, "GET"); assert.equal(config.write!.method, "PUT");
  assert.equal(config.originWrite.headers["content-type"], "application/json");
  assert.equal(config.valuePointer, "/value"); assert.equal(config.sourceReadsPointer, "/reads");
  assert.equal(config.invalidation, "required");
  assert.equal(parseCacheConfiguration({ ...settings, write: undefined, invalidation: "ttl-only" }).write, undefined);
});
test("cache configuration rejects unsafe templates, invalid roles, limits and unknown settings", () => {
  for (const extra of [{ ttlMs: 99 }, { ttlMs: 60001 }, { windowGuardMs: 0 }, { windowGuardMs: 400 }, { expiryGraceMs: 701 }, { hitRequests: 0 }, { burstRequests: 1 }, { concurrency: 33 }, { deadlineMs: 0 }, { invalidation: "sometimes" }, { extra: true }, { valuePointer: "/bad~2" }, { invalidation: "ttl-only" }]) assert.throws(() => parseCacheConfiguration({ ...settings, ...extra }));
  for (const endpoint of [
    { target: "not-a-url/{caller}/{key}" }, { target: "http://{caller}.example.test/{key}" },
    { target: "http://example.test/{key}" }, { target: "http://example.test/{caller}/{key}/{key}" },
    { ...settings.read, method: "POST" }, { ...settings.read, expectedStatus: 204 },
    { ...settings.read, body: "private" }, { ...settings.read, extra: true },
  ]) assert.throws(() => parseCacheConfiguration({ ...settings, read: endpoint }));
  assert.throws(() => parseCacheConfiguration({ ...settings, write: { ...settings.write, headers: { "Content-Type": "text/plain" } } }));
  assert.throws(() => parseCacheConfiguration({ ...settings, originWrite: { ...settings.originWrite, method: "GET" } }));
});
