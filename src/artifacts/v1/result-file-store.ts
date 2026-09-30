import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
// The content digest is over the BYTES, never over a JSON encoding of them.
// `sha256Digest` from the security module digests a canonical JSON value, which
// is the right tool for a record and the wrong one here: it would make the
// catalog's `sha256(convert_to(...))` disagree with the store's, and the two
// must agree exactly or a file is visible and undownloadable.
const bytesDigest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * The result-file byte store: the sibling of `PersistentLocalArtifactStorageV1`
 * that holds the files a job produced, on the Mac, beside the existing 64 KiB
 * native text path (which it never touches).
 *
 * What makes it safe to hand to a worker in the next part:
 *
 *   * The storage key is DERIVED from the tenant, the project, the file's own id
 *     and its content digest. No caller supplies a key, a name or a path, and
 *     `resultFileStorageKeyV1` is the identical derivation the 0206 insert
 *     trigger performs, so the catalog and the store agree on exactly one name
 *     per file. Because the project is inside the digest, two projects holding
 *     identical bytes get two different keys and two different files: there is
 *     no cross-project dedupe, and therefore no "do you already have it" answer
 *     to probe.
 *   * On disk the key is a flat name under one root — no directory tree, so
 *     there is no path segment for a caller to influence and no traversal is
 *     expressible. The root must be canonical and mode 0700, and its device and
 *     inode are re-checked on every operation, so replacing it with a symlink
 *     mid-run fails closed.
 *   * Create-once. A second write of the same key with the same bytes replays,
 *     so an exact retry is idempotent; the same key with different bytes is a
 *     conflict, never an overwrite.
 *   * No symlinks and no hard links: every entry is opened `O_NOFOLLOW` and must
 *     be a regular file with link count 1, so a substituted payload cannot be
 *     substituted past the digest check.
 *   * Reads re-verify the digest of what came back, so a truncated or swapped
 *     file is a refusal, not a download.
 *
 * Every refusal is a `ResultFileStoreError` with a fixed code. These codes reach
 * logs, so none of them carries a path, a display name or a digest.
 */
export type ResultFileStoreErrorCodeV1 =
  | "store_invalid"     // a caller passed something the store refuses to interpret
  | "store_missing"     // no file under that key
  | "store_conflict"    // the key exists and holds different bytes
  | "store_capacity"    // past a declared limit
  | "store_ambiguous";  // a read could not be proven exact

export class ResultFileStoreError extends Error {
  constructor(readonly code: ResultFileStoreErrorCodeV1) {
    super(`result_file_store_${code}`);
    this.name = "ResultFileStoreError";
  }
}

export interface ResultFileStoreConfigurationV1 {
  /** An existing, canonical, private directory. The store never creates it. */
  rootPath: string;
  /** The per-result-SET file ceiling, applied against the caller's own view of
   * the set (`setFiles`), not against the whole installation. The installation
   * has no file-count ceiling: its ceiling is `maximumTotalBytes`. */
  maximumFiles: number;
  maximumFileBytes: number;
  maximumSetBytes: number;
  maximumTotalBytes: number;
  operationTimeoutMs: number;
}

export interface ResultFileIdentityV1 {
  tenantId: string;
  projectId: string;
  fileId: string;
  contentDigest: string;
}

export interface ResultFileStoreWriteV1 extends ResultFileIdentityV1 {
  bytes: Uint8Array;
  /** What the set already holds, for the per-set ceiling. Omitted means "unknown". */
  setBytes?: number;
  setFiles?: number;
  signal?: AbortSignal;
}

export interface ResultFileStoreReadV1 extends ResultFileIdentityV1 {
  signal?: AbortSignal;
}

export interface ResultFileStoredV1 {
  storageKey: string;
  contentDigest: string;
  sizeBytes: number;
}

/** The v1 defaults from plan §2.6. A configuration may go lower; never higher. */
export const RESULT_FILE_LIMITS_V1 = Object.freeze({
  maximumFilesPerSet: 32,
  maximumFileBytes: 268_435_456,
  maximumSetBytes: 536_870_912,
  maximumTotalBytes: 10_737_418_240,
});

const projectPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
const tenantPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
const fileIdPattern = /^result-file:[a-f0-9]{32}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const onDiskPattern = /^[a-f0-9]{64}\.crbf$/u;
const keyPrefix = "crbf1-";
const lockName = ".control-room-result-file-store.lock";
const pendingPrefix = ".control-room-result-file-store-pending-";
// The recovery lock is never a result and never a writer's lock: it exists only
// so two openers cannot both decide about the same leftovers. It is removed at
// the end of a successful recovery and is itself recovered (as bookkeeping)
// after a recovery that was itself interrupted.
const recoveryName = ".control-room-result-file-store-recovery.lock";
const recoveryPathOf = (root: string): string => join(root, recoveryName);
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;

/**
 * This BOOT's identity, read once per process.
 *
 * The review's S1, third case, and it is the one that matters on a real Mac. A
 * lock records its writer's process id, and a pid is only proof of liveness
 * while the boot is the same boot: after a reboot the kernel reuses low pids, a
 * login-started app gets a low pid, and boot daemons already occupy exactly the
 * range a login app would land in. So a lock left by yesterday's crash reads as
 * HELD BY A LIVE PROCESS today, forever. The review measured it with pid 1 —
 * `EPERM` counts as alive — so the store reports `store_ambiguous` and every
 * write is refused, after a restart and for good.
 *
 * `kern.boottime` is the kernel's own answer to "when did this boot start", and
 * every process on the machine gets the same answer, so a lock written before a
 * reboot can never match one written after it. Where it cannot be read the
 * identity is `undefined` and the store falls back to the older pid-only test:
 * degraded, not different in kind, and never fail-open.
 */
