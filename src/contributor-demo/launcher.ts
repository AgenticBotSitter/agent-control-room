type DemoService = {
  start(): Promise<void>;
  close(): Promise<void>;
  ownerCode: string;
};
type LauncherIO = {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  off(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  output(message: string): void;
  error(message: string): void;
  exitCode(code: number): void;
};

/** Explicit CLI orchestration. No ambient credentials, automatic retry or forced
 * process exit. Signals remain handled until asynchronous cleanup has finished.
 */
export async function launchContributorDemo(create: () => Promise<DemoService>, io: LauncherIO) {
  let service: DemoService | undefined, stopping = false;
  let cleanup: Promise<void> | undefined;
  const detach = () => { io.off("SIGINT", stop); io.off("SIGTERM", stop); };
  const close = () => cleanup ??= (async () => {
    try { await service?.close(); }
    catch { io.error("Demo cleanup could not be confirmed. Temporary demo data may remain."); io.exitCode(1); }
    finally { detach(); }
  })();
  function stop() { stopping = true; if (service) void close(); }
  io.on("SIGINT", stop); io.on("SIGTERM", stop);
  try {
    service = await create();
    if (stopping) { await close(); return; }
    await service.start();
    if (stopping) { await close(); return; }
    io.output("SIMULATION ONLY — no real agents or providers are connected.\nOpen http://127.0.0.1:3000/local-preview\n"
      + "Paste this one-time code into the owner login field on that page:\n" + service.ownerCode
      + "\nKeep this code private. Press Ctrl+C to stop and delete this session's demo data.");
  } catch {
    if (!stopping) { io.error("Demo could not start. Check that the demo is built and port 3000 is available. No retry was made."); io.exitCode(1); }
    await close();
  }
}
