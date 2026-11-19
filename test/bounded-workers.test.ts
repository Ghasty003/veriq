import assert from "node:assert/strict";
import { test } from "node:test";
import { runBounded } from "../src/bounded-workers.ts";

test("closing admission drains active actions without cancelling or claiming queued work", async () => {
  let open = true, started = 0, settled = 0;
  const releases: (() => void)[] = [];
  let ready!: () => void; const allStarted = new Promise<void>((resolve) => ready = resolve);
  const pending = runBounded({ count: 20, concurrency: 3, shouldStart: () => open,
    action: async (_, signal) => { started++; if (started === 3) ready(); await new Promise<void>((resolve) => releases.push(resolve)); assert.equal(signal.aborted, false); settled++; return settled; },
    stopWhen: () => false, onException: () => { assert.fail("unexpected exception"); },
  });
  await allStarted; open = false; for (const release of releases) release();
  const result = await pending;
  assert.equal(started, 3); assert.equal(settled, 3); assert.equal(result.entries.length, 3); assert.equal(result.peakInFlight, 3);
});
test("an admission exception cancels and settles active workers before returning", async () => {
  let checks = 0, exceptions = 0, settled = false;
  const result = await runBounded({ count: 10, concurrency: 2, shouldStart: () => { if (++checks === 2) throw Error("predicate failed"); return true; },
    action: async (_, signal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => { settled = true; resolve(); }, { once: true })); return "cancelled"; },
    stopWhen: () => false, onException: () => { exceptions++; return "error"; },
  });
  assert.equal(exceptions, 1); assert.equal(settled, true); assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries.map((e) => e.value), ["cancelled", "error"]);
});
