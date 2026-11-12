import type { LatencyReport } from "./http-latency.ts";

export function formatLatencyReport(report: LatencyReport, format: "text" | "json"): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  const { summary, configuration: config, completion } = report;
  const lines = [
    `${report.result}  GET ${config.target}`,
    `Run: ${report.runId}`,
    `Requirement: all ${config.sampleCount} samples return ${config.expectedStatus} within ${config.maxDurationMs} ms (headers only)`,
    `Sampling: ${completion.reason}; ${completion.attemptedSampleCount}/${config.sampleCount} attempted, ${completion.completedSampleCount} completed, ${completion.unstartedSampleCount} unstarted`,
    `Outcomes: ${summary.responseCount} responses, ${summary.timeoutCount} timeouts, ${summary.requestErrorCount} request errors, ${summary.cancelledCount} cancelled, ${summary.unobservedAttemptCount} without evidence`,
  ];
  const stats = summary.responseDurations;
  lines.push(stats
    ? `Received-response durations (${summary.responseCount}): mean ${stats.meanMs.toFixed(2)} ms, min ${stats.minMs.toFixed(2)} ms, max ${stats.maxMs.toFixed(2)} ms, p50 ${stats.p50Ms.toFixed(2)} ms, p95 ${stats.p95Ms.toFixed(2)} ms, p99 ${stats.p99Ms.toFixed(2)} ms (nearest-rank)`
    : "Received-response durations: unavailable (no response headers received)");
  lines.push("Sample  Result  Outcome        Status  Duration (ms)");
  for (const sample of report.samples) {
    lines.push(`${sample.sample}  ${sample.result}  ${sample.evidence?.outcome ?? "unavailable"}  ${sample.evidence?.status ?? "-"}  ${sample.evidence?.durationMs.toFixed(2) ?? "-"}`);
  }
  lines.push(report.finding);
  if (report.error) lines.push(report.error.message);
  return lines.join("\n");
}