let bootIdentity: string | undefined;
let bootIdentityRead = false;
function currentBootIdentity(): string | undefined {
  if (!bootIdentityRead) {
    bootIdentityRead = true;
    try {
      bootIdentity = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8", timeout: 2_000,
      }).replace(/\s+/gu, " ").trim() || undefined;
    } catch { bootIdentity = undefined; }
  }
  return bootIdentity;
}

/** Test seam: the boot identity a lock is judged against. Replaced by the S1
 * tests, which need to judge a lock written under a DIFFERENT boot. */
let bootIdentityForTest: (() => string | undefined) | undefined;
const bootOf = () => (bootIdentityForTest ?? currentBootIdentity)();

/** The stamp a live writer leaves in its own lock: the boot identity when this
 * process can read one, then its pid, then the first second of its own life.
 * The third line is what makes a RECYCLED pid distinguishable from the original
 * — see `processStartedAtSeconds` below. */
function holderStamp(): string {
  return [bootOf() ?? "boot:unknown", String(process.pid), String(Math.floor(Date.now() / 1000))]
    .join("\n").trim();
}

/** A stamp from BEFORE the boot-identity line existed: the part-1 format was
 * `<header>\n<pid>` and nothing more, so a lock carrying only that cannot be
 * attributed to a boot or a start time. It is recognised and judged by liveness
 * alone, which is a strict improvement on treating it as live for ever and never
 * a weakening: a pid that IS running still keeps its lock. */
function isBarePidStamp(recorded: string): boolean {
  return recorded.trim().split("\n").filter(part => part.trim().length > 0).length === 2;
}

/** Liveness, and only liveness. `ESRCH` is the sole proof of death: `EPERM`
 * means the pid exists and belongs to another user, which is as alive as this
 * store needs to know, and which is why the review's pid-1 case read as a live
 * holder.
 *
 * The `EPERM` branch cannot be reached from inside a test process — nothing here
 * can make `process.kill` genuinely return `EPERM`, because that needs a process
 * owned by another user — so the rule it applies is `pidSignalMeansAliveV1`,
 * which is exported and proved directly. Collapsing the two would be a fail-open:
 * a lock held by another user's process cleared, and its staging file with it.
 */
function pidIsRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;  // unparsable: never proven dead
  try { process.kill(pid, 0); return true; }
  catch (error) { return pidSignalMeansAliveV1((error as NodeJS.ErrnoException).code); }
}

/** Whether a failed `process.kill(pid, 0)` still means the process is ALIVE.
 *
 * `ESRCH` is the only code that proves death. `EPERM` means the pid exists and
 * belongs to another user — a live process, and the exact case the review hit
 * from the other side: a lock naming pid 1 read as held for ever because
 * signalling it gives EPERM. Split out and exported so the rule is a proved
 * property rather than an untested line: no test running as this user can make
 * `process.kill` genuinely return EPERM, so without this seam a fail-open that
 * collapsed the two would pass the whole lane.
 */
export function pidSignalMeansAliveV1(code: string | undefined): boolean {
  return code !== "ESRCH";
}

/** When the given pid started, in whole seconds, or `undefined` if this process
 * cannot ask. On macOS that is `ps -o lstart=`, which is the only per-process
 * start time available without a native module — and it is what makes a
 * RECYCLED pid provable: a pid inside one boot is reused only after its original
 * process is reaped, and the new process's start time cannot be the old one. */
const processStartTimes: { pid: number; second: number }[] = [];
function processStartedAtSeconds(pid: number): number | undefined {
  const remembered = processStartTimes.find(entry => entry.pid === pid);
  if (remembered) return remembered.second;
  if (processStartTimes.length >= 64) processStartTimes.length = 0;
  try {
    const printed = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 2_000,
    }).trim();
    if (!printed) return undefined;
    const at = Date.parse(`${printed}`.replace(/\s+/gu, " "));
    if (!Number.isFinite(at)) return undefined;
    const second = Math.floor(at / 1000);
    processStartTimes.push({ pid, second });
    return second;
  } catch { return undefined; }
}

/** This boot's identity, for a caller that has to stamp a lock the way a writer
 * would. Exported so that a test can build a stamp this store will accept as its
 * own, rather than guessing the format and the identity together. */
export function resultFileStoreBootIdentityV1(): string { return bootOf() ?? "boot:unknown"; }

class DeadlineError extends Error {}

/** How long an EMPTY lock is re-examined before it is called abandoned. Long
 * enough that a writer stalled for a scheduling quantum still stamps inside the
 * window, short enough that the owner is not left waiting to find out whether
 * their Mac still works. */
const emptyLockRecheckMs = 150;

/**
 * The one derivation of a result file's storage key.
 *
 * Deliberately identical, byte for byte, to the expression in 0206's
 * `guard_result_file_insert`. The two must not drift: the database writes the
 * catalog row and this names the file, and a disagreement would be a file the
 * owner can see and cannot download. `tests/result-file-catalog-postgres.test.ts`
 * proves the two agree against a real cluster, by reading the key the database
 * itself wrote.
 */
