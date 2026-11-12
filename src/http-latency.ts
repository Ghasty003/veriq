import { randomUUID } from "node:crypto";
import { ConfigurationError, parseHttpConfiguration, redactUrl } from "./http-config.ts";
import { runHttpExperiment, type HttpRunReport, type RunResult } from "./http-experiment.ts";
import { summarizeHttpLatency } from "./http-latency-summary.ts";

export type LatencySettings = {
  sampleCount?: number;
  maxDurationMs?: number;
  timeoutMs?: number;
  expectedStatus?: number;
};
export type LatencySample = Pick<HttpRunReport, "evidence" | "assertion" | "result" | "error"> & { sample: number };
export type LatencyReport = {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  configuration: {
    target: string; sampleCount: number; maxDurationMs: number; timeoutMs: number;
    expectedStatus: number; mode: "sequential"; measurementBoundary: "response-headers";
  };
  completion: {
    reason: "completed" | "cancelled" | "execution-error";
    requestedSampleCount: number;
    attemptedSampleCount: number;
    completedSampleCount: number;
    unstartedSampleCount: number;
  };
  samples: LatencySample[];
  summary: ReturnType<typeof summarizeHttpLatency> & { unobservedAttemptCount: number };
  assertion: { description: string; passed: boolean | null };
  result: RunResult;
  finding: string;
  error: HttpRunReport["error"];
};

export async function measureHttpLatency(
  target: string,
  settings: LatencySettings = {},
  options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<LatencyReport> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
      Object.keys(settings).some((key) => !["sampleCount", "maxDurationMs", "timeoutMs", "expectedStatus"].includes(key))) {
    throw new ConfigurationError("Unknown or invalid latency settings.");
  }
  const sampleCount = settings.sampleCount === undefined ? 5 : settings.sampleCount;
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 10_000) {
    throw new ConfigurationError("sampleCount must be an integer from 1 to 10000.");
  }
  const config = parseHttpConfiguration({
    target, method: "GET", timeoutMs: settings.timeoutMs,
    maxDurationMs: settings.maxDurationMs === undefined ? 200 : settings.maxDurationMs,
    expectedStatus: settings.expectedStatus,
  });
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const samples: LatencySample[] = [];
  let reason: LatencyReport["completion"]["reason"] = "completed";
  let error: HttpRunReport["error"] = null;
  for (let sample = 1; sample <= sampleCount; sample++) {
    if (options.signal?.aborted) { reason = "cancelled"; break; }
    const report = await runHttpExperiment(config, options);
    samples.push({ sample, evidence: report.evidence, assertion: report.assertion, result: report.result, error: report.error });
    if (report.result === "ERROR") { reason = "execution-error"; error = report.error; break; }
    if (report.result === "INCONCLUSIVE") { reason = "cancelled"; break; }
    // A target failure does not stop sampling; later attempts remain useful evidence.
  }
  const failed = samples.some((sample) => sample.assertion.passed === false);
  const result: RunResult = reason === "execution-error" ? "ERROR"
    : failed ? "FAIL" : reason === "cancelled" ? "INCONCLUSIVE" : "PASS";
  const evidence = samples.flatMap((sample) => sample.evidence ? [sample.evidence] : []);
  return {
    schemaVersion: 1, runId, startedAt,
    endedAt: new Date().toISOString(), durationMs: performance.now() - start,
    configuration: {
      target: redactUrl(config.target), sampleCount, maxDurationMs: config.maxDurationMs,
      timeoutMs: config.timeoutMs, expectedStatus: config.expectedStatus,
      mode: "sequential", measurementBoundary: "response-headers",
    },
    completion: {
      reason, requestedSampleCount: sampleCount, attemptedSampleCount: samples.length,
      completedSampleCount: samples.filter((sample) => sample.result === "PASS" || sample.result === "FAIL").length,
      unstartedSampleCount: sampleCount - samples.length,
    },
    samples,
    summary: {
      ...summarizeHttpLatency(evidence), attemptCount: samples.length,
      unobservedAttemptCount: samples.length - evidence.length,
    },
    assertion: {
      description: `All ${sampleCount} samples must receive HTTP response headers with status ${config.expectedStatus} within ${config.maxDurationMs} milliseconds`,
      passed: result === "ERROR" || result === "INCONCLUSIVE" ? null : result === "PASS",
    },
    result,
    finding: result === "ERROR" ? "Veriq could not complete the experiment correctly; preserved samples remain available."
      : result === "FAIL" ? "At least one sample violated the requirement; check completion for any unstarted attempts."
      : result === "INCONCLUSIVE" ? "Sampling was cancelled before the full requirement could be evaluated."
      : "Every requested sample satisfied the status and header-arrival duration requirement.",
    error,
  };
}
