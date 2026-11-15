import { createServer } from "node:http";

export function createConcurrencyTarget({ delayMs = 40, capacity = 256 } = {}) {
  const metrics = { active: 0, peak: 0, received: 0, rejected: 0 };
  const server = createServer((request, response) => {
    if (request.url === "/metrics") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(metrics)); return; }
    if (request.url !== "/work") { response.writeHead(404); response.end(); return; }
    metrics.received++;
    if (metrics.active >= capacity) { metrics.rejected++; response.writeHead(503); response.end(); return; }
    metrics.active++; metrics.peak = Math.max(metrics.peak, metrics.active);
    let released = false;
    const release = () => { if (!released) { released = true; metrics.active--; } };
    const timer = setTimeout(() => { response.writeHead(200); response.end(); }, delayMs);
    response.on("finish", release);
    response.on("close", () => { clearTimeout(timer); release(); });
  });
  return { server, metrics };
}
