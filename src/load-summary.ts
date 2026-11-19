import { summarizeHttpLatency } from "./http-latency-summary.ts";
import type { HttpObservation } from "./http-observation.ts";

export type LoadAttempt = {
  request: number; worker: number; startedElapsedMs: number; observedElapsedMs: number | null;
  evidence: HttpObservation | null; passed: boolean | null;
};
export function summarizeLoadStage(attempts: readonly LoadAttempt[], timing: { admissionMs: number; durationMs: number; peakInFlight: number }, expectedStatus: number) {
  const evidence = attempts.flatMap((a) => a.evidence ? [a.evidence] : []);
  const passedCount = attempts.filter((a) => a.passed === true).length, failedCount = attempts.filter((a) => a.passed === false).length;
  const unknownCount = attempts.length - passedCount - failedCount;
  const statusCounts: Record<string, number> = {};
  for (const e of evidence) if (e.status !== null) statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1;
  const expected = evidence.filter((e) => e.outcome === "response" && e.status === expectedStatus);
  const all = summarizeHttpLatency(evidence), matching = summarizeHttpLatency(expected);
  const rate = (count: number) => timing.durationMs > 0 ? count * 1000 / timing.durationMs : null;
  return {
    ...all, attemptCount: attempts.length, unobservedAttemptCount: attempts.length - evidence.length, passedCount, failedCount, unknownCount,
    evaluatedFailureFraction: passedCount + failedCount > 0 ? failedCount / (passedCount + failedCount) : null,
    failureFractionPopulation: "evaluated-attempts", statusCounts, peakInFlight: timing.peakInFlight,
    expectedStatusResponseCount: expected.length, expectedStatusResponseDurations: matching.responseDurations,
    rates: { startedPerSecond: timing.admissionMs > 0 ? attempts.length * 1000 / timing.admissionMs : null,
      responseHeadersPerSecond: rate(all.responseCount), expectedStatusResponsesPerSecond: rate(expected.length), passedRequestsPerSecond: rate(passedCount),
      admissionDenominatorMs: timing.admissionMs, completionDenominatorMs: timing.durationMs },
  };
}
