// Local runtime files for the worker inbox watcher.
//
// Everything this tool creates lives under one runtime directory per worker. The
// directory carries a version marker, and the uninstall path refuses to remove anything
// unless that marker is present, so cleanup can never touch a directory this tool did not
// create. No function here reads, writes, or copies a credential value.
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Same shapes the accepted inbox client enforces, so a watcher and the inbox agree on what
// a valid worker ID and repository are.
export const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/;
export const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const RUNTIME_VERSION = "agent-control-room-worker-inbox-platform:v1";
export const MARKER_FILE = "worker-inbox-platform.marker";
export const STATE_FILE = "state.json";
export const LOG_FILE = "watch.log";
export const SIGNAL_FILE = "signal.json";
export const GENERATED_DIRECTORY = "generated";
// launchd captures this process's console output itself, so the generated plist points here
// rather than at the bounded watch.log. These are still this tool's own footprint: once
// launchd creates them, an uninstall that did not know about them would find unrecognised
// files, preserve them, and refuse to remove the runtime directory.
export const LAUNCHD_OUT_LOG = "launchd.out.log";
export const LAUNCHD_ERR_LOG = "launchd.err.log";

// Files and directories this tool may create. Uninstall removes only these.
const OWNED_ENTRIES = [STATE_FILE, LOG_FILE, SIGNAL_FILE, GENERATED_DIRECTORY, LAUNCHD_OUT_LOG, LAUNCHD_ERR_LOG];

export function assertWorkerId(value) {
  if (typeof value !== "string" || !WORKER_ID_PATTERN.test(value)) {
    throw new Error("worker_inbox_platform_worker_id_invalid");
  }
  return value;
}

export function assertRepository(value) {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) {
    throw new Error("worker_inbox_platform_repository_invalid");
  }
  return value;
}

// A worker ID may contain ":" (valid on POSIX, illegal in Windows paths), so the directory
// name is slugged and suffixed with a short digest that keeps distinct IDs distinct.
export function workerSlug(workerId) {
  assertWorkerId(workerId);
  const readable = workerId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
  const digest = createHash("sha256").update(workerId).digest("hex").slice(0, 8);
  return `${readable}-${digest}`;
}

export function runtimeRoot({ override, home = homedir(), environment = process.env } = {}) {
  if (typeof override === "string" && override.trim()) return resolve(override);
  const fromEnvironment = environment?.WORKER_INBOX_RUNTIME;
  if (typeof fromEnvironment === "string" && fromEnvironment.trim()) return resolve(fromEnvironment);
  return join(home, ".agent-control-room", "worker-inbox");
}

export function workerDirectory({ workerId, runtimeRoot: root, ...rest }) {
  return join(runtimeRoot({ override: root, ...rest }), workerSlug(workerId));
}

export const stateFile = directory => join(directory, STATE_FILE);
export const logFile = directory => join(directory, LOG_FILE);
export const signalFile = directory => join(directory, SIGNAL_FILE);
export const generatedDirectory = directory => join(directory, GENERATED_DIRECTORY);
export const markerFile = directory => join(directory, MARKER_FILE);

// Creates the runtime directory and writes the ownership marker. The marker records only
// the schema version and the worker ID; it never records a token or any credential.
export function ensureWorkerDirectory(directory, { workerId }) {
  mkdirSync(directory, { recursive: true });
  const marker = markerFile(directory);
  if (!existsSync(marker)) {
    writeFileSync(marker, `${JSON.stringify({ version: RUNTIME_VERSION, workerId }, null, 2)}\n`, "utf8");
  }
  return directory;
}

function readMarker(directory) {
  try {
    const parsed = JSON.parse(readFileSync(markerFile(directory), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Where the optional extra signal was written. This is a HINT for messages only, NEVER an
// authorisation: anything able to write the marker could otherwise point a path of its choosing at
// cleanup and have uninstall delete it. Removal is driven by the operator naming the directory on
// the uninstall command, so the target comes from the caller rather than from state on disk.
export function recordedExternalSignals(directory) {
  const marker = readMarker(directory);
  return Array.isArray(marker?.externalSignals) ? marker.externalSignals : [];
}

// The atomic writer's temporary files. A process killed between the write and the rename leaves one
// behind, and because it is not a named entry uninstall would preserve it - which makes the runtime
// directory permanently unremovable. These exact name shapes are therefore owned too.
const TEMPORARY_NAME_PATTERN = /^(?:state\.json|signal\.json|worker-inbox-platform\.marker)\.\d+\.tmp$/;

export function isOwnedDirectory(directory) {
  return readMarker(directory)?.version === RUNTIME_VERSION;
}

// Records where the extra signal was written, so the uninstall message can tell the operator which
// directory to name. It authorises nothing: see recordedExternalSignals above.
export function recordExternalSignal(directory, signalPath) {
  const marker = readMarker(directory);
  if (marker?.version !== RUNTIME_VERSION) {
    throw new Error("worker_inbox_runtime_directory_not_owned");
  }
  const recorded = Array.isArray(marker.externalSignals) ? marker.externalSignals : [];
  if (recorded.includes(signalPath)) return false;
  writeJsonAtomic(markerFile(directory), { ...marker, externalSignals: [...recorded, signalPath] });
  return true;
}

export function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Atomic: a reader never observes a half-written state file, so a restart during a tick
// cannot lose the last known action and re-notify.
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, file);
  } catch (error) {
    // Never leave the temporary file behind. It is not an owned entry, so uninstall would preserve
    // it as a foreign file and the runtime directory could then never be removed.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best effort: the original write error is the one worth reporting.
    }
    throw error;
  }
  return file;
}

