import { acquireRecoverablePrivateProcessLockV1, readPrivateProcessLeaseV1 } from "../../src/installer/shared/private-process-lock.mjs";
import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
// Owns one Mac-local task-host child, its bounded private log, and its durable stop reason.
// launchd supervises this process; a child crash makes this exit unsuccessfully so launchd restarts it.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { alive, hostCommand, protectedRootFromArguments, repoRoot, runtimePaths, supervisorLockPaths, taskHostCommand } from "./stack.mjs";

export const HOST_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const HOST_LOG_BACKUPS = 3;

function invalidHostLog(path) {
  const error = new Error("mac_local_host_log_invalid");
  error.path = path;
  return error;
}

async function regularPrivateFile(path) {
  try {
    const entry = await lstat(path);
    // A second link is a second name for the same inode. Rotation renames the directory entry,
    // not the file, so a hardlinked log keeps being written and read through its other name
    // after this stack has moved it to a backup generation and out of its own private runtime.
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1
      || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid())
      throw invalidHostLog(path);
    return entry;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function discardUnsafeDiagnostic(path) {
  const entry = await lstat(path).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (entry?.isDirectory()) {
    // Move the entry without opening or removing anything inside it.
    await rename(path, `${path}.quarantine-${randomBytes(16).toString("hex")}`);
  } else await rm(path, { force: true });
}

export async function rotateHostLog(path, maxBytes = HOST_LOG_MAX_BYTES, backups = HOST_LOG_BACKUPS) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(backups) || backups < 1)
    throw new Error("mac_local_host_log_policy_invalid");
  const current = await regularPrivateFile(path);
  if (!current || current.size < maxBytes) return false;
  await discardUnsafeDiagnostic(`${path}.${backups}`);
  for (let index = backups - 1; index >= 1; index -= 1) {
    const backup = `${path}.${index}`;
    try { if (await regularPrivateFile(backup)) await rename(backup, `${path}.${index + 1}`); }
    catch (error) {
      if (error?.message !== "mac_local_host_log_invalid") throw error;
      // Discard only the unsafe directory entry, without following links or recursing.
      await discardUnsafeDiagnostic(backup);
    }
  }
  await rename(path, `${path}.1`);
  return true;
}

export function openHostLog(path) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  // Checked on the descriptor, not on the path: O_NOFOLLOW has already proved the entry we opened
  // is not a symlink, and the link count is the only thing that says whether a name we do not
  // control can still reach every byte appended to this file.
  const entry = fstatSync(fd);
  if (!entry.isFile() || entry.nlink > 1 || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid()) {
    closeSync(fd);
    throw invalidHostLog(path);
  }
  return fd;
}

export class RotatingHostLog {
  constructor(path, fd, size, maxBytes, backups) {
    this.path = path;
    this.fd = fd;
    this.size = size;
    this.maxBytes = maxBytes;
    this.backups = backups;
    this.pending = Promise.resolve();
  }

  static async open(path, maxBytes = HOST_LOG_MAX_BYTES, backups = HOST_LOG_BACKUPS) {
    let fd, replacedUnsafeLog = false;
    try {
      await rotateHostLog(path, maxBytes, backups);
      fd = openHostLog(path);
    } catch (error) {
      if (error?.path !== path
        || (error?.message !== "mac_local_host_log_invalid" && error?.code !== "ELOOP")) throw error;
      // The log is bounded diagnostic output, not authority-bearing state. A loose or symlinked
      // file restored into the private runtime must never be appended to, but it must not wedge
      // launchd's restart loop either. Removing the directory entry is safe: rm does not follow a
      // symlink, and without recursive=true it refuses a directory or other unexpected shape.
      await rm(path, { force: true });
      fd = openHostLog(path);
      replacedUnsafeLog = true;
    }
    const log = new RotatingHostLog(path, fd, fstatSync(fd).size, maxBytes, backups);
    if (replacedUnsafeLog) await log.line("replaced unsafe existing host log with a new private log");
    return log;
  }

