import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

export const REHEARSAL_SCHEMA = "control-room.mac-local-rehearsal/v1";
export const REHEARSAL_MARKER = ".control-room-rehearsal.json";
export const REHEARSAL_POSTGRES_MARKER = ".control-room-disposable-postgres.json";
export const RESERVED_DATABASE_PORT = 5432;
export const RESERVED_WEB_PORT = 3210;

export const defaultRegistryDirectory = (home = homedir()) =>
  join(home, "Library", "Caches", "Agent Control Room", "rehearsals");
export const defaultOwnerProtectedRoot = (home = homedir()) =>
  join(home, "Library", "Application Support", "Agent Control Room", "Protected");

const productionFiles = Object.freeze({
  chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile,
  uid: () => typeof process.getuid === "function" ? process.getuid() : undefined,
});
const exec = promisify(execFile);
const productionProcessCommand = async pid => {
  try {
    return (await exec("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)],
      { encoding: "utf8", timeout: 10_000 })).stdout.trim() || undefined;
  } catch { return undefined; }
};

const privateRegularFile = (entry, uid) => entry.isFile() && !entry.isSymbolicLink()
  && (entry.mode & 0o077) === 0 && (uid === undefined || entry.uid === uid);
const privateDirectory = (entry, uid) => entry.isDirectory() && !entry.isSymbolicLink()
  && (entry.mode & 0o077) === 0 && (uid === undefined || entry.uid === uid);
const exactArray = value => Array.isArray(value) && value.length > 0
  && value.every(item => typeof item === "string" && item.length > 0 && !/[\u0000\r\n]/u.test(item));

const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
export function forbiddenOwnerRoots(extra = []) {
  return [defaultOwnerProtectedRoot(), process.env.CONTROL_ROOM_OWNER_PROTECTED_ROOT,
    process.env.CONTROL_ROOM_PROTECTED_ROOT, ...extra]
    .filter(value => typeof value === "string" && isAbsolute(value)).map(value => resolve(value));
}
async function canonicalForbiddenOwnerRoots(extra, runtime) {
  return Promise.all(forbiddenOwnerRoots(extra).map(async root => {
    try { return await runtime.realpath(root); } catch { return root; }
  }));
}

export function captureRehearsalOwnership(value) {
  if (!value || value.schema !== REHEARSAL_SCHEMA || typeof value.runId !== "string"
    || !/^[a-f0-9]{32}$/u.test(value.runId) || !isAbsolute(value.root)
    || resolve(value.root) !== value.root || !Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.device) || !Number.isSafeInteger(value.inode)
    || value.device < 0 || value.inode < 1 || !isAbsolute(value.repositoryRoot)
    || resolve(value.repositoryRoot) !== value.repositoryRoot
    || value.databaseDirectory !== join(value.root, "pg")
    || value.protectedRoot !== join(value.root, "protected")
    || !Number.isInteger(value.databasePort) || value.databasePort < 1024 || value.databasePort > 65535
    || !Number.isInteger(value.webPort) || value.webPort < 1024 || value.webPort > 65535
    || value.databasePort === value.webPort || value.databasePort === RESERVED_DATABASE_PORT
    || value.webPort === RESERVED_WEB_PORT || typeof value.createdAt !== "string"
    || !Array.isArray(value.processes) || value.processes.some(process =>
      !process || !["setup", "journey", "host", "child"].includes(process.kind)
      || !Number.isSafeInteger(process.pid) || process.pid <= 1 || !exactArray(process.command)
      || typeof process.group !== "boolean")) {
    throw new Error("rehearsal_ownership_invalid");
  }
  return Object.freeze({ ...value, processes: Object.freeze(value.processes.map(process => Object.freeze({ ...process,
    command: Object.freeze([...process.command]) }))) });
}

async function readPrivateJson(path, runtime, uid) {
  const entry = await runtime.lstat(path);
  if (!privateRegularFile(entry, uid)) throw new Error("rehearsal_ownership_file_unsafe");
  return JSON.parse(await runtime.readFile(path, "utf8"));
}

