import { createServer } from "node:http";

export type TargetEvent = {
  event: "request" | "body-received" | "closed";
  path: string;
  method: string;
  bodyBytes?: number;
  headerNames?: string[];
};

// Controlled HTTP behavior for integration experiments, not business logic.
export function createHttpTarget(
  onEvent: (event: TargetEvent) => void = () => {},
  sequenceDelaysMs: readonly number[] = [0, 0, 350, 0, 0],
) {
  if (!sequenceDelaysMs.length || sequenceDelaysMs.some((ms) => !Number.isInteger(ms) || ms < 0 || ms > 5000)) {
    throw new Error("Sequence delays must be integers from 0 to 5000 milliseconds.");
  }
  let sequenceIndex = 0;
  return createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 16384 }, async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    const path = url.pathname;
    const method = request.method ?? "GET";
    onEvent({ event: "request", path, method, headerNames: Object.keys(request.headers) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stream: ReturnType<typeof setInterval> | undefined;
    response.on("close", () => {
      clearTimeout(timer);
      clearInterval(stream);
      onEvent({ event: "closed", path, method });
    });
    response.on("error", () => response.destroy());
    if (path === "/hang") return; // Intentionally withhold headers until caller cancels.
    if (path === "/reset") { request.socket.destroy(); return; }
    if (path === "/redirect") {
      response.writeHead(302, { location: "/health?token=fixture-secret" });
      response.end();
      return;
    }
    if (path === "/stream") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("headers are available; the body has not completed\n");
      stream = setInterval(() => response.write("more\n"), 25);
      return;
    }
    if (path === "/delay") {
      const delay = Number(url.searchParams.get("ms") ?? 500);
      if (!Number.isInteger(delay) || delay < 0 || delay > 5000) {
        response.writeHead(400); response.end(); return;
      }
      timer = setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ delayedByMs: delay }));
      }, delay);
      return;
    }
    if (path === "/sequence") {
      const delay = sequenceDelaysMs[sequenceIndex++ % sequenceDelaysMs.length];
      timer = setTimeout(() => { response.writeHead(200); response.end(); }, delay);
      return;
    }
    if (path === "/echo") {
      let bodyBytes = 0;
      try {
        for await (const chunk of request) {
          bodyBytes += chunk.length;
          if (bodyBytes > 1048576) { response.writeHead(413); response.end(); return; }
        }
        onEvent({ event: "body-received", path, method, bodyBytes });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ method, bodyBytes }));
      } catch { response.destroy(); }
      return;
    }
    response.writeHead(path === "/health" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: path === "/health" ? "ready" : "not-found" }));
  });
}

