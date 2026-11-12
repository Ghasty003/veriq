import { randomUUID } from "node:crypto";
import { parseHttpConfiguration, redactUrl } from "./http-config.ts";
import { observeHttp, type HttpObservation } from "./http-observation.ts";
import { assertHttpResponse } from "./http-assertion.ts";

export type RunResult = "PASS" | "FAIL" | "INCONCLUSIVE" | "ERROR";
export type HttpRunReport = {
  schemaVersion: 1;
  runId: string;
  configuration: {
    target: string; method: string; headerNames: string[]; hasBody: boolean;
    expectedStatus: number; maxDurationMs: number; timeoutMs: number;
  };
  evidence: HttpObservation | null;
  assertion: { description: string; expectedStatus: number; maxDurationMs: number; passed: boolean | null };
  result: RunResult;
  finding: string;
  error: { code: string; name: string; message: string } | null;
};

export async function runHttpExperiment(
  input: unknown,
  options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<HttpRunReport> {
  const config = parseHttpConfiguration(input);
  const report: HttpRunReport = {
    schemaVersion: 1, runId: randomUUID(),
    configuration: {
      target: redactUrl(config.target), method: config.method,
      headerNames: Object.keys(config.headers).sort(), hasBody: config.body !== undefined,
      expectedStatus: config.expectedStatus, maxDurationMs: config.maxDurationMs, timeoutMs: config.timeoutMs,
    },
    evidence: null,
    assertion: {
      description: `Receive HTTP response headers with status ${config.expectedStatus} within ${config.maxDurationMs} milliseconds`,
      expectedStatus: config.expectedStatus, maxDurationMs: config.maxDurationMs, passed: null,
    },
    result: "ERROR", finding: "The experiment could not complete correctly.", error: null,
  };
  try {
    report.evidence = await observeHttp(config, options);
    if (report.evidence.cleanup === "failed") {
      report.error = {
        code: "HTTP_CLEANUP_FAILED", name: "CleanupError",
        message: "Response headers arrived, but Veriq could not finish releasing the response body.",
      };
      return report;
    }
    if (report.evidence.outcome === "cancelled") {
      report.result = "INCONCLUSIVE";
      report.finding = "Execution was cancelled; the response requirement was not evaluated.";
    } else {
      report.assertion = assertHttpResponse(report.evidence, config.maxDurationMs, config.expectedStatus);
      report.result = report.assertion.passed ? "PASS" : "FAIL";
      report.finding = report.assertion.passed
        ? "This request satisfied the status and header-arrival duration requirement."
        : "This request did not satisfy the status and header-arrival duration requirement.";
    }
  } catch {
    // Arbitrary exception messages may contain headers, bodies, or secret URLs.
    report.error = { code: "HTTP_EXECUTION_FAILED", name: "ExecutionError", message: "HTTP execution failed inside Veriq." };
  }
  return report;
}