async function atomicPrivateJson(path, value, runtime) {
  const temporary = `${path}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  await runtime.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await runtime.chmod(temporary, 0o600);
  await runtime.rename(temporary, path);
}

export async function createRehearsalOwnership({ root, databasePort, webPort, repositoryRoot,
  registryDirectory = defaultRegistryDirectory(), processes = [], forbiddenProtectedRoots = [] }, runtime = productionFiles) {
  if (!isAbsolute(root) || resolve(root) !== root || !isAbsolute(repositoryRoot))
    throw new Error("rehearsal_root_must_be_absolute");
  const canonicalRepositoryRoot = resolve(repositoryRoot);
  if (databasePort === RESERVED_DATABASE_PORT || webPort === RESERVED_WEB_PORT)
    throw new Error("rehearsal_reserved_port_refused");
  const uid = runtime.uid?.() ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  await runtime.mkdir(root, { recursive: true, mode: 0o700 });
  await runtime.chmod(root, 0o700);
  const rootEntry = await runtime.lstat(root);
  if (!privateDirectory(rootEntry, uid)) throw new Error("rehearsal_root_unsafe");
  const canonicalRoot = await runtime.realpath(root);
  if ((await canonicalForbiddenOwnerRoots(forbiddenProtectedRoots, runtime))
    .some(protectedRoot => overlaps(canonicalRoot, protectedRoot))) throw new Error("rehearsal_protected_root_refused");
  if ((await runtime.readdir(canonicalRoot)).length !== 0) throw new Error("rehearsal_root_not_empty");
  await runtime.mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  await runtime.chmod(registryDirectory, 0o700);
  const registryEntry = await runtime.lstat(registryDirectory);
  if (!privateDirectory(registryEntry, uid)) throw new Error("rehearsal_registry_unsafe");
  const canonicalRegistryDirectory = await runtime.realpath(registryDirectory);
  const ownership = captureRehearsalOwnership({
    schema: REHEARSAL_SCHEMA,
    runId: randomBytes(16).toString("hex"),
    root: canonicalRoot,
    uid: uid ?? 0,
    device: Number(rootEntry.dev),
    inode: Number(rootEntry.ino),
    repositoryRoot: canonicalRepositoryRoot,
    databaseDirectory: join(canonicalRoot, "pg"),
    protectedRoot: join(canonicalRoot, "protected"),
    databasePort,
    webPort,
    createdAt: new Date().toISOString(),
    processes,
  });
  const markerPath = join(canonicalRoot, REHEARSAL_MARKER);
  await runtime.writeFile(markerPath, `${JSON.stringify(ownership, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await runtime.chmod(markerPath, 0o600);
  try {
    await runtime.writeFile(join(canonicalRegistryDirectory, `${ownership.runId}.json`), `${JSON.stringify(ownership, null, 2)}\n`,
      { mode: 0o600, flag: "wx" });
  } catch (error) {
    await runtime.rm(markerPath, { force: true });
    throw error;
  }
  return ownership;
}

export async function validateRehearsalOwnership({ root, registryDirectory = defaultRegistryDirectory(),
  expectedRunId = undefined, forbiddenProtectedRoots = [] }, runtime = productionFiles) {
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error("rehearsal_root_must_be_absolute");
  const uid = runtime.uid?.() ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const rootEntry = await runtime.lstat(root);
  if (!privateDirectory(rootEntry, uid)) throw new Error("rehearsal_root_unsafe");
  const canonicalRoot = await runtime.realpath(root);
  const marker = captureRehearsalOwnership(await readPrivateJson(join(canonicalRoot, REHEARSAL_MARKER), runtime, uid));
  if (marker.root !== canonicalRoot || marker.uid !== (uid ?? marker.uid) || marker.device !== Number(rootEntry.dev)
    || marker.inode !== Number(rootEntry.ino) || expectedRunId && marker.runId !== expectedRunId)
    throw new Error("rehearsal_ownership_mismatch");
  if ((await canonicalForbiddenOwnerRoots(forbiddenProtectedRoots, runtime)).some(protectedRoot =>
    overlaps(canonicalRoot, protectedRoot) || overlaps(marker.protectedRoot, protectedRoot)))
    throw new Error("rehearsal_protected_root_refused");
  const registryEntry = await runtime.lstat(registryDirectory);
  if (!privateDirectory(registryEntry, uid)) throw new Error("rehearsal_registry_unsafe");
  const canonicalRegistryDirectory = await runtime.realpath(registryDirectory);
  const registryPath = join(canonicalRegistryDirectory, `${marker.runId}.json`);
  const registered = captureRehearsalOwnership(await readPrivateJson(registryPath, runtime, uid));
  if (JSON.stringify(registered) !== JSON.stringify(marker)) throw new Error("rehearsal_registry_mismatch");
  return Object.freeze({ ownership: marker, markerPath: join(canonicalRoot, REHEARSAL_MARKER), registryPath });
}

export async function updateRehearsalProcesses({ root, registryDirectory = defaultRegistryDirectory(), processes,
  forbiddenProtectedRoots = [] }, runtime = productionFiles) {
  const current = await validateRehearsalOwnership({ root, registryDirectory, forbiddenProtectedRoots }, runtime);
  const updated = captureRehearsalOwnership({ ...current.ownership, processes });
  await atomicPrivateJson(current.markerPath, updated, runtime);
  try { await atomicPrivateJson(current.registryPath, updated, runtime); }
  catch (error) {
    await atomicPrivateJson(current.markerPath, current.ownership, runtime).catch(() => {});
    throw error;
  }
  return updated;
}

const appendBounded = (current, chunk, limit) => {
  const next = current + String(chunk);
  return next.length <= limit ? next : next.slice(0, limit);
};

/**
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number,
 *   terminateGraceMs?: number, outputLimit?: number, spawnImpl?: typeof spawn,
 *   processCommand?: (pid: number) => Promise<string | undefined>,
 *   onSpawn?: (record: { pid: number, command: readonly string[], group: boolean }) => void | Promise<void> }} [options]
 */
export function runBoundedChild(command, args = [], { cwd, env = process.env, signal, timeoutMs = 180_000,
  terminateGraceMs = 5_000, outputLimit = 1_048_576, spawnImpl = spawn,
  processCommand = productionProcessCommand, onSpawn } = {}) {
  if (typeof command !== "string" || !command || !Array.isArray(args) || args.some(arg => typeof arg !== "string"))
    throw new Error("rehearsal_child_command_invalid");
  return new Promise(resolvePromise => {
    const child = spawnImpl(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false, childClosed = false, timedOut = false, aborted = false, killTimer, registrationError;
    let registrationSettled = onSpawn === undefined, pendingResult;
    const terminate = reason => {
      if (settled || childClosed || !child.pid) return;
      timedOut ||= reason === "timeout";
      aborted ||= reason === "abort";
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      killTimer = setTimeout(() => {
        if (childClosed || settled) return;
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      }, terminateGraceMs);
      killTimer.unref?.();
    };
    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref?.();
    const onAbort = () => terminate("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (!child.pid) {
      registrationError = new Error("rehearsal_child_pid_missing");
      registrationSettled = true;
    }
    else if (onSpawn) Promise.resolve().then(async () => {
      const actualCommand = await processCommand(child.pid);
      if (!actualCommand) throw new Error("rehearsal_child_identity_unavailable");
      await onSpawn(Object.freeze({ pid: child.pid,
        command: Object.freeze([actualCommand]), group: true }));
    }).then(() => {
        registrationSettled = true;
        if (pendingResult) finish(pendingResult);
      }, error => {
        registrationError = error;
        registrationSettled = true;
        if (pendingResult) finish(pendingResult);
        else terminate("registration");
      });
    child.stdout?.on("data", chunk => { stdout = appendBounded(stdout, chunk, outputLimit); });
    child.stderr?.on("data", chunk => { stderr = appendBounded(stderr, chunk, outputLimit); });
    child.once("error", error => complete({ status: null, signal: null, error }));
    child.once("close", (status, childSignal) => complete({ status, signal: childSignal, error: undefined }));
    function complete(result) {
      childClosed = true;
      clearTimeout(killTimer);
      if (!registrationSettled) { pendingResult = result; return; }
      finish(result);
    }
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(Object.freeze({ ...result, error: registrationError ?? result.error, stdout, stderr, timedOut, aborted }));
    }
  });
}

export function installRehearsalSignalCleanup(cleanup, { processObject = process,
  exit = code => processObject.exit(code) } = {}) {
  let requested;
  let completion;
  const handler = signal => {
    requested ??= signal;
    completion ??= Promise.resolve().then(cleanup).then(
      () => exit(requested === "SIGINT" ? 130 : 143),
      () => exit(1));
  };
  const interrupt = () => handler("SIGINT"), terminate = () => handler("SIGTERM");
  processObject.once("SIGINT", interrupt);
  processObject.once("SIGTERM", terminate);
  return Object.freeze({
    requested: () => requested,
    wait: () => completion ?? Promise.resolve(),
    dispose: () => {
      processObject.removeListener("SIGINT", interrupt);
      processObject.removeListener("SIGTERM", terminate);
    },
  });
}
