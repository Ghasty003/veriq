import { ConfigurationError, parseHttpConfiguration } from "./http-config.ts";

export function parseLoadConfiguration(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigurationError("Load configuration must be an object.");
  const raw = input as Record<string, unknown>;
  const fields = ["request", "stages", "stageDurationMs", "maxRequestsPerStage", "minSamplesPerStage", "pauseMs", "deadlineMs", "minPassedRequestsPerSecond", "recovery"];
  if (Object.keys(raw).some((key) => !fields.includes(key))) throw new ConfigurationError("Unknown load configuration field.");
  if (!raw.request || typeof raw.request !== "object" || Array.isArray(raw.request)) throw new ConfigurationError("request must be an HTTP configuration object.");
  const http = raw.request as Record<string, unknown>;
  const request = parseHttpConfiguration({ ...http, maxDurationMs: http.maxDurationMs === undefined ? 200 : http.maxDurationMs });
  const levels = raw.stages === undefined ? [1, 5, 10, 20] : raw.stages;
  if (!Array.isArray(levels) || levels.length < 1 || levels.length > 16 || levels.some((level, i) => !Number.isInteger(level) || level < 1 || level > 256 || i > 0 && level <= levels[i - 1])) throw new ConfigurationError("stages must contain 1–16 strictly increasing concurrency integers from 1 to 256.");
  function integer(name: string, fallback: number, min: number, max: number) {
    const value = raw[name] === undefined ? fallback : raw[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ConfigurationError(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  }
  const recovery = raw.recovery === undefined ? true : raw.recovery;
  if (typeof recovery !== "boolean") throw new ConfigurationError("recovery must be boolean.");
  const maxRequestsPerStage = integer("maxRequestsPerStage", 2000, 1, 10000), minSamplesPerStage = integer("minSamplesPerStage", 10, 1, 10000);
  if (maxRequestsPerStage < levels[levels.length - 1] || maxRequestsPerStage < minSamplesPerStage) throw new ConfigurationError("maxRequestsPerStage must cover every concurrency level and minSamplesPerStage.");
  if (maxRequestsPerStage * (levels.length + Number(recovery)) > 50000) throw new ConfigurationError("The maximum combined request budget is 50000 across all stages and recovery.");
  const minimum = raw.minPassedRequestsPerSecond === undefined ? 0 : raw.minPassedRequestsPerSecond;
  if (typeof minimum !== "number" || !Number.isFinite(minimum) || minimum < 0 || minimum > 1000000) throw new ConfigurationError("minPassedRequestsPerSecond must be a finite number from 0 to 1000000; zero disables this requirement.");
  return {
    request, stages: [...levels] as number[], recovery, maxRequestsPerStage, minSamplesPerStage,
    stageDurationMs: integer("stageDurationMs", 2000, 50, 60000), pauseMs: integer("pauseMs", 250, 0, 60000),
    deadlineMs: integer("deadlineMs", 60000, 1, 2147483647), minPassedRequestsPerSecond: minimum,
  };
}
export type LoadConfiguration = ReturnType<typeof parseLoadConfiguration>;
