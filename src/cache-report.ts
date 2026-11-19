import type { CacheReport } from "./http-cache.ts";
export function formatCacheReport(report: CacheReport, format: "text" | "json") {
  if (format === "json") return JSON.stringify(report, null, 2);
  return [
    `${report.result}  Cache experiment: ${report.configuration.read.target}`,
    `Run: ${report.runId}; completion: ${report.completion.reason}`,
    `TTL: ${report.configuration.ttlMs} ms; invalidation: ${report.configuration.invalidation}; reads: ${report.attemptedReads}/${report.plannedReads}; burst client peak: ${report.peakInFlight}`,
    ...report.waits.map((w) => `${w.phase}: waited ${w.actualMs.toFixed(2)} ms`),
    ...report.preconditions.map((p) => `${p.bucket}: fresh=${p.fresh ?? "unknown"}, seeded=${p.seeded}`),
    ...report.counterIssues.map((i) => `${i.bucket}: source counter decreased ${i.previous} -> ${i.observed}; affected count assertions are unknown`),
    ...report.observations.map((o) => `${o.sequence}: ${o.phase}, ${o.bucket}, ${o.action}: ${o.evidence?.outcome ?? "unavailable"}, status ${o.evidence?.status ?? "-"}, ${o.evidence?.durationMs.toFixed(2) ?? "-"} ms${o.action === "source" ? `; source reads=${o.sourceReads ?? "unknown"}` : ""}`),
    ...report.assertions.map((a) => `${a.passed === null ? "UNKNOWN" : a.passed ? "PASS" : "FAIL"}  ${a.name}: ${a.description}`),
    report.finding, ...(report.error ? [report.error.message] : []),
  ].join("\n");
}
