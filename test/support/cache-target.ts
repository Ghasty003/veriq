import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export type CacheMode = "single-flight" | "no-cache" | "never-expire" | "no-invalidation" | "shared-key" | "shared-entry" | "stampede" | "write-through";
export function cacheConfiguration(base: string, ttlMs = 700) {
  return {
    read: { target: `${base}/cache/{caller}/{key}`, timeoutMs: 1500, maxDurationMs: 1000 },
    source: { target: `${base}/source/{caller}/{key}` },
    originWrite: { target: `${base}/origin/{caller}/{key}` },
    write: { target: `${base}/source/{caller}/{key}` },
    ttlMs, expiryGraceMs: 30, deadlineMs: 5500,
  };
}
export function createCacheTarget(options: {
  mode?: CacheMode; ttlMs?: number; sourceDelayMs?: number; hitDelayMs?: number;
  unavailableSource?: boolean; invalidCounts?: boolean; malformedReads?: boolean;
  oversizedReads?: boolean; stalledReads?: boolean; stalledReadsAfter?: number; readStatus?: number;
  invalidateCounter?: boolean; resetCounterOnOriginWrite?: boolean;
} = {}) {
  const mode = options.mode ?? "single-flight", ttlMs = options.ttlMs ?? 700;
  const sources = new Map<string, { value: string | null; reads: number }>();
  const cache = new Map<string, { value: string | null; expires: number }>();
  const flights = new Map<string, Promise<string | null>>();
  const epochs = new Map<string, object>();
  const pending = new Set<AbortController>();
  const metrics = { cacheRequests: 0, sourceLoads: 0, activeLoads: 0, peakLoads: 0, joined: 0 };
  const events: { action: string; caller: string; key: string; value: string | null; time: number }[] = [];
  const sourceKey = (caller: string, key: string) => JSON.stringify([caller, key]);
  const cacheKey = (caller: string, key: string) => mode === "shared-entry" ? "all" : mode === "shared-key" ? key : sourceKey(caller, key);
  function source(caller: string, key: string) {
    const id = sourceKey(caller, key);
    let record = sources.get(id);
    if (!record) { record = { value: null, reads: 0 }; sources.set(id, record); }
    return record;
  }
  async function load(caller: string, key: string, id: string) {
    const state = source(caller, key), value = state.value;
    state.reads++; metrics.sourceLoads++; metrics.activeLoads++; metrics.peakLoads = Math.max(metrics.peakLoads, metrics.activeLoads);
    const epoch = epochs.get(id) ?? {}; epochs.set(id, epoch);
    const controller = new AbortController(); pending.add(controller);
    try {
      await delay(options.sourceDelayMs ?? 35, undefined, { signal: controller.signal });
      if (mode !== "no-cache" && epochs.get(id) === epoch) cache.set(id, { value, expires: performance.now() + ttlMs });
      return value;
    } finally { pending.delete(controller); metrics.activeLoads--; }
  }
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => { if (!response.destroyed) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); } };
    try {
      const parts = new URL(request.url ?? "/", "http://fixture").pathname.split("/").slice(1).map(decodeURIComponent);
      if (parts.length !== 3 || !["cache", "source", "origin"].includes(parts[0])) { send(404, {}); return; }
      const [path, caller, key] = parts;
      const state = source(caller, key), id = cacheKey(caller, key);
      events.push({ action: `${request.method}:${path}`, caller, key, value: state.value, time: performance.now() });
      if (request.method === "GET" && path === "source") {
        if (options.unavailableSource) { send(503, {}); return; }
        send(200, { value: state.value, reads: options.invalidCounts ? "invalid" : options.invalidateCounter && state.reads > 1 ? 0 : state.reads }); return;
      }
      if (request.method === "PUT" && path !== "cache") {
        let text = "";
        for await (const chunk of request) { text += chunk; if (text.length > 4096) { send(413, {}); return; } }
        const body = JSON.parse(text);
        if (typeof body.value !== "string") { send(400, {}); return; }
        state.value = body.value;
        if (path === "origin" && options.resetCounterOnOriginWrite) state.reads = 0;
        if (path === "source" && mode !== "no-invalidation") {
          epochs.set(id, {}); cache.delete(id); flights.delete(id);
          if (mode === "write-through") cache.set(id, { value: body.value, expires: performance.now() + ttlMs });
        }
        send(200, { ok: true }); return;
      }
      if (request.method !== "GET" || path !== "cache") { send(404, {}); return; }
      metrics.cacheRequests++;
      const cached = mode === "no-cache" ? undefined : cache.get(id);
      let value: string | null;
      if (cached && (mode === "never-expire" || performance.now() < cached.expires)) {
        if (options.hitDelayMs) await delay(options.hitDelayMs);
        value = cached.value;
      } else {
        const previous = mode === "stampede" || mode === "no-cache" ? undefined : flights.get(id);
        if (previous) { metrics.joined++; value = await previous; }
        else {
          const promise = load(caller, key, id);
          if (mode !== "stampede" && mode !== "no-cache") flights.set(id, promise);
          try { value = await promise; } finally { if (flights.get(id) === promise) flights.delete(id); }
        }
      }
      if (options.stalledReads || options.stalledReadsAfter !== undefined && metrics.cacheRequests > options.stalledReadsAfter) { response.writeHead(200); response.write("{"); return; }
      if (options.malformedReads) { response.writeHead(200); response.end("bad JSON"); return; }
      send(options.readStatus ?? 200, options.oversizedReads ? { value, large: "x".repeat(70000) } : { value });
    } catch { send(503, { error: "target-failure" }); }
  });
  server.on("close", () => { for (const controller of pending) controller.abort(); });
  return { server, sources, cache, events, metrics };
}
