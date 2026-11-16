import type { IdempotencyReport } from "./http-idempotency.ts";

export function formatIdempotencyReport(report: IdempotencyReport, format: "text" | "json") {
  if (format === "json") return JSON.stringify(report, null, 2);
  return [
    `${report.result}  ${report.configuration.method} ${report.configuration.target}`,
    `Run: ${report.runId}; completion: ${report.completion.reason}`,
    `Fresh keys: sequential ${report.keys.sequential}, concurrent ${report.keys.concurrent}`,
    `Attempts: ${report.completion.sequentialAttempted} sequential, ${report.completion.concurrentAttempted} concurrent; concurrent peak ${report.completion.concurrentPeakInFlight}; conflict ${report.completion.conflictAttempted ? "sent" : "not sent"}`,
    `Observed effect counts: ${JSON.stringify(report.stateCounts)}`,
    ...report.assertions.map((assertion) => `${assertion.passed === null ? "UNKNOWN" : assertion.passed ? "PASS" : "FAIL"}  ${assertion.name}: ${assertion.description}`),
    report.finding, ...(report.error ? [report.error.message] : []),
  ].join("\n");
}
