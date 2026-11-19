#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { probeHttp } from "./http-probe.ts";
import { assertHttpResponse } from "./http-assertion.ts";
import { measureHttpLatency } from "./http-latency.ts";
import { runHttpExperiment } from "./http-experiment.ts";
import { formatHttpReport } from "./report.ts";
import { readConfigurationFile } from "./config-file.ts";
import { ConfigurationError } from "./http-config.ts";
import { formatLatencyReport } from "./latency-report.ts";
import { withCliCancellation } from "./cli-cancellation.ts";
import { runHttpConcurrency } from "./http-concurrency.ts";
import { formatConcurrencyReport } from "./concurrency-report.ts";
import { testHttpIdempotency } from "./http-idempotency.ts";
import { formatIdempotencyReport } from "./idempotency-report.ts";
import { testHttpRetry } from "./http-retry.ts";
import { formatRetryReport } from "./retry-report.ts";
import { testHttpRateLimit } from "./http-rate-limit.ts";
import { formatRateLimitReport } from "./rate-limit-report.ts";
import { testHttpCache } from "./http-cache.ts";
import { formatCacheReport } from "./cache-report.ts";
import { testHttpLoad } from "./http-load.ts";
import { formatLoadReport } from "./load-report.ts";

function normalizeTarget(value: string) {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error("Target must be an absolute HTTP or HTTPS URL.");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Target must use HTTP or HTTPS.");
  }
  return target.href;
}

function positiveMilliseconds(value: string) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new InvalidArgumentError("Use an integer from 1 to 2147483647 milliseconds.");
  }
  return number;
}

function httpStatus(value: string) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < 100 || number > 599) {
    throw new InvalidArgumentError("Use an HTTP status from 100 to 599.");
  }
  return number;
}

function sampleCount(value: string) {
  const count = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(count) || count < 1 || count > 10000) {
    throw new InvalidArgumentError("Use an integer from 1 to 10000 samples.");
  }
  return count;
}

function boundedCount(label: string, maximum: number) {
  return (value: string) => {
    const count = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(count) || count < 1 || count > maximum) {
      throw new InvalidArgumentError(`${label} must be an integer from 1 to ${maximum}.`);
    }
    return count;
  };
}

function delayMilliseconds(value: string) {
  const milliseconds = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 60000) throw new InvalidArgumentError("Delay must be an integer from 0 to 60000 milliseconds.");
  return milliseconds;
}

const program = new Command()
  .name("veriq")
  .description("Run HTTP experiments and report evidence against explicit requirements.")
  .exitOverride()
  .configureOutput({ writeErr: () => {} })
  .addHelpText("after", "\nHTTP/latency/concurrency measurements stop at headers. Idempotency reads bounded JSON and declared effect counts. Redirects are not followed.\nExit codes: 0 PASS/help, 1 FAIL, 2 ERROR, 3 INCONCLUSIVE; interrupted: 130 SIGINT / 143 SIGTERM.");

program.command("run [url]")
  .description("Run one configured HTTP experiment (URL or --config, exclusively).")
  .option("--config <path>", "HTTP experiment JSON configuration file")
  .option("--method <method>", "HTTP method; default GET")
  .option("--expected-status <status>", "required final HTTP status; default 200", httpStatus)
  .option("--max-duration-ms <ms>", "header-arrival duration requirement", positiveMilliseconds)
  .option("--timeout-ms <ms>", "observer waiting limit; default 2000", positiveMilliseconds)
  .option("--format <format>", "text or json", "text")
  .action(async (url: string | undefined, options: {
    config?: string; method?: string; expectedStatus?: number; maxDurationMs?: number;
    timeoutMs?: number; format: string;
  }) => {
    if (!["text", "json"].includes(options.format)) throw new ConfigurationError("--format must be text or json.");
    if ((url === undefined) === (options.config === undefined)) {
      throw new ConfigurationError("Provide exactly one target URL or --config file.");
    }
    if (options.config && [options.method, options.expectedStatus, options.maxDurationMs, options.timeoutMs].some((value) => value !== undefined)) {
      throw new ConfigurationError("Request settings belong in the config file when using --config; CLI overrides are not supported.");
    }
    await withCliCancellation(async (signal, exitCode) => {
      const input = options.config ? await readConfigurationFile(options.config) : {
        target: url, method: options.method, expectedStatus: options.expectedStatus,
        maxDurationMs: options.maxDurationMs, timeoutMs: options.timeoutMs,
      };
      const report = await runHttpExperiment(input, { signal });
      console.log(formatHttpReport(report, options.format as "text" | "json"));
      process.exitCode = exitCode(report.result);
    });
  });

