import { parseHttpConfiguration } from "./http-config.ts";
import { observeHttp } from "./http-observation.ts";

export type HttpEvidence = {
  target: string;
  method: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  timeoutMs: number;
  outcome: "response" | "timeout" | "request-error" | "cancelled";
  status: number | null;
  contentType: string | null;
  location: string | null;
  error: {
    name: string;
    message: string;
    cause: { name: string; message: string } | null;
  } | null;
};

// Compatibility entry point: probe and latency share the configured run lifecycle.
export async function probeHttp(target: string, timeoutMs = 2000): Promise<HttpEvidence> {
  const observation = await observeHttp(parseHttpConfiguration({ target, timeoutMs }));
  if (observation.cleanup === "failed") throw new Error("HTTP response resource cleanup failed.");
  return observation;
}
