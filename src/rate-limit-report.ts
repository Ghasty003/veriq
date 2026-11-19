import type { RateLimitReport } from "./http-rate-limit.ts";
export function formatRateLimitReport(report: RateLimitReport, format: "text" | "json") {
  if (format === "json") return JSON.stringify(report, null, 2);
  return [
    `${report.result}  ${report.configuration.request.method} ${report.configuration.request.target}`,
    `Run: ${report.runId}; completion: ${report.completion.reason}`,
    `Allowance: ${report.configuration.allowance} per caller per ${report.configuration.windowMs} ms anchored window`,
    `Requests: ${report.attempts.length}/${report.plannedRequests}; burst client peak: ${report.peakInFlight}; reset wait: ${report.resetWaitMs.toFixed(2)} ms`,
    ...report.attempts.map((a) => `${a.phase} ${a.request}: ${a.evidence?.outcome ?? "unavailable"}, status ${a.evidence?.status ?? "-"}, ${a.evidence?.durationMs.toFixed(2) ?? "-"} ms; ${a.inWindow ? "inside window" : "window unconfirmed"}`),
    ...report.assertions.map((a) => `${a.passed === null ? "UNKNOWN" : a.passed ? "PASS" : "FAIL"}  ${a.name}: ${a.description}`), report.finding,
  ].join("\n");
}
