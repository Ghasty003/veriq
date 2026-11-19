import { ConfigurationError, parseHttpConfiguration, type HttpConfiguration } from "./http-config.ts";
import { validatePointer } from "./json-value.ts";

export type CacheEndpoint = HttpConfiguration;
export function parseCacheConfiguration(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigurationError("Cache configuration must be an object.");
  const raw = input as Record<string, unknown>;
  const fields = ["read", "source", "write", "originWrite", "valuePointer", "sourceValuePointer", "sourceReadsPointer", "ttlMs", "windowGuardMs", "expiryGraceMs", "hitRequests", "burstRequests", "concurrency", "deadlineMs", "invalidation"];
  if (Object.keys(raw).some((key) => !fields.includes(key))) throw new ConfigurationError("Unknown cache configuration field.");
  function endpoint(name: string, mutation: boolean): CacheEndpoint {
    const value = raw[name];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError(`${name} must be an HTTP configuration object.`);
    const settings = value as Record<string, unknown>;
    if (typeof settings.target !== "string" || settings.target.split("{caller}").length !== 2 || settings.target.split("{key}").length !== 2) throw new ConfigurationError(`${name}.target must contain exactly one {caller} and one {key} placeholder.`);
    if (settings.body !== undefined) throw new ConfigurationError(`${name}.body is owned by the experiment; writes send JSON with one generated value field.`);
    const http = parseHttpConfiguration({ ...settings,
      target: settings.target.replace("{caller}", "validation-caller").replace("{key}", "validation-key"),
      method: settings.method === undefined ? mutation ? "PUT" : "GET" : settings.method,
    });
    // Caller and key vary the resource, never the destination host or credentials.
    const authority = settings.target.match(/^[a-z]+:\/\/([^/?#]*)/i)?.[1];
    if (!authority || authority.includes("{caller}") || authority.includes("{key}")) throw new ConfigurationError("Cache placeholders must appear in the URL path or query.");
    if (mutation ? !["POST", "PUT", "PATCH"].includes(http.method) : http.method !== "GET") throw new ConfigurationError(`${name} must use ${mutation ? "POST, PUT or PATCH" : "GET"}.`);
    if (http.expectedStatus > 299 || [204, 205].includes(http.expectedStatus)) throw new ConfigurationError(`${name} must require a successful JSON response status.`);
    if (mutation) {
      if (http.headers["content-type"] !== undefined && http.headers["content-type"].toLowerCase() !== "application/json") throw new ConfigurationError("Cache writes use Content-Type application/json.");
      http.headers["content-type"] = "application/json";
      parseHttpConfiguration({ ...http, body: JSON.stringify({ value: "validation-value" }) });
    }
    return { ...http, target: settings.target };
  }
  function integer(name: string, fallback: number, min: number, max: number) {
    const value = raw[name] === undefined ? fallback : raw[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ConfigurationError(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  }
  const invalidation = raw.invalidation === undefined ? "required" : raw.invalidation;
  if (invalidation !== "required" && invalidation !== "ttl-only") throw new ConfigurationError("invalidation must be required or ttl-only.");
  if (invalidation === "ttl-only" && raw.write !== undefined) throw new ConfigurationError("write is only used when invalidation is required.");
  const ttlMs = integer("ttlMs", 1000, 100, 60000);
  return {
    read: endpoint("read", false), source: endpoint("source", false), originWrite: endpoint("originWrite", true),
    write: invalidation === "required" ? endpoint("write", true) : undefined, invalidation,
    valuePointer: validatePointer(raw.valuePointer === undefined ? "/value" : raw.valuePointer),
    sourceValuePointer: validatePointer(raw.sourceValuePointer === undefined ? "/value" : raw.sourceValuePointer),
    sourceReadsPointer: validatePointer(raw.sourceReadsPointer === undefined ? "/reads" : raw.sourceReadsPointer),
    ttlMs, windowGuardMs: integer("windowGuardMs", Math.min(50, Math.floor(ttlMs / 10)), 1, Math.floor(ttlMs / 2)),
    expiryGraceMs: integer("expiryGraceMs", 50, 0, ttlMs), hitRequests: integer("hitRequests", 2, 1, 100),
    burstRequests: integer("burstRequests", 5, 2, 100), concurrency: integer("concurrency", 5, 2, 32),
    deadlineMs: integer("deadlineMs", Math.max(10000, ttlMs * 4 + 5000), 1, 2147483647),
  };
}
export type CacheConfiguration = ReturnType<typeof parseCacheConfiguration>;
