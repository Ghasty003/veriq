import { createHash } from "node:crypto";
import { ConfigurationError } from "./http-config.ts";

export function validatePointer(pointer: unknown): string {
  if (typeof pointer !== "string" || pointer.length > 512 ||
      (pointer !== "" && !pointer.startsWith("/")) || /~(?![01])/.test(pointer)) {
    throw new ConfigurationError("JSON pointers must be empty or start with /, use ~0/~1 escapes, and be at most 512 characters.");
  }
  return pointer;
}

export function selectJson(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value };
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, token) ||
        (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(token))) return { found: false };
    value = (value as Record<string, unknown>)[token];
  }
  return { found: true, value };
}

export function jsonFingerprint(value: unknown): string {
  function canonical(value: unknown, depth: number): string {
    if (depth > 64) throw new Error("JSON nesting exceeds 64 levels.");
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    throw new Error("Unsupported JSON value.");
  }
  return createHash("sha256").update(canonical(value, 0)).digest("hex");
}
