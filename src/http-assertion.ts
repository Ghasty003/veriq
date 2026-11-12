import type { HttpEvidence } from "./http-probe.ts";

export function assertHttpResponse(
  evidence: HttpEvidence,
  maxDurationMs = evidence.timeoutMs,
  expectedStatus = 200,
) {
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > evidence.timeoutMs) {
    throw new Error("The response requirement must be positive and no longer than the observer waiting limit.");
  }
  if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
    throw new Error("Expected HTTP status must be an integer from 100 to 599.");
  }
  const passed =
    evidence.outcome === "response" &&
    evidence.status === expectedStatus &&
    evidence.durationMs <= maxDurationMs;

  return {
    description: `Receive HTTP response headers with status ${expectedStatus} within ${maxDurationMs} milliseconds`,
    expectedStatus,
    maxDurationMs,
    passed,
  };
}
