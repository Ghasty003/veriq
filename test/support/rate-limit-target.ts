import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export type RateMode = "atomic" | "racy" | "global" | "sticky" | "deny-all" | "no-retry-after";
export function createRateLimitTarget(options: { mode?: RateMode; allowance?: number; windowMs?: number; responseDelayMs?: number } = {}) {
  const { mode = "atomic", allowance = 3, windowMs = 1000, responseDelayMs = 0 } = options;
  const buckets = new Map<string, { used: number; expires: number }>();
  const starts: { identity: string; time: number; status: number }[] = [];
  let active = 0, peak = 0;
  const server = createServer(async (request, response) => {
    const identity = String(request.headers["x-ratelimit-client"] ?? "missing");
    const key = mode === "global" ? "global" : identity;
    const now = performance.now();
    const old = buckets.get(key);
    const bucket = old && (mode === "sticky" || now < old.expires) ? old : { used: 0, expires: now + windowMs };
    const prior = bucket.used;
    const admitted = mode !== "deny-all" && prior < allowance;
    active++; peak = Math.max(peak, active);
    try {
      if (mode === "racy") await delay(25);
      if (admitted) { bucket.used = prior + 1; buckets.set(key, bucket); }
      const status = admitted ? 200 : 429;
      starts.push({ identity, time: now, status });
      if (responseDelayMs) await delay(responseDelayMs);
      if (!admitted && mode !== "no-retry-after") response.setHeader("Retry-After", String(Math.max(0, Math.ceil((bucket.expires - performance.now()) / 1000))));
      response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify({ admitted }));
    } finally { active--; }
  });
  return { server, starts, buckets, metrics: () => ({ active, peak }) };
}
