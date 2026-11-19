import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseCacheConfiguration, type CacheEndpoint } from "./cache-config.ts";
import { captureHttpJson, type JsonEvidence } from "./http-json.ts";
import { jsonFingerprint, selectJson } from "./json-value.ts";
import { redactUrl } from "./http-config.ts";
import { runBounded } from "./bounded-workers.ts";
import type { RunResult } from "./http-experiment.ts";

type Action = "read" | "source" | "write" | "origin-write";
type Bucket = { name: string; caller: string; key: string };
export type CacheObservation = {
  sequence: number; phase: string; bucket: string; action: Action;
  startedElapsedMs: number; endedElapsedMs: number | null; evidence: JsonEvidence | null;
  valueFingerprint: string | null; sourceReads: number | null;
};
type Assertion = { name: string; passed: boolean | null; description: string };

export async function testHttpCache(input: unknown, options: { signal?: AbortSignal; fetch?: typeof fetch } = {}) {
  const config = parseCacheConfiguration(input), start = performance.now(), startedAt = new Date().toISOString();
  const elapsed = () => performance.now() - start;
  const controller = new AbortController();
  let cancelled = false, deadline = false, internalError = false, overran = false, peakInFlight = 0;
  const cancel = () => { cancelled = true; controller.abort(); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => { deadline = true; controller.abort(); }, config.deadlineMs);
  const observations: CacheObservation[] = [], waits: { phase: string; plannedMs: number; actualMs: number }[] = [];
  const preconditions: { bucket: string; fresh: boolean | null; seeded: boolean }[] = [];
  const lastSourceCounts = new Map<string, number>();
  const counterIssues: { bucket: string; sequence: number; previous: number; observed: number }[] = [];
  const unreliableCounters = new Set<string>();
  const counterDependencies = new Map<string, string[]>();
  const expectedValues: { bucket: string; initialFingerprint: string; updatedFingerprint: string | null }[] = [];
  const assertions: Assertion[] = [
    ["cold-value", "An uncached read returns the seeded source value."],
    ["cold-source-read", "The first cache read performs exactly one source read."],
    ["warm-values", "Reads inside the TTL retain the cached value after an out-of-band source update."],
    ["warm-source-reuse", "Warm requests perform no additional source reads inside the TTL."],
    ["expiry-value", "A read after expiry returns the updated source value."],
    ["expiry-source-refresh", "The first read after expiry performs one new source read."],
    ...(config.write ? [
      ["invalidation-value", "A read after an acknowledged normal write returns the new value."],
      ["invalidation-source-work", "The post-write read performs at most one source read, permitting write-through refresh."],
    ] : []),
    ["key-isolation", "Different keys under one caller return their own seeded values."],
    ["caller-isolation", "The same key under different callers returns each caller's own value."],
    ["isolation-source-reuse", "Each isolated bucket loads once and then reuses its own cache entry."],
    ["burst-values", "Every request in the expired-entry burst receives the updated source value."],
    ["burst-source-coalescing", "The entire expired-entry burst performs exactly one new source read."],
    ["read-responses", "All planned cache reads return the configured status and complete JSON within the duration requirement."],
  ].map(([name, description]) => ({ name, description, passed: null }));
  function set(name: string, passed: boolean | null) { assertions.find((a) => a.name === name)!.passed = passed; }
  function setCount(name: string, passed: boolean | null, buckets: string[]) {
    counterDependencies.set(name, buckets); set(name, passed);
  }
  function active() {
    if (!controller.signal.aborted && config.deadlineMs - elapsed() < 1) { deadline = true; controller.abort(); }
    return !controller.signal.aborted && !internalError;
  }
  function valid(record: CacheObservation | null, endpoint: CacheEndpoint) {
    return record !== null && record.evidence?.outcome === "response" && record.evidence.status === endpoint.expectedStatus && record.evidence.durationMs <= endpoint.maxDurationMs;
  }
  function matches(record: CacheObservation | null, expected: string): boolean | null {
    return record?.evidence?.outcome === "response" && record.valueFingerprint !== null ? record.valueFingerprint === jsonFingerprint(expected) : null;
  }
  function combine(values: (boolean | null)[]): boolean | null {
    return values.some((v) => v === false) ? false : values.every((v) => v === true) ? true : null;
  }
  async function capture(endpoint: CacheEndpoint, action: Action, bucket: Bucket, phase: string, value?: string, signal = controller.signal): Promise<CacheObservation | null> {
    if (!active() || signal.aborted) return null;
    const budget = Math.floor(Math.min(endpoint.timeoutMs, config.deadlineMs - elapsed()));
    if (budget < 1) { deadline = true; controller.abort(); return null; }
    const record: CacheObservation = { sequence: observations.length + 1, phase, bucket: bucket.name, action, startedElapsedMs: elapsed(), endedElapsedMs: null, evidence: null, valueFingerprint: null, sourceReads: null };
    observations.push(record);
    try {
      const result = await captureHttpJson({ ...endpoint,
        target: endpoint.target.replace("{caller}", encodeURIComponent(bucket.caller)).replace("{key}", encodeURIComponent(bucket.key)),
        ...(value === undefined ? {} : { body: JSON.stringify({ value }) }),
        timeoutMs: budget, maxDurationMs: Math.min(endpoint.maxDurationMs, budget),
      }, { signal, fetch: options.fetch });
      record.endedElapsedMs = elapsed(); record.evidence = result.evidence;
      if (result.evidence.outcome === "execution-error") internalError = true;
      if (result.evidence.outcome === "response" && (action === "read" || action === "source")) {
        const selection = selectJson(result.value, action === "read" ? config.valuePointer : config.sourceValuePointer);
        if (selection.found) { try { record.valueFingerprint = jsonFingerprint(selection.value); } catch { /* unsupported selection is unavailable evidence */ } }
        if (action === "source") {
          const count = selectJson(result.value, config.sourceReadsPointer);
          if (count.found && typeof count.value === "number" && Number.isSafeInteger(count.value) && count.value >= 0) {
            record.sourceReads = count.value;
            // Keep the raw snapshot in evidence, while making inconsistent deltas unavailable.
            const previous = valid(record, config.source) ? lastSourceCounts.get(bucket.name) : undefined;
            if (previous !== undefined && count.value < previous) {
              unreliableCounters.add(bucket.name);
              counterIssues.push({ bucket: bucket.name, sequence: record.sequence, previous, observed: count.value });
            }
            if (valid(record, config.source)) lastSourceCounts.set(bucket.name, count.value);
          }
        }
      }
    } catch { internalError = true; record.endedElapsedMs = elapsed(); }
    return record;
  }
  const read = (bucket: Bucket, phase: string, signal?: AbortSignal) => capture(config.read, "read", bucket, phase, undefined, signal);
  const source = (bucket: Bucket, phase: string) => capture(config.source, "source", bucket, phase);
  function state(record: CacheObservation | null, expected: string) {
    return record && !unreliableCounters.has(record.bucket) && valid(record, config.source) && matches(record, expected) === true ? record!.sourceReads : null;
  }
  function difference(before: number | null, after: number | null) {
    return before !== null && after !== null && after >= before ? after - before : null;
  }
  function countEquals(delta: number | null, expected: number): boolean | null { return delta === null ? null : delta === expected; }
  function inside(origin: number, records: (CacheObservation | null)[]) {
    const end = origin + config.ttlMs - config.windowGuardMs;
    const confirmed = records.every((r) => r !== null && r.endedElapsedMs !== null && r.endedElapsedMs <= end);
    if (!confirmed && records.some((r) => r?.endedElapsedMs !== null && r?.endedElapsedMs !== undefined && r.endedElapsedMs > end)) overran = true;
    return confirmed;
  }
  async function waitForExpiry(record: CacheObservation, phase: string) {
    const plannedMs = Math.max(0, record.endedElapsedMs! + config.ttlMs + config.expiryGraceMs - elapsed());
    if (!active()) return false;
    if (elapsed() + plannedMs >= config.deadlineMs) { deadline = true; controller.abort(); return false; }
    const waiting = elapsed();
    try {
      const until = waiting + plannedMs;
      while (active() && elapsed() < until) await delay(Math.max(1, Math.ceil(until - elapsed())), undefined, { signal: controller.signal });
    }
    catch { /* the abort owner records cancellation or deadline */ }
    waits.push({ phase, plannedMs, actualMs: elapsed() - waiting });
    return active();
  }
  async function seed(bucket: Bucket, value: string) {
    if (!active()) return null;
    const initial = await source(bucket, "precondition");
    const fresh = valid(initial, config.source) && initial!.valueFingerprint === jsonFingerprint(null) && initial!.sourceReads === 0;
    const precondition = { bucket: bucket.name, fresh: fresh ? true : null, seeded: false };
    preconditions.push(precondition);
    if (!fresh || !active()) return null;
    expectedValues.push({ bucket: bucket.name, initialFingerprint: jsonFingerprint(value), updatedFingerprint: null });
    const written = await capture(config.originWrite, "origin-write", bucket, "seed", value);
    if (!valid(written, config.originWrite) || !active()) return null;
    const confirmed = await source(bucket, "seed-confirmation");
    precondition.seeded = state(confirmed, value) === 0;
    return precondition.seeded ? confirmed : null;
  }
  async function updateOrigin(bucket: Bucket, value: string, phase: string) {
    if (!active()) return null;
    expectedValues.find((e) => e.bucket === bucket.name)!.updatedFingerprint = jsonFingerprint(value);
    const written = await capture(config.originWrite, "origin-write", bucket, phase, value);
    if (!valid(written, config.originWrite) || !active()) return null;
    const confirmed = await source(bucket, `${phase}-confirmation`);
    return state(confirmed, value) !== null ? confirmed : null;
  }
  const callerA = randomUUID(), callerB = randomUUID();
  const bucket = (name: string, caller = callerA, key = randomUUID()): Bucket => ({ name, caller, key });
  try {
    // Retention and expiry share one key; an out-of-band write deliberately leaves its cache alone.
    const ttl = bucket("ttl"), oldValue = randomUUID(), newValue = randomUUID();
    const seeded = await seed(ttl, oldValue);
    if (seeded && active()) {
      const first = await read(ttl, "cold");
      const loaded = await source(ttl, "after-cold");
      set("cold-value", matches(first, oldValue));
      setCount("cold-source-read", countEquals(difference(seeded.sourceReads, state(loaded, oldValue)), 1), [ttl.name]);
      if (valid(first, config.read) && matches(first, oldValue) === true && active()) {
        const changed = await updateOrigin(ttl, newValue, "out-of-band-update");
        if (changed && active()) {
          const hits: (CacheObservation | null)[] = [];
          for (let i = 0; i < config.hitRequests && active(); i++) hits.push(await read(ttl, "warm"));
          const afterHits = await source(ttl, "after-warm");
          const inWindow = inside(first!.startedElapsedMs, [...hits, afterHits]);
          const warmValues = hits.map((r) => inside(first!.startedElapsedMs, [r]) ? matches(r, oldValue) : null);
          set("warm-values", warmValues.some((v) => v === false) ? false : hits.length === config.hitRequests ? combine(warmValues) : null);
          setCount("warm-source-reuse", inWindow ? countEquals(difference(state(changed, newValue), state(afterHits, newValue)), 0) : null, [ttl.name]);
          if (active() && await waitForExpiry(first!, "ttl-expiry")) {
            const expired = await read(ttl, "expired");
            const afterExpiry = await source(ttl, "after-expiry");
            set("expiry-value", matches(expired, newValue));
            setCount("expiry-source-refresh", inWindow && hits.every((r) => valid(r, config.read)) && difference(state(changed, newValue), state(afterHits, newValue)) === 0
              ? countEquals(difference(state(afterHits, newValue), state(afterExpiry, newValue)), 1) : null, [ttl.name]);
          }
        }
      }
    }
    if (config.write && active()) {
      const entry = bucket("invalidation"), beforeValue = randomUUID(), afterValue = randomUUID();
      if (await seed(entry, beforeValue) && active()) {
        const first = await read(entry, "invalidation-warm");
        if (valid(first, config.read) && matches(first, beforeValue) === true && active()) {
          expectedValues.find((e) => e.bucket === entry.name)!.updatedFingerprint = jsonFingerprint(afterValue);
          const written = await capture(config.write, "write", entry, "normal-update", afterValue);
          if (valid(written, config.write) && active()) {
            const before = await source(entry, "after-write");
            if (state(before, afterValue) !== null && active()) {
              const fresh = await read(entry, "invalidation-read");
              const after = await source(entry, "after-invalidation-read");
              // Invalidation must be tested while the previous entry would still be live.
              const inWindow = inside(first!.startedElapsedMs, [written, fresh, after]);
              set("invalidation-value", inside(first!.startedElapsedMs, [written, fresh]) ? matches(fresh, afterValue) : null);
              const delta = difference(state(before, afterValue), state(after, afterValue));
              setCount("invalidation-source-work", inWindow && delta !== null ? delta <= 1 : null, [entry.name]);
            }
          }
        }
      }
    }
    if (active()) {
      const key = randomUUID();
      const isolated = [bucket("isolation-first", callerA, key), bucket("isolation-key", callerA), bucket("isolation-caller", callerB, key)];
      const values = isolated.map(() => randomUUID());
      // Validate every resource before filling any cache bucket.
      const seeds: (CacheObservation | null)[] = [];
      for (let i = 0; i < isolated.length && active(); i++) seeds.push(await seed(isolated[i], values[i]));
      if (seeds.length === 3 && seeds.every((s) => s !== null) && active()) {
        const cold: (CacheObservation | null)[] = [], coldStates: (CacheObservation | null)[] = [], warm: (CacheObservation | null)[] = [], warmStates: (CacheObservation | null)[] = [];
        for (const entry of isolated) { cold.push(await read(entry, "isolation-cold")); coldStates.push(await source(entry, "isolation-after-cold")); }
        for (const entry of isolated) { warm.push(await read(entry, "isolation-warm")); warmStates.push(await source(entry, "isolation-after-warm")); }
        set("key-isolation", combine([matches(cold[0], values[0]), matches(cold[1], values[1]), matches(warm[0], values[0]), matches(warm[1], values[1])]));
        set("caller-isolation", combine([matches(cold[0], values[0]), matches(cold[2], values[2]), matches(warm[0], values[0]), matches(warm[2], values[2])]));
        setCount("isolation-source-reuse", combine(isolated.map((_, i) => cold[i] && inside(cold[i]!.startedElapsedMs, [coldStates[i], warm[i], warmStates[i]]) ? combine([
          countEquals(difference(seeds[i]!.sourceReads, state(coldStates[i], values[i])), 1),
          countEquals(difference(state(coldStates[i], values[i]), state(warmStates[i], values[i])), 0),
        ]) : null)), isolated.map((b) => b.name));
      }
    }
    if (active()) {
      const entry = bucket("burst"), oldValue = randomUUID(), newValue = randomUUID();
      if (await seed(entry, oldValue) && active()) {
        const first = await read(entry, "burst-warm");
        if (valid(first, config.read) && matches(first, oldValue) === true && active()) {
          const changed = await updateOrigin(entry, newValue, "burst-origin-update");
          if (changed && active() && await waitForExpiry(first!, "burst-expiry")) {
            const origin = elapsed();
            const pool = await runBounded<CacheObservation | null>({ count: config.burstRequests, concurrency: config.concurrency, signal: controller.signal,
              action: (_, signal) => read(entry, "burst", signal),
              stopWhen: (r) => r === null || internalError || r.evidence?.outcome === "cancelled",
              onException: () => { internalError = true; return null; },
            });
            peakInFlight = pool.peakInFlight;
            const records = pool.entries.map((e) => e.value);
            const after = await source(entry, "after-burst");
            const verdicts = records.map((r) => matches(r, newValue));
            set("burst-values", verdicts.some((v) => v === false) ? false : records.length === config.burstRequests ? combine(verdicts) : null);
            const delta = difference(state(changed, newValue), state(after, newValue));
            const inWindow = inside(origin, [after]);
            setCount("burst-source-coalescing", inWindow && delta !== null && delta > 1 ? false
              : records.length === config.burstRequests && records.every((r) => valid(r, config.read)) && inside(origin, [...records, after]) ? countEquals(delta, 1) : null, [entry.name]);
          }
        }
      }
    }
  } catch { internalError = true; }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); controller.abort(); }
  const reads = observations.filter((o) => o.action === "read");
  const plannedReads = config.hitRequests + config.burstRequests + 9 + (config.write ? 2 : 0);
  set("read-responses", reads.some((r) => r.evidence && (r.evidence.status !== null && r.evidence.status !== config.read.expectedStatus || r.evidence.outcome === "response" && r.evidence.durationMs > config.read.maxDurationMs)) ? false : reads.length === plannedReads && reads.every((r) => valid(r, config.read)) ? true : null);
  for (const [name, buckets] of counterDependencies) {
    if (buckets.some((bucket) => unreliableCounters.has(bucket))) set(name, null);
  }
  const result: RunResult = internalError ? "ERROR" : assertions.some((a) => a.passed === false) ? "FAIL" : assertions.every((a) => a.passed === true) ? "PASS" : "INCONCLUSIVE";
  const endpointSummary = (endpoint: CacheEndpoint) => ({ target: redactUrl(endpoint.target.replace("{caller}", "run-caller").replace("{key}", "run-key")), method: endpoint.method, expectedStatus: endpoint.expectedStatus, timeoutMs: endpoint.timeoutMs, maxDurationMs: endpoint.maxDurationMs });
  return {
    schemaVersion: 1, experiment: "http-cache", runId: randomUUID(), startedAt, endedAt: new Date().toISOString(), durationMs: elapsed(),
    configuration: { ...config, read: endpointSummary(config.read), source: endpointSummary(config.source), originWrite: endpointSummary(config.originWrite), write: config.write ? endpointSummary(config.write) : undefined },
    completion: { reason: internalError ? "execution-error" : cancelled ? "cancelled" : deadline ? "deadline" : overran ? "ttl-window-overrun" : preconditions.some((p) => !p.seeded) ? "precondition" : assertions.some((a) => a.passed === null) ? "insufficient-evidence" : "completed", cancelled },
    plannedReads, attemptedReads: reads.length, peakInFlight, preconditions, expectedValues, counterIssues, waits, observations, assertions, result,
    finding: result === "PASS" ? "Observed cache reuse, expiry, isolation and coalesced refresh met the declared requirements." : result === "FAIL" ? "Observed behavior violated at least one declared cache requirement." : result === "ERROR" ? "Veriq could not execute the cache experiment correctly." : "Available evidence does not establish every declared cache requirement.",
    error: internalError ? { code: "CACHE_EXECUTION_FAILED", message: "Veriq could not execute or clean up a cache observation correctly." } : null,
  };
}
export type CacheReport = Awaited<ReturnType<typeof testHttpCache>>;
