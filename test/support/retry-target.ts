import { createServer } from "node:http";

export function createRetryTarget({ deduplicate = true, failures = 2, missingState = false } = {}) {
  const attempts: Record<string, number> = {};
  const effects = new Map<string, number>();
  const writeAttempts = new Map<string, number>();
  const keys: string[] = [];
  const starts: Record<string, number[]> = {};
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const send = (status: number, value: unknown = {}) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (path.startsWith("/effects/")) {
      const key = path.slice(9); send(200, missingState ? { missing: true } : { effectCount: effects.get(key) ?? 0 }); return;
    }
    attempts[path] = (attempts[path] ?? 0) + 1;
    (starts[path] ??= []).push(performance.now());
    if (path === "/hang") return;
    if (path === "/slow") { const timer = setTimeout(() => send(200), 500); response.on("close", () => clearTimeout(timer)); return; }
    if (path === "/permanent") { send(400); return; }
    if (path === "/always") { send(503); return; }
    if (path === "/flaky") { send(attempts[path] <= failures ? 503 : 200); return; }
    if (path === "/rate") {
      if (attempts[path] === 1) response.setHeader("retry-after", "1");
      send(attempts[path] === 1 ? 429 : 200); return;
    }
    if (path === "/operations" && request.method === "POST") {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") { send(400); return; }
      let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) { send(413); return; } }
      keys.push(key);
      const attempt = (writeAttempts.get(key) ?? 0) + 1; writeAttempts.set(key, attempt);
      if (!deduplicate || !effects.has(key)) effects.set(key, (effects.get(key) ?? 0) + 1);
      if (attempt === 1) { response.destroy(); return; }
      send(201, { operationId: key }); return;
    }
    send(404);
  });
  return { server, attempts, effects, keys, starts };
}