program.command("probe <url>")
  .description("Send one GET request and evaluate its status and response duration.")
  .option("--expected-status <status>", "required HTTP status", httpStatus, 200)
  .option("--max-duration-ms <ms>", "response-duration requirement; defaults to waiting limit", positiveMilliseconds)
  .option("--timeout-ms <ms>", "observer waiting limit", positiveMilliseconds, 2000)
  .action(async (url: string, options: { expectedStatus: number; maxDurationMs?: number; timeoutMs: number }) => {
    const target = normalizeTarget(url);
    const maxDurationMs = options.maxDurationMs ?? options.timeoutMs;
    if (maxDurationMs > options.timeoutMs) {
      throw new Error("--timeout-ms must be at least --max-duration-ms so Veriq can observe the requirement.");
    }
    const evidence = await probeHttp(target, options.timeoutMs);
    const assertion = assertHttpResponse(evidence, maxDurationMs, options.expectedStatus);
    const result = assertion.passed ? "PASS" : "FAIL";
    console.log(JSON.stringify({ evidence, assertion, result }, null, 2));
    process.exitCode = assertion.passed ? 0 : 1;
  });

program.command("latency <url>")
  .description("Measure sequential GET samples and require every sample to meet the status/duration rule.")
  .option("--samples <count>", "number of attempts, from 1 to 10000; default 5", sampleCount)
  .option("--expected-status <status>", "required final HTTP status; default 200", httpStatus)
  .option("--max-duration-ms <ms>", "per-sample header-arrival requirement; default 200", positiveMilliseconds)
  .option("--timeout-ms <ms>", "per-attempt observer waiting limit; default 2000", positiveMilliseconds)
  .option("--format <format>", "json or text", "json")
  .action(async (url: string, options: {
    samples?: number; expectedStatus?: number; maxDurationMs?: number; timeoutMs?: number; format: string;
  }) => {
    if (!["text", "json"].includes(options.format)) throw new ConfigurationError("--format must be text or json.");
    await withCliCancellation(async (signal, exitCode) => {
      const report = await measureHttpLatency(url, {
        sampleCount: options.samples, expectedStatus: options.expectedStatus,
        maxDurationMs: options.maxDurationMs, timeoutMs: options.timeoutMs,
      }, { signal });
      console.log(formatLatencyReport(report, options.format as "text" | "json"));
      process.exitCode = exitCode(report.result, report.completion.reason === "cancelled");
    });
  });

program.command("concurrency [url]")
  .description("Execute bounded concurrent HTTP requests (URL or --config, exclusively).")
  .option("--config <path>", "JSON request settings plus requests and concurrency")
  .option("--requests <count>", "total requests, 1 to 10000; default 20", boundedCount("requests", 10000))
  .option("--concurrency <count>", "maximum in-flight attempts, 1 to 256; default 5", boundedCount("concurrency", 256))
  .option("--method <method>", "HTTP method; default GET")
  .option("--expected-status <status>", "required final HTTP status; default 200", httpStatus)
  .option("--max-duration-ms <ms>", "per-request header-arrival requirement; default 500", positiveMilliseconds)
  .option("--timeout-ms <ms>", "per-request observer waiting limit; default 2000", positiveMilliseconds)
  .option("--format <format>", "text or json", "text")
  .action(async (url: string | undefined, options: {
    config?: string; requests?: number; concurrency?: number; method?: string;
    expectedStatus?: number; maxDurationMs?: number; timeoutMs?: number; format: string;
  }) => {
    if (!["text", "json"].includes(options.format)) throw new ConfigurationError("--format must be text or json.");
    if ((url === undefined) === (options.config === undefined)) throw new ConfigurationError("Provide exactly one target URL or --config file.");
    const settings = { target: url, requests: options.requests, concurrency: options.concurrency, method: options.method, expectedStatus: options.expectedStatus, maxDurationMs: options.maxDurationMs, timeoutMs: options.timeoutMs };
    if (options.config && Object.entries(settings).some(([key, value]) => key !== "target" && value !== undefined)) {
      throw new ConfigurationError("Request and scheduling settings belong in the config file when using --config.");
    }
    await withCliCancellation(async (signal, exitCode) => {
      const report = await runHttpConcurrency(options.config ? await readConfigurationFile(options.config) : settings, { signal });
      console.log(formatConcurrencyReport(report, options.format as "text" | "json"));
      process.exitCode = exitCode(report.result, report.completion.reason === "cancelled");
    });
  });

program.command("idempotency")
  .description("Verify repeated operations, replay, conflict rejection and observed effects using a declared JSON state API.")
  .requiredOption("--config <path>", "idempotency experiment JSON configuration")
  .option("--format <format>", "text or json", "text")
  .action(async (options: { config: string; format: string }) => {
    if (!["text", "json"].includes(options.format)) throw new ConfigurationError("--format must be text or json.");
    await withCliCancellation(async (signal, exitCode) => {
      const report = await testHttpIdempotency(await readConfigurationFile(options.config), { signal });
      console.log(formatIdempotencyReport(report, options.format as "text" | "json"));
      process.exitCode = exitCode(report.result, report.completion.reason === "cancelled");
    });
  });

