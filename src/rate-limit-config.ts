import { ConfigurationError, parseHttpConfiguration } from "./http-config.ts";

/** A fresh caller's fixed window begins with its first request. */
export function parseRateLimitConfiguration(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigurationError("Rate-limit configuration must be an object.");
  const raw = input as Record<string, unknown>;
  const allowed = ["request", "algorithm", "identityHeader", "allowance", "excessRequests", "windowMs", "windowGuardMs", "resetGraceMs", "concurrency", "deadlineMs", "rejectedStatus", "requireRetryAfter"];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new ConfigurationError("Unknown rate-limit configuration field.");
  if (raw.algorithm !== undefined && raw.algorithm !== "anchored-fixed-window") throw new ConfigurationError("algorithm must be anchored-fixed-window.");
  const request = parseHttpConfiguration(raw.request);
  if (request.expectedStatus > 299) throw new ConfigurationError("Accepted requests must require a 2xx status.");
  function integer(name: string, fallback: number, min: number, max: number): number {
    const value = raw[name] === undefined ? fallback : raw[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ConfigurationError(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  }
  const windowMs = integer("windowMs", 1000, 100, 60000);
  const identityHeader = raw.identityHeader === undefined ? "x-ratelimit-client" : raw.identityHeader;
  if (typeof identityHeader !== "string" || !identityHeader || Object.hasOwn(request.headers, identityHeader.toLowerCase())) throw new ConfigurationError("identityHeader must name a header absent from request.headers.");
  // Validate the generated header as part of the complete request, including total size limits.
  parseHttpConfiguration({ ...request, headers: { ...request.headers, [identityHeader]: "00000000-0000-0000-0000-000000000000" } });
  const requireRetryAfter = raw.requireRetryAfter === undefined ? false : raw.requireRetryAfter;
  if (typeof requireRetryAfter !== "boolean") throw new ConfigurationError("requireRetryAfter must be boolean.");
  return {
    request, algorithm: "anchored-fixed-window" as const, identityHeader: identityHeader.toLowerCase(),
    allowance: integer("allowance", 3, 1, 100), excessRequests: integer("excessRequests", 2, 1, 100), windowMs,
    windowGuardMs: integer("windowGuardMs", Math.min(50, Math.floor(windowMs / 10)), 1, Math.floor(windowMs / 2)),
    resetGraceMs: integer("resetGraceMs", 50, 0, windowMs), concurrency: integer("concurrency", 5, 2, 64),
    deadlineMs: integer("deadlineMs", Math.max(10000, 3 * windowMs + 1000), 1, 2147483647),
    rejectedStatus: integer("rejectedStatus", 429, 400, 499), requireRetryAfter,
  };
}
export type RateLimitConfiguration = ReturnType<typeof parseRateLimitConfiguration>;
