import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError, parseHttpConfiguration, redactUrl } from "../src/http-config.ts";

const target = "https://example.test/health";
test("configuration normalizes headers, applies defaults, and snapshots input", () => {
  const input = { target, method: "POST", headers: { Authorization: "Bearer secret" }, body: "hello" };
  const config = parseHttpConfiguration(input);
  input.headers.Authorization = "changed";
  assert.equal(config.headers.authorization, "Bearer secret");
  assert.equal(config.timeoutMs, 2000);
  assert.equal(config.maxDurationMs, 2000);
  assert.equal(config.expectedStatus, 200);
  assert.equal(config.body, "hello");
});

test("invalid and ambiguous configurations fail before any request can run", () => {
  const invalid: unknown[] = [null, [], "target", {},
    { target: "file:///etc/passwd" }, { target: "relative" },
    { target: "https://user:password@example.test" }, { target: `${target}#fragment` },
    { target, tymeoutMs: 20 }, { target, method: "CONNECT" }, { target, method: "get" },
    { target, method: null }, { target, headers: null }, { target, timeoutMs: null },
    { target, maxDurationMs: null }, { target, expectedStatus: null },
    { target, timeoutMs: 0 }, { target, timeoutMs: "2000" }, { target, timeoutMs: 1.5 },
    { target, timeoutMs: 2 ** 31 }, { target, timeoutMs: 100, maxDurationMs: 200 },
    { target, expectedStatus: 101 }, { target, expectedStatus: 600 },
    { target, headers: { Host: "elsewhere" } }, { target, headers: { "Content-Length": "8" } },
    { target, headers: { Accept: "x", accept: "y" } },
    { target, headers: { "x-key": "x\r\nInjected: value" } },
    { target, headers: { "x-key": "a".repeat(16385) } }, { target, headers: { "x-key": 3 } },
    { target, headers: [] }, { target, body: "body" },
    { target, method: "HEAD", body: "body" },
    { target, method: "POST", body: "x".repeat(1048577) },
  ];
  for (const input of invalid) assert.throws(() => parseHttpConfiguration(input), ConfigurationError);
});

test("URL reporting redacts all query values and credentials in redirect locations", () => {
  const result = redactUrl("https://name:secret@example.test/path?token=secret&token=other&x=private#secret");
  for (const secret of ["name:", "secret", "other", "private"]) assert.ok(!result.includes(secret));
  assert.equal(new URL(result).searchParams.get("token"), "[redacted]");
  assert.equal(redactUrl("javascript:secret()"), "[non-HTTP location omitted]");
});
