import type { LoadReport } from "./http-load.ts";
export function formatLoadReport(report: LoadReport, format: "text" | "json") {
  if (format === "json") return JSON.stringify(report, null, 2);
  const number = (value: number | null | undefined) => value === null || value === undefined ? "-" : value.toFixed(2);
  return [
    `${report.result}  ${report.configuration.request.method} ${report.configuration.request.target}`,
    `Run: ${report.runId}; closed-loop load; measurement: response headers`,
    `Stages: ${report.completion.startedStages}/${report.completion.plannedStages}; completion: ${report.completion.reason}; attempts: ${report.attemptedRequests}/${report.maxRequestBudget} maximum`,
    "Phase       Workers  Attempts  Passed  Failed  Unknown  Passed/s  Status p95 ms  Result",
    ...report.stages.flatMap((s) => [
      `${s.phase.padEnd(11)} ${String(s.concurrency).padEnd(8)} ${String(s.summary.attemptCount).padEnd(9)} ${String(s.summary.passedCount).padEnd(7)} ${String(s.summary.failedCount).padEnd(7)} ${String(s.summary.unknownCount).padEnd(8)} ${number(s.summary.rates.passedRequestsPerSecond).padEnd(9)} ${number(s.summary.expectedStatusResponseDurations?.p95Ms).padEnd(16)} ${s.result}`,
      `  stage ${s.stage}: ${s.completion.reason}; ${number(s.durationMs)} ms including drain; headers/s=${number(s.summary.rates.responseHeadersPerSecond)}; statuses=${JSON.stringify(s.summary.statusCounts)}; timeouts=${s.summary.timeoutCount}; transport errors=${s.summary.requestErrorCount}; peak client actions=${s.summary.peakInFlight}`,
      ...s.assertions.filter((a) => a.passed !== true).map((a) => `  ${a.passed === null ? "UNKNOWN" : "FAIL"} ${a.name}: ${a.description}`),
    ]),
    `p95 column includes only status ${report.configuration.request.expectedStatus} responses; timeout/request-error durations are excluded.`,
    report.finding, ...(report.error ? [report.error.message] : []),
  ].join("\n");
}
