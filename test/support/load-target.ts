import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export type LoadMode = "queue" | "unbounded" | "reject" | "sticky";
export function createLoadTarget(options: { mode?: LoadMode; capacity?: number; serviceMs?: number; maxQueue?: number; overloadAt?: number; stickyServiceMs?: number } = {}) {
  const { mode = "queue", capacity = 2, serviceMs = 25, maxQueue = 32, overloadAt = 4, stickyServiceMs = 120 } = options;
  const metrics = { received: 0, active: 0, queued: 0, peakActive: 0, peakQueued: 0, completed: 0, rejected: 0, failed: 0, degraded: false, clientClosed: 0 };
  const arrivals: { method: string; url: string; authorization: string | undefined; body: string; time: number }[] = [];
  const queue: ServerResponse[] = [], pending = new Set<AbortController>();
  const send = (response: ServerResponse, status: number) => { if (!response.destroyed) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ status })); } };
  async function run(response: ServerResponse) {
    metrics.active++; metrics.peakActive = Math.max(metrics.peakActive, metrics.active);
    const controller = new AbortController(); pending.add(controller);
    try {
      await delay(mode === "sticky" && metrics.degraded ? stickyServiceMs : serviceMs, undefined, { signal: controller.signal });
      metrics.completed++; send(response, 200);
    } catch { metrics.failed++; send(response, 503); }
    finally {
      pending.delete(controller); metrics.active--;
      if (queue.length) { const next = queue.shift()!; metrics.queued = queue.length; void run(next); }
    }
  }
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 4096) { send(response, 413); return; } }
    arrivals.push({ method: request.method ?? "GET", url: request.url ?? "/", authorization: request.headers.authorization, body, time: performance.now() });
    metrics.received++;
    response.on("close", () => { if (!response.writableFinished) metrics.clientClosed++; });
    if (mode === "sticky" && metrics.active + queue.length + 1 >= overloadAt) metrics.degraded = true;
    if (mode === "unbounded" || metrics.active < capacity) void run(response);
    else if (mode === "reject" || queue.length >= maxQueue) { metrics.rejected++; send(response, 503); }
    else { queue.push(response); metrics.queued = queue.length; metrics.peakQueued = Math.max(metrics.peakQueued, queue.length); }
  });
  function stopWork() { queue.length = 0; metrics.queued = 0; for (const controller of pending) controller.abort(); }
  server.on("close", stopWork);
  return { server, metrics, arrivals, stopWork };
}
