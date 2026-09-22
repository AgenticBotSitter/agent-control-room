import { spawn } from "node:child_process";

export const LOCAL_SETUP_HOST_READINESS_V1 = Object.freeze({
  schema: "control-room.local-setup-host-readiness/v1",
  state: "ready",
  origin: "http://127.0.0.1:3210",
  path: "/setup",
});

const READY_BYTES = Buffer.from(`${JSON.stringify(LOCAL_SETUP_HOST_READINESS_V1)}\n`, "utf8");
const MAX_READINESS_BYTES = 4096;
const refused = reason => {
  const error = new Error(reason);
  error.code = reason;
  return error;
};

function defaultKillGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
}

function validSpec(spec) {
  return spec && typeof spec === "object" && typeof spec.executable === "string"
    && Array.isArray(spec.args) && spec.args.every(value => typeof value === "string" && !value.includes("\0"))
    && typeof spec.cwd === "string" && spec.environment && typeof spec.environment === "object";
}

/**
 * Owns one long-lived setup-host process group. The child may emit exactly one
 * bounded readiness record and nothing else. Only then is the fixed loopback
 * setup URL opened. The returned promise intentionally stays pending while the
 * host is alive.
 */
export function superviseLocalSetupLauncherHostV1(spec, dependencies = {}) {
  if (!validSpec(spec)) return Promise.reject(refused("local_setup_launcher_supervisor_refused"));
  const spawnProcess = dependencies.spawnProcess ?? ((executable, args, options) => spawn(executable, args, options));
  const runOpener = dependencies.runOpener;
  const openerExecutable = dependencies.openerExecutable;
  const signals = dependencies.signals ?? process;
  const killGroup = dependencies.killGroup ?? defaultKillGroup;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  if (typeof spawnProcess !== "function" || typeof runOpener !== "function" || typeof openerExecutable !== "string"
    || !openerExecutable.startsWith("/") || openerExecutable.includes("\0") || typeof signals?.on !== "function"
    || typeof signals?.off !== "function" || typeof killGroup !== "function"
    || typeof setTimer !== "function" || typeof clearTimer !== "function") {
    return Promise.reject(refused("local_setup_launcher_supervisor_refused"));
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: spec.environment,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(refused("local_setup_host_start_failed"));
      return;
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1
      || typeof child.once !== "function" || typeof child.stdout?.on !== "function"
      || typeof child.stderr?.on !== "function") {
      reject(refused("local_setup_host_start_failed"));
      return;
    }

    const graceMs = 2_000;
    const reapMs = 2_000;
    let output = Buffer.alloc(0), ready = false, opened = false, stopping = false;
    let leaderClosed = false, groupKillAttempted = false, settled = false, failure;
    let readinessTimer, killTimer, reapTimer;
    const listeners = [];

    const removeListeners = () => {
      for (const [event, listener] of listeners) signals.off(event, listener);
      listeners.length = 0;
    };
    const finish = () => {
      if (settled || !stopping || !leaderClosed || !groupKillAttempted) return;
      settled = true;
      clearTimer(readinessTimer); clearTimer(killTimer); clearTimer(reapTimer);
      removeListeners();
      if (failure) reject(failure);
      else resolve(Object.freeze({ state: "setup_host_closed", ready, opened, reaped: true }));
    };
    const failUnreaped = () => {
      if (settled) return;
      settled = true;
      removeListeners();
      reject(refused("local_setup_host_cleanup_uncertain"));
    };
    const terminate = reason => {
      if (stopping) return;
      stopping = true;
      clearTimer(readinessTimer);
      failure = reason ? refused(reason) : undefined;
      try { killGroup(child.pid, "SIGTERM"); }
      catch { failure = refused("local_setup_host_cleanup_uncertain"); }
      killTimer = setTimer(() => {
        try { killGroup(child.pid, "SIGKILL"); }
        catch { failure = refused("local_setup_host_cleanup_uncertain"); }
        groupKillAttempted = true;
        if (!leaderClosed) reapTimer = setTimer(failUnreaped, reapMs);
        finish();
      }, graceMs);
    };
    const parentStop = () => terminate();
    for (const event of ["SIGINT", "SIGTERM", "SIGHUP", "beforeExit"]) {
      signals.on(event, parentStop); listeners.push([event, parentStop]);
    }
    const exitStop = () => {
      try { killGroup(child.pid, "SIGTERM"); } catch {}
      try { killGroup(child.pid, "SIGKILL"); } catch {}
    };
    signals.on("exit", exitStop); listeners.push(["exit", exitStop]);

    const malformed = () => terminate("local_setup_host_output_refused");
    child.stdout.on("data", chunk => {
      if (stopping) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (ready || output.byteLength + bytes.byteLength > MAX_READINESS_BYTES) { malformed(); return; }
      output = Buffer.concat([output, bytes], output.byteLength + bytes.byteLength);
      const newline = output.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== output.byteLength - 1 || !output.equals(READY_BYTES)) { malformed(); return; }
      ready = true; clearTimer(readinessTimer);
      Promise.resolve().then(() => runOpener({
        executable: openerExecutable,
        args: ["http://127.0.0.1:3210/setup"],
        cwd: spec.cwd,
        environment: spec.environment,
        timeoutMs: 15_000,
        terminationGraceMs: 2_000,
      })).then(result => {
        if (stopping) return;
        if (!result || result.exitCode !== 0 || result.signal !== null || result.oversized || result.timedOut
          || typeof result.stdout !== "string" || (result.stderr !== undefined && typeof result.stderr !== "string")) {
          terminate("local_setup_host_opener_failed"); return;
        }
        opened = true;
      }, () => terminate("local_setup_host_opener_failed"));
    });
    child.stderr.on("data", malformed);
    child.once("error", () => terminate("local_setup_host_start_failed"));
    child.once("close", () => {
      leaderClosed = true;
      if (!stopping) terminate(ready ? "local_setup_host_exited" : "local_setup_host_start_failed");
      finish();
    });
    readinessTimer = setTimer(() => terminate("local_setup_host_readiness_timeout"), 15_000);
  });
}