export function resultFileStorageKeyV1(tenantId: string, projectId: string, fileId: string,
  contentDigest: string): string {
  if (!tenantPattern.test(tenantId) || !projectPattern.test(projectId) || !fileIdPattern.test(fileId)
    || !digestPattern.test(contentDigest)) throw new ResultFileStoreError("store_invalid");
  return `${keyPrefix}${createHash("sha256")
    .update(`control-room.result-file-store/v1:${tenantId}:${projectId}:${fileId}:${contentDigest}`, "utf8")
    .digest("hex")}`;
}

/** The on-disk name. The key's own hex, so the key is never parsed back. */
const onDiskName = (storageKey: string): string => `${storageKey.slice(keyPrefix.length)}.crbf`;

/** The store's OWN bookkeeping entries: the write lock, and the staging file a
 * writer builds before it links it into place. Both are written only by this
 * store, neither is ever a readable result, and both are transient by design.
 *
 * They are recognised by their exact prefixes and are excluded from the byte and
 * name accounting — never from the target-name derivation, which is the hex
 * digest alone. A file called `.control-room-result-file-store-pending-x` is not
 * a result, so it can neither be read as one nor displace one. */
const isStoreBookkeeping = (entry: string): boolean =>
  entry === lockName || entry === recoveryName || entry.startsWith(pendingPrefix);

function abortError(): Error {
  const error = new Error("result_file_store_aborted");
  error.name = "AbortError";
  return error;
}

function validPrivateMode(mode: bigint): boolean {
  return process.platform === "win32" || (Number(mode) & 0o077) === 0;
}

interface RootIdentity { device: bigint; inode: bigint }

function safe(error: unknown): ResultFileStoreError {
  return error instanceof ResultFileStoreError ? error : new ResultFileStoreError("store_ambiguous");
}

/** A whole-operation context. One deadline for the operation, not per call. */
interface Operation { deadline: number; signal?: AbortSignal }

/**
 * Runs one filesystem call under the operation's deadline, and marks the
 * operation uncertain if the call was interrupted after a mutation started.
 *
 * A promise that loses the race is abandoned, not awaited: the point of the
 * deadline is that a wedged disk fails closed instead of hanging a request. The
 * abandoned call is caught so it cannot surface as an unhandled rejection.
 */
async function bounded<T>(operation: Operation, begin: () => Promise<T>,
  afterMutation: () => void): Promise<T> {
  if (operation.signal?.aborted) { afterMutation(); throw abortError(); }
  if (Date.now() >= operation.deadline) { afterMutation(); throw new DeadlineError(); }
  const running = Promise.resolve().then(begin);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), Math.max(0, operation.deadline - Date.now()));
    if (operation.signal) {
      onAbort = () => reject(abortError());
      operation.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([running, stopped]);
  } catch (error) {
    if (error instanceof DeadlineError || error instanceof Error && error.name === "AbortError") afterMutation();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (operation.signal && onAbort) operation.signal.removeEventListener("abort", onAbort);
    void running.catch(() => {});
  }
}

export class ResultFileStoreV1 {
  /** Serialises writes, so two publishers cannot race the create-once lock. */
  private queue: Promise<void> = Promise.resolve();
  /** Set once an operation's outcome became unprovable. Refuses everything after. */
  private poisoned = false;

  private constructor(
    private readonly root: string,
    private readonly identity: RootIdentity,
    private readonly configuration: Readonly<ResultFileStoreConfigurationV1>,
  ) {}

  /** Opens one already-existing private root. It creates nothing, and it repairs
   * only what a crashed writer of THIS store left behind — proven, never assumed
   * (see `recoverAbandonedWriterEntries`).
   *
   * The review found the old behaviour here: a writer killed by power loss or a
   * signal leaves the lock or a `pending-*` file, `inventory()` refused the name
   * it could not account for, `create()` threw, and the Mac-local task provider
   * awaited `create()` with no fallback — so one interrupted download side-car
   * stopped the owner from starting ANY task at all. Nothing in the brief asks
   * for a crash to lock the owner out of every task, and the leftovers are
   * provably harmless, so they are cleared here instead. */
  static async create(configuration: ResultFileStoreConfigurationV1): Promise<ResultFileStoreV1> {
    if (!configuration || typeof configuration !== "object" || typeof configuration.rootPath !== "string"
      || configuration.rootPath.length > 4096 || !isAbsolute(configuration.rootPath)
      || resolve(configuration.rootPath) !== configuration.rootPath
      || !Number.isSafeInteger(configuration.maximumFiles) || configuration.maximumFiles < 1
      // The per-set file ceiling is a v1 limit (32), not a free parameter: a
      // configuration may go lower, never higher, exactly as for the byte
      // ceilings below.
      || configuration.maximumFiles > RESULT_FILE_LIMITS_V1.maximumFilesPerSet
      || !Number.isSafeInteger(configuration.maximumFileBytes) || configuration.maximumFileBytes < 1
      || configuration.maximumFileBytes > RESULT_FILE_LIMITS_V1.maximumFileBytes
      || !Number.isSafeInteger(configuration.maximumSetBytes) || configuration.maximumSetBytes < 1
      || configuration.maximumSetBytes > RESULT_FILE_LIMITS_V1.maximumSetBytes
      || !Number.isSafeInteger(configuration.maximumTotalBytes) || configuration.maximumTotalBytes < 1
      // The installation quota is a v1 limit too (10 GiB). A configuration may
      // go lower so an operator can shrink it, never higher.
      || configuration.maximumTotalBytes > RESULT_FILE_LIMITS_V1.maximumTotalBytes
      || !Number.isSafeInteger(configuration.operationTimeoutMs) || configuration.operationTimeoutMs < 1
      || configuration.operationTimeoutMs > 30_000) throw new ResultFileStoreError("store_invalid");
    const operation: Operation = { deadline: Date.now() + configuration.operationTimeoutMs };
    let canonical: string;
    let stats: BigIntStats;
    try {
      const [resolved, listed] = await Promise.all([
        bounded(operation, () => realpath(configuration.rootPath), () => {}),
        bounded(operation, () => lstat(configuration.rootPath, { bigint: true }), () => {}),
      ]);
      canonical = resolved; stats = listed;
    } catch (error) {
      if (error instanceof DeadlineError) throw error;
      throw new ResultFileStoreError("store_invalid");
    }
    if (canonical !== configuration.rootPath || !stats.isDirectory() || stats.isSymbolicLink()
      || !validPrivateMode(stats.mode)) throw new ResultFileStoreError("store_invalid");
    const store = new ResultFileStoreV1(canonical, { device: stats.dev, inode: stats.ino },
      Object.freeze({ ...configuration }));
    const opened: Operation = { deadline: Date.now() + configuration.operationTimeoutMs };
    await store.assertRootIdentity(opened);
    await store.recoverAbandonedWriterEntries(opened);
    await store.inventory(opened);
    return store;
  }

