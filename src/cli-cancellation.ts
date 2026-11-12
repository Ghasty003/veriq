import type { RunResult } from "./http-experiment.ts";

// Process signal ownership belongs to invocation, not HTTP execution.
export async function withCliCancellation<T>(operation: (
  signal: AbortSignal,
  exitCode: (result: RunResult, cancelled?: boolean) => number,
) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let interrupted: "SIGINT" | "SIGTERM" | undefined;
  const cancel = (signal: "SIGINT" | "SIGTERM") => {
    if (interrupted) process.exit(signal === "SIGINT" ? 130 : 143);
    interrupted = signal;
    controller.abort();
  };
  const onInterrupt = () => cancel("SIGINT");
  const onTerminate = () => cancel("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    return await operation(controller.signal, (result, cancelled = result === "INCONCLUSIVE") =>
      cancelled && interrupted ? interrupted === "SIGINT" ? 130 : 143
        : { PASS: 0, FAIL: 1, ERROR: 2, INCONCLUSIVE: 3 }[result]);
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
