import { parseHttpConfiguration, redactUrl, type HttpConfiguration } from "./http-config.ts";
import type { HttpEvidence } from "./http-probe.ts";

export type TransportCategory = "dns" | "connection" | "tls" | "transport";
export type HttpObservation = HttpEvidence & {
  measurementBoundary: "response-headers";
  failure: { category: TransportCategory | "timeout" | "cancelled"; code: string | null } | null;
  cleanup: "no-body" | "body-cancelled" | "failed";
};

function transportFailure(cause: unknown): { category: TransportCategory; code: string | null } | null {
  const queue: unknown[] = [cause];
  const codes: string[] = [];
  for (let checked = 0; queue.length && checked < 16; checked++) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    const error = item as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)) codes.push(error.code);
    if (error.cause) queue.push(error.cause);
    if (Array.isArray(error.errors)) queue.push(...error.errors.slice(0, 8));
  }
  const dns = codes.find((code) => ["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code));
  if (dns) return { category: "dns", code: dns };
  const connection = codes.find((code) => ["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code));
  if (connection) return { category: "connection", code: connection };
  const tls = codes.find((code) => /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code));
  if (tls) return { category: "tls", code: tls };
  if (cause instanceof TypeError || codes.some((code) => code.startsWith("UND_ERR_"))) {
    return { category: "transport", code: codes[0] ?? null };
  }
  return null;
}

export async function observeHttp(
  input: HttpConfiguration,
  options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<HttpObservation> {
  const config = parseHttpConfiguration(input);
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let stopCause: "timeout" | "cancelled" | undefined;
  const stop = (reason: "timeout" | "cancelled") => {
    if (!controller.signal.aborted) {
      stopCause = reason;
      controller.abort(new DOMException(reason, "AbortError"));
    }
  };
  const onCancel = () => stop("cancelled");
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const timer = setTimeout(() => stop("timeout"), config.timeoutMs);
  options.signal?.addEventListener("abort", onCancel, { once: true });
  if (options.signal?.aborted) onCancel();
  let response: Response | null = null;
  let failure: HttpObservation["failure"] = null;
  let error: HttpEvidence["error"] = null;
  let cleanup: HttpObservation["cleanup"] = "no-body";
  try {
    try {
      controller.signal.throwIfAborted();
      response = await fetchRequest(config.target, {
        method: config.method, headers: config.headers, body: config.body,
        signal: controller.signal, redirect: "manual", credentials: "omit",
      });
    } catch (cause) {
      if (stopCause) {
        failure = { category: stopCause, code: null };
        error = {
          name: stopCause === "timeout" ? "TimeoutError" : "AbortError",
          message: stopCause === "timeout"
            ? `No response headers were received within ${config.timeoutMs} milliseconds.`
            : "Execution was cancelled before response headers were received.", cause: null,
        };
      } else {
        failure = transportFailure(cause);
        if (!failure) throw cause;
        error = {
          name: "TransportError", message: `HTTP request failed (${failure.category}).`,
          cause: failure.code ? { name: failure.code, message: "Runtime transport error code." } : null,
        };
      }
    }
    const durationMs = performance.now() - start;
    const endedAt = new Date().toISOString();
    // Later cancellation cannot rewrite a completed header observation.
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
    if (response?.body) {
      // Do not buffer bodies. Bound cleanup separately from header-arrival time.
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          response.body.cancel(),
          new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(() => reject(new Error("Body cleanup timed out")), 250);
          }),
        ]);
        cleanup = "body-cancelled";
      } catch {
        cleanup = "failed";
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
    const location = response?.headers.get("location");
    return {
      target: redactUrl(config.target), method: config.method, startedAt, endedAt, durationMs,
      timeoutMs: config.timeoutMs,
      outcome: response ? "response" : stopCause ?? "request-error",
      status: response?.status ?? null,
      contentType: response?.headers.get("content-type")?.slice(0, 256) ?? null,
      location: location ? redactUrl(location, config.target) : null,
      error, failure, cleanup, measurementBoundary: "response-headers",
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
    controller.abort();
  }
}
