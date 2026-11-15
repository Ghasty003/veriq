import { randomUUID } from "node:crypto";
import { ConfigurationError, parseHttpConfiguration, redactUrl, type HttpConfiguration } from "./http-config.ts";
import { runHttpExperiment, type HttpRunReport, type RunResult } from "./http-experiment.ts";
import { summarizeHttpLatency } from "./http-latency-summary.ts";

export type ConcurrencyConfiguration = HttpConfiguration & { requests: number; concurrency: number };
export type ConcurrentRequest = Pick<HttpRunReport, "evidence" | "assertion" | "result" | "error"> & {
  request: number;
  worker: number;
};
export type ConcurrencyReport = {
  schemaVersion: 1; runId: string; startedAt: string; endedAt: string; durationMs: number;
  configuration: {
    target: string; method: string; headerNames: string[]; hasBody: boolean;
    requests: number; concurrency: number; timeoutMs: number; maxDurationMs: number;
    expectedStatus: number; mode: "bounded-concurrency"; measurementBoundary: "response-headers";
  };
  completion: {
    reason: "completed" | "cancelled" | "execution-error";
    requestedRequestCount: number; attemptedRequestCount: number;
    completedRequestCount: number; unstartedRequestCount: number;
  };
  requests: ConcurrentRequest[];
  summary: ReturnType<typeof summarizeHttpLatency> & {
    unobservedAttemptCount: number; statusCounts: Record<string, number>; peakInFlight: number;
  };
  assertion: { description: string; passed: boolean | null };
  result: RunResult; finding: string; error: HttpRunReport["error"];
};

export function parseConcurrencyConfiguration(input: unknown): ConcurrencyConfiguration {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigurationError("Concurrency configuration must be a JSON object.");
  const { requests = 20, concurrency = 5, ...http } = input as Record<string, unknown>;
  if (typeof requests !== "number" || !Number.isInteger(requests) || requests < 1 || requests > 10000) {
    throw new ConfigurationError("requests must be an integer from 1 to 10000.");
  }
  if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256) {
    throw new ConfigurationError("concurrency must be an integer from 1 to 256.");
  }
  return {
    ...parseHttpConfiguration({ ...http, maxDurationMs: http.maxDurationMs === undefined ? 500 : http.maxDurationMs }),
    requests, concurrency,
  };
}

export async function runHttpConcurrency(
  input: unknown,
  options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<ConcurrencyReport> {
  const config = parseConcurrencyConfiguration(input);
  const { requests: count, concurrency, ...http } = config;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const records: (ConcurrentRequest | undefined)[] = new Array(count);
  // One private controller per worker avoids adding hundreds of listeners to
  // the caller's signal. The caller has exactly one cancellation subscription.
  const controllers = Array.from({ length: Math.min(count, concurrency) }, () => new AbortController());
  let next = 0, active = 0, peakInFlight = 0;
  let stopped = false;
  let error: HttpRunReport["error"] = null;
  const stop = () => {
    stopped = true;
    for (const controller of controllers) controller.abort();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const fetchRequest = options.fetch;
  async function worker(workerIndex: number) {
    const signal = controllers[workerIndex].signal;
    while (!stopped && next < count) {
      // No await between reading/incrementing next: each JS worker claims a
      // unique request number before yielding, without a shared-memory race.
      const index = next++;
      active++;
      peakInFlight = Math.max(peakInFlight, active);
      let report: Pick<HttpRunReport, "evidence" | "assertion" | "result" | "error">;
      try {
        report = await runHttpExperiment(http, { signal, fetch: fetchRequest });
      } catch {
        report = {
          evidence: null, result: "ERROR",
          assertion: { description: "HTTP execution could not complete", expectedStatus: http.expectedStatus, maxDurationMs: http.maxDurationMs, passed: null },
          error: { code: "WORKER_EXECUTION_FAILED", name: "ExecutionError", message: "A concurrency worker could not execute the request correctly." },
        };
      } finally {
        active--;
      }
      records[index] = { request: index + 1, worker: workerIndex + 1, evidence: report.evidence, assertion: report.assertion, result: report.result, error: report.error };
      if (report.result === "ERROR") {
        error ??= report.error ?? { code: "WORKER_EXECUTION_FAILED", name: "ExecutionError", message: "A concurrency worker reported an internal error." };
        stop();
      } else if (report.result === "INCONCLUSIVE") stop();
      // Target FAIL is evidence, not a reason to discard the rest of the run.
    }
  }
  try {
    await Promise.all(controllers.map((_, index) => worker(index)));
  } finally {
    options.signal?.removeEventListener("abort", stop);
    for (const controller of controllers) controller.abort();
  }
  const attempts = records.filter((record): record is ConcurrentRequest => record !== undefined);
  const completed = attempts.filter((request) => request.result === "PASS" || request.result === "FAIL").length;
  const reason = error ? "execution-error" : completed === count ? "completed" : "cancelled";
  const failed = attempts.some((request) => request.assertion.passed === false);
  const result: RunResult = error ? "ERROR" : failed ? "FAIL" : reason === "cancelled" ? "INCONCLUSIVE" : "PASS";
  const evidence = attempts.flatMap((request) => request.evidence ? [request.evidence] : []);
  const statusCounts: Record<string, number> = {};
  for (const item of evidence) {
    if (item.status !== null) statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
  }
  return {
    schemaVersion: 1, runId, startedAt, endedAt: new Date().toISOString(), durationMs: performance.now() - start,
    configuration: {
      target: redactUrl(http.target), method: http.method, headerNames: Object.keys(http.headers).sort(), hasBody: http.body !== undefined,
      requests: count, concurrency, timeoutMs: http.timeoutMs, maxDurationMs: http.maxDurationMs,
      expectedStatus: http.expectedStatus, mode: "bounded-concurrency", measurementBoundary: "response-headers",
    },
    completion: { reason, requestedRequestCount: count, attemptedRequestCount: attempts.length, completedRequestCount: completed, unstartedRequestCount: count - attempts.length },
    requests: attempts,
    summary: { ...summarizeHttpLatency(evidence), attemptCount: attempts.length, unobservedAttemptCount: attempts.length - evidence.length, statusCounts, peakInFlight },
    assertion: { description: `All ${count} requests must receive HTTP response headers with status ${http.expectedStatus} within ${http.maxDurationMs} milliseconds`, passed: result === "ERROR" || result === "INCONCLUSIVE" ? null : result === "PASS" },
    result,
    finding: error ? "Veriq could not complete the experiment correctly; preserved request evidence remains available."
      : failed ? "At least one request violated the requirement; inspect completion for unstarted work."
      : reason === "cancelled" ? "Execution was cancelled before all request requirements could be evaluated."
      : "Every requested attempt met its HTTP requirement; this does not establish application-state invariants.",
    error,
  };
}
