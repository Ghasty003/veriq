import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigurationFile } from "../src/config-file.ts";
import { ConfigurationError } from "../src/http-config.ts";

test("config file reading handles valid JSON, malformed input, invalid UTF-8 and bounded reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "veriq-config-"));
  try {
    const path = join(directory, "config.json");
    await writeFile(path, '{"target":"http://example.test"}');
    assert.deepEqual(await readConfigurationFile(path), { target: "http://example.test" });
    for (const content of ["{bad-secret-json", Buffer.from([0xff]), " ".repeat(2 * 1024 * 1024 + 1)]) {
      await writeFile(path, content);
      await assert.rejects(readConfigurationFile(path), ConfigurationError);
    }
    await assert.rejects(readConfigurationFile(join(directory, "missing.json")), ConfigurationError);
    await assert.rejects(readConfigurationFile(directory), ConfigurationError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
