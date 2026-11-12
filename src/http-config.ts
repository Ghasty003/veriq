export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

export type HttpConfiguration = {
  target: string; method: string; headers: Record<string, string>; body?: string;
  timeoutMs: number; maxDurationMs: number; expectedStatus: number;
};
const allowed = new Set(["target", "method", "headers", "body", "timeoutMs", "maxDurationMs", "expectedStatus"]);
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const reservedHeaders = new Set([
  "host", "content-length", "transfer-encoding", "connection", "upgrade", "expect",
  "trailer", "te", "keep-alive", "proxy-authorization", "proxy-connection",
]);

function milliseconds(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ConfigurationError(`${name} must be an integer from 1 to 2147483647 milliseconds.`);
  }
  return value;
}

export function parseHttpConfiguration(input: unknown): HttpConfiguration {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigurationError("HTTP configuration must be a JSON object.");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ConfigurationError("Unknown HTTP configuration field. Check the documented configuration keys.");
  }
  let target: URL;
  try {
    if (typeof value.target !== "string" || value.target.length > 8192) throw new Error();
    target = new URL(value.target);
  } catch {
    throw new ConfigurationError("target must be an absolute HTTP or HTTPS URL of at most 8192 characters.");
  }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) {
    throw new ConfigurationError("target must use HTTP(S), without embedded credentials or a fragment.");
  }
  const method = value.method === undefined ? "GET" : value.method;
  if (typeof method !== "string" || !methods.has(method)) {
    throw new ConfigurationError("method must be GET, HEAD, POST, PUT, PATCH, DELETE, or OPTIONS (uppercase).");
  }
  const timeoutMs = milliseconds(value.timeoutMs === undefined ? 2000 : value.timeoutMs, "timeoutMs");
  const maxDurationMs = milliseconds(value.maxDurationMs === undefined ? timeoutMs : value.maxDurationMs, "maxDurationMs");
  if (maxDurationMs > timeoutMs) {
    throw new ConfigurationError("timeoutMs must be at least maxDurationMs to observe the response requirement.");
  }
  const expectedStatus = value.expectedStatus === undefined ? 200 : value.expectedStatus;
  if (typeof expectedStatus !== "number" || !Number.isInteger(expectedStatus) || expectedStatus < 200 || expectedStatus > 599) {
    throw new ConfigurationError("expectedStatus must be a final HTTP status from 200 to 599.");
  }
  const suppliedHeaders = value.headers === undefined ? {} : value.headers;
  if (!suppliedHeaders || typeof suppliedHeaders !== "object" || Array.isArray(suppliedHeaders)) {
    throw new ConfigurationError("headers must be an object of string values.");
  }
  const headers: Record<string, string> = Object.create(null);
  let headerBytes = 0;
  for (const [name, content] of Object.entries(suppliedHeaders)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower) || reservedHeaders.has(lower) || lower in headers ||
        typeof content !== "string" || /[^\t\x20-\x7e\x80-\xff]/.test(content)) {
      throw new ConfigurationError("Invalid, duplicate, or transport-controlled HTTP header. Header values must be single-line Latin-1 strings.");
    }
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(content);
    headers[lower] = content;
  }
  if (headerBytes > 16_384 || Object.keys(headers).length > 100) {
    throw new ConfigurationError("Request headers exceed the limit of 100 headers or 16 KiB.");
  }
  if (value.body !== undefined && (typeof value.body !== "string" || Buffer.byteLength(value.body) > 1_048_576)) {
    throw new ConfigurationError("body must be a string of at most 1 MiB.");
  }
  if (value.body !== undefined && (method === "GET" || method === "HEAD")) {
    throw new ConfigurationError("GET and HEAD requests cannot include a body.");
  }
  return { target: target.href, method, headers, body: value.body as string | undefined, timeoutMs, maxDurationMs, expectedStatus };
}

export function redactUrl(input: string, base?: string): string {
  try {
    const url = new URL(input, base);
    if (!["http:", "https:"].includes(url.protocol)) return "[non-HTTP location omitted]";
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, "[redacted]");
    return url.href;
  } catch {
    return "[invalid location omitted]";
  }
}
