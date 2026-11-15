import { parseHttpConfiguration, redactUrl, type HttpConfiguration } from "./http-config.ts";
import { transportFailure } from "./http-observation.ts";

export type JsonEvidence = {
  target: string; method: string; startedAt: string; endedAt: string; durationMs: number;
  headersDurationMs: number | null; timeoutMs: number; status: number | null;
  measurementBoundary: "response-json"; responseBytes: number;
  outcome: "response" | "timeout" | "cancelled" | "request-error" | "invalid-json" | "body-limit" | "execution-error";
  error: { code: string; message: string } | null;
};
export type JsonCapture = { evidence: JsonEvidence; value?: unknown };

export async function captureHttpJson(input: HttpConfiguration, options: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<JsonCapture> {
  const config = parseHttpConfiguration(input);
  const controller = new AbortController();
  let stopCause: "timeout" | "cancelled" | undefined;
  const stop = (reason: "timeout" | "cancelled") => {
    if (!controller.signal.aborted) { stopCause = reason; controller.abort(); }
  };
  const cancel = () => stop("cancelled");
  const startedAt = new Date().toISOString(), start = performance.now();
  let endedAt = startedAt, durationMs = 0;
  let status: number | null = null, headersDurationMs: number | null = null, responseBytes = 0;
  let outcome: JsonEvidence["outcome"] = "execution-error", error: JsonEvidence["error"] = null, value: unknown;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let observedFailure: unknown;
  let hadObservedFailure = false;
  const timer = setTimeout(() => stop("timeout"), config.timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    controller.signal.throwIfAborted();
    response = await (options.fetch ?? fetch)(config.target, { method: config.method, headers: config.headers, body: config.body, signal: controller.signal, redirect: "manual", credentials: "omit" });
    status = response.status; headersDurationMs = performance.now() - start;
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    while (reader) {
      controller.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      responseBytes += chunk.value.byteLength;
      if (responseBytes > 65536) { outcome = "body-limit"; error = { code: "JSON_BODY_LIMIT", message: "Response JSON exceeds 64 KiB." }; break; }
      chunks.push(chunk.value);
    }
    if (outcome !== "body-limit") {
      controller.signal.throwIfAborted();
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        outcome = "response";
      } catch { outcome = "invalid-json"; error = { code: "INVALID_JSON", message: "Response is not valid UTF-8 JSON." }; }
    }
  } catch (cause) {
    observedFailure = cause;
    hadObservedFailure = true;
    if (stopCause) { outcome = stopCause; error = { code: stopCause.toUpperCase(), message: `JSON observation ${stopCause}.` }; }
    else {
      const failure = transportFailure(cause);
      outcome = failure ? "request-error" : "execution-error";
      error = { code: failure?.code ?? (failure ? "TRANSPORT_ERROR" : "JSON_EXECUTION_FAILED"), message: failure ? `JSON request failed (${failure.category}).` : "Veriq could not execute the JSON observation." };
    }
  } finally {
    endedAt = new Date().toISOString(); durationMs = performance.now() - start;
    clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
    controller.abort();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cleanup = reader ? reader.cancel() : response?.body?.cancel();
      if (cleanup) await Promise.race([cleanup, new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error()), 250); })]);
    } catch (cause) {
      // Cancelling an already errored stream rejects with its existing error.
      // An expected abort/transport termination is not a new cleanup failure.
      if (!(hadObservedFailure && cause === observedFailure) && !(cause instanceof Error && cause.name === "AbortError" && controller.signal.aborted)) {
        outcome = "execution-error"; error = { code: "JSON_CLEANUP_FAILED", message: "Veriq could not release the JSON response body." };
      }
    }
    finally {
      clearTimeout(cleanupTimer);
      try { reader?.releaseLock(); }
      catch { outcome = "execution-error"; error = { code: "JSON_CLEANUP_FAILED", message: "Veriq could not release the JSON reader." }; }
    }
  }
  return { evidence: { target: redactUrl(config.target), method: config.method, startedAt, endedAt, durationMs, headersDurationMs, timeoutMs: config.timeoutMs, status, measurementBoundary: "response-json", responseBytes, outcome, error }, ...(outcome === "response" ? { value } : {}) };
}
