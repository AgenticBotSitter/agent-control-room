import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { exactHostDataSnapshotV1 } from "../../security/host-value";

/** Exact retained tool closure. This preflight imports or executes none of it. */
export const privateRecoveryReviewedToolPathsV1 = Object.freeze([
  "deploy/postgres/backup-database.mjs", "deploy/postgres/restore-database.mjs",
  "deploy/postgres/restore-identity.mjs", "deploy/postgres/evidence.mjs",
  "deploy/postgres/apply-migrations.mjs", "deploy/postgres/migration-ledger.json",
  "deploy/postgres/private-owner-dependency-manifest.json", "db/roles/production_roles.sql",
] as const);
const toolNames = ["node", "pg_dump", "pg_restore"] as const;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const readAborted = Reflect.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const blockers = Object.freeze([
  "pin_provenance_missing",
  "private_source_credentials_required",
  "protected_backup_destination_required",
  "native_tool_execution_and_dependency_custody_required",
  "isolated_disposable_cluster_observation_required",
  "quiesced_source_and_protected_artifact_inventory_required",
  "restricted_login_observations_required",
  "subprocess_connection_and_target_retirement_required",
] as const);
type Pin = Readonly<{ path: string; sha256: string }>;
type Held = { path: string; handle: FileHandle; initial: Stats; digest?: string };
type Input = Readonly<{
  releaseRoot: string; releaseDigest: string; requestDigest: string; expectedOwnerUid: number;
  reviewedFiles: Readonly<Record<typeof privateRecoveryReviewedToolPathsV1[number], string>>;
  executables: Readonly<Record<typeof toolNames[number], Pin>>;
  signal: AbortSignal; deadlineMs: number;
}>;
const refused = (): never => { const e = new Error("private_recovery_tool_preflight_refused"); e.stack = undefined; throw e; };
function path(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/"
    || value.endsWith("/") || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return refused();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}
function capture(value: Input): Input {
  const input = exactHostDataSnapshotV1(value, ["releaseRoot", "releaseDigest", "requestDigest", "expectedOwnerUid",
    "reviewedFiles", "executables", "signal", "deadlineMs"]);
  const files = exactHostDataSnapshotV1(input?.reviewedFiles, privateRecoveryReviewedToolPathsV1);
  const executables = exactHostDataSnapshotV1(input?.executables, toolNames);
  if (!input || !files || !executables || !Number.isSafeInteger(input.expectedOwnerUid)
    || typeof process.geteuid !== "function" || input.expectedOwnerUid !== process.geteuid()
    || !Number.isSafeInteger(input.deadlineMs) || (input.deadlineMs as number) < 1
    || (input.deadlineMs as number) > 30_000) return refused();
  // The AbortSignal is a trusted host control, not a JSON configuration field.
  try { Reflect.apply(readAborted, input.signal, []); }
  catch { return refused(); }
  const pinned = Object.fromEntries(toolNames.map(name => {
    const pin = exactHostDataSnapshotV1(executables[name], ["path", "sha256"]);
    if (!pin) return refused();
    return [name, Object.freeze({ path: path(pin.path), sha256: digest(pin.sha256) })];
  })) as Input["executables"];
  if (new Set(toolNames.map(name => pinned[name].path)).size !== toolNames.length) return refused();
  return Object.freeze({ releaseRoot: path(input.releaseRoot), releaseDigest: digest(input.releaseDigest),
    requestDigest: digest(input.requestDigest), expectedOwnerUid: input.expectedOwnerUid as number,
    reviewedFiles: Object.freeze(Object.fromEntries(privateRecoveryReviewedToolPathsV1.map(name => [name, digest(files[name])]))) as Input["reviewedFiles"],
    executables: Object.freeze(pinned), signal: input.signal as AbortSignal, deadlineMs: input.deadlineMs as number });
}
function same(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Shared mode policy, including special bits that some fixture filesystems strip. */
export function privateRecoveryToolModeAllowedV1(mode: number, kind: "executable" | "release_file" | "directory"): boolean {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0xffffffff) return false;
  if (kind === "executable") return (mode & 0o7022) === 0 && (mode & 0o111) !== 0;
  if (kind === "release_file") return (mode & 0o7777) === 0o600;
  if (kind === "directory") return (mode & 0o7777) === 0o700;
  return false;
}

/**
 * Concrete read-only filesystem preflight for the recovery host. Captures and
 * retains exact file descriptors; never imports tools, connects, restores,
 * acquires credentials, or returns runnable arguments. Holding an fd does not
 * prove spawn-by-path custody, so this cannot produce installation readiness.
 * The deadline is cooperative between bounded regular-file reads: it is not a
 * hard native I/O cancellation guarantee.
 */
