import type { RetryReport } from "./http-retry.ts";

export function formatRetryReport(report: RetryReport, format: "text" | "json") {
  if (format === "json") return JSON.stringify(report, null, 2);
  return [
    `${report.result}  ${report.configuration.method} ${report.configuration.target}`, `Run: ${report.runId}; completion: ${report.completion.reason}`,
    `Attempts: ${report.attempts.length}/${report.configuration.policy.maxAttempts}; budget ${report.configuration.policy.deadlineMs} ms; elapsed ${report.durationMs.toFixed(2)} ms`,
    ...(report.key ? [`Reused key: ${report.key}; observed effects before=${report.state.before?.count ?? "unknown"}, after=${report.state.after?.count ?? "unknown"}`] : []),
    ...report.attempts.map((attempt) => `${attempt.attempt}: ${attempt.evidence?.outcome ?? "unavailable"}, status ${attempt.evidence?.status ?? "-"}, ${attempt.evidence?.durationMs.toFixed(2) ?? "-"} ms; ${attempt.decision.category}; next delay ${attempt.plannedDelayMs ?? "-"} ms, waited ${attempt.waitedMs.toFixed(2)} ms`),
    ...report.assertions.filter((assertion) => assertion.applicable).map((assertion) => `${assertion.passed === null ? "UNKNOWN" : assertion.passed ? "PASS" : "FAIL"}  ${assertion.name}: ${assertion.description}`),
    report.finding, ...(report.error ? [report.error.message] : []),
  ].join("\n");
}
