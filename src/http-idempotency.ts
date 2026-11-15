import { randomUUID } from "node:crypto";
import { ConfigurationError, parseHttpConfiguration, redactUrl, type HttpConfiguration } from "./http-config.ts";
import { runBounded } from "./bounded-workers.ts";
import { captureHttpJson, type JsonCapture, type JsonEvidence } from "./http-json.ts";
import { runHttpExperiment, type HttpRunReport, type RunResult } from "./http-experiment.ts";
import { jsonFingerprint, selectJson, validatePointer } from "./json-value.ts";

export type IdempotencyConfiguration = {
  request: HttpConfiguration;
  state: HttpConfiguration & { countPointer: string };
  conflictBody: string; conflictExpectedStatus: number; responsePointer: string;
  sequentialRequests: number; concurrentRequests: number; concurrency: number;
};
export function parseIdempotencyConfiguration(input: unknown): IdempotencyConfiguration {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigurationError("Idempotency configuration must be a JSON object.");
  const value = input as Record<string, unknown>;
  const allowed = ["request", "state", "conflictBody", "conflictExpectedStatus", "responsePointer", "sequentialRequests", "concurrentRequests", "concurrency"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ConfigurationError("Unknown idempotency configuration field.");
  if (!value.request || typeof value.request !== "object" || Array.isArray(value.request)) throw new ConfigurationError("request must be an HTTP configuration object.");
  const rawRequest = value.request as Record<string, unknown>;
  const request = parseHttpConfiguration({ ...rawRequest, method: rawRequest.method === undefined ? "POST" : rawRequest.method });
  if (!["POST", "PUT", "PATCH"].includes(request.method)) throw new ConfigurationError("Idempotency operations must use POST, PUT or PATCH.");
  if (request.expectedStatus < 200 || request.expectedStatus > 299 || [204, 205].includes(request.expectedStatus)) throw new ConfigurationError("The operation must return a successful JSON response status (2xx, other than 204/205).");
  if (Object.hasOwn(request.headers, "idempotency-key")) throw new ConfigurationError("Veriq generates isolated Idempotency-Key headers; do not configure one.");
  if (typeof value.conflictBody !== "string" || value.conflictBody === (request.body ?? "")) throw new ConfigurationError("conflictBody must be a different request body string.");
  const conflictExpectedStatus = value.conflictExpectedStatus === undefined ? 409 : value.conflictExpectedStatus;
  if (typeof conflictExpectedStatus !== "number" || conflictExpectedStatus < 400 || conflictExpectedStatus > 499 || !Number.isInteger(conflictExpectedStatus)) throw new ConfigurationError("conflictExpectedStatus must be a rejection status from 400 to 499.");
  parseHttpConfiguration({ ...request, body: value.conflictBody, expectedStatus: conflictExpectedStatus });
  let equivalent = false;
  try { equivalent = jsonFingerprint(JSON.parse(request.body ?? "")) === jsonFingerprint(JSON.parse(value.conflictBody)); } catch {}
  if (equivalent) throw new ConfigurationError("conflictBody must not be JSON-equivalent to the original request body.");
  if (!value.state || typeof value.state !== "object" || Array.isArray(value.state)) throw new ConfigurationError("state must describe a JSON count endpoint.");
  const { countPointer = "/effectCount", ...rawState } = value.state as Record<string, unknown>;
  if (typeof rawState.target !== "string" || rawState.target.split("{key}").length !== 2) throw new ConfigurationError("state.target must contain exactly one {key} placeholder.");
  const stateHttp = parseHttpConfiguration({ ...rawState, target: rawState.target.replace("{key}", "validation-key") });
  if (stateHttp.method !== "GET" || stateHttp.body !== undefined) throw new ConfigurationError("The state observation must use GET without a body.");
  if (stateHttp.expectedStatus < 200 || stateHttp.expectedStatus > 299 || [204, 205].includes(stateHttp.expectedStatus)) throw new ConfigurationError("The state endpoint must have a successful JSON response status.");
  function count(name: string, fallback: number, maximum: number) {
    const number = value[name] === undefined ? fallback : value[name];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 2 || number > maximum) throw new ConfigurationError(`${name} must be an integer from 2 to ${maximum}.`);
    return number;
  }
  return {
    request, state: { ...stateHttp, target: rawState.target, countPointer: validatePointer(countPointer) },
    conflictBody: value.conflictBody, conflictExpectedStatus, responsePointer: validatePointer(value.responsePointer === undefined ? "" : value.responsePointer),
    sequentialRequests: count("sequentialRequests", 3, 100), concurrentRequests: count("concurrentRequests", 5, 100), concurrency: count("concurrency", 5, 32),
  };
}

