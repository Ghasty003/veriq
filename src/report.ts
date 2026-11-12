import type { HttpRunReport } from "./http-experiment.ts";

export function formatHttpReport(report: HttpRunReport, format: "text" | "json"): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  const lines = [
    `${report.result}  ${report.configuration.method} ${report.configuration.target}`,
    `Run: ${report.runId}`,
    `Requirement: status ${report.configuration.expectedStatus} within ${report.configuration.maxDurationMs} ms (headers only)`,
  ];
  if (report.evidence) {
    lines.push(`Observed: ${report.evidence.outcome}, status ${report.evidence.status ?? "unavailable"}, ${report.evidence.durationMs.toFixed(2)} ms`);
    if (report.evidence.error) lines.push(report.evidence.error.message);
    if (report.evidence.failure?.code) lines.push(`Transport code: ${report.evidence.failure.code}`);
  }
  lines.push(report.finding);
  if (report.error) lines.push(report.error.message);
  return lines.join("\n");
}
