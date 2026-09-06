type StopSignal = "SIGINT" | "SIGTERM";
type SignalSource = {
  on(signal: StopSignal, listener: () => void): unknown;
  off(signal: StopSignal, listener: () => void): unknown;
};
type ShutdownResult = { status: "closed" | "cleanup_uncertain" };

/** Explicit operator-entrypoint glue for an already running host. Import is inert.
 * Reuses host.close(); the OS supervisor owns termination/restart policy. No
 * process.exit, signal sending, deployment or automatic restart occurs here.
 */
export function bindPrivateHostShutdown(host: { close(): Promise<void> }, signals: SignalSource, timeoutMs = 40_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 40_000) throw new Error("private_shutdown_config_invalid");
  const close = host.close.bind(host);
  const on = signals.on.bind(signals), off = signals.off.bind(signals);
  let stopping: Promise<ShutdownResult> | undefined;
  let finish!: (result: ShutdownResult) => void;
  const completed = new Promise<ShutdownResult>(resolve => { finish = resolve; });
  const detach = () => {
    let detached = true;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      try { off(signal, stopFromSignal); } catch { detached = false; }
    }
    return detached;
  };
  function stop(): Promise<ShutdownResult> {
    if (stopping) return stopping;
    // Assign before invoking close, including synchronous reentrant stop signals.
    stopping = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: ShutdownResult;
      try {
        await Promise.race([Promise.resolve().then(close), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("private_shutdown_timeout")), timeoutMs);
        })]);
        result = { status: "closed" };
      } catch { result = { status: "cleanup_uncertain" }; }
      finally { clearTimeout(timer); }
      if (!detach()) result = { status: "cleanup_uncertain" };
      finish(result);
      return result;
    });
    return stopping;
  }
  function stopFromSignal() { void stop(); }
  try { on("SIGINT", stopFromSignal); on("SIGTERM", stopFromSignal); }
  catch { detach(); throw new Error("private_shutdown_registration_failed"); }
  return Object.freeze({ stop, completed });
}
