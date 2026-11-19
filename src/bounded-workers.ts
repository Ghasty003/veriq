export async function runBounded<T>(options: {
  count: number;
  concurrency: number;
  signal?: AbortSignal;
  // Closing admission drains active actions; it does not cancel them.
  shouldStart?: () => boolean;
  action: (index: number, signal: AbortSignal) => Promise<T>;
  stopWhen: (value: T) => boolean;
  onException: () => T;
}) {
  const controllers = Array.from({ length: Math.min(options.count, options.concurrency) }, () => new AbortController());
  const records: ({ index: number; worker: number; value: T } | undefined)[] = new Array(options.count);
  let next = 0, active = 0, peakInFlight = 0, stopped = false;
  const stop = () => { stopped = true; for (const controller of controllers) controller.abort(); };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  async function worker(worker: number) {
    while (!stopped && next < options.count) {
      let admitted: boolean;
      try { admitted = options.shouldStart?.() ?? true; }
      catch {
        const index = next++;
        records[index] = { index, worker: worker + 1, value: options.onException() };
        stop(); break;
      }
      if (!admitted) break;
      const index = next++; // A synchronous claim, before yielding to another worker.
      active++; peakInFlight = Math.max(peakInFlight, active);
      let value: T;
      try { value = await options.action(index, controllers[worker].signal); }
      catch { value = options.onException(); stop(); }
      finally { active--; }
      records[index] = { index, worker: worker + 1, value };
      if (options.stopWhen(value)) stop();
    }
  }
  try { await Promise.all(controllers.map((_, index) => worker(index))); }
  finally {
    options.signal?.removeEventListener("abort", stop);
    for (const controller of controllers) controller.abort();
  }
  return { entries: records.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined), peakInFlight };
}
