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

// Paths this tool wrote OUTSIDE its own directory. Only exact file paths are ever recorded, never
// a directory, so cleanup can never delete a directory this tool did not create.
function recordedExternalSignals(marker) {
  return Array.isArray(marker?.externalSignals)
    ? marker.externalSignals.filter(entry => typeof entry === "string" && entry.length > 0)
    : [];
}

export function isOwnedDirectory(directory) {
  return readMarker(directory)?.version === RUNTIME_VERSION;
}

// Records a signal file written outside the runtime directory, so uninstall can remove it. Without
// this the optional extra signal - which exists precisely so another process can watch a known path
// - would be orphaned by every uninstall. Idempotent: recording the same path twice is a no-op.
export function recordExternalSignal(directory, signalPath) {
  const marker = readMarker(directory);
  if (marker?.version !== RUNTIME_VERSION) {
    throw new Error("worker_inbox_runtime_directory_not_owned");
  }
  const recorded = recordedExternalSignals(marker);
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
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
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
export function removeOwnedFiles(directory, { dryRun = false } = {}) {
  if (!existsSync(directory)) {
    return { refused: false, missing: true, removed: [], preserved: [] };
  }
  const marker = readMarker(directory);
  if (marker?.version !== RUNTIME_VERSION) {
    return { refused: true, reason: "worker_inbox_runtime_directory_not_owned", removed: [], preserved: [] };
  }
  const removed = [];
  for (const name of OWNED_ENTRIES) {
    const target = join(directory, name);
    if (!existsSync(target)) continue;
    if (!dryRun) rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  // Files written outside this directory - the optional extra signal - are recorded in the marker
  // when they are written. Only the exact recorded file paths are removed; the containing directory
  // is never touched, because this tool did not create it. A recorded path that has since been
  // deleted by the operator is skipped rather than reported as removed.
  for (const target of recordedExternalSignals(marker)) {
    if (!existsSync(target)) continue;
    if (!dryRun) rmSync(target, { force: true });
    removed.push(target);
  }
  // Compare bare directory entry names, not paths: markerFile() returns a full path, so
  // comparing it to readdirSync() output would classify our own marker as a foreign file
  // and the directory could never be cleaned up. Owned entries are excluded too, so a dry
  // run does not report something as both removable and preserved.
  const preserved = readdirSync(directory).filter(name =>
    name !== MARKER_FILE && !OWNED_ENTRIES.includes(name));
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
