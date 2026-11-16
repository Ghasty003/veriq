import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
test("root and probe help expose configurable requirements and exit successfully", () => {
  for (const args of [["--help"], ["probe", "--help"], ["run", "--help"], ["latency", "--help"], ["concurrency", "--help"], ["idempotency", "--help"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, args.length === 1 ? /probe/ : new RegExp(args[0]));
    if (args.length === 2) assert.match(result.stdout, args[0] === "idempotency" ? /--config/ : /--expected-status/);
  }
});

test("invalid invocations produce ERROR on stderr without experiment evidence", () => {
  const url = "http://127.0.0.1:1/unused";
  const cases = [
    [], ["unknown"], ["probe"], ["probe", "relative-url"], ["probe", "ftp://example.test"],
    ["probe", url, "extra"], ["probe", url, "--unknown"],
    ["probe", url, "--expected-status", "600"],
    ["probe", url, "--timeout-ms", "0"], ["probe", url, "--timeout-ms", "1.5"],
    ["probe", url, "--timeout-ms"],
    ["probe", url, "--timeout-ms", "100", "--max-duration-ms", "200"],
    ["run"], ["run", url, "--config", "missing.json"],
    ["run", url, "--format", "xml"], ["run", url, "--method", "CONNECT"],
    ["run", url, "--expected-status", "101"],
    ["run", "--config", "missing.json"],
    ["run", "--config", "missing.json", "--timeout-ms", "100"],
    ["latency", url, "--samples", "0"], ["latency", url, "--samples", "10001"],
    ["latency", url, "--samples", "1.5"], ["latency", url, "--samples"],
    ["latency", url, "--format", "xml"], ["latency", url, "--expected-status", "101"],
    ["latency", url, "--timeout-ms", "100", "--max-duration-ms", "200"],
    ["concurrency"], ["concurrency", url, "--requests", "0"],
    ["concurrency", url, "--concurrency", "257"], ["concurrency", url, "--requests", "10001"],
    ["concurrency", url, "--format", "xml"], ["concurrency", url, "--method", "CONNECT"],
    ["concurrency", url, "--config", "missing.json"],
    ["concurrency", "--config", "missing.json", "--requests", "2"],
    ["idempotency"], ["idempotency", "--config", "missing.json"],
    ["idempotency", "--config", "missing.json", "--format", "xml"],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    const report = JSON.parse(result.stderr);
    assert.equal(report.result, "ERROR");
    assert.equal(report.evidence, undefined);
  }
});
