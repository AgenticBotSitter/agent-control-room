import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
import { parseMacLocalWebHostArguments, startMacLocalTaskHost } from "./start-web-host.mjs";

export function monitorActiveTaskHost(active, runtime = process, timers = globalThis, supervisor = undefined) {
  let closed = false, supervisorLost = false, boundedStop, readinessTimer;
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
    if (readinessTimer !== undefined) timers.clearInterval(readinessTimer);
    releaseSupervisor();
    try { await active.close(); runtime.exitCode = code; }
    catch { runtime.exitCode = 1; }
  };
  const stopWithinBound = (code = 0) => {
    if (boundedStop) return boundedStop;
    runtime.exitCode = code;
    const forced = timers.setTimeout(() => runtime.exit(runtime.exitCode ?? code), 10_000);
    boundedStop = stop(code).finally(() => {
      timers.clearTimeout(forced);
      runtime.exit(runtime.exitCode ?? code);
    });
    return boundedStop;
  };
  runtime.once("SIGINT", () => { void stopWithinBound(); });
  runtime.once("SIGTERM", () => { void stopWithinBound(); });
  if (supervisor) {
    onSupervisorLost = () => {
      if (supervisorLost || closed) return;
      supervisorLost = true;
      void stopWithinBound(1);
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
    void stopWithinBound(1);
  });
  if (typeof active.isReady === "function" && typeof timers.setInterval === "function") {
    readinessTimer = timers.setInterval(() => {
      let ready = false;
      try { ready = active.isReady() === true; } catch {}
      if (ready || closed) return;
      runtime.stderr.write("host stopped because application readiness failed\n");
      void stopWithinBound(1);
    }, 1_000);
    readinessTimer.unref?.();
  }
  return Object.freeze({ stop });
}

async function main() {
  const parsed = parseMacLocalWebHostArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log("Usage: pnpm mac:tasks -- --owner-attended --protected-root ABSOLUTE_PATH");
    return;
  }
  const active = await startMacLocalTaskHost(parsed);
  console.log("Control Room connector-only host is running. Press Control-C to stop.");
  const supervisor = process.env.CONTROL_ROOM_TASK_HOST_SUPERVISED === "1" ? process.stdin : undefined;
  monitorActiveTaskHost(active, process, globalThis, supervisor);
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  void main().catch(error => {
    console.error(`host stopped because startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
