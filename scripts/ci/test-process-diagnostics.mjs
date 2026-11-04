// Diagnostic only: never send a signal, change test selection or limit resources.
// Imported by the quarantine runner only for the two affected CI invocations.
import { ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, statfsSync, writeSync } from "node:fs";
import { relative } from "node:path";
import { beforeEach, afterEach } from "node:test";

const owner = process.env.CONTROL_ROOM_CI_TEST_DIAGNOSTICS_PID;
if (owner && /^[1-9][0-9]*$/u.test(owner)) {
  let destination = 2;
  if (process.platform === "linux") {
    // Node's TAP reporter buffers other files behind the current file. Write to
    // our still-running wrapper's stderr so a runner shutdown cannot hide the
    // concurrent test or signal that preceded it. No new process or log file.
    try { destination = openSync(`/proc/${owner}/fd/2`, "a"); } catch { /* stderr fallback */ }
  }
  const read = path => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };
  const identity = pid => {
    const stat = read(`/proc/${pid}/stat`);
    if (!stat) return {};
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(fields[1]), pgid: Number(fields[2]) };
  };
  const file = process.argv[1] ? relative(process.cwd(), process.argv[1]) : null;
  const emit = (event, fields = {}) => {
    try {
      writeSync(destination, `[ci-test-diagnostic] ${JSON.stringify({
        at: new Date().toISOString(), event, pid: process.pid, file, ...fields,
      })}\n`);
    } catch { /* Diagnostics must never change the test's verdict. */ }
  };
  const resources = () => {
    let disk = null;
    try {
      const stat = statfsSync(process.cwd());
      disk = { availableBytes: stat.bavail * stat.bsize, availableInodes: stat.ffree };
    } catch { /* unsupported filesystem */ }
    return { memory: process.memoryUsage(), disk,
      cgroupMemoryCurrent: read("/sys/fs/cgroup/memory.current"),
      cgroupMemoryMax: read("/sys/fs/cgroup/memory.max"),
      cgroupMemoryEvents: read("/sys/fs/cgroup/memory.events"),
      hostMemory: read("/proc/meminfo")?.split("\n").filter(line =>
        /^(MemTotal|MemAvailable|SwapFree):/u.test(line)).join("; ") ?? null };
  };
  const signalName = signal => signal === undefined ? "SIGTERM" : typeof signal === "number" ? signal
    : typeof signal === "string" && /^SIG[A-Z0-9]+$/u.test(signal) ? signal : "invalid";
  const originalKill = process.kill;
  process.kill = function (pid, signal) {
    // Zero is only a liveness probe; retain the signal-bearing calls, including
    // pid 0 and negative pids, before attempting them.
    if (signal !== 0) emit("process.kill", { target: typeof pid === "number" ? pid : "invalid",
      signal: signalName(signal), self: identity(process.pid) });
    return Reflect.apply(originalKill, this, arguments);
  };
  const originalChildKill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function (signal) {
    if (signal !== 0) emit("child.kill", { target: this.pid ?? null, signal: signalName(signal),
      exitCode: this.exitCode, signalCode: this.signalCode, self: identity(process.pid) });
    return Reflect.apply(originalChildKill, this, arguments);
  };
  emit("process-start", { ppid: process.ppid, ...identity(process.pid), ...resources() });
  if (process.env.NODE_TEST_CONTEXT) {
    beforeEach(context => emit("test-start", { name: context.name, ...resources() }));
    afterEach(context => emit("test-end", { name: context.name, ...resources() }));
  }
  const timer = setInterval(() => emit("heartbeat", resources()), 15_000);
  timer.unref();
  process.once("exit", code => {
    clearInterval(timer);
    emit("process-exit", { code, ...resources() });
    if (destination !== 2) { try { closeSync(destination); } catch { /* already closed */ } }
  });
}
