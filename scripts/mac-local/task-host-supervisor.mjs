// Owns one Mac-local task-host child, its bounded private log, and its durable stop reason.
// launchd supervises this process; a child crash makes this exit unsuccessfully so launchd restarts it.
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { invokedDirectlyV1 } from "../dev/invoked-directly.mjs";
import { alive, hostCommand, protectedRootFromArguments, repoRoot, runtimePaths, taskHostCommand } from "./stack.mjs";

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

export async function rotateHostLog(path, maxBytes = HOST_LOG_MAX_BYTES, backups = HOST_LOG_BACKUPS) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(backups) || backups < 1)
    throw new Error("mac_local_host_log_policy_invalid");
  const current = await regularPrivateFile(path);
  if (!current || current.size < maxBytes) return false;
  await rm(`${path}.${backups}`, { force: true });
  for (let index = backups - 1; index >= 1; index -= 1) {
    if (await regularPrivateFile(`${path}.${index}`)) await rename(`${path}.${index}`, `${path}.${index + 1}`);
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

  write(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    this.pending = this.pending.then(async () => {
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
    });
    return this.pending;
  }

  line(value) { return this.write(`${new Date().toISOString()} ${value}\n`); }
  async close() { await this.pending; closeSync(this.fd); }
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

async function writePrivateFile(path, content) {
  const temporary = `${path}.new-${process.pid}`;
  await rm(temporary, { force: true });
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

const writeState = (path, state) => writePrivateFile(path, `${JSON.stringify(state)}\n`);

async function stopStaleChild(previous, root, runtime = {}) {
  if (previous?.state !== "running" || !Number.isSafeInteger(previous.pid)
    || !Number.isSafeInteger(previous.childPid)) return;
  const exactAlive = runtime.alive ?? alive;
  if (exactAlive(previous.pid, hostCommand(root)) || !exactAlive(previous.childPid, taskHostCommand(root))) return;
  const signal = runtime.signal ?? process.kill;
  try { signal(-previous.childPid, "SIGKILL"); }
  catch { try { signal(previous.childPid, "SIGKILL"); } catch {} }
  for (let attempt = 0; attempt < 80 && exactAlive(previous.childPid, taskHostCommand(root)); attempt += 1)
    await new Promise(resolve => setTimeout(resolve, 25));
  if (exactAlive(previous.childPid, taskHostCommand(root))) throw new Error("mac_local_stale_task_host_would_not_stop");
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
  const paths = runtimePaths(root);
  const [defaultCommand, ...defaultArgs] = taskHostCommand(root);
  const command = runtime.command ?? defaultCommand;
  const args = runtime.args ?? defaultArgs;
  const signals = runtime.signals ?? process;
  let shutdown, child, childClosed = false, escalation, streamError;
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
  signals.once("SIGTERM", onTerm);
  signals.once("SIGINT", onInt);
  signals.once("SIGHUP", onHangup);
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
    child = (runtime.spawn ?? spawn)(command, args, {
      cwd: repoRoot, detached: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CONTROL_ROOM_TASK_HOST_SUPERVISED: "1" },
    });
    const completion = new Promise(resolve => {
      child.once("error", error => resolve({ code: 1, signal: undefined, error }));
      child.once("close", (code, signal) => { childClosed = true; resolve({ code, signal, error: undefined }); });
    });
    const capture = chunk => { void log.write(chunk).catch(error => {
      streamError ??= error;
      signalChild("SIGKILL");
    }); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    if (shutdown) forward(shutdown.signal, shutdown.deliberate);
    await writePrivateFile(paths.hostPid, `${process.pid}\n`);
    await writeState(paths.hostState, { schema: "control-room.mac-local-host-state/v1", state: "running",
      pid: process.pid, childPid: child.pid, at: new Date().toISOString(),
      ...(lastStop ? { lastStop } : {}) });
    runtime.onStarted?.();
    const result = await completion;
    if (escalation) clearTimeout(escalation);
    if (result.error && !streamError) await log.line(`task host stderr: ${cleanDetail(result.error.message)}`);
    const requestedSignal = shutdown?.deliberate ? shutdown.signal : undefined;
    const reason = streamError ? "supervisor log write failed" : stoppedBecause(result.code, result.signal, requestedSignal);
    if (!streamError) await log.line(`host stopped because ${reason}`);
    await writeState(paths.hostState, { schema: "control-room.mac-local-host-state/v1", state: "stopped",
      reason, at: new Date().toISOString() });
    await rm(paths.hostPid, { force: true });
    // Only a signal explicitly forwarded by the supervisor is deliberate. Any other
    // child exit, including code 0, leaves the service unavailable and must trigger launchd recovery.
    return requestedSignal ? 0 : 1;
  } finally {
    signals.removeListener("SIGTERM", onTerm);
    signals.removeListener("SIGINT", onInt);
    signals.removeListener("SIGHUP", onHangup);
    if (escalation) clearTimeout(escalation);
    if (child && !childClosed) signalChild("SIGKILL");
    if (log) await log.close();
  }
}

async function main() {
  const root = protectedRootFromArguments(process.argv.slice(2));
  if (!root) throw new Error("--protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required");
  process.exitCode = await superviseTaskHost(root);
}

if (invokedDirectlyV1(process.argv[1], import.meta.url)) {
  void main().catch(async error => {
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
