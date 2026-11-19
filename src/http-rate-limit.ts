import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseRateLimitConfiguration } from "./rate-limit-config.ts";
import { observeHttp, type HttpObservation } from "./http-observation.ts";
import { redactUrl } from "./http-config.ts";
import { runBounded } from "./bounded-workers.ts";
import { retryAfterDelay } from "./retry-policy.ts";
import type { RunResult } from "./http-experiment.ts";

type Phase = "primary" | "isolation" | "reset" | "concurrent";
type Attempt = { phase: Phase; request: number; startedElapsedMs: number; observedElapsedMs: number | null; inWindow: boolean; evidence: HttpObservation | null };
type Assertion = { name: string; passed: boolean | null; description: string };

export async function testHttpRateLimit(input: unknown, options: { signal?: AbortSignal; fetch?: typeof fetch } = {}) {
  const config = parseRateLimitConfiguration(input);
  const start = performance.now(), startedAt = new Date().toISOString();
  const elapsed = () => performance.now() - start;
  const controller = new AbortController();
  let cancelled = false, deadline = false, internalError = false, overran = false;
  const cancel = () => { cancelled = true; controller.abort(); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => { deadline = true; controller.abort(); }, config.deadlineMs);
  const attempts: Attempt[] = [], assertions: Assertion[] = [];
  const identities = { primary: randomUUID(), isolation: randomUUID(), concurrent: randomUUID() };
  const total = config.allowance + config.excessRequests;
  let peakInFlight = 0, resetWaitMs = 0;
  const active = () => {
    if (!controller.signal.aborted && elapsed() >= config.deadlineMs) { deadline = true; controller.abort(); }
    return !controller.signal.aborted && !internalError;
  };
  function add(name: string, passed: boolean | null, description: string) { assertions.push({ name, passed, description }); }
  const response = (a: Attempt) => a.inWindow && a.evidence?.outcome === "response";
  const accepted = (a: Attempt) => response(a) && a.evidence!.status === config.request.expectedStatus;
  const admitted = (a: Attempt) => response(a) && a.evidence!.status! >= 200 && a.evidence!.status! <= 299;
  function allStatus(list: Attempt[], count: number, status: number): boolean | null {
    if (list.some((a) => response(a) && a.evidence!.status !== status)) return false;
    return list.length === count && list.every(response) ? true : null;
  }
  async function send(phase: Phase, index: number, origin: number, signal: AbortSignal): Promise<Attempt | null> {
    const remainingWindow = origin + config.windowMs - config.windowGuardMs - elapsed();
    const budget = Math.floor(Math.min(config.request.timeoutMs, config.deadlineMs - elapsed(), remainingWindow));
    if (!active() || signal.aborted) return null;
    if (budget < 1) {
      if (config.deadlineMs - elapsed() < 1) { deadline = true; controller.abort(); }
      else overran = true;
      return null;
    }
    const attempt: Attempt = { phase, request: index + 1, startedElapsedMs: elapsed(), observedElapsedMs: null, inWindow: false, evidence: null };
    attempts.push(attempt);
    try {
      attempt.evidence = await observeHttp({ ...config.request,
        timeoutMs: budget, maxDurationMs: Math.min(config.request.maxDurationMs, budget),
        headers: { ...config.request.headers, [config.identityHeader]: identities[phase === "reset" ? "primary" : phase] },
      }, { signal, fetch: options.fetch, onObservationEnd: () => { attempt.observedElapsedMs = elapsed(); } });
      attempt.inWindow = attempt.observedElapsedMs !== null && attempt.observedElapsedMs <= origin + config.windowMs - config.windowGuardMs;
      if (!attempt.inWindow) overran = true;
      if (attempt.evidence.cleanup === "failed") internalError = true;
    } catch { internalError = true; }
    return attempt;
  }
  async function sequential(phase: Phase, count: number, origin: number) {
    const records: Attempt[] = [];
    for (let i = 0; i < count && active(); i++) {
      const record = await send(phase, i, origin, controller.signal);
      if (!record) break;
      records.push(record);
      if (!record.inWindow) break;
    }
    return records;
  }
  function checkWindow(prefix: string, records: Attempt[], exhausted: boolean) {
    add(`${prefix}-allowance`, allStatus(records.slice(0, config.allowance), config.allowance, config.request.expectedStatus), "Every request within the declared allowance receives the accepted status.");
    add(`${prefix}-excess`, exhausted ? allStatus(records.slice(config.allowance), config.excessRequests, config.rejectedStatus) : null, "After confirmed allowance consumption, extra requests receive the rejected status.");
    add(`${prefix}-cap`, records.filter(admitted).length > config.allowance ? false : records.length === total && records.every(response) ? true : null, "Observed successful admissions never exceed the allowance inside one window.");
  }
  try {
    const origin = elapsed();
    const primary = await sequential("primary", total, origin);
    const exhausted = primary.length >= config.allowance && primary.slice(0, config.allowance).every(accepted);
    checkWindow("primary", primary, exhausted);
    const isolated = await sequential("isolation", config.allowance, origin);
    add("caller-isolation", exhausted ? allStatus(isolated, config.allowance, config.request.expectedStatus) : null, "A second fresh caller retains its allowance while the first caller is exhausted.");
    let reset: Attempt[] = [];
    if (exhausted && active()) {
      // The server saw the first request before its response arrived. Waiting from that
      // observed response gives a conservative upper bound on the first window's expiry.
      const wait = Math.max(0, primary[0].observedElapsedMs! + config.windowMs + config.resetGraceMs - elapsed());
      const waiting = elapsed();
      if (elapsed() + wait >= config.deadlineMs) { deadline = true; controller.abort(); }
      else {
        try { await delay(wait, undefined, { signal: controller.signal }); } catch { /* cancellation is recorded below */ }
        resetWaitMs = elapsed() - waiting;
        if (active()) reset = await sequential("reset", total, elapsed());
      }
    }
    checkWindow("reset", reset, reset.length >= config.allowance && reset.slice(0, config.allowance).every(accepted));
    let concurrent: Attempt[] = [];
    if (active()) {
      const origin = elapsed();
      const batch = await runBounded<Attempt | null>({ count: total, concurrency: config.concurrency, signal: controller.signal,
        action: (index, signal) => send("concurrent", index, origin, signal),
        stopWhen: (a) => internalError || a === null || !a.inWindow,
        onException: () => { internalError = true; return null; },
      });
      peakInFlight = batch.peakInFlight;
      concurrent = batch.entries.flatMap((entry) => entry.value ? [entry.value] : []);
    }
    const successes = concurrent.filter(admitted).length;
    const complete = concurrent.length === total && concurrent.every(response);
    add("concurrent-cap", successes > config.allowance ? false : complete ? true : null, "Overlapping attempts do not obtain more successful admissions than the allowance.");
    add("concurrent-distribution", complete ? concurrent.filter(accepted).length === config.allowance && concurrent.filter((a) => a.evidence!.status === config.rejectedStatus).length === config.excessRequests : null, "The complete burst contains exactly the allowed successes and expected rejections.");
    const planned = 4 * config.allowance + 3 * config.excessRequests;
    add("response-duration", attempts.some((a) => a.evidence?.outcome === "response" && a.evidence.durationMs > config.request.maxDurationMs) ? false : attempts.length === planned && attempts.every((a) => a.evidence?.outcome === "response") ? true : null, "All response headers arrive within the configured duration requirement.");
    if (config.requireRetryAfter) {
      const rejected = attempts.filter((a) => a.evidence?.outcome === "response" && a.evidence.status === config.rejectedStatus);
      add("retry-after", rejected.some((a) => retryAfterDelay(a.evidence!.retryAfter, Date.parse(a.evidence!.endedAt)) === null) ? false : attempts.length === planned && rejected.length > 0 && attempts.every((a) => a.evidence?.outcome === "response") ? true : null, "Rejections include a syntactically valid Retry-After delay or HTTP date.");
    }
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); controller.abort();
  }
  const result: RunResult = internalError ? "ERROR" : assertions.some((a) => a.passed === false) ? "FAIL" : assertions.every((a) => a.passed === true) ? "PASS" : "INCONCLUSIVE";
  return {
    schemaVersion: 1, experiment: "http-rate-limit", runId: randomUUID(), startedAt, endedAt: new Date().toISOString(), durationMs: elapsed(),
    configuration: { ...config, request: { target: redactUrl(config.request.target), method: config.request.method, expectedStatus: config.request.expectedStatus, timeoutMs: config.request.timeoutMs, maxDurationMs: config.request.maxDurationMs }, identityMode: "generated-fresh-callers" },
    completion: { reason: internalError ? "execution-error" : cancelled ? "cancelled" : deadline ? "deadline" : overran ? "window-overrun" : assertions.some((a) => a.passed === null) ? "insufficient-evidence" : "completed", cancelled },
    plannedRequests: 4 * config.allowance + 3 * config.excessRequests, peakInFlight, resetWaitMs, attempts, assertions, result,
    finding: result === "PASS" ? "Observed callers obeyed the declared allowance, isolation, reset and concurrent admission requirements." : result === "FAIL" ? "Observed behavior violated at least one declared requirement." : result === "ERROR" ? "Veriq could not complete execution correctly." : "Available observations do not establish all declared requirements.",
    error: internalError ? { code: "EXECUTION_ERROR", message: "HTTP execution or response cleanup failed inside Veriq." } : null,
  };
}
export type RateLimitReport = Awaited<ReturnType<typeof testHttpRateLimit>>;