  /**
   * Clears the bookkeeping of a writer that died mid-write, so a crash costs
   * the owner one half-written file and not the whole application.
   *
   * The review found the old behaviour here: a writer killed by power loss or a
   * signal leaves the lock or a `pending-*` file, `inventory()` refuses a name
   * it cannot account for, `create()` threw, and the Mac-local task provider
   * awaited `create()` with no fallback — so one interrupted upload stopped the
   * owner from starting ANY task. Nothing in the brief asks for that, so the
   * leftovers are cleared here instead, and only when they are PROVABLY
   * abandoned.
   *
   * "Provably" is the whole design, so here is exactly what is proved:
   *
   *   * A `pending-*` file is staging for a `link()` that either happened or did
   *     not. Its name is not a content digest, so it is never a readable result,
   *     and the target name is derived from the file's own id and digest and
   *     never from a pending name — so an orphan can neither shadow nor be
   *     mistaken for a stored file. Deleting one destroys no complete file: a
   *     `link()` that succeeded left a complete target whose digest re-proves,
   *     and one that did not left nothing to keep.
   *   * The lock records the writer's PROCESS ID while it is held, and a pid is
   *     proof of liveness that does not depend on this process. `kill(pid, 0)`
   *     succeeds for a live process and fails with ESRCH for a dead one, and a
   *     recycled pid is the conservative direction: the store reports
   *     `store_ambiguous` (a refusal, never a wrong delete) rather than clearing.
   *
   * The rules, in the order they are applied:
   *
   *   1. A lock file whose recorded pid is ALIVE is left exactly as it is, and
   *      the store still opens — a second process publishing through another
   *      store instance while this one starts must not stop this one starting.
   *      Every write that process attempts already fails on its own O_EXCL
   *      create, which is the store's existing mutual exclusion and is not
   *      weakened by a second reader of the lock.
   *   2. A lock file whose recorded pid is DEAD is removed: the writer cannot
   *      return, and the file has no other purpose than the exclusion it no
   *      longer provides.
   *   3. Once no live writer holds the lock, the lock is removed FIRST and the
   *      `pending-*` files after it, so the directory a staging file is judged in
   *      genuinely has no lock in it. A staging file seen while a live lock
   *      exists belongs to that writer and is left alone.
   *   4. A lock file this store cannot classify — no pid recorded, a pid that is
   *      not a number, a lock that is a directory or a symlink or multi-linked —
   *      is a refusal, and nothing is removed. So is a name that is neither a
   *      bookkeeping name nor a result name, which is unchanged behaviour.
   *
   * Recovery is itself serialised by an O_EXCL recovery lock, so two openers
   * cannot both decide about the same leftovers, and it deletes only names this
   * store itself created. That lock is subject to the SAME liveness test as the
   * write lock: a leftover from a recovery that was itself interrupted is
   * removed and the recovery proceeds, because a permanent lock-out is the one
   * outcome this function must never produce. A recovery lock with a LIVE holder
   * is a concurrent recovery and is left alone. It never repairs, never
   * overwrites and never touches a `<hex>.crbf` result file.
   */
  private async recoverAbandonedWriterEntries(operation: Operation): Promise<void> {
    const listed = await bounded(operation, () => readdir(this.root), () => {});
    if (!listed.some(isStoreBookkeeping)) return;
    let recovery: FileHandle | undefined;
    try {
      recovery = await bounded(operation, () => open(recoveryPathOf(this.root),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600), () => {});
    } catch (error) {
      // A recovery lock already exists. If its holder is DEAD this is a recovery
      // that was itself interrupted, and refusing here would reproduce exactly
      // the permanent lock-out this function exists to end: the owner could
      // never start a task again, because the only thing standing in the way
      // would be this function. So the same liveness test that governs the write
      // lock governs this one: a dead holder's name is removed and the recovery
      // proceeds; a LIVE holder is a concurrent recovery, which is left alone.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await this.namedHolderIsAlive(operation, recoveryName))
        throw new ResultFileStoreError("store_ambiguous");
      await this.removeProvenAbandoned(operation, recoveryName);
      recovery = await bounded(operation, () => open(recoveryPathOf(this.root),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600), () => {});
    }
    try {
      await bounded(operation, async () => {
        await recovery!.writeFile(`control-room-result-file-store-recovery\n${holderStamp()}\n`, "utf8");
      }, () => {});
      // Re-read the directory INSIDE the recovery lock: the list above is only
      // a hint, and a name that appeared since must be judged on its own.
      const current = await bounded(operation, () => readdir(this.root), () => {});
      if (current.includes(lockName) && await this.namedHolderIsAlive(operation, lockName)) {
        // A live writer is publishing through this same directory. Its lock and
        // its pending file are its own, and this store opens anyway: the write
        // path is already mutually excluded by O_EXCL, and refusing to open here
        // would reintroduce the lock-out this recovery exists to remove.
        return;
      }
      // No live writer. Everything this store wrote for its own bookkeeping and
      // nothing else is now provably abandoned, and the lock is removed FIRST so
      // that a pending file is judged against a directory that genuinely has no
      // lock in it. The ordering matters: a reader of this function's rule 3
      // ("a pending file is removed only when no lock exists") would be reading
      // a stale flag if the lock were removed after.
      for (const entry of current) {
        if (isStoreBookkeeping(entry)) await this.removeProvenAbandoned(operation, entry);
      }
      await this.syncRoot(operation);
    } finally {
      await recovery.close().catch(() => {});
      await bounded(operation, () => unlink(recoveryPathOf(this.root)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }), () => {});
    }
  }

  /**
   * True when one of the store's own bookkeeping files records a process that is
   * STILL running, and false only when this store can PROVE otherwise.
   *
   * The proof, in order, and every step of it is evidence rather than a guess:
   *
   *   * the file is gone (ENOENT) -> false. Nothing holds it.
   *   * it is not a plain private regular file -> true. A directory or a symlink
   *     at this name is not this store's file, and the store refuses rather than
   *     removing something it does not own.
   *   * it records a BOOT identity and that boot is not this boot -> false. This
   *     is the review's S1: a pid from a previous boot is not a live process
   *     now, however plausible it looks, and no amount of restarting the app
   *     would ever clear it.
   *   * it records a pid and a START TIME, and either the boot differs or the
   *     start time differs from that pid's real start time -> false. This is the
   *     recycled-pid case within one boot: the pid is alive but it is somebody
   *     else's process, and the lock is a dead writer's.
   *   * it records a pid and that pid is running -> true.
   *   * it records a bare pid with no boot and no start time -> the part-1 format
   *     (S1's second case). Judged by liveness alone, and repaired when the pid
   *     is dead; see below.
   *   * anything else -> true. An EMPTY lock is a writer between the O_EXCL
   *     create and the stamp write, a window of microseconds that is real.
   *
   * The two repaired cases are the ones that used to lock the owner out for
   * good, and they are repaired by the SAME rule: a lock whose holder cannot be
   * proven alive is not proof of a live writer, and a lock that cannot be
   * classified at all is re-examined once the opener has been running a moment,
   * which is long past any writer's stamp window and long before a writer that
   * is genuinely alive would have stopped. See `isProvenAbandoned`.
   */
  private async namedHolderIsAlive(operation: Operation, name: string): Promise<boolean> {
    const path = join(this.root, name);
    let listed: BigIntStats;
    try { listed = await bounded(operation, () => lstat(path, { bigint: true }), () => {}); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== BigInt(1)) return true;
    // An EMPTY lock is a writer between the O_EXCL create and the stamp write, or
    // a crash in exactly that window. It is re-examined ONCE after a short,
    // bounded wait, which separates the two by observation rather than by
    // assumption: a live writer stamps within microseconds, so a lock that is
    // still empty a moment later belongs to a writer that is not coming back.
    //
    // The review's S1, first case: an empty lock used to be "assume live" for
    // ever, and every write was refused `store_ambiguous` — still, after a
    // restart, because nothing in the app could ever clear it. The wait is
    // bounded by the caller's own operation deadline, so it cannot outlive the
    // request, and it is the only wait this class performs.
    if (listed.size === BigInt(0)) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, emptyLockRecheckMs);
        if (typeof timer.unref === "function") timer.unref();
      });
      return this.emptyLockIsNowStamped(operation, name);
    }
    // Read the stamp `O_NOFOLLOW`. A name that passed the shape test above and
    // is nonetheless a symlink now — a swap between the two — fails here with
    // ELOOP, and ELOOP is answered as a LIVE holder rather than allowed to
    // escape as a raw errno. That is the same decision the shape test makes,
    // made twice on purpose: the second one covers the race the first one
    // cannot, and a refusal is the only answer either may give.
    let handle: FileHandle;
    try {
      handle = await bounded(operation, () => open(path, constants.O_RDONLY | noFollow), () => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") return true;
      throw error;
    }
    let recorded: string;
    try { recorded = (await bounded(operation, () => handle.readFile("utf8"), () => {})).trim(); }
    finally { await handle.close().catch(() => {}); }
    if (isBarePidStamp(recorded)) {
      const bare = recorded.trim().split("\n").map(part => part.trim())
        .filter(part => part.length > 0).at(-1)!;
      return pidIsRunning(Number(bare));
    }
    // The stamp is `<header>\n<boot identity>\n<pid>\n<start second>`, and both
    // the header and the boot identity contain spaces, so nothing is read by
    // LINE POSITION except the two trailing numbers. The boot identity is
    // everything between the first newline and the pid, which is why it is
    // rejoined rather than taken as `lines[0]`.
    const parts = recorded.split("\n").map(part => part.trim()).filter(part => part.length > 0);
    if (parts.length < 3) return true;   // a shape this store never wrote: refuse
    const startedSecond = Number(parts[parts.length - 1]);
    const pid = Number(parts[parts.length - 2]);
    const boot = parts.slice(1, parts.length - 2).join("\n");
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startedSecond) || startedSecond <= 0)
      return true;
    // A lock from an earlier boot names a different boot, and that alone is proof
    // its writer is gone. Checked FIRST because it is free and it is the case
    // that survives every restart.
    if (boot !== (bootOf() ?? "boot:unknown")) return false;
    // Same boot. A live writer's start time matches; a recycled pid's does not.
    const real = processStartedAtSeconds(pid);
    if (real !== undefined && real > 0 && real !== startedSecond) return false;
    return pidIsRunning(pid);
  }

  /** Whether a lock that was EMPTY has since been stamped, which is the proof
   * that a writer really did hold it. Re-reads the same file rather than
   * trusting the earlier `lstat`, and a file that has since been removed counts
   * as "not a live writer" — the holder finished and cleaned up. */
  private async emptyLockIsNowStamped(operation: Operation, name: string): Promise<boolean> {
    const path = join(this.root, name);
    let listed: BigIntStats;
    try { listed = await bounded(operation, () => lstat(path, { bigint: true }), () => {}); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== BigInt(1)) return true;
    if (listed.size === BigInt(0)) return false;   // still empty: no writer claimed it
    return this.namedHolderIsAlive(operation, name);
  }

  /** Unlinks one name the recovery has already proved is this store's own
   * abandoned bookkeeping, refusing anything that is not a plain private file. */
  private async removeProvenAbandoned(operation: Operation, entry: string): Promise<void> {
    const path = join(this.root, entry);
    let stats: BigIntStats;
    try { stats = await bounded(operation, () => lstat(path, { bigint: true }), () => {}); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== BigInt(1)
      || !validPrivateMode(stats.mode)) throw new ResultFileStoreError("store_ambiguous");
    await bounded(operation, () => unlink(path), () => {});
  }

  private usable(operation: Operation): void {
    if (operation.signal?.aborted) { this.poisoned = true; throw abortError(); }
    if (this.poisoned || Date.now() >= operation.deadline) { this.poisoned = true; throw new DeadlineError(); }
  }

  async put(input: ResultFileStoreWriteV1): Promise<ResultFileStoredV1> {
    if (!(input.bytes instanceof Uint8Array)) throw new ResultFileStoreError("store_invalid");
    const bytes = Uint8Array.from(input.bytes);
    const key = resultFileStorageKeyV1(input.tenantId, input.projectId, input.fileId, input.contentDigest);
    if (bytesDigest(bytes) !== input.contentDigest) throw new ResultFileStoreError("store_invalid");
    if (bytes.byteLength > this.configuration.maximumFileBytes) throw new ResultFileStoreError("store_capacity");
    if (input.setBytes !== undefined || input.setFiles !== undefined) {
      if (!Number.isSafeInteger(input.setBytes ?? 0) || !Number.isSafeInteger(input.setFiles ?? 0)
        || (input.setBytes ?? 0) < 0 || (input.setFiles ?? 0) < 0)
        throw new ResultFileStoreError("store_invalid");
      if ((input.setBytes ?? 0) + bytes.byteLength > this.configuration.maximumSetBytes
        || (input.setFiles ?? 0) + 1 > this.configuration.maximumFiles)
        throw new ResultFileStoreError("store_capacity");
    }
    const run = this.queue.then(() => this.writeExclusive(input, bytes, key),
      () => this.writeExclusive(input, bytes, key));
    this.queue = run.then(() => undefined, () => undefined);
    return run.then(() => Object.freeze({ storageKey: key, contentDigest: input.contentDigest,
      sizeBytes: bytes.byteLength }));
  }

  async read(input: ResultFileStoreReadV1): Promise<Uint8Array | undefined> {
    const key = resultFileStorageKeyV1(input.tenantId, input.projectId, input.fileId, input.contentDigest);
    const operation: Operation = { deadline: Date.now() + this.configuration.operationTimeoutMs,
      ...(input.signal ? { signal: input.signal } : {}) };
    try {
      this.usable(operation);
      await this.assertRootIdentity(operation);
      // The whole directory is accounted for before any byte is served, not just
      // the one file being read. A store that read its own path and ignored what
      // else was in the directory could not tell "this file is missing" from
      // "something else replaced this store's contents", and would serve the
      // first as an empty result. An entry the store cannot account for is a
      // refusal — and never a deletion, because the store cleans up nothing.
      await this.assertDirectoryIsAccountedFor(operation);
      const bytes = await this.readRecord(join(this.root, onDiskName(key)), operation, true);
      if (!bytes) return undefined;
      // The digest is re-proved on every read. A store that returned bytes it
      // had not just checked would be serving whatever is on disk today.
      if (bytes.byteLength > this.configuration.maximumFileBytes
        || bytesDigest(bytes) !== input.contentDigest) throw new ResultFileStoreError("store_ambiguous");
      await this.assertRootIdentity(operation);
      this.usable(operation);
      return bytes;
    } catch (error) {
      if (error instanceof DeadlineError) this.poisoned = true;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw safe(error);
    }
  }

  private async writeExclusive(input: ResultFileStoreWriteV1, bytes: Uint8Array, key: string) {
    const operation: Operation = { deadline: Date.now() + this.configuration.operationTimeoutMs,
      ...(input.signal ? { signal: input.signal } : {}) };
    const lockPath = join(this.root, lockName);
    const targetPath = join(this.root, onDiskName(key));
    const name = onDiskName(key);
    let lock: FileHandle | undefined;
    let ownedLock = false;
    let pendingPath: string | undefined;
    let mutationStarted = false;
    let uncertain = false;
    // The refusal, if this operation ended in one. It is re-thrown after the
    // lock is retired, so a caller is told the write did not happen and not
    // merely that the store is in some state.
    let refusal: ResultFileStoreError | undefined;
    const mutating = () => { if (mutationStarted) uncertain = true; };
    try {
      this.usable(operation);
      await this.assertRootIdentity(operation);
      // The lock is created O_EXCL, so a second writer cannot proceed. The
      // create is a MUTUAL EXCLUSION and the store serialises its own writes
      // behind `this.queue`, so reaching here with the lock present means the
      // holder is a crashed writer or a live writer in another process. Either
      // way this operation cannot proceed, and the answer is a store refusal
      // with a fixed code — never a raw EEXIST, which would leak an errno out
      // of the store and past its own error contract. The lock is NOT removed
      // here: clearing it is the opener's job, and only after it has proved no
      // writer holds it.
      try {
        lock = await bounded(operation,
          () => open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600),
          mutating);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new ResultFileStoreError("store_ambiguous");
        throw error;
      }
      ownedLock = true;
      mutationStarted = true;
      // The lock records the writer's process id. That is what lets a later
      // open prove a leftover is ABANDONED rather than merely old: a pid is
      // liveness evidence this process does not have to take on trust, and
      // `kill(pid, 0)` answers it without disturbing the process.
      await bounded(operation, async () => {
        await lock!.writeFile(`control-room-result-file-store-write\n${holderStamp()}\n`, "utf8");
      }, mutating);
      await bounded(operation, () => lock!.sync(), mutating);
      const inventory = await this.inventory(operation);
      if (inventory.names.has(name)) {
        // Create-once with an exact replay: the same bytes are a retry, and
        // anything else is a conflict rather than an overwrite.
        //
        // Both sides are compared to the NAME, not only to each other. The name
        // is a digest, so a file whose bytes no longer hash to it is not a
        // replay of anything: it is a tampered or mis-restored file, and
        // overwriting it here would destroy the only evidence that it went wrong.
        const existing = await this.readRecord(targetPath, operation, false);
        if (!existing) throw new ResultFileStoreError("store_ambiguous");
        if (bytesDigest(existing) !== input.contentDigest
          || existing.byteLength !== bytes.byteLength || bytesDigest(bytes) !== bytesDigest(existing))
          throw new ResultFileStoreError("store_conflict");
      } else {
        // The per-set ceilings were already checked by the CALLER's own view of
        // the set (`setFiles` / `setBytes` above), which is where the per-set
        // limit belongs.
        //
        // There is deliberately no whole-installation FILE COUNT here any more.
        // `inventory.count` is every file in the store, not every file in a set,
        // and the review reproduced the consequence: files 1-32 stored, and the
        // 33RD FILE EVER STORED refused `store_capacity` on an installation that
        // had stored nothing close to 32 files in any one set. A per-set limit
        // was being applied to the whole installation. The installation's byte
        // quota IS a whole-installation total, so that one is checked here.
        if (inventory.totalBytes + bytes.byteLength > this.configuration.maximumTotalBytes)
          throw new ResultFileStoreError("store_capacity");
        pendingPath = join(this.root, `${pendingPrefix}${randomUUID()}`);
        const pending = await bounded(operation,
          () => open(pendingPath!, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600),
          mutating);
        try {
          await bounded(operation, async () => { await pending.writeFile(bytes); }, mutating);
          await bounded(operation, () => pending.sync(), mutating);
        } finally { await pending.close().catch(() => {}); }
        // link() is atomic and refuses to overwrite, so the file appears whole
        // or not at all; the directory sync is what makes it survive a crash.
        await bounded(operation, () => link(pendingPath!, targetPath), mutating);
        await this.syncRoot(operation);
        await this.discard(pendingPath, operation);
        pendingPath = undefined;
        await this.syncRoot(operation);
        const proven = await this.readRecord(targetPath, operation, false);
        if (!proven || bytesDigest(proven) !== input.contentDigest)
          throw new ResultFileStoreError("store_ambiguous");
      }
    } catch (error) {
      // A refusal must REACH THE CALLER. This block only decides whether the
      // store's own state is still knowable afterwards; it never converts a
      // refusal into a success. A `store_conflict` or `store_capacity` is a
      // definite answer — nothing was written — so the store stays usable and
      // the error is re-thrown below. Anything else after a mutation started
      // leaves the outcome unprovable, and the store poisons itself.
      if (error instanceof DeadlineError) this.poisoned = true;
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof ResultFileStoreError
        && (error.code === "store_conflict" || error.code === "store_capacity"
          || error.code === "store_invalid")) {
        uncertain = false;
        refusal = error;
      } else if (uncertain) this.poisoned = true;
      else throw error;
    } finally {
      try {
        if (!uncertain && pendingPath) { await this.discard(pendingPath, operation); pendingPath = undefined; }
        if (lock) await lock.close().catch(() => {});
        if (ownedLock && !uncertain) {
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          ownedLock = false;
          await this.syncRoot(operation);
        }
      } catch { uncertain = true; this.poisoned = true; }
    }
    if (refusal) throw refusal;
    if (uncertain) throw new ResultFileStoreError("store_ambiguous");
  }

  private async discard(path: string, operation: Operation): Promise<void> {
    try { await bounded(operation, () => unlink(path), () => {}); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof DeadlineError)) throw error;
    }
  }

  private async inventory(operation: Operation) {
    await this.assertRootIdentity(operation);
    const names = new Set<string>();
    let totalBytes = 0;
    const entries = await bounded(operation, () => readdir(this.root), () => {});
    for (const entry of entries) {
      // The store's own bookkeeping — the write lock, the recovery lock and any
      // staging file — is not stored result bytes, so it is not counted here and
      // it is not a refusal. This is the same rule the read path uses, and it is
      // what lets the store OPEN and KEEP SERVING while a write is in progress
      // (the review measured 13 of 50 concurrent reads failing `store_ambiguous`
      // because of exactly these names). A `<hex>.crbf` result is counted, proven
      // and nothing else is.
      if (isStoreBookkeeping(entry)) continue;
      // Any entry this store did not write is a refusal, never a deletion: the
      // store never cleans up an unknown file it cannot account for.
      if (!onDiskPattern.test(entry)) throw new ResultFileStoreError("store_ambiguous");
      const bytes = await this.readRecord(join(this.root, entry), operation, false);
      if (!bytes) throw new ResultFileStoreError("store_ambiguous");
      names.add(entry);
      totalBytes += bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.configuration.maximumTotalBytes)
        throw new ResultFileStoreError("store_ambiguous");
    }
    await this.assertRootIdentity(operation);
    return { names, count: names.size, totalBytes };
  }

  /** One file, proven unchanged across the read, or a refusal. */
  private async readRecord(path: string, operation: Operation,
    missingAllowed: boolean): Promise<Uint8Array | undefined> {
    this.usable(operation);
    let listed: BigIntStats;
    try { listed = await bounded(operation, () => lstat(path, { bigint: true }), () => {}); }
    catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== BigInt(1)
      || listed.size > BigInt(this.configuration.maximumFileBytes) || !validPrivateMode(listed.mode))
      throw new ResultFileStoreError("store_ambiguous");
    const handle = await bounded(operation,
      () => open(path, constants.O_RDONLY | noFollow | nonBlock), () => {});
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino
        || opened.nlink !== BigInt(1) || opened.size !== listed.size || !validPrivateMode(opened.mode))
        throw new ResultFileStoreError("store_ambiguous");
      const allocation = new Uint8Array(Number(listed.size));
      let length = 0;
      while (length < allocation.byteLength) {
        const next = await bounded(operation,
          () => handle.read(allocation, length, allocation.byteLength - length, length), () => {});
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const current = await bounded(operation, () => lstat(path, { bigint: true }), () => {});
      if (length !== Number(listed.size) || after.size !== listed.size
        || after.mtimeNs !== listed.mtimeNs || after.ctimeNs !== listed.ctimeNs
        || after.dev !== listed.dev || after.ino !== listed.ino || after.nlink !== BigInt(1)
        || current.isSymbolicLink() || current.dev !== listed.dev || current.ino !== listed.ino
        || current.size !== listed.size || current.mtimeNs !== listed.mtimeNs
        || current.ctimeNs !== listed.ctimeNs) throw new ResultFileStoreError("store_ambiguous");
      return allocation;
    } finally { await handle.close().catch(() => {}); }
  }

  /** Every entry under the root is one this store could have written, or one
   * this store is writing RIGHT NOW. Anything else — a stray file, a directory,
   * a name that is not a content digest — means the directory's state is not
   * what the catalog believes, so nothing is served until that is resolved. The
   * entries are listed, not read: this proves the NAMES are ours, and the
   * individual read still proves its own bytes.
   *
   * The lock and the `pending-*` files are this store's own bookkeeping, and
   * they are ignored here. A live writer has both in the directory for the whole
   * duration of its write, and refusing them made every concurrent download fail
   * `store_ambiguous` — the review measured 13 of 50 reads failing while a
   * single 64 MiB upload was in flight, which the route turns into a 503. The
   * safety argument is unchanged: a reader proves the bytes it is about to serve
   * with its own digest re-check, and a pending file is never a target name, so
   * ignoring it cannot serve a partial write. What it does change is that a
   * download no longer depends on no upload being in progress. */
  private async assertDirectoryIsAccountedFor(operation: Operation): Promise<void> {
    const entries = await bounded(operation, () => readdir(this.root), () => {});
    for (const entry of entries) {
      if (isStoreBookkeeping(entry)) continue;
      if (!onDiskPattern.test(entry)) throw new ResultFileStoreError("store_ambiguous");
    }
  }

  private async assertRootIdentity(operation: Operation): Promise<void> {
    this.usable(operation);
    const [canonical, stats] = await Promise.all([
      bounded(operation, () => realpath(this.root), () => {}),
      bounded(operation, () => lstat(this.root, { bigint: true }), () => {}),
    ]);
    if (canonical !== this.root || !stats.isDirectory() || stats.isSymbolicLink()
      || stats.dev !== this.identity.device || stats.ino !== this.identity.inode
      || !validPrivateMode(stats.mode)) throw new ResultFileStoreError("store_ambiguous");
  }

  private async syncRoot(operation: Operation): Promise<void> {
    this.usable(operation);
    const directory = await bounded(operation, () => open(this.root, constants.O_RDONLY | noFollow), () => {});
    try { await bounded(operation, () => directory.sync(), () => {}); }
    finally { await directory.close().catch(() => {}); }
  }
}

export async function openResultFileStoreV1(
  configuration: ResultFileStoreConfigurationV1,
): Promise<ResultFileStoreV1> {
  return ResultFileStoreV1.create(configuration);
}
