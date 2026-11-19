import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseRetryConfiguration, retryDecision, backoffDelay, retryAfterDelay, type RetryConfiguration } from "./retry-policy.ts";
import { observeHttp, type HttpObservation } from "./http-observation.ts";
import { captureHttpJson, type JsonEvidence } from "./http-json.ts";
import { redactUrl } from "./http-config.ts";
import { selectJson } from "./json-value.ts";
import type { RunResult } from "./http-experiment.ts";

type StopReason = "success" | "non-retryable" | "response-too-slow" | "attempts-exhausted" | "deadline" | "insufficient-budget" | "cancelled" | "precondition" | "state-unavailable" | "execution-error";
export type RetryReport = {
  schemaVersion: 1; runId: string; key: string | null; startedAt: string; endedAt: string; durationMs: number;
  configuration: { target: string; method: string; headerNames: string[]; hasBody: boolean; expectedStatus: number; timeoutMs: number; maxDurationMs: number; retrySafety: RetryConfiguration["retrySafety"]; policy: RetryConfiguration["policy"]; stateTargetTemplate: string | null };
  attempts: { attempt: number; startedElapsedMs: number; observedElapsedMs: number | null; evidence: HttpObservation | null; decision: { retryable: boolean; category: string }; backoffCapMs: number | null; retryAfterMs: number | null; plannedDelayMs: number | null; waitedMs: number }[];
  state: { before: { evidence: JsonEvidence; count: number | null } | null; after: { evidence: JsonEvidence; count: number | null } | null };
  completion: { reason: StopReason; attemptedCount: number; remainingAttemptSlots: number; cancelled: boolean };
  assertions: { name: string; applicable: boolean; passed: boolean | null; description: string }[];
  result: RunResult; finding: string; error: { code: string; message: string } | null;
};
export type RetryOptions = {
  signal?: AbortSignal; fetch?: typeof fetch; random?: () => number;
  now?: () => number; wallNow?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export async function testHttpRetry(input: unknown, options: RetryOptions = {}): Promise<RetryReport> {
  const config = parseRetryConfiguration(input), now = options.now ?? (() => performance.now());
  const start = now(), controller = new AbortController();
  let interrupted: "cancelled" | "deadline" | undefined;
  function stop(reason: "cancelled" | "deadline") { if (!controller.signal.aborted) { interrupted = reason; controller.abort(); } }
  const cancel = () => stop("cancelled");
  const timer = setTimeout(() => stop("deadline"), config.policy.deadlineMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const key = config.retrySafety === "idempotency-key" ? randomUUID() : null;
  const report: RetryReport = {
    schemaVersion: 1, runId: randomUUID(), key, startedAt: new Date().toISOString(), endedAt: "", durationMs: 0,
    configuration: { target: redactUrl(config.request.target), method: config.request.method, headerNames: Object.keys(config.request.headers).sort(), hasBody: config.request.body !== undefined, expectedStatus: config.request.expectedStatus, maxDurationMs: config.request.maxDurationMs, timeoutMs: config.request.timeoutMs, retrySafety: config.retrySafety, policy: config.policy, stateTargetTemplate: config.state ? redactUrl(config.state.target.replace("{key}", "run-key")) : null },
    attempts: [], state: { before: null, after: null }, completion: { reason: "execution-error", attemptedCount: 0, remainingAttemptSlots: config.policy.maxAttempts, cancelled: false },
    assertions: [
      { name: "recovered-within-budget", applicable: true, passed: null, description: "Receive the required status and header-arrival duration within the configured retry budget." },
      { name: "effect-safety", applicable: Boolean(key), passed: null, description: "Observe at most one effect for the reused key, and exactly one if recovery succeeded." },
    ], result: "INCONCLUSIVE", finding: "", error: null,
  };
  const remaining = () => config.policy.deadlineMs - (now() - start);
  function stopped() { if (remaining() < 1 && !interrupted) stop("deadline"); return controller.signal.aborted; }
  function finish(reason: StopReason) {
    report.completion = { reason, attemptedCount: report.attempts.length, remainingAttemptSlots: config.policy.maxAttempts - report.attempts.length, cancelled: reason === "cancelled" };
    report.endedAt = new Date().toISOString(); report.durationMs = now() - start;
    const assertions = report.assertions.filter((assertion) => assertion.applicable);
    report.result = report.error ? "ERROR" : assertions.some((assertion) => assertion.passed === false) ? "FAIL" : assertions.every((assertion) => assertion.passed === true) ? "PASS" : "INCONCLUSIVE";
    report.finding = report.result === "PASS" ? "The configured retry policy recovered within its budget and all applicable effect assertions passed."
      : report.result === "FAIL" ? "Recovery or an observed effect-safety requirement failed; inspect attempts and assertions."
      : report.result === "ERROR" ? "Veriq could not execute or clean up the retry experiment correctly."
      : "The available evidence is insufficient to establish recovery and all applicable safety requirements.";
    return report;
  }
  async function state() {
    if (stopped()) return null;
    const { countPointer, ...http } = config.state!;
    const timeoutMs = Math.min(http.timeoutMs, Math.floor(remaining()));
    if (timeoutMs < 1) { stop("deadline"); return null; }
    const capture = await captureHttpJson({ ...http, target: http.target.replace("{key}", encodeURIComponent(key!)), timeoutMs, maxDurationMs: Math.min(http.maxDurationMs, timeoutMs) }, { signal: controller.signal, fetch: options.fetch });
    if (capture.evidence.outcome === "execution-error") report.error = capture.evidence.error ?? { code: "STATE_EXECUTION_FAILED", message: "State execution failed." };
    const selected = selectJson(capture.value, countPointer);
    const count = capture.evidence.outcome === "response" && capture.evidence.status === http.expectedStatus && capture.evidence.durationMs <= Math.min(http.maxDurationMs, timeoutMs) && selected.found && typeof selected.value === "number" && Number.isSafeInteger(selected.value) && selected.value >= 0 ? selected.value : null;
    return { evidence: capture.evidence, count };
  }
  let reason: StopReason = "attempts-exhausted";
  try {
    if (stopped()) { if (interrupted === "deadline" && !key) report.assertions[0].passed = false; return finish(interrupted!); }
    if (key) {
      report.state.before = await state();
      if (report.error) return finish("execution-error");
      if (stopped()) return finish(interrupted!);
      if (report.state.before?.count !== 0) return finish("precondition");
    }
    for (let index = 0; index < config.policy.maxAttempts; index++) {
      if (stopped()) { reason = interrupted!; break; }
      const startedElapsedMs = now() - start;
      const timeoutMs = Math.min(config.request.timeoutMs, Math.floor(remaining()));
      if (timeoutMs < 1) { stop("deadline"); reason = "deadline"; break; }
      const attempt: RetryReport["attempts"][number] = { attempt: index + 1, startedElapsedMs, observedElapsedMs: null, evidence: null, decision: { retryable: false, category: "execution-error" }, backoffCapMs: null, retryAfterMs: null, plannedDelayMs: null, waitedMs: 0 };
      report.attempts.push(attempt);
      const evidence = await observeHttp({ ...config.request, timeoutMs, maxDurationMs: Math.min(config.request.maxDurationMs, timeoutMs), headers: key ? { ...config.request.headers, "idempotency-key": key } : config.request.headers }, { signal: controller.signal, fetch: options.fetch, onObservationEnd: () => { attempt.observedElapsedMs = now() - start; } });
      attempt.evidence = evidence; attempt.decision = retryDecision(evidence, config.policy);
      if (evidence.cleanup === "failed") { report.error = { code: "HTTP_CLEANUP_FAILED", message: "Veriq could not release a retry response body." }; reason = "execution-error"; break; }
      const receivedInBudget = attempt.observedElapsedMs !== null && attempt.observedElapsedMs <= config.policy.deadlineMs;
      if (evidence.outcome === "response" && evidence.status === config.request.expectedStatus) {
        reason = !receivedInBudget ? "deadline" : evidence.durationMs > config.request.maxDurationMs ? "response-too-slow" : "success";
        attempt.decision = { retryable: false, category: reason };
        report.assertions[0].passed = reason === "success";
        break;
      }
      if (stopped()) { reason = interrupted!; break; }
      if (!attempt.decision.retryable) { reason = "non-retryable"; break; }
      if (index + 1 === config.policy.maxAttempts) { reason = "attempts-exhausted"; break; }
      const backoff = backoffDelay(config.policy, index, options.random);
      attempt.backoffCapMs = backoff.capMs;
      attempt.retryAfterMs = evidence.outcome === "response" ? retryAfterDelay(evidence.retryAfter, (options.wallNow ?? Date.now)()) : null;
      attempt.plannedDelayMs = Math.max(backoff.delayMs, attempt.retryAfterMs ?? 0);
      if (attempt.plannedDelayMs >= remaining()) { reason = "insufficient-budget"; break; }
      const waitStart = now();
      try {
        await (options.wait ?? (async (ms, signal) => { await sleep(ms, undefined, { signal }); }))(attempt.plannedDelayMs, controller.signal);
      } catch (cause) { if (!controller.signal.aborted) throw cause; }
      finally { attempt.waitedMs = now() - waitStart; }
    }
    if (report.assertions[0].passed === null && reason !== "cancelled" && reason !== "execution-error") report.assertions[0].passed = false;
    if (key && !report.error && !stopped()) {
      report.state.after = await state();
      const count = report.state.after?.count ?? null;
      report.assertions[1].passed = count === null ? null : count > 1 ? false : report.assertions[0].passed === true ? count === 1 : true;
    }
    if (report.error) reason = "execution-error";
    else if (interrupted === "cancelled" && (key && report.assertions[1].passed === null || report.assertions[0].passed === null)) reason = "cancelled";
    else if (key && report.assertions[0].passed === true && report.assertions[1].passed === null) reason = interrupted ?? "state-unavailable";
    return finish(reason);
  } catch {
    report.error ??= { code: "RETRY_EXECUTION_FAILED", message: "Veriq could not execute the retry experiment correctly." };
    return finish("execution-error");
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); controller.abort(); }
}
