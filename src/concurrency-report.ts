import type { ConcurrencyReport } from "./http-concurrency.ts";

export function formatConcurrencyReport(report: ConcurrencyReport, format: "text" | "json"): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  const { configuration: config, completion, summary } = report;
  const lines = [
    `${report.result}  ${config.method} ${config.target}`, `Run: ${report.runId}`,
    `Requirement: all ${config.requests} requests return ${config.expectedStatus} within ${config.maxDurationMs} ms (headers only)`,
    `Concurrency: limit ${config.concurrency}, peak client-side in-flight ${summary.peakInFlight}`,
    `Completion: ${completion.reason}; ${completion.attemptedRequestCount}/${config.requests} attempted, ${completion.completedRequestCount} completed, ${completion.unstartedRequestCount} unstarted`,
    `Outcomes: ${summary.responseCount} responses, ${summary.timeoutCount} timeouts, ${summary.requestErrorCount} request errors, ${summary.cancelledCount} cancelled, ${summary.unobservedAttemptCount} without evidence`,
    `HTTP statuses: ${Object.entries(summary.statusCounts).map(([status, count]) => `${status}=${count}`).join(", ") || "unavailable"}`,
    `Run duration: ${report.durationMs.toFixed(2)} ms (including cleanup)`,
  ];
  const stats = summary.responseDurations;
  lines.push(stats ? `Received-response durations: mean ${stats.meanMs.toFixed(2)} ms, min ${stats.minMs.toFixed(2)} ms, max ${stats.maxMs.toFixed(2)} ms, p50 ${stats.p50Ms.toFixed(2)} ms, p95 ${stats.p95Ms.toFixed(2)} ms, p99 ${stats.p99Ms.toFixed(2)} ms (nearest-rank)` : "Received-response durations: unavailable");
  lines.push("Request  Worker  Result  Outcome  Status  Duration (ms)");
  for (const request of report.requests) lines.push(`${request.request}  ${request.worker}  ${request.result}  ${request.evidence?.outcome ?? "unavailable"}  ${request.evidence?.status ?? "-"}  ${request.evidence?.durationMs.toFixed(2) ?? "-"}`);
  lines.push(report.finding);
  if (report.error) lines.push(report.error.message);
  return lines.join("\n");
}
