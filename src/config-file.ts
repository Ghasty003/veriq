import { open } from "node:fs/promises";
import { ConfigurationError } from "./http-config.ts";

export async function readConfigurationFile(path: string): Promise<unknown> {
  // Limit reads rather than trusting a size check: a file can grow after stat.
  const limit = 2 * 1024 * 1024;
  let file;
  try {
    file = await open(path, "r");
    if (!(await file.stat()).isFile()) throw new ConfigurationError("Configuration must be a regular JSON file.");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new ConfigurationError("Configuration file exceeds 2 MiB.");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
    } catch {
      throw new ConfigurationError("Configuration file must contain valid UTF-8 JSON.");
    }
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError("Could not read the configuration file. Check its path and permissions.");
  } finally {
    await file?.close();
  }
}
