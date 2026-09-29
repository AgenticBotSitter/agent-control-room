export type SupervisorLoopHandleV1 = Readonly<{ close(): Promise<void> }>;

type LoopRuntime = Readonly<{
  setInterval(run: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  report(error: unknown): void;
}>;

const productionRuntime: LoopRuntime = Object.freeze({
  setInterval: (run, milliseconds) => setInterval(run, milliseconds),
  clearInterval: timer => clearInterval(timer),
  report: () => process.stderr.write("supervisor_cycle_unavailable\n"),
});

/** Starts one verified cycle before returning, then continues without overlap.
 * A later failed cycle is reported and retried by the next tick; it cannot
 * silently kill the loop. The enclosing LaunchDaemon restarts a crashed host. */
export async function startSupervisorLoopV1(input: Readonly<{
  service: Readonly<{ cycle(): Promise<unknown> }>;
  intervalMs?: number;
  runtime?: LoopRuntime;
}>): Promise<SupervisorLoopHandleV1> {
  const intervalMs = input.intervalMs ?? 30_000;
  if (!input.service || typeof input.service.cycle !== "function"
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000)
    throw new Error("supervisor_loop_input_invalid");
  const runtime = input.runtime ?? productionRuntime;
  await input.service.cycle();
  let closed = false;
  let inFlight: Promise<unknown> | undefined;
  const timer = runtime.setInterval(() => {
    if (closed || inFlight) return;
    inFlight = input.service.cycle().catch(runtime.report).finally(() => { inFlight = undefined; });
  }, intervalMs);
  timer.unref?.();
  return Object.freeze({ async close() {
    if (closed) return;
    closed = true;
    runtime.clearInterval(timer);
    await inFlight?.catch(() => {});
  } });
}
