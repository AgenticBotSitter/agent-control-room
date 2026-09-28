// Owns one Mac-local task-host child, its bounded private log, and its durable stop reason.
// launchd supervises this process; a child crash makes this exit unsuccessfully so launchd restarts it.
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { protectedRootFromArguments, repoRoot, runtimePaths, taskHostCommand } from "./stack.mjs";

export const HOST_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const HOST_LOG_BACKUPS = 3;

async function regularPrivateFile(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid())
      throw new Error("mac_local_host_log_invalid");
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
  const entry = fstatSync(fd);
  if (!entry.isFile() || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid()) {
    closeSync(fd);
    throw new Error("mac_local_host_log_invalid");
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
    await rotateHostLog(path, maxBytes, backups);
    const fd = openHostLog(path);
    return new RotatingHostLog(path, fd, fstatSync(fd).size, maxBytes, backups);
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

export async function superviseTaskHost(root, runtime = {}) {
  const paths = runtimePaths(root);
  const [defaultCommand, ...defaultArgs] = taskHostCommand(root);
  const command = runtime.command ?? defaultCommand;
  const args = runtime.args ?? defaultArgs;
  const signals = runtime.signals ?? process;
  let requestedSignal, child, childClosed = false, escalation, streamError;
  const forward = signal => {
    requestedSignal ??= signal;
    if (!child) return;
    try { child.kill(signal); } catch {}
    // Leave five seconds inside launchd's 45-second ExitTimeOut to record the forced stop.
    escalation ??= setTimeout(() => { if (!childClosed) try { child.kill("SIGKILL"); } catch {} }, runtime.shutdownMs ?? 40_000);
    if (runtime.unrefShutdown !== false) escalation.unref?.();
  };
  const onTerm = () => forward("SIGTERM"), onInt = () => forward("SIGINT"), onHangup = () => forward("SIGHUP");
  signals.once("SIGTERM", onTerm);
  signals.once("SIGINT", onInt);
  signals.once("SIGHUP", onHangup);
  let log;
  try {
    log = await RotatingHostLog.open(paths.hostLog, runtime.maxLogBytes, runtime.backups);
    runtime.beforeSpawn?.();
    const previous = await readHostState(paths.hostState);
    await log.line("task host supervisor started");
    const lastStop = previous?.state === "stopped" ? { reason: previous.reason, at: previous.at }
      : previous?.state === "running" ? { reason: "supervisor disappeared without recording an exit", at: new Date().toISOString() }
        : previous?.lastStop;
    if (previous?.state === "running") await log.line(`host stopped because ${lastStop.reason}`);
    child = (runtime.spawn ?? spawn)(command, args, {
      cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env: process.env,
    });
    const completion = new Promise(resolve => {
      child.once("error", error => resolve({ code: 1, signal: undefined, error }));
      child.once("close", (code, signal) => { childClosed = true; resolve({ code, signal, error: undefined }); });
    });
    const capture = chunk => { void log.write(chunk).catch(error => {
      streamError ??= error;
      try { child.kill("SIGKILL"); } catch {}
    }); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    if (requestedSignal) forward(requestedSignal);
    await writePrivateFile(paths.hostPid, `${process.pid}\n`);
    await writeState(paths.hostState, { schema: "control-room.mac-local-host-state/v1", state: "running",
      pid: process.pid, childPid: child.pid, at: new Date().toISOString(),
      ...(lastStop ? { lastStop } : {}) });
    runtime.onStarted?.();
    const result = await completion;
    if (escalation) clearTimeout(escalation);
    if (result.error && !streamError) await log.line(`task host stderr: ${cleanDetail(result.error.message)}`);
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
    if (child && !childClosed) try { child.kill("SIGKILL"); } catch {}
    if (log) await log.close();
  }
}

async function main() {
  const root = protectedRootFromArguments(process.argv.slice(2));
  if (!root) throw new Error("--protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required");
  process.exitCode = await superviseTaskHost(root);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch(async error => {
    const root = protectedRootFromArguments(process.argv.slice(2));
    if (root) {
      try {
        const paths = runtimePaths(root), fd = openHostLog(paths.hostLog);
        writeSync(fd, `${new Date().toISOString()} host stopped because supervisor error: ${cleanDetail(error?.message ?? "unknown")}\n`);
        closeSync(fd);
        await writeState(paths.hostState, { schema: "control-room.mac-local-host-state/v1", state: "stopped",
          reason: "supervisor error", at: new Date().toISOString() });
      } catch {}
    }
    process.exitCode = 1;
  });
}
