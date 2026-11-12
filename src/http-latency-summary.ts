import type { HttpEvidence } from "./http-probe.ts";

export function summarizeHttpLatency(evidence: readonly HttpEvidence[]) {
  const durations = evidence
    .filter((item) => item.outcome === "response")
    .map((item) => item.durationMs)
    .sort((a, b) => a - b);

  const percentile = (percentage: number) =>
    durations[Math.ceil((percentage / 100) * durations.length) - 1];

  return {
    attemptCount: evidence.length,
    responseCount: durations.length,
    timeoutCount: evidence.filter((item) => item.outcome === "timeout").length,
    requestErrorCount: evidence.filter((item) => item.outcome === "request-error").length,
    cancelledCount: evidence.filter((item) => item.outcome === "cancelled").length,
    population: "received-response-headers",
    percentileMethod: "nearest-rank",
    responseDurations:
      durations.length === 0
        ? null
        : {
            meanMs: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
            minMs: durations[0],
            maxMs: durations[durations.length - 1],
            p50Ms: percentile(50),
            p95Ms: percentile(95),
            p99Ms: percentile(99),
          },
  };
}
