import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export function createIdempotencyTarget(options: {
  mode?: "atomic" | "naive" | "racy"; unavailableState?: boolean; invalidState?: boolean;
  malformedResponse?: boolean; oversizedResponse?: boolean; stalledResponse?: boolean;
  loseFirstResponse?: boolean; unstableResponse?: boolean; delayMs?: number;
} = {}) {
  const mode = options.mode ?? "atomic";
  const effects = new Map<string, unknown[]>();
  const cache = new Map<string, { body: string; reply: Promise<unknown> }>();
  const metrics = { operations: 0, active: 0, peak: 0 };
  let nextId = 1;
  const pending = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.method === "GET" && request.url?.startsWith("/effects/")) {
      if (options.unavailableState) { send(503, { error: "unavailable" }); return; }
      const key = decodeURIComponent(request.url.slice("/effects/".length));
      send(200, options.invalidState ? { unknown: true } : { effectCount: effects.get(key)?.length ?? 0 });
      return;
    }
    if (request.method !== "POST" || request.url !== "/operations") { send(404, {}); return; }
    metrics.operations++;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string") { send(400, {}); return; }
    let body = "";
    for await (const chunk of request) { body += chunk; if (body.length > 4096) { send(413, {}); return; } }
    const existing = cache.get(key);
    if (mode !== "naive" && existing && existing.body !== body) { send(409, { error: "key-conflict" }); return; }
    metrics.active++; metrics.peak = Math.max(metrics.peak, metrics.active);
    let created = false;
    try {
      let reply: Promise<unknown>;
      if (mode !== "naive" && existing) reply = existing.reply;
      else {
        created = true;
        const controller = new AbortController(); pending.add(controller);
        reply = (async () => {
          try {
            await delay(options.delayMs ?? 20, undefined, { signal: controller.signal });
            const value = { operationId: `operation-${nextId++}` };
            effects.set(key, [...(effects.get(key) ?? []), value]);
            return value;
          } finally { pending.delete(controller); }
        })();
        if (mode === "atomic") cache.set(key, { body, reply });
      }
      const value = await reply;
      if (mode === "racy" && created) cache.set(key, { body, reply });
      if (created && options.loseFirstResponse) { response.destroy(); return; }
      if (options.stalledResponse) { response.writeHead(201); response.write("{"); return; }
      if (options.malformedResponse) { response.writeHead(201); response.end("bad json"); return; }
      if (options.oversizedResponse) { response.writeHead(201); response.end(JSON.stringify({ oversized: "x".repeat(70000) })); return; }
      send(201, options.unstableResponse ? { operationId: `reply-${nextId++}` } : value);
    } catch { if (!response.destroyed) send(503, { error: "target-stopped" }); }
    finally { metrics.active--; }
  });
  server.on("close", () => { for (const controller of pending) controller.abort(); });
  return { server, effects, metrics };
}