  /** Appends diagnostics, and NEVER rejects. A bounded log is not worth stopping the service
   * over: on a full disk every write raises ENOSPC, and the old behaviour killed the running
   * website host because of it — then could not restart it, because the pid and state writes
   * failed too. A full disk is precisely when the owner most needs the site still serving.
   * The first failure is remembered (and logged once, to stderr) so the condition is visible;
   * after that the bytes are discarded. */
  write(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    this.pending = this.pending.then(async () => {
      if (this.failed) return;
      try {
        let offset = 0;
        while (offset < buffer.length) {
          if (this.size >= this.maxBytes) {
            closeSync(this.fd);
            await rotateHostLog(this.path, this.maxBytes, this.backups);
            this.fd = openHostLog(this.path);
            this.size = 0;
          }
          const length = Math.min(buffer.length - offset, this.maxBytes - this.size);
          writeSync(this.fd, buffer, offset, length);
          this.size += length;
          offset += length;
        }
      } catch (error) {
        this.failed ??= error;
        // Losing the descriptor is the last resort: if it is still open, leaving it open would
        // hold the file we can no longer write. closeSync is guarded so an already-closed
        // descriptor cannot turn a diagnostic failure into an unhandled throw.
        try { closeSync(this.fd); } catch {}
        process.stderr.write(`${new Date().toISOString()} host log write failed (${cleanDetail(error?.message ?? "unknown")}); `
          + "the host keeps serving without diagnostics\n");
      }
    });
    return this.pending;
  }

  line(value) { return this.write(`${new Date().toISOString()} ${value}\n`); }
  async close() { await this.pending; if (!this.failed) try { closeSync(this.fd); } catch {} }
}

function cleanDetail(value) {
  return String(value).replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ").slice(0, 240);
}

export function stoppedBecause(code, signal, requestedSignal) {
  if (requestedSignal) return `requested ${cleanDetail(requestedSignal)}`;
  if (signal) return `signal ${cleanDetail(signal)}`;
  if (Number.isInteger(code)) return `exit code ${code}`;
  return "unknown process exit";
}

// Diagnostic writes, not authority. A directory (or any other shape) where the pid or state file
// belongs — a restored backup, a manual mistake — used to make every start fail with EISDIR, so
// launchd could never bring the site back. Move the entry aside without opening or descending
// into it, so anything inside it comes back out whole, then rename onto the path.
async function writePrivateFile(path, content) {
  const temporary = `${path}.new-${process.pid}`;
  await rm(temporary, { force: true });
  const occupied = await lstat(path).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (occupied && (!occupied.isFile() || occupied.isSymbolicLink())) {
    await rename(path, `${path}.quarantine-${randomBytes(16).toString("hex")}`);
  }
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

const writeState = (path, state) => writePrivateFile(path, `${JSON.stringify(state)}\n`);

async function stopStaleChild(previous, root, runtime = {}) {
  const paths = supervisorLockPaths(root);
  if (!runtime.alive) {
    const lease = readPrivateProcessLeaseV1(paths.childLock);
    previous = lease ? { childPid: lease.pid, childLease: lease.identity } : undefined;
  } else if (previous?.state !== "running" || !Number.isSafeInteger(previous.pid)
    || !Number.isSafeInteger(previous.childPid)) return;
  if (!previous) return;
  const exactAlive = runtime.alive ?? ((pid, command) => alive(pid, command, { path: paths.childLock, identity: previous.childLease }));
  const command = runtime.command ? [runtime.command, ...(runtime.args ?? [])] : taskHostCommand(root);
  if ((runtime.alive && exactAlive(previous.pid, hostCommand(root))) || !exactAlive(previous.childPid, command)) return;
  const signal = runtime.signal ?? process.kill;
  try { signal(-previous.childPid, "SIGKILL"); }
  catch { try { signal(previous.childPid, "SIGKILL"); } catch {} }
  for (let attempt = 0; attempt < 80 && exactAlive(previous.childPid, command); attempt += 1)
    await new Promise(resolve => setTimeout(resolve, 25));
  if (exactAlive(previous.childPid, command)) throw new Error("mac_local_stale_task_host_would_not_stop");
}

export async function readHostState(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid())
      throw new Error("mac_local_host_state_invalid");
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || !["running", "stopped"].includes(parsed.state) || typeof parsed.at !== "string")
      throw new Error("mac_local_host_state_invalid");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Recorded host state is diagnostic context. Callers that are trying to recover or report health
 * need the refusal as evidence, but must not let an unsafe restored file block the host itself. */
export async function readRecoverableHostState(path, reader = readHostState) {
  try { return Object.freeze({ state: await reader(path) }); }
  catch (error) {
    return Object.freeze({ state: undefined,
      unreadable: cleanDetail(error instanceof Error ? error.message : "unknown") });
  }
}

