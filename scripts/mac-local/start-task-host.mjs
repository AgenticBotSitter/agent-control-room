import { parseMacLocalWebHostArguments, startMacLocalTaskHost } from "./start-web-host.mjs";
import { pathToFileURL } from "node:url";

export function monitorActiveTaskHost(active, runtime = process, timers = globalThis, supervisor = undefined) {
  let closed = false, supervisorLost = false;
  let onSupervisorLost;
  const releaseSupervisor = () => {
    if (!supervisor) return;
    supervisor.removeListener("end", onSupervisorLost);
    supervisor.removeListener("error", onSupervisorLost);
    supervisor.destroy?.();
  };
  const stop = async (code = 0) => {
    if (closed) return;
    closed = true;
    releaseSupervisor();
    try { await active.close(); runtime.exitCode = code; }
    catch { runtime.exitCode = 1; }
  };
  runtime.once("SIGINT", () => { void stop(); });
  runtime.once("SIGTERM", () => { void stop(); });
  if (supervisor) {
    onSupervisorLost = () => {
      if (supervisorLost || closed) return;
      supervisorLost = true;
      runtime.exitCode = 1;
      const forced = timers.setTimeout(() => runtime.exit(1), 10_000);
      void stop(1).finally(() => { timers.clearTimeout(forced); runtime.exit(runtime.exitCode ?? 1); });
    };
    supervisor.once("end", onSupervisorLost);
    supervisor.once("error", onSupervisorLost);
    supervisor.resume();
  }
  runtime.once("uncaughtExceptionMonitor", error => {
    runtime.stderr.write(`host stopped because uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  });
  runtime.once("unhandledRejection", reason => {
    runtime.stderr.write(`host stopped because unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
    runtime.exitCode = 1;
    const forced = timers.setTimeout(() => runtime.exit(1), 10_000);
    void stop(1).finally(() => { timers.clearTimeout(forced); runtime.exit(runtime.exitCode ?? 1); });
  });
  return Object.freeze({ stop });
}

async function main() {
  const parsed = parseMacLocalWebHostArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log("Usage: pnpm mac:tasks -- --owner-attended --protected-root ABSOLUTE_PATH");
    return;
  }
  const active = await startMacLocalTaskHost(parsed);
  console.log("Control Room local task host is running. Press Control-C to stop.");
  const supervisor = process.env.CONTROL_ROOM_TASK_HOST_SUPERVISED === "1" ? process.stdin : undefined;
  monitorActiveTaskHost(active, process, globalThis, supervisor);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(`host stopped because startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
