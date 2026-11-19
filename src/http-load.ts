import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseLoadConfiguration } from "./load-config.ts";
import { observeHttp } from "./http-observation.ts";
import { runBounded } from "./bounded-workers.ts";
import { summarizeLoadStage, type LoadAttempt } from "./load-summary.ts";
import { redactUrl } from "./http-config.ts";
import type { RunResult } from "./http-experiment.ts";

type Assertion = { name: string; passed: boolean | null; description: string };
export type LoadStage = {
  stage: number; phase: "ramp" | "recovery"; concurrency: number;
  startedAt: string; endedAt: string; startedElapsedMs: number; durationMs: number; admissionDurationMs: number;
  completion: { reason: "duration-completed" | "request-cap" | "cancelled" | "deadline" | "execution-error"; fullAdmissionWindow: boolean; requestCapReached: boolean };
  requests: LoadAttempt[]; summary: ReturnType<typeof summarizeLoadStage>; assertions: Assertion[]; result: RunResult;
};

export async function testHttpLoad(input: unknown, options: { signal?: AbortSignal; fetch?: typeof fetch } = {}) {
  const config = parseLoadConfiguration(input), startedAt = new Date().toISOString(), start = performance.now();
  const elapsed = () => performance.now() - start;
  const controller = new AbortController();
  let cancelled = false, internalError = false;
  let stopCause: "cancelled" | "deadline" | undefined, stoppedAt: number | undefined, errorAt: number | undefined;
  const stop = (cause: "cancelled" | "deadline") => {
    if (!controller.signal.aborted) { stopCause = cause; stoppedAt = elapsed(); controller.abort(); }
  };
  const markError = () => { internalError = true; errorAt ??= elapsed(); };
  const cancel = () => { cancelled = true; stop("cancelled"); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => stop("deadline"), config.deadlineMs);
  const stages: LoadStage[] = [], pauses: { beforeStage: number; plannedMs: number; actualMs: number }[] = [];
  function active() {
    if (!controller.signal.aborted && config.deadlineMs - elapsed() < 1) { stop("deadline"); }
    return !controller.signal.aborted && !internalError;
  }
  const plans = [...config.stages.map((concurrency) => ({ phase: "ramp" as const, concurrency })),
    ...(config.recovery ? [{ phase: "recovery" as const, concurrency: config.stages[0] }] : [])];
  async function stage(plan: typeof plans[number]) {
    const origin = elapsed(), windowEnd = origin + config.stageDurationMs;
    const report: LoadStage = {
      stage: stages.length + 1, ...plan, startedAt: new Date().toISOString(), endedAt: "", startedElapsedMs: origin, durationMs: 0, admissionDurationMs: 0,
      completion: { reason: "duration-completed", fullAdmissionWindow: false, requestCapReached: false },
      requests: [], summary: summarizeLoadStage([], { admissionMs: 0, durationMs: 0, peakInFlight: 0 }, config.request.expectedStatus), assertions: [], result: "INCONCLUSIVE",
    };
    stages.push(report);
    let peakInFlight = 0, capReachedAt: number | undefined;
    try {
      const pool = await runBounded<LoadAttempt | null>({
        count: config.maxRequestsPerStage, concurrency: plan.concurrency, signal: controller.signal,
        shouldStart: () => active() && elapsed() < windowEnd,
        action: async (index, signal) => {
          if (!active() || signal.aborted) return null;
          const budget = Math.floor(Math.min(config.request.timeoutMs, config.deadlineMs - elapsed()));
          if (budget < 1) { stop("deadline"); return null; }
          const admittedAt = elapsed();
          if (admittedAt >= windowEnd) return null;
          const record: LoadAttempt = { request: index + 1, worker: 0, startedElapsedMs: admittedAt - origin, observedElapsedMs: null, evidence: null, passed: null };
          report.requests.push(record);
          if (report.requests.length === config.maxRequestsPerStage) capReachedAt = elapsed();
          try {
            const evidence = await observeHttp({ ...config.request, timeoutMs: budget, maxDurationMs: Math.min(config.request.maxDurationMs, budget) }, {
              signal, fetch: options.fetch, onObservationEnd: () => { record.observedElapsedMs = elapsed() - origin; },
            });
            record.evidence = evidence;
            if (evidence.cleanup === "failed") markError();
            if (evidence.outcome === "response") record.passed = evidence.status === config.request.expectedStatus && evidence.durationMs <= config.request.maxDurationMs;
            else if (evidence.outcome === "request-error" || evidence.outcome === "timeout" && budget === config.request.timeoutMs) record.passed = false;
            // A shortened wait or caller cancellation does not establish the
            // original timeout requirement. Keep that attempt unknown.
          } catch { markError(); }
          return record;
        },
        stopWhen: (record) => internalError || record === null && !active() || record?.evidence?.outcome === "cancelled",
        onException: () => { markError(); return null; },
      });
      peakInFlight = pool.peakInFlight;
      for (const entry of pool.entries) if (entry.value) entry.value.worker = entry.worker;
    } catch { markError(); }
    finally {
      report.requests.sort((a, b) => a.request - b.request);
      report.durationMs = elapsed() - origin; report.endedAt = new Date().toISOString();
      const admissionEnd = Math.min(origin + report.durationMs, windowEnd, stoppedAt ?? Infinity, errorAt ?? Infinity, capReachedAt ?? Infinity);
      report.admissionDurationMs = Math.max(0, admissionEnd - origin);
      const capped = report.requests.length >= config.maxRequestsPerStage;
      const fullWindow = !capped && admissionEnd >= windowEnd;
      report.completion = { reason: internalError ? "execution-error" : stopCause === "cancelled" ? "cancelled" : stopCause === "deadline" ? "deadline" : capped ? "request-cap" : "duration-completed", fullAdmissionWindow: fullWindow, requestCapReached: capped };
      report.summary = summarizeLoadStage(report.requests, { admissionMs: report.admissionDurationMs, durationMs: report.durationMs, peakInFlight }, config.request.expectedStatus);
      const evaluated = report.summary.passedCount + report.summary.failedCount;
      report.assertions = [
        { name: "request-requirements", passed: report.summary.failedCount > 0 ? false : report.requests.length > 0 && report.summary.unknownCount === 0 ? true : null,
          description: `Every observed request must receive status ${config.request.expectedStatus} within ${config.request.maxDurationMs} ms; original per-request timeout ${config.request.timeoutMs} ms.` },
        { name: "stage-window", passed: fullWindow ? true : null, description: "Admission covers the requested stage duration without exhausting the request cap." },
        { name: "sample-count", passed: evaluated >= config.minSamplesPerStage ? true : null, description: `At least ${config.minSamplesPerStage} attempts have evaluated outcomes.` },
        ...(config.minPassedRequestsPerSecond > 0 ? [{ name: "passed-throughput", passed: fullWindow && evaluated >= config.minSamplesPerStage && report.summary.unknownCount === 0 && !internalError
          ? report.summary.rates.passedRequestsPerSecond! >= config.minPassedRequestsPerSecond : null,
          description: `At least ${config.minPassedRequestsPerSecond} requests per second meet status and duration requirements, including drain time.` }] : []),
      ];
      report.result = internalError ? "ERROR" : report.assertions.some((a) => a.passed === false) ? "FAIL" : report.assertions.every((a) => a.passed === true) ? "PASS" : "INCONCLUSIVE";
    }
  }
  try {
    for (const plan of plans) {
      if (!active()) break;
      if (stages.length && config.pauseMs > 0) {
        const waiting = elapsed(), until = waiting + config.pauseMs;
        try { while (active() && elapsed() < until) await delay(Math.max(1, Math.ceil(until - elapsed())), undefined, { signal: controller.signal }); }
        catch { /* cancellation/deadline owner records the reason */ }
        pauses.push({ beforeStage: stages.length + 1, plannedMs: config.pauseMs, actualMs: elapsed() - waiting });
        if (!active()) break;
      }
      await stage(plan);
    }
  } catch { markError(); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); controller.abort(); }
  const ramp = stages.filter((s) => s.phase === "ramp"), recovery = stages.find((s) => s.phase === "recovery");
  const firstBreach = ramp.find((s) => s.result === "FAIL");
  const result: RunResult = internalError ? "ERROR" : stages.some((s) => s.result === "FAIL") ? "FAIL" : stages.length === plans.length && stages.every((s) => s.result === "PASS") ? "PASS" : "INCONCLUSIVE";
  const baseline = ramp[0];
  const baselineRate = baseline?.summary.rates.passedRequestsPerSecond, baselineP95 = baseline?.summary.expectedStatusResponseDurations?.p95Ms;
  return {
    schemaVersion: 1, experiment: "http-load", runId: randomUUID(), startedAt, endedAt: new Date().toISOString(), durationMs: elapsed(),
    configuration: { ...config, request: { target: redactUrl(config.request.target), method: config.request.method, headerNames: Object.keys(config.request.headers).sort(), hasBody: config.request.body !== undefined,
      expectedStatus: config.request.expectedStatus, maxDurationMs: config.request.maxDurationMs, timeoutMs: config.request.timeoutMs }, mode: "closed-loop", measurementBoundary: "response-headers" },
    completion: { reason: internalError ? "execution-error" : stopCause === "cancelled" ? "cancelled" : stopCause === "deadline" ? "deadline" : stages.some((s) => s.completion.requestCapReached) ? "request-cap" : stages.some((s) => s.result === "INCONCLUSIVE") ? "insufficient-evidence" : "completed",
      cancelled, plannedStages: plans.length, startedStages: stages.length, skippedStages: plans.length - stages.length, completedStageWindows: stages.filter((s) => s.completion.fullAdmissionWindow).length },
    maxRequestBudget: config.maxRequestsPerStage * plans.length, attemptedRequests: stages.reduce((sum, s) => sum + s.requests.length, 0), pauses, stages,
    comparison: { firstObservedFailingConcurrency: firstBreach?.concurrency ?? null, observedPassingConcurrencyLevels: ramp.filter((s) => s.result === "PASS").map((s) => s.concurrency),
      recoveryResult: config.recovery ? recovery?.result ?? "INCONCLUSIVE" : null,
      relativeToFirstStage: stages.map((s) => ({ stage: s.stage, phase: s.phase, concurrency: s.concurrency,
        passedThroughputRatio: baselineRate && s.summary.rates.passedRequestsPerSecond !== null ? s.summary.rates.passedRequestsPerSecond / baselineRate : null,
        expectedStatusP95Ratio: baselineP95 && s.summary.expectedStatusResponseDurations ? s.summary.expectedStatusResponseDurations.p95Ms / baselineP95 : null })) },
    result, finding: result === "ERROR" ? "Veriq could not execute the load experiment correctly; collected observations are preserved."
      : firstBreach ? `The first observed ramp requirement violation was at concurrency ${firstBreach.concurrency}. Recovery result: ${recovery?.result ?? (config.recovery ? "unobserved" : "disabled")}. This does not identify a bottleneck or establish maximum capacity.`
      : result === "FAIL" ? "The recovery stage violated a declared requirement; ramp observations remain available."
      : result === "PASS" ? "Every tested stage and enabled recovery met the declared requirements during the measured windows."
      : "The available stages, durations or samples do not establish every declared requirement.",
    error: internalError ? { code: "LOAD_EXECUTION_FAILED", message: "Veriq could not execute or release a load observation correctly." } : null,
  };
}
export type LoadReport = Awaited<ReturnType<typeof testHttpLoad>>;