export async function superviseTaskHost(root, runtime = {}) {
  const paths = { ...runtimePaths(root), ...supervisorLockPaths(root) };
  // Own exclusion before any log/state write. A refused second start must have no effects. A
    // wrong-mode, directory or dangling-symlink entry left in the private runtime is NOT "a
    // supervisor is already running": it is damage the owner can clear, so one such entry is
    // quarantined beside itself and the lock retried. Only a real holder gets the busy code, and
    // only the busy code means "do not start".
  const supervisorLock = acquireRecoverablePrivateProcessLockV1(paths.hostLock,
    { busyCode: "mac_local_supervisor_busy", unusableCode: "mac_local_supervisor_lock_unusable" });
  const [defaultCommand, ...defaultArgs] = taskHostCommand(root);
  const command = runtime.command ?? defaultCommand;
  const args = runtime.args ?? defaultArgs;
  const signals = runtime.signals ?? process;
  let shutdown, child, childClosed = false, escalation, streamError, childLock, completion;
  const signalChild = signal => {
    if (!child) return;
    try {
      // The real child is a process-group leader. Test doubles use their own kill method
      // so unit tests cannot accidentally signal an unrelated host process group.
      if (runtime.spawn) child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {}
  };
  const forward = (signal, deliberate = false) => {
    // The first shutdown event owns the classification. A later owner signal must
    // not turn an earlier session-loss recovery into a successful deliberate stop.
    shutdown ??= { signal, deliberate };
    if (!child) return;
    signalChild(signal);
    // Leave five seconds inside launchd's 45-second ExitTimeOut to record the forced stop.
    escalation ??= setTimeout(() => { if (!childClosed) signalChild("SIGKILL"); }, runtime.shutdownMs ?? 40_000);
    if (runtime.unrefShutdown !== false) escalation.unref?.();
  };
  const onTerm = () => forward("SIGTERM", true), onInt = () => forward("SIGINT", true);
  // A hangup is session loss, not an owner request to leave the service stopped.
  const onHangup = () => forward("SIGHUP");
  signals.on("SIGTERM", onTerm);
  signals.on("SIGINT", onInt);
  signals.on("SIGHUP", onHangup);
  let log;
  try {
    log = await RotatingHostLog.open(paths.hostLog, runtime.maxLogBytes, runtime.backups);
    runtime.beforeSpawn?.();
    // The recorded stop reason is diagnostic context, not state this host needs. A file that is
    // not a private regular file we own — a restored backup, a manual edit, anything that landed
    // in runtime/ from outside — must not be able to stop the host from serving. The read is
    // narrowed rather than propagated, exactly as status.mjs narrows its own reason, and the
    // condition is written to the log so the owner can see and clear it.
    const { state: previous, unreadable: stateUnreadable } = await readRecoverableHostState(paths.hostState);
    await log.line("task host supervisor started");
    if (stateUnreadable)
      await log.line(`host state file task-host-state.json could not be read (${cleanDetail(stateUnreadable)}); `
        + "starting without a recorded stop reason");
    const lastStop = previous?.state === "stopped" ? { reason: previous.reason, at: previous.at }
      : previous?.state === "running" ? { reason: "supervisor disappeared without recording an exit", at: new Date().toISOString() }
        : previous?.lastStop;
    if (previous?.state === "running") await log.line(`host stopped because ${lastStop.reason}`);
    await stopStaleChild(previous, root, runtime);
    // Same rule as the supervisor lock above: one unusable entry is quarantined, a real holder
    // is still refused. Without this a directory left at the child lock path stopped the site
    // from ever starting again.
    childLock = acquireRecoverablePrivateProcessLockV1(paths.childLock,
      { busyCode: "mac_local_task_host_busy", unusableCode: "mac_local_task_host_lock_unusable" });
    child = (runtime.spawn ?? spawn)(command, args, {
      cwd: repoRoot, detached: true, stdio: ["pipe", "pipe", "pipe", childLock.fd],
      env: { ...process.env, CONTROL_ROOM_TASK_HOST_SUPERVISED: "1" },
    });
    completion = new Promise(resolve => {
      child.once("error", error => resolve({ code: 1, signal: undefined, error }));
      child.once("close", (code, signal) => { childClosed = true; resolve({ code, signal, error: undefined }); });
    });
    childLock.writeOwner(child.pid, [command, ...args]);
    // The log can no longer reject, so this only guards a future port that can. Diagnostics must
    // never decide whether the site keeps serving: on a full disk this used to SIGKILL the
    // running host, and then the pid and state writes below failed too, so it could not be
    // restarted. The failure is remembered for the recorded stop reason and nothing else.
    // `onChildOutput` observes the child's own output through the same pipe the log sees, so a
    // test can prove the child kept working while the disk is full without writing anything.
    const capture = chunk => {
      runtime.onChildOutput?.(chunk);
      void log.write(chunk).catch(error => { streamError ??= error; });
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    if (shutdown) forward(shutdown.signal, shutdown.deliberate);
    // The pid and state files are DIAGNOSTIC, like the log: they describe a host that is already
    // running and are rebuilt on the next start. Making them a hard requirement meant that on a
    // full disk the ENOSPC from these two writes took down a perfectly healthy site — and left
    // the state file saying "running", so every later start was refused as busy. Recorded once,
    // on stderr, and the host serves on.
    const recordState = async state => {
      try { await writeState(paths.hostState, state); return true; }
      catch (error) {
        process.stderr.write(`${new Date().toISOString()} host state could not be recorded (${cleanDetail(error?.message ?? "unknown")}); `
          + "the host keeps serving\n");
        return false;
      }
    };
    try { await writePrivateFile(paths.hostPid, `${process.pid}\n`); }
    catch (error) {
      process.stderr.write(`${new Date().toISOString()} host pid file could not be written (${cleanDetail(error?.message ?? "unknown")}); `
        + "the host keeps serving\n");
    }
    await recordState({ schema: "control-room.mac-local-host-state/v1", state: "running",
      pid: process.pid, childPid: child.pid, childLease: childLock.identity, at: new Date().toISOString(),
      ...(lastStop ? { lastStop } : {}) });
    // Only the child holds this descriptor now; its death releases the identity lease.
    if (!runtime.spawn) childLock.close();
    runtime.onStarted?.();
    const result = await completion;
    if (escalation) clearTimeout(escalation);
    if (result.error && !streamError) await log.line(`task host stderr: ${cleanDetail(result.error.message)}`);
    const requestedSignal = shutdown?.deliberate ? shutdown.signal : undefined;
    const reason = streamError ? "supervisor log write failed" : stoppedBecause(result.code, result.signal, requestedSignal);
    if (!streamError) await log.line(`host stopped because ${reason}`);
    await recordState({ schema: "control-room.mac-local-host-state/v1", state: "stopped",
      reason, at: new Date().toISOString() });
    await rm(paths.hostPid, { force: true }).catch(() => {});
    // Only a signal explicitly forwarded by the supervisor is deliberate. Any other
    // child exit, including code 0, leaves the service unavailable and must trigger launchd recovery.
    return requestedSignal ? 0 : 1;
  } finally {
    signals.removeListener("SIGTERM", onTerm);
    signals.removeListener("SIGINT", onInt);
    signals.removeListener("SIGHUP", onHangup);
    if (escalation) clearTimeout(escalation);
    try {
      if (child && !childClosed) { signalChild("SIGKILL"); await completion; }
      if (log) await log.close();
    } finally {
      try { childLock?.release(); } finally { supervisorLock.release(); }
    }
  }
}

async function main() {
  const root = protectedRootFromArguments(process.argv.slice(2));
  if (!root) throw new Error("--protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required");
  process.exitCode = await superviseTaskHost(root);
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  void main().catch(async error => {
    if (error?.message === "mac_local_supervisor_busy") {
      console.error("mac_local_supervisor_busy"); process.exitCode = 1; return;
    }
    const root = protectedRootFromArguments(process.argv.slice(2));
    const message = `${new Date().toISOString()} host stopped because supervisor error: ${cleanDetail(error?.message ?? "unknown")}`;
    if (root) {
      const paths = runtimePaths(root);
      try {
        const fd = openHostLog(paths.hostLog);
        writeSync(fd, `${message}\n`);
        closeSync(fd);
      } catch { console.error(message); }
      try { await writeState(paths.hostState, { schema: "control-room.mac-local-host-state/v1", state: "stopped",
        reason: "supervisor error", at: new Date().toISOString() }); }
      catch (stateError) { console.error(`${message}; state could not be recorded: ${cleanDetail(stateError?.message ?? "unknown")}`); }
    } else console.error(message);
    process.exitCode = 1;
  });
}