export function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

// Bounded log: once the file would exceed maxBytes it is reduced to its most recent half
// with an explicit truncation notice, so an unattended watcher cannot grow without limit
// and cannot silently lose the newest evidence.
export function appendBoundedLog(file, text, { maxBytes = 65536 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) {
    throw new Error("worker_inbox_platform_log_bound_invalid");
  }
  const line = text.endsWith("\n") ? text : `${text}\n`;
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  let combined = existing + line;
  let truncated = false;
  if (Buffer.byteLength(combined, "utf8") > maxBytes) {
    const keep = Math.floor(maxBytes / 2);
    const buffer = Buffer.from(combined, "utf8");
    const tail = buffer.subarray(Math.max(0, buffer.length - keep)).toString("utf8");
    const boundary = tail.indexOf("\n");
    combined = `[log truncated by worker-inbox-platform at ${new Date().toISOString()}]\n`
      + (boundary >= 0 ? tail.slice(boundary + 1) : tail);
    truncated = true;
  }
  writeFileSync(file, combined, "utf8");
  return { truncated, bytes: sizeOf(file) };
}

export function writeSignal(file, payload) {
  return writeJsonAtomic(file, payload);
}

export function readSignal(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// Removes only what this tool created. A directory without the ownership marker is refused
// outright, and unrecognised files inside an owned directory are preserved and reported
// rather than deleted.
export function removeOwnedFiles(directory, { dryRun = false, externalFiles = [] } = {}) {
  // Caller-named external files are handled even when the runtime directory is already gone. The
  // normal sequence is to run uninstall once - which reports which directory to name - and then
  // again with the flag, by which point the runtime directory has been removed. Returning early
  // without honouring the flag would make the printed hint impossible to act on.
  //
  // Nothing recorded on disk authorises this: the list comes from the operator's own command, and
  // that is the whole point. A file anything with write access can edit must never be able to make
  // cleanup delete a path of its choosing.
  const removeExternal = () => {
    const done = [];
    for (const target of externalFiles) {
      if (!existsSync(target)) continue;
      if (!dryRun) rmSync(target, { force: true });
      done.push(target);
    }
    return done;
  };
  if (!existsSync(directory)) {
    return { refused: false, missing: true, removed: removeExternal(), preserved: [] };
  }
  const marker = readMarker(directory);
  if (marker?.version !== RUNTIME_VERSION) {
    // Refused means nothing was touched, so the caller-named files are left alone too.
    return {
      refused: true, reason: "worker_inbox_runtime_directory_not_owned", removed: [], preserved: [],
    };
  }
  const removed = [];
  for (const name of OWNED_ENTRIES) {
    const target = join(directory, name);
    if (!existsSync(target)) continue;
    if (!dryRun) rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  // A temporary file left behind by a process killed mid-write is owned too, so a crash cannot leave
  // the runtime directory permanently unremovable.
  for (const name of readdirSync(directory).filter(entry => TEMPORARY_NAME_PATTERN.test(entry))) {
    if (!dryRun) rmSync(join(directory, name), { force: true });
    removed.push(name);
  }
  // Files this tool wrote outside its own directory, named by the operator on this command.
  removed.push(...removeExternal());
  // Compare bare directory entry names, not paths: markerFile() returns a full path, so
  // comparing it to readdirSync() output would classify our own marker as a foreign file
  // and the directory could never be cleaned up. Owned entries and owned temporaries are
  // excluded too, so a dry run does not report something as both removable and preserved.
  const preserved = readdirSync(directory).filter(name =>
    name !== MARKER_FILE && !OWNED_ENTRIES.includes(name) && !TEMPORARY_NAME_PATTERN.test(name));
  let directoryRemoved = false;
  if (!dryRun && preserved.length === 0) {
    try {
      // rmdirSync, not rmSync: fs.rmSync refuses a directory path without recursive: true,
      // which would make a real uninstall silently keep the runtime directory.
      rmSync(markerFile(directory), { force: true });
      rmdirSync(directory);
      directoryRemoved = true;
      removed.push(MARKER_FILE);
    } catch {
      preserved.push(directory);
    }
  }
  return { refused: false, missing: false, removed, preserved, directoryRemoved };
}