export async function openPrivateRecoveryToolPreflightV1(value: Input) {
  const input = capture(value), end = performance.now() + input.deadlineMs;
  const held: Held[] = [];
  let closed = false, busy = false;
  const check = () => { if (closed || Reflect.apply(readAborted, input.signal, []) || performance.now() >= end) return refused(); };
  const checkFile = (entry: Held, current: Stats) => {
    if (!same(entry.initial, current)) return refused();
  };
  const close = async () => {
    if (busy) return refused();
    closed = true; busy = true;
    try {
      let failed = false;
      for (const entry of [...held]) {
        try { await entry.handle.close(); held.splice(held.indexOf(entry), 1); } catch { failed = true; }
      }
      if (failed) {
        const error = new Error("private_recovery_tool_preflight_retirement_uncertain"); error.stack = undefined; throw error;
      }
      return Object.freeze({ retired: true as const, modifiedFiles: false as const, startedProcesses: false as const });
    } finally { busy = false; }
  };
  async function hashHeld(entry: Held) {
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    try {
      let position = 0;
      while (position < entry.initial.size) {
        check();
        const { bytesRead } = await entry.handle.read(buffer, 0, Math.min(buffer.length, entry.initial.size - position), position);
        if (bytesRead === 0) return refused();
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      return `sha256:${hash.digest("hex")}`;
    } finally { buffer.fill(0); }
  }
  async function inspectEntry(entry: Held) {
    check();
    if (await realpath(entry.path) !== entry.path) return refused();
    checkFile(entry, await entry.handle.stat());
    checkFile(entry, await stat(entry.path));
    if (entry.digest && await hashHeld(entry) !== entry.digest) return refused();
    checkFile(entry, await entry.handle.stat()); checkFile(entry, await stat(entry.path));
    check();
  }
  async function acquire(filePath: string, expectedDigest: string | undefined, executable = false) {
    check();
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      | (expectedDigest ? 0 : constants.O_DIRECTORY));
    // Register immediately: every subsequent refusal retires the opened fd.
    let initial: Stats;
    try { initial = await handle.stat(); } catch { await handle.close(); return refused(); }
    const entry: Held = { path: filePath, handle, initial, digest: expectedDigest };
    held.push(entry);
    const s = entry.initial;
    if (expectedDigest) {
      const maximum = executable ? 512 * 1024 * 1024 : 32 * 1024 * 1024;
      if (!s.isFile() || s.nlink !== 1 || s.size < 1 || s.size > maximum
        || !privateRecoveryToolModeAllowedV1(s.mode, executable ? "executable" : "release_file")
        || (executable ? s.uid !== input.expectedOwnerUid && s.uid !== 0 : s.uid !== input.expectedOwnerUid)) return refused();
    } else if (!s.isDirectory() || s.uid !== input.expectedOwnerUid || !privateRecoveryToolModeAllowedV1(s.mode, "directory")) return refused();
    await inspectEntry(entry);
  }
  async function inspect() {
    if (busy) return refused();
    busy = true;
    try {
      check();
      for (const entry of held) await inspectEntry(entry);
      return Object.freeze({ schema: "control-room.private-recovery-tool-preflight/v1" as const,
        // These observations compare bytes with caller-supplied pins only.
        // No accepted release/authority proof has authenticated those pins.
        pinProvenanceVerified: false as const,
        releaseFilesMatchingSuppliedPins: privateRecoveryReviewedToolPathsV1.length,
        executableFilesMatchingSuppliedPins: toolNames.length,
        readyForExecution: false as const, dependencyContentsVerified: false as const,
        extendedAclVerified: false as const, observedDatabase: false as const,
        grantsRecoveryAuthority: false as const, remainingBlockers: blockers });
    } catch { return refused(); }
    finally { busy = false; }
  }
  try {
    await acquire(input.releaseRoot, undefined);
    const directories = new Set<string>();
    for (const name of privateRecoveryReviewedToolPathsV1) {
      let directory = dirname(join(input.releaseRoot, name));
      while (directory !== input.releaseRoot) { directories.add(directory); directory = dirname(directory); }
    }
    for (const directory of [...directories].sort((a, b) => a.length - b.length)) {
      const rel = relative(input.releaseRoot, directory);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return refused();
      await acquire(directory, undefined);
    }
    for (const name of privateRecoveryReviewedToolPathsV1) await acquire(join(input.releaseRoot, name), input.reviewedFiles[name]);
    for (const name of toolNames) await acquire(input.executables[name].path, input.executables[name].sha256, true);
    await inspect();
    return Object.freeze({ inspect, close });
  } catch {
    await close();
    return refused();
  }
}
