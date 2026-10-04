import { databaseSqlStateIsAnyV1 } from "../../../src/persistence/database";

function isDatabaseDisconnect(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message ?? "";
  return databaseSqlStateIsAnyV1(error, ["57P01"]) || code === "ECONNRESET" || code === "EPIPE"
    || /terminating connection|Connection terminated|Client has encountered a connection error/u.test(message);
}

/** A process error must reach teardown before the runner can exit. Only the verified
 * database's deliberate shutdown can excuse a disconnection; the same error during
 * the journey is a failure. No handler calls process.exit, which would skip finally. */
export async function runMacLocalJourneyV1(
  work: (signal: AbortSignal) => Promise<void>,
  cleanup: (settleWork: () => Promise<void>) => Promise<void>,
  options: { isStoppingDatabase: () => boolean; runtime?: Pick<NodeJS.Process,
    "on" | "removeListener" | "stderr" | "exitCode"> },
): Promise<void> {
  const runtime = options.runtime ?? process, controller = new AbortController();
  let fail!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
  const onError = (error: unknown) => {
    if (options.isStoppingDatabase() && isDatabaseDisconnect(error)) return;
    if (controller.signal.aborted) return;
    runtime.exitCode = 1;
    controller.abort(error);
    fail(error);
    // Diagnostics must not prevent shutdown if stderr itself has failed.
    try {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      runtime.stderr.write(`journey process error: ${message}\n`);
    } catch {}
  };
  runtime.on("uncaughtException", onError);
  runtime.on("unhandledRejection", onError);
  const running = Promise.resolve().then(() => work(controller.signal));
  const settleWork = async () => { await running.catch(() => {}); };
  try {
    await Promise.race([running, failure]);
  } finally {
    // Stop the owned transports first, then let cancelled work settle before
    // removing files it could still be finishing a write to.
    try { await cleanup(settleWork); }
    finally {
      await settleWork();
      runtime.removeListener("uncaughtException", onError);
      runtime.removeListener("unhandledRejection", onError);
    }
  }
  // An unrelated process error during cleanup must still fail the journey.
  controller.signal.throwIfAborted();
}
