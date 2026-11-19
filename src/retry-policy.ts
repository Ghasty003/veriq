import { ConfigurationError, parseHttpConfiguration, type HttpConfiguration } from "./http-config.ts";
import { validatePointer } from "./json-value.ts";
import type { HttpObservation } from "./http-observation.ts";

export type RetryPolicy = {
  maxAttempts: number; deadlineMs: number; baseDelayMs: number; maxDelayMs: number;
  jitter: "full" | "none"; retryableStatuses: number[];
  retryOnTimeout: boolean; retryOnTransportErrors: boolean;
};
export type RetryConfiguration = {
  request: HttpConfiguration; policy: RetryPolicy; retrySafety: "read-only" | "idempotency-key";
  state?: HttpConfiguration & { countPointer: string };
};

export function parseRetryConfiguration(input: unknown): RetryConfiguration {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigurationError("Retry configuration must be an object.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["request", "policy", "retrySafety", "state"].includes(key))) throw new ConfigurationError("Unknown retry configuration field.");
  const request = parseHttpConfiguration(value.request);
  if (request.expectedStatus < 200 || request.expectedStatus > 299) throw new ConfigurationError("Retry recovery must require a successful 2xx status.");
  const safe = ["GET", "HEAD", "OPTIONS"].includes(request.method);
  const retrySafety = value.retrySafety === undefined ? safe ? "read-only" : undefined : value.retrySafety;
  if (retrySafety !== "read-only" && retrySafety !== "idempotency-key" || safe && retrySafety !== "read-only" || !safe && retrySafety !== "idempotency-key") {
    throw new ConfigurationError("Mutating requests require explicit retrySafety: idempotency-key; GET/HEAD/OPTIONS use read-only.");
  }
  if (Object.hasOwn(request.headers, "idempotency-key")) throw new ConfigurationError("Veriq generates one fresh key reused across write attempts; do not configure Idempotency-Key.");
  let state: RetryConfiguration["state"];
  if (!safe) {
    if (!value.state || typeof value.state !== "object" || Array.isArray(value.state)) throw new ConfigurationError("Mutating retries require a declared state count API.");
    const { countPointer = "/effectCount", ...raw } = value.state as Record<string, unknown>;
    if (typeof raw.target !== "string" || raw.target.split("{key}").length !== 2) throw new ConfigurationError("state.target requires exactly one {key} placeholder.");
    const http = parseHttpConfiguration({ ...raw, target: raw.target.replace("{key}", "validation-key") });
    if (http.method !== "GET" || http.body !== undefined || http.expectedStatus < 200 || http.expectedStatus > 299 || [204, 205].includes(http.expectedStatus)) throw new ConfigurationError("state must be a GET endpoint returning successful JSON.");
    state = { ...http, target: raw.target, countPointer: validatePointer(countPointer) };
  } else if (value.state !== undefined) throw new ConfigurationError("State verification applies to idempotency-key writes, not read-only requests.");
  const raw = value.policy === undefined ? {} : value.policy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigurationError("policy must be an object.");
  const settings = raw as Record<string, unknown>;
  const keys = ["maxAttempts", "deadlineMs", "baseDelayMs", "maxDelayMs", "jitter", "retryableStatuses", "retryOnTimeout", "retryOnTransportErrors"];
  if (Object.keys(settings).some((key) => !keys.includes(key))) throw new ConfigurationError("Unknown retry policy field.");
  function integer(name: string, fallback: number, min: number, max: number) {
    const value = settings[name] === undefined ? fallback : settings[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ConfigurationError(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  }
  function boolean(name: string) {
    const value = settings[name] === undefined ? true : settings[name];
    if (typeof value !== "boolean") throw new ConfigurationError(`${name} must be boolean.`);
    return value;
  }
  const jitter = settings.jitter === undefined ? "full" : settings.jitter;
  if (jitter !== "full" && jitter !== "none") throw new ConfigurationError("jitter must be full or none.");
  const statuses = settings.retryableStatuses === undefined ? [408, 429, 502, 503, 504] : settings.retryableStatuses;
  if (!Array.isArray(statuses) || statuses.length > 32 || statuses.some((status) => !Number.isInteger(status) || status < 400 || status > 599) || new Set(statuses).size !== statuses.length) throw new ConfigurationError("retryableStatuses must contain up to 32 distinct 4xx/5xx status numbers.");
  const baseDelayMs = integer("baseDelayMs", 100, 0, 60000), maxDelayMs = integer("maxDelayMs", 2000, 0, 60000);
  if (maxDelayMs < baseDelayMs) throw new ConfigurationError("maxDelayMs must be at least baseDelayMs.");
  return { request, retrySafety, state, policy: {
    maxAttempts: integer("maxAttempts", 3, 1, 100), deadlineMs: integer("deadlineMs", 10000, 1, 2147483647),
    baseDelayMs, maxDelayMs, jitter, retryableStatuses: [...statuses],
    retryOnTimeout: boolean("retryOnTimeout"), retryOnTransportErrors: boolean("retryOnTransportErrors"),
  } };
}

export function backoffDelay(policy: RetryPolicy, retryIndex: number, random = Math.random) {
  const capMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retryIndex);
  if (policy.jitter === "none") return { capMs, delayMs: capMs };
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("Invalid random source.");
  return { capMs, delayMs: Math.floor(value * (capMs + 1)) };
}

export function retryAfterDelay(value: string | null, wallNow = Date.now()): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number.MAX_SAFE_INTEGER, Number(text) * 1000);
  // HTTP-date includes the modern form and two obsolete forms that recipients
  // must still accept. RFC 850's two-digit year uses a rolling 50-year window.
  const modern = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i.exec(text);
  const rfc850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/i.exec(text);
  const asctime = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Za-z]{3}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i.exec(text);
  const parts = modern ?? rfc850;
  if (!parts && !asctime) return null;
  const day = Number(parts ? parts[2] : asctime![3]);
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf((parts ? parts[3] : asctime![2]).toLowerCase());
  let year = Number(parts ? parts[4] : asctime![7]);
  if (rfc850) year += Math.floor(new Date(wallNow).getUTCFullYear() / 100) * 100;
  const hour = Number(parts ? parts[5] : asctime![4]), minute = Number(parts ? parts[6] : asctime![5]), second = Number(parts ? parts[7] : asctime![6]);
  if (month < 0 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0); date.setUTCFullYear(year, month, day); date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  if (rfc850) {
    const future = new Date(wallNow); future.setUTCFullYear(future.getUTCFullYear() + 50);
    if (date.getTime() > future.getTime()) { year -= 100; date.setUTCFullYear(year); }
  }
  return Math.max(0, date.getTime() - wallNow);
}

export function retryDecision(evidence: HttpObservation, policy: RetryPolicy): { retryable: boolean; category: string } {
  if (evidence.outcome === "response") return { retryable: policy.retryableStatuses.includes(evidence.status!), category: `http-${evidence.status}` };
  if (evidence.outcome === "timeout") return { retryable: policy.retryOnTimeout, category: "attempt-timeout" };
  const transient = new Set(["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
  return { retryable: evidence.outcome === "request-error" && policy.retryOnTransportErrors && transient.has(evidence.failure?.code ?? ""), category: evidence.failure?.code ?? evidence.outcome };
}