program.command("load")
  .description("Run timed, increasing concurrency stages and optional low-concurrency recovery against declared HTTP requirements.")
  .requiredOption("--config <path>", "load request, concurrency stages and bounded timing configuration")
  .option("--format <format>", "text or json", "text")
  .action(async (options: { config: string; format: string }) => {
    if (!["text", "json"].includes(options.format)) throw new ConfigurationError("--format must be text or json.");
    await withCliCancellation(async (signal, exitCode) => {
      const report = await testHttpLoad(await readConfigurationFile(options.config), { signal });
      console.log(formatLoadReport(report, options.format as "text" | "json"));
      process.exitCode = exitCode(report.result, report.completion.cancelled);
    });
  });

program.command("cache")
  .description("Verify declared JSON cache reuse, expiry, invalidation, isolation and coalesced refresh.")
  .requiredOption("--config <path>", "cache read, source, mutation and timing configuration")
  .option("--format <format>", "text or json", "text")
  .action(async (options: { config: string; format: string }) => {
    if (!["text", "json"].includes(options.format)) throw new ConfigurationError("--format must be text or json.");
    await withCliCancellation(async (signal, exitCode) => {
      const report = await testHttpCache(await readConfigurationFile(options.config), { signal });
      console.log(formatCacheReport(report, options.format as "text" | "json"));
      process.exitCode = exitCode(report.result, report.completion.cancelled);
    });
  });

program.command("rate-limit")
  .description("Check per-caller anchored fixed-window allowance, isolation, reset and concurrent admission.")
  .requiredOption("--config <path>", "rate-limit experiment JSON configuration")
  .option("--format <format>", "text or json", "text")
  .action(async (options: { config: string; format: string }) => {
    if (!["text", "json"].includes(options.format)) throw new ConfigurationError("--format must be text or json.");
    await withCliCancellation(async (signal, exitCode) => {
      const report = await testHttpRateLimit(await readConfigurationFile(options.config), { signal });
      console.log(formatRateLimitReport(report, options.format as "text" | "json"));
      process.exitCode = exitCode(report.result, report.completion.cancelled);
    });
  });

program.command("retry [url]")
  .description("Run a bounded recovery experiment with classified retries, backoff and an overall deadline.")
  .option("--config <path>", "JSON request, retry policy and optional declared write-state contract")
  .option("--max-attempts <count>", "total attempts including the first; default 3", boundedCount("maxAttempts", 100))
  .option("--deadline-ms <ms>", "overall action budget including backoff and state checks; default 10000", positiveMilliseconds)
  .option("--base-delay-ms <ms>", "initial exponential backoff cap; default 100", delayMilliseconds)
  .option("--max-delay-ms <ms>", "maximum exponential backoff cap; default 2000", delayMilliseconds)
  .option("--jitter <mode>", "full or none; default full")
  .option("--timeout-ms <ms>", "per-attempt observation limit; default 2000", positiveMilliseconds)
  .option("--max-duration-ms <ms>", "successful attempt header-duration requirement; defaults to timeout", positiveMilliseconds)
  .option("--expected-status <status>", "required successful status; default 200", httpStatus)
  .option("--format <format>", "text or json", "text")
  .action(async (url: string | undefined, options: { config?: string; maxAttempts?: number; deadlineMs?: number; baseDelayMs?: number; maxDelayMs?: number; jitter?: string; timeoutMs?: number; maxDurationMs?: number; expectedStatus?: number; format: string }) => {
    if (!["text", "json"].includes(options.format)) throw new ConfigurationError("--format must be text or json.");
    if ((url === undefined) === (options.config === undefined)) throw new ConfigurationError("Provide exactly one URL or --config file.");
    if (options.config && [options.maxAttempts, options.deadlineMs, options.baseDelayMs, options.maxDelayMs, options.jitter, options.timeoutMs, options.maxDurationMs, options.expectedStatus].some((value) => value !== undefined)) throw new ConfigurationError("Request and policy settings belong in the config file when using --config.");
    await withCliCancellation(async (signal, exitCode) => {
      const report = await testHttpRetry(options.config ? await readConfigurationFile(options.config) : {
        request: { target: url, timeoutMs: options.timeoutMs, maxDurationMs: options.maxDurationMs, expectedStatus: options.expectedStatus },
        policy: { maxAttempts: options.maxAttempts, deadlineMs: options.deadlineMs, baseDelayMs: options.baseDelayMs, maxDelayMs: options.maxDelayMs, jitter: options.jitter },
      }, { signal });
      console.log(formatRetryReport(report, options.format as "text" | "json"));
      process.exitCode = exitCode(report.result, report.completion.cancelled);
    });
  });

try {
  if (process.argv.length === 2) {
    throw new Error("Expected a command: veriq run, probe, latency, concurrency, idempotency, retry, rate-limit, cache, or load. Use --help for usage.");
  }
  await program.parseAsync(process.argv);
} catch (cause) {
  if (!(cause instanceof CommanderError && cause.exitCode === 0)) {
    const error = {
      name: cause instanceof Error ? cause.name : "UnknownError",
      message: cause instanceof Error ? cause.message : String(cause),
    };
    console.error(JSON.stringify({ result: "ERROR", error }, null, 2));
    process.exitCode = 2;
  }
}
