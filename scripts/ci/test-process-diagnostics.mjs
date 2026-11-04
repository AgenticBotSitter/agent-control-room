// Diagnostic only: never send a signal, change test selection or limit resources.
// Imported by the quarantine runner only for the two affected CI invocations.
import { ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, statfsSync, writeSync } from "node:fs";
import { relative } from "node:path";
import { beforeEach, afterEach } from "node:test";

const read = path => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };

// Resolve the process's actual cgroup, rather than assuming it is at the mount
// root. Only fixed kernel counters are read or emitted; never command lines/env.
export function readCgroupMemory(readKernel = read, platform = process.platform) {
  if (platform !== "linux") return null;
  try {
    const memberships = (readKernel("/proc/self/cgroup") ?? "").split("\n");
    const v2 = memberships.find(line => line.startsWith("0::"))?.slice(3);
    const v1 = memberships.find(line => line.split(":")[1]?.split(",").includes("memory"))?.split(":")[2];
    const safePath = path => path?.startsWith("/") && !path.split("/").includes("..") && !/[\0\r\n]/u.test(path);
    const version = v2 !== undefined || v1 === undefined ? 2 : 1;
    const root = version === 2 ? "/sys/fs/cgroup" : "/sys/fs/cgroup/memory";
    const membership = version === 2 ? v2 : v1;
    const directory = safePath(membership) ? `${root}${membership === "/" ? "" : membership}` : root;
    const counter = name => readKernel(`${directory}/${name}`);
    return version === 2 ? {
      version, current: counter("memory.current"), max: counter("memory.max"),
      peak: counter("memory.peak"), events: counter("memory.events"), eventsLocal: counter("memory.events.local"),
    } : {
      version, current: counter("memory.usage_in_bytes"), max: counter("memory.limit_in_bytes"),
      peak: counter("memory.max_usage_in_bytes"), failcnt: counter("memory.failcnt"), oomControl: counter("memory.oom_control"),
    };
  } catch { return null; }
}

function eventDelta(before, after) {
  const counters = snapshot => Object.fromEntries((snapshot?.events ?? snapshot?.oomControl ?? "")
    .split("\n").map(line => line.split(/\s+/u)));
  const start = counters(before), end = counters(after), delta = {};
  for (const name of ["low", "high", "max", "oom", "oom_kill", "oom_group_kill"]) {
    if (/^\d+$/u.test(start[name]) && /^\d+$/u.test(end[name])) delta[name] = Number(end[name]) - Number(start[name]);
  }
  if (/^\d+$/u.test(before?.failcnt) && /^\d+$/u.test(after?.failcnt)) delta.failcnt = Number(after.failcnt) - Number(before.failcnt);
  return delta;
}

function emitDiagnostic(destination, event, fields) {
  try {
    writeSync(destination, `[ci-test-diagnostic] ${JSON.stringify({
      at: new Date().toISOString(), event, pid: process.pid, ...fields,
    })}\n`);
  } catch { /* Diagnostics must never change the test's verdict. */ }
}

// Called by the surviving wrapper even when the child had no chance to log an
// exit. Keep signal evidence separate from the wrapper's existing status mapping.
export function recordChildExit(result, before, readMemory = readCgroupMemory, emit = (event, fields) => emitDiagnostic(2, event, fields)) {
  try {
    const after = readMemory();
    emit("child-exit", { childPid: result.pid ?? null, code: result.status ?? null,
      signal: result.signal ?? null, cgroupMemoryBefore: before, cgroupMemoryAfter: after,
      cgroupMemoryEventDelta: eventDelta(before, after) });
  } catch { /* A post-mortem failure must not mask the child result/error. */ }
}

export function processIdentity(pid, readKernel = read) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const stat = readKernel(`/proc/${pid}/stat`);
  if (!stat) return null;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/u);
  const ppid = Number(fields[1]), pgid = Number(fields[2]), session = Number(fields[3]);
  return [ppid, pgid, session].every(Number.isSafeInteger) ? { pid, ppid, pgid, session } : null;
}

export function killTargetIdentity(target, self, identify = processIdentity) {
  if (!Number.isSafeInteger(target)) return null;
  // -1 has POSIX broadcast semantics, not process group 1.
  if (target === -1) return { kind: "broadcast" };
  if (target <= 0) {
    const pgid = target === 0 ? self?.pgid ?? null : -target;
    return { kind: "process-group", pgid, leader: pgid === null ? null : identify(pgid),
      sameProcessGroup: self?.pgid === undefined ? null : pgid === self.pgid };
  }
  const identity = identify(target);
  return { kind: "process", process: identity,
    sameProcessGroup: !identity || self?.pgid === undefined ? null : identity.pgid === self.pgid };
}

const owner = process.env.CONTROL_ROOM_CI_TEST_DIAGNOSTICS_PID;
// The wrapper imports the post-mortem helpers too. Only an explicit --import
// preload may install hooks or open the owning wrapper's stderr descriptor.
const preloaded = process.execArgv.some((arg, index, args) =>
  (arg === "--import" && args[index + 1] === import.meta.url) || arg === `--import=${import.meta.url}`);
if (preloaded && owner && /^[1-9][0-9]*$/u.test(owner)) {
  let destination = 2;
  if (process.platform === "linux") {
    // Node's TAP reporter buffers other files behind the current file. Write to
    // our still-running wrapper's stderr so a runner shutdown cannot hide the
    // concurrent test or signal that preceded it. No new process or log file.
    try { destination = openSync(`/proc/${owner}/fd/2`, "a"); } catch { /* stderr fallback */ }
  }
  const file = process.argv[1] ? relative(process.cwd(), process.argv[1]) : null;
  const emit = (event, fields = {}) => emitDiagnostic(destination, event, { file, ...fields });
  const resources = () => {
    let disk = null;
    try {
      const stat = statfsSync(process.cwd());
      disk = { availableBytes: stat.bavail * stat.bsize, availableInodes: stat.ffree };
    } catch { /* unsupported filesystem */ }
    return { memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS, disk,
      cgroupMemory: readCgroupMemory(),
      hostMemory: read("/proc/meminfo")?.split("\n").filter(line =>
        /^(MemTotal|MemAvailable|SwapFree):/u.test(line)).join("; ") ?? null };
  };
  const signalName = signal => signal === undefined ? "SIGTERM" : typeof signal === "number" ? signal
    : typeof signal === "string" && /^SIG[A-Z0-9]+$/u.test(signal) ? signal : "invalid";
  const originalKill = process.kill;
  process.kill = function (pid, signal) {
    // Zero is only a liveness probe; retain the signal-bearing calls, including
    // pid 0 and negative pids, before attempting them.
    try {
      if (signal !== 0) {
        const self = processIdentity(process.pid);
        emit("process.kill", { target: typeof pid === "number" ? pid : "invalid",
          signal: signalName(signal), self, targetIdentity: killTargetIdentity(pid, self) });
      }
    } catch { /* Observation must not prevent or alter signal delivery. */ }
    return Reflect.apply(originalKill, this, arguments);
  };
  const originalChildKill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function (signal) {
    try {
      if (signal !== 0) {
        const self = processIdentity(process.pid);
        emit("child.kill", { target: this.pid ?? null, signal: signalName(signal),
          exitCode: this.exitCode, signalCode: this.signalCode, self,
          targetIdentity: killTargetIdentity(this.pid, self) });
      }
    } catch { /* Observation must not prevent or alter signal delivery. */ }
    return Reflect.apply(originalChildKill, this, arguments);
  };
  emit("process-start", { ppid: process.ppid, ...processIdentity(process.pid), ...resources() });
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
