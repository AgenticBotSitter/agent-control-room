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
 * silently kill the loop. The enclosing LaunchDaemon restarts a crashed host.
 *
 * `toleratesFirstCycleFailure` extends that same "report, don't throw"
 * handling to this first cycle too: a recurring health-check loop that a host
 * startup path awaits must not fail that startup merely because the machine
 * was busy or briefly unreachable at that exact moment, since the loop's own
 * retry already covers it. A one-shot caller that treats "the cycle" as the
 * whole unit of work it needs to have completed (night-kit's simulated run)
 * leaves this off and keeps the original throw-through behavior. */
export async function startSupervisorLoopV1(input: Readonly<{
  service: Readonly<{ cycle(): Promise<unknown> }>;
  intervalMs?: number;
  runtime?: LoopRuntime;
  toleratesFirstCycleFailure?: boolean;
}>): Promise<SupervisorLoopHandleV1> {
  const intervalMs = input.intervalMs ?? 30_000;
  if (!input.service || typeof input.service.cycle !== "function"
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000)
    throw new Error("supervisor_loop_input_invalid");
  const runtime = input.runtime ?? productionRuntime;
  if (input.toleratesFirstCycleFailure) await input.service.cycle().catch(runtime.report);
  else await input.service.cycle();
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