export type IdempotencyReport = {
  schemaVersion: 1; runId: string; startedAt: string; endedAt: string; durationMs: number;
  keys: { sequential: string; concurrent: string };
  configuration: {
    target: string; method: string; stateTargetTemplate: string; responsePointer: string; countPointer: string;
    sequentialRequests: number; concurrentRequests: number; concurrency: number;
    expectedStatus: number; maxDurationMs: number; timeoutMs: number; conflictExpectedStatus: number;
  };
  completion: { reason: "completed" | "cancelled" | "precondition" | "execution-error"; sequentialAttempted: number; concurrentAttempted: number; sequentialUnstarted: number; concurrentUnstarted: number; concurrentPeakInFlight: number; conflictAttempted: boolean };
  observations: { phase: string; attempt: number; evidence: JsonEvidence; responseFingerprint: string | null }[];
  conflict: HttpRunReport | null;
  stateCounts: Record<string, number | null>;
  assertions: { name: string; passed: boolean | null; description: string }[];
  result: RunResult; finding: string; error: { code: string; message: string } | null;
};

export async function testHttpIdempotency(input: unknown, options: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<IdempotencyReport> {
  const config = parseIdempotencyConfiguration(input), start = performance.now();
  const report: IdempotencyReport = {
    schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(), endedAt: "", durationMs: 0,
    keys: { sequential: randomUUID(), concurrent: randomUUID() },
    configuration: { target: redactUrl(config.request.target), method: config.request.method, stateTargetTemplate: redactUrl(config.state.target.replace("{key}", "run-key")), responsePointer: config.responsePointer, countPointer: config.state.countPointer, sequentialRequests: config.sequentialRequests, concurrentRequests: config.concurrentRequests, concurrency: config.concurrency, expectedStatus: config.request.expectedStatus, timeoutMs: config.request.timeoutMs, maxDurationMs: config.request.maxDurationMs, conflictExpectedStatus: config.conflictExpectedStatus },
    completion: { reason: "completed", sequentialAttempted: 0, concurrentAttempted: 0, sequentialUnstarted: config.sequentialRequests, concurrentUnstarted: config.concurrentRequests, concurrentPeakInFlight: 0, conflictAttempted: false },
    observations: [], conflict: null,
    stateCounts: { sequentialBaseline: null, concurrentBaseline: null, afterSequential: null, afterConflict: null, afterConcurrent: null },
    assertions: [
      ["fresh-sequential-key", "Sequential key has no prior effects."], ["fresh-concurrent-key", "Concurrent key has no prior effects."],
      ["sequential-responses", "Sequential operations return the configured status and bounded complete JSON."],
      ["sequential-replay", "Sequential repeats replay the selected JSON response value."],
      ["sequential-effect", "Sequential repeats produce exactly one observed effect."],
      ["conflict-response", "Different input under the original key is rejected."],
      ["conflict-effect", "Conflicting input creates no additional observed effect."],
      ["concurrent-responses", "Concurrent first-use requests return the configured status and bounded complete JSON."],
      ["concurrent-replay", "Concurrent first-use requests replay one selected JSON response value."],
      ["concurrent-effect", "Concurrent first-use requests produce exactly one observed effect."],
    ].map(([name, description]) => ({ name, description, passed: null })),
    result: "INCONCLUSIVE", finding: "", error: null,
  };
  function assertion(name: string, passed: boolean | null) { report.assertions.find((item) => item.name === name)!.passed = passed; }
  function fingerprint(capture: JsonCapture) {
    if (capture.evidence.outcome !== "response") return null;
    const selected = selectJson(capture.value, config.responsePointer);
    try { return selected.found ? jsonFingerprint(selected.value) : null; } catch { return null; }
  }
  function finish(reason: IdempotencyReport["completion"]["reason"]) {
    report.completion.reason = reason;
    report.completion.sequentialUnstarted = config.sequentialRequests - report.completion.sequentialAttempted;
    report.completion.concurrentUnstarted = config.concurrentRequests - report.completion.concurrentAttempted;
    report.endedAt = new Date().toISOString(); report.durationMs = performance.now() - start;
    report.result = report.error ? "ERROR" : report.assertions.some((item) => item.passed === false) ? "FAIL"
      : report.assertions.every((item) => item.passed === true) ? "PASS" : "INCONCLUSIVE";
    report.finding = report.result === "PASS" ? "The declared replay, conflict and observed effect-count requirements held for both fresh keys."
      : report.result === "FAIL" ? "At least one declared idempotency requirement was violated; inspect individual assertions."
      : report.result === "ERROR" ? "Veriq could not complete the experiment correctly; collected observations are preserved."
      : "The available evidence is insufficient to establish all declared idempotency requirements.";
    return report;
  }
  async function capture(http: HttpConfiguration, phase: string, attempt = 1, signal = options.signal) {
    const captured = await captureHttpJson(http, { signal, fetch: options.fetch });
    report.observations.push({ phase, attempt, evidence: captured.evidence, responseFingerprint: phase === "sequential" || phase === "concurrent" ? fingerprint(captured) : null });
    if (captured.evidence.outcome === "execution-error") report.error ??= captured.evidence.error ?? { code: "JSON_EXECUTION_FAILED", message: "JSON execution failed." };
    return captured;
  }
  async function state(key: string, phase: string) {
    const { countPointer, ...http } = config.state;
    const captured = await capture({ ...http, target: http.target.replace("{key}", encodeURIComponent(key)) }, phase);
    const selected = selectJson(captured.value, countPointer);
    return captured.evidence.outcome === "response" && captured.evidence.status === http.expectedStatus && captured.evidence.durationMs <= http.maxDurationMs && selected.found && typeof selected.value === "number" && Number.isSafeInteger(selected.value) && selected.value >= 0 ? selected.value : null;
  }
  const stopped = () => Boolean(report.error || options.signal?.aborted);
  const stopReason = () => report.error ? "execution-error" as const : "cancelled" as const;
  function evaluate(captures: JsonCapture[], phase: "sequential" | "concurrent", requested: number) {
    const bad = captures.some(({ evidence }) => evidence.status !== null && evidence.status !== config.request.expectedStatus || evidence.outcome === "response" && evidence.durationMs > config.request.maxDurationMs);
    const all = captures.length === requested && captures.every(({ evidence }) => evidence.outcome === "response");
    assertion(`${phase}-responses`, bad ? false : all ? true : null);
    const hashes = captures.map(fingerprint), known = hashes.filter((hash) => hash !== null);
    assertion(`${phase}-replay`, new Set(known).size > 1 ? false : all && known.length === requested ? true : null);
  }
  const effect = (name: string, count: number | null, captures: JsonCapture[]) => assertion(name, count === null ? null : count === 1 ? true : count > 1 || captures.some(({ evidence }) => evidence.status === config.request.expectedStatus) ? false : null);
  try {
    if (stopped()) return finish(stopReason());
    for (const role of ["sequential", "concurrent"] as const) {
      const count = await state(report.keys[role], `${role}-baseline`);
      report.stateCounts[`${role}Baseline`] = count;
      assertion(`fresh-${role}-key`, count === 0 ? true : null);
      if (stopped()) return finish(stopReason());
      if (count !== 0) return finish("precondition");
    }
    const operation = (role: "sequential" | "concurrent") => ({ ...config.request, headers: { ...config.request.headers, "idempotency-key": report.keys[role] } });
    const sequential: JsonCapture[] = [];
    for (let index = 0; index < config.sequentialRequests; index++) {
      if (stopped()) break;
      report.completion.sequentialAttempted++;
      sequential.push(await capture(operation("sequential"), "sequential", index + 1));
    }
    evaluate(sequential, "sequential", config.sequentialRequests);
    if (stopped()) return finish(stopReason());
    report.stateCounts.afterSequential = await state(report.keys.sequential, "after-sequential");
    effect("sequential-effect", report.stateCounts.afterSequential, sequential);
    if (stopped()) return finish(stopReason());
    // A conflicting payload must not become the first accepted operation when
    // the original request never produced an observed effect.
    if (report.stateCounts.afterSequential !== null && report.stateCounts.afterSequential >= 1) {
      report.completion.conflictAttempted = true;
      report.conflict = await runHttpExperiment({ ...operation("sequential"), body: config.conflictBody, expectedStatus: config.conflictExpectedStatus }, options);
      if (report.conflict.result === "ERROR") report.error = { code: report.conflict.error?.code ?? "CONFLICT_EXECUTION_FAILED", message: report.conflict.error?.message ?? "Conflict request execution failed." };
      assertion("conflict-response", report.conflict.evidence?.outcome === "response" ? report.conflict.assertion.passed : null);
      if (stopped()) return finish(stopReason());
      report.stateCounts.afterConflict = await state(report.keys.sequential, "after-conflict");
      effect("conflict-effect", report.stateCounts.afterConflict, sequential);
      if (stopped()) return finish(stopReason());
    }
    const pool = await runBounded<JsonCapture | null>({
      count: config.concurrentRequests, concurrency: config.concurrency, signal: options.signal,
      action: (index, signal) => capture(operation("concurrent"), "concurrent", index + 1, signal),
      stopWhen: (captured) => captured === null || captured.evidence.outcome === "execution-error" || captured.evidence.outcome === "cancelled",
      onException: () => { report.error ??= { code: "IDEMPOTENCY_EXECUTION_FAILED", message: "An idempotency worker could not execute correctly." }; return null; },
    });
    report.completion.concurrentAttempted = pool.entries.length;
    report.completion.concurrentPeakInFlight = pool.peakInFlight;
    const concurrent = pool.entries.flatMap((entry) => entry.value ? [entry.value] : []);
    evaluate(concurrent, "concurrent", config.concurrentRequests);
    if (stopped()) return finish(stopReason());
    report.stateCounts.afterConcurrent = await state(report.keys.concurrent, "after-concurrent");
    effect("concurrent-effect", report.stateCounts.afterConcurrent, concurrent);
    return finish(stopped() ? stopReason() : "completed");
  } catch {
    report.error ??= { code: "IDEMPOTENCY_EXECUTION_FAILED", message: "Veriq could not execute the idempotency experiment correctly." };
    return finish("execution-error");
  }
}
