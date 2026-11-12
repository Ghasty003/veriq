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

const program = new Command()
  .name("veriq")
  .description("Run HTTP experiments and report evidence against explicit requirements.")
  .exitOverride()
  .configureOutput({ writeErr: () => {} })
  .addHelpText("after", "\nMeasurements stop at headers; redirects are not followed; bodies are not asserted.\nExit codes: 0 PASS/help, 1 FAIL, 2 ERROR, 3 INCONCLUSIVE; run interrupted: 130 SIGINT / 143 SIGTERM.");

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

try {
  if (process.argv.length === 2) {
    throw new Error("Expected a command: veriq run, probe, or latency. Use --help for usage.");
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
