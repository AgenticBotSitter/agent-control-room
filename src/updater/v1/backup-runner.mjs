import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, rename, rm, statfs } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { updaterRefuseV1 } from "./contracts.mjs";
import { assertNoSymlinkBelowV1 } from "./fs-safety.mjs";
import { assertCompletionV1, assertGenerationIdV1, generationLeafV1 } from "./backup-store.mjs";

/**
 * Item 19a: the minimal nightly backup (design §9.5, R5i, R17a/c).
 *
 * THE SHAPE OF THE THING, and why each piece is where it is:
 *
 *  * `pg_dump` is spawned as `_crdb` by the updater and STREAMS to stdout
 *    (R17c). The dump never touches a staging directory and `_crdb` never has
 *    access to `backups/` at all: the bytes go root -> root-owned file. That is
 *    the whole reason the design deleted `backups/staging` in R6.
 *  * The root writes into a generation directory it created itself, under a
 *    configured backup root, with the same no-symlink walk as every other root
 *    path (R-FS). A generation name is never taken from an untrusted value; it
 *    is the id the DATABASE minted, and it is re-checked against the bounded
 *    grammar before it is ever used as a path component.
 *  * The dump is then RESTORE-VERIFIED: root creates `pg/scratch-<id>`, lchowns
 *    it to `_crdb`, the runtime `initdb` runs there with its own socket, and
 *    root streams the dump into `pg_restore` over stdin. Schema digest and
 *    per-table row counts read back from the scratch cluster must equal the
 *    ones read from the source inside the exported snapshot. If they differ,
 *    the generation is deleted, never promoted.
 *  * A generation is promoted by RENAMING the in-progress directory to its
 *    final name, after the verify passes. So a crash, a `kill -9` or a full
 *    disk can only ever leave an `.inprogress-<id>` directory, which retention
 *    does not count and which the next sweep removes. This is the daemons4
 *    carry-forward ("a failed run's empty generation dir is retained over a
 *    good dump"), fixed structurally rather than by a filter: there is no way
 *    for a partial generation to be mistaken for a dump, because a partial
 *    generation does not have a dump name.
 *  * Encryption at rest: the dump is streamed to a PLAINTEXT pipe first, so the
 *    plaintext digest is what the ledger records, and then the file is sealed
 *    in place. Outside the install root a seal is REQUIRED (an unsealed dump
 *    is refused); inside it a seal is OPTIONAL and happens exactly when the
 *    policy's `seal` is true. (An earlier version of this comment said sealing
 *    is refused inside the install root; the code never did that, and the
 *    production composition simply sets `seal: false` for the in-root default,
 *    because inside the install root R-FS — root 0700, `_crdb` denied — is the
 *    protection and a seal would make a restore depend on a key held nowhere.)
 *
 * WHAT IS CHECKED ON DISK, not only as a string (review backup19b H2): before a
 * byte is written, `assertBackupRootOnDiskV1` walks the backup root from `/`.
 * No component may be a symlink; every ancestor must be owned by root or by the
 * updater and must not be group/world-writable unless it is sticky (so nobody
 * else can rename a component away); and the root itself, opened with
 * O_NOFOLLOW|O_DIRECTORY, must be a directory owned by the updater with no
 * group/other bits at all. The open descriptor's device and inode are then
 * re-compared with the path before the promote rename and before every removal,
 * so a root swapped after the check is refused rather than written into.
 */

const DUMP_FILE_V1 = "database.dump";
const MANIFEST_FILE_V1 = "manifest.json";
const IN_PROGRESS_PREFIX_V1 = ".inprogress-";
/** A surplus generation is RENAMED to this prefix before it is removed, so a
 * sweep killed half-way through an `rm` leaves a name the next sweep clears,
 * not a half-deleted `gen-` directory reported `unsafe` forever (review L1). */
const REMOVING_PREFIX_V1 = ".removing-";
const MANIFEST_SCHEMA_V1 = "control-room.backup-manifest/v1";
/** The generation directory holds at most a dump, a manifest and a seal. */
const GENERATION_ENTRIES_MAX_V1 = 8;

const plainMessage = Object.freeze({
  updater_backup_lock_busy: "Another backup or a database update held the backup lock, so this backup did not run. It will try again shortly.",
  updater_backup_root_unsafe: "The backup folder is not private to the updater, so no backup was written there.",
  updater_backup_root_unconfigured: "No backup folder is set up, so no backup was written.",
  updater_backup_disk_full: "There was not enough room to write the backup, so it did not complete.",
  updater_backup_dump_failed: "The database could not be read in one piece, so no backup was written.",
  updater_backup_shape_digest_mismatch: "The backup was written but the restored database is not shaped the same, so it was thrown away.",
  updater_backup_row_counts_mismatch: "The backup was written but some rows did not come back, so it was thrown away.",
  updater_backup_verify_failed: "The backup was written but did not restore cleanly, so it was thrown away.",
  updater_backup_not_due: "Tonight's backup is not due yet.",
});

/**
 * The configured backup root, and the decision about sealing.
 *
 * A configured path rather than a hard-coded `<root>/backups`, because the
 * carry-forward says backups may later live on the owner's external drive, and
 * that drive currently has ownership DISABLED — so the R-FS guarantees that
 * protect everything else in the install root do NOT hold there. The policy
 * therefore says: outside the install root, seal the dump. Inside it, the root's
 * own 0700 is the boundary and sealing is refused (a seal nobody holds the key
 * to is a backup nobody can restore).
 */
export function resolveBackupRootPolicyV1({ installRoot, backupRoot, seal = true }) {
  if (typeof installRoot !== "string" || !isAbsolute(installRoot))
    throw updaterRefuseV1("updater_backup_root_refused");
  if (typeof backupRoot !== "string" || !isAbsolute(backupRoot) || resolve(backupRoot) !== backupRoot
      || backupRoot.includes("\0"))
    throw updaterRefuseV1("updater_backup_root_refused");
  const inside = backupRoot === installRoot || backupRoot.startsWith(`${installRoot}${sep}`);
  // The install root ITSELF is refused, not accepted as "inside". A backup root
  // equal to the install root would put `gen-…` directories and a `.inprogress-`
  // directory beside `releases/`, `pg/` and `updater-state/` — and the sweep
  // walks that root, so it would be walking the directory everything else
  // lives in. §3 puts backups in their own root-owned `backups/`.
  if (backupRoot === "/" || backupRoot === installRoot)
    throw updaterRefuseV1("updater_backup_root_refused");
  // H15 again, in the place the carry-forward puts it. A backup root under the
  // owner's home is a root the owner can RENAME and replace, which is the whole
  // reason the install root moved to /Library. The owner's external drive is
  // `/Volumes/…`, not `/Users/…`, so refusing /Users costs nothing and closes
  // the case where a bot writes a plaintext dump somewhere it can swap.
  if (backupRoot === "/Users" || backupRoot.startsWith("/Users/"))
    throw updaterRefuseV1("updater_backup_root_refused");
  return Object.freeze({
    backupRoot,
    insideInstallRoot: inside,
    // A root outside the install root loses ownership, so it MUST be sealed. A
    // root inside keeps it, so sealing is allowed but not required, and the
    // caller may still ask for it.
    sealRequired: !inside,
    seal: seal === true,
  });
}

/**
 * The backup root, checked ON DISK (review backup19b H2). Returns an open
 * descriptor for the root plus its identity; the caller keeps it open for the
 * attempt and re-checks the path against it with `assertBackupRootUnchangedV1`.
 *
 * Node has no openat/mkdirat, so the descriptor alone cannot make every later
 * path operation race-free. What makes the later paths safe is the ANCESTOR
 * rule: when no component can be renamed or replaced by anybody but root or
 * the updater itself, there is nobody to race. The descriptor and the identity
 * re-check are the second fence, for a root that changed anyway.
 *
 * Measured before this existed: a backup root that was a symlink to a 0777
 * directory elsewhere returned `verified` with the dump written into the
 * symlink's target, and a plain 0777 root returned `verified` too.
 */
export async function assertBackupRootOnDiskV1(backupRoot, { ownerUid = currentUidV1() } = {}) {
  if (typeof backupRoot !== "string" || !isAbsolute(backupRoot) || resolve(backupRoot) !== backupRoot
      || backupRoot.includes("\0") || !Number.isSafeInteger(ownerUid) || ownerUid < 0)
    throw updaterRefuseV1("updater_backup_root_unsafe");
  const parts = backupRoot.split(sep).filter(Boolean);
  let current = sep;
  for (let index = 0; index < parts.length; index += 1) {
    const entry = await lstat(current).catch(() => null);
    // Every ANCESTOR (the root itself is checked through its descriptor below):
    // a real directory, owned by root or by the updater, and not writable by
    // group or other unless the sticky bit stops them renaming our entries.
    if (entry === null || entry.isSymbolicLink() || !entry.isDirectory()
        || (entry.uid !== 0 && entry.uid !== ownerUid)
        || ((entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0))
      throw updaterRefuseV1("updater_backup_root_unsafe");
    current = join(current, parts[index]);
  }
  let handle;
  try {
    handle = await open(backupRoot, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch { throw updaterRefuseV1("updater_backup_root_unsafe"); }
  try {
    const entry = await handle.stat();
    assertPrivateRootV1(entry, ownerUid);
    const root = Object.freeze({ backupRoot, handle, dev: entry.dev, ino: entry.ino, ownerUid });
    await assertBackupRootUnchangedV1(root);
    return root;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** The ONE statement of "a private root": a directory, owned by the updater,
 * with no group or other bits. Both the first check and every re-check use it. */
function assertPrivateRootV1(entry, ownerUid) {
  if (!entry.isDirectory() || entry.uid !== ownerUid || (entry.mode & 0o077) !== 0)
    throw updaterRefuseV1("updater_backup_root_unsafe");
}

/** The path still names the directory the descriptor was opened on, and that
 * directory is still private. Called before the promote rename and before every
 * removal.
 *
 * A symlinked root meets THREE fences, deliberately: O_NOFOLLOW on the open,
 * `isSymbolicLink()` here, and the device/inode comparison (a link's own inode
 * is not its target's). Any one of them refuses it, so a mutation that removes
 * only one survives by design; the ancestor walk's symlink check has no such
 * backup and is the one the mutation manifest pins. */
export async function assertBackupRootUnchangedV1(root) {
  const byPath = await lstat(root.backupRoot).catch(() => null);
  const byHandle = await root.handle.stat().catch(() => null);
  if (byPath === null || byHandle === null || byPath.isSymbolicLink()
      || byPath.dev !== root.dev || byPath.ino !== root.ino
      || byHandle.dev !== root.dev || byHandle.ino !== root.ino)
    throw updaterRefuseV1("updater_backup_root_unsafe");
  assertPrivateRootV1(byHandle, root.ownerUid);
}

function currentUidV1() {
  return typeof process.geteuid === "function" ? process.geteuid() : -1;
}

/** Free bytes on the filesystem holding `path`, or null when unreadable. */
export async function freeBytesAtV1(path) {
  const result = await statfs(path);
  // statfs reports frsize; bavail is the count of free blocks available to this
  // process's user. The product is what a write can actually get.
  return Number(result.bavail) * Number(result.bsize);
}

/**
 * The manifest. It is what makes a generation countable without opening the
 * dump, and it is written ONLY after the verify passes, so its presence is the
 * signal that the generation is real. The sweep checks for the manifest and
 * refuses to count a directory without one.
 */
export function backupManifestV1({ generationId, createdAt, dumpSha256, dumpBytes, fileSha256,
  shapeDigest, rowCounts, snapshotXid, encrypted, pgVersion, installRoot }) {
  if (pgVersion !== "control-room.pg-version/v1") throw updaterRefuseV1("updater_backup_manifest_refused");
  assertGenerationIdV1(generationId, "updater_backup_manifest_refused");
  for (const digest of [dumpSha256, fileSha256, shapeDigest]) {
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw updaterRefuseV1("updater_backup_manifest_refused");
  }
  if (!Number.isSafeInteger(dumpBytes) || dumpBytes <= 0) throw updaterRefuseV1("updater_backup_manifest_refused");
  if (!Array.isArray(rowCounts) || rowCounts.length < 1 || rowCounts.length > 4096)
    throw updaterRefuseV1("updater_backup_manifest_refused");
  if (typeof installRoot !== "string" || !isAbsolute(installRoot))
    throw updaterRefuseV1("updater_backup_manifest_refused");
  return Object.freeze({
    schema: MANIFEST_SCHEMA_V1,
    generationId,
    createdAt,
    dumpSha256,
    dumpBytes,
    fileSha256,
    shapeDigest,
    rowCounts,
    rowCountsDigest: `sha256:${createHash("sha256").update(JSON.stringify(rowCounts)).digest("hex")}`,
    snapshotXid,
    encrypted,
    // The release the dump was taken from. Recorded so an operator restoring by
    // hand can tell which migration set to load afterwards, and BOTH are
    // validated rather than interpolated anywhere.
    pgVersion,
    installRoot,
  });
}

/**
 * A bounded, single-line slice of a failure's own message.
 *
 * The `failure_detail` column is 200 characters and the store refuses anything
 * longer, so the slice happens here rather than being caught by a constraint at
 * run time — a failed backup must never fail to record WHY it failed.
 *
 * A SQLSTATE is useless on its own to whoever reads the ledger next week. The
 * message is what says "permission denied for schema pg_catalog" instead of
 * "42501", and this lane found four real bugs whose entire cost was that
 * difference. Newlines and tabs become spaces so one failure stays one row, and
 * control characters are dropped rather than trusted to render.
 */
function boundedDetailV1(error) {
  const raw = error && typeof error.message === "string" ? error.message : "";
  if (raw === "") return null;
  return raw.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200) || null;
}

/** A generation directory's two readable names, both derived from the id. */
function generationPathsV1(backupRoot, generationId) {
  // The leaf comes from the single shared transform, and the id is re-checked on
  // the way in, so no caller-supplied string reaches a path. There is no reverse
  // transform anywhere in this file: a directory name is never turned back into
  // a generation id.
  const leaf = `gen-${generationLeafV1(generationId)}`;
  return Object.freeze({
    final: join(backupRoot, leaf),
    inProgress: join(backupRoot, `${IN_PROGRESS_PREFIX_V1}${generationLeafV1(generationId)}`),
    dump: join(backupRoot, leaf, DUMP_FILE_V1),
    manifest: join(backupRoot, leaf, MANIFEST_FILE_V1),
  });
}

/**
 * A generation is REAL, or it is not. Three things must all hold, and the
 * caller checks all three rather than the first:
 *
 *  1. the directory is a real directory, not a symlink, with a sane entry count;
 *  2. it holds exactly the manifest and (optionally) the dump — nothing else,
 *     so a planted file, socket, device or hardlink makes it unsafe;
 *  3. the manifest parses, names this generation, and its dump digest matches
 *     the bytes on disk.
 *
 * Point 2 is the daemons4 `unsafe_generation` lesson and the P8 "symlink swaps
 * in lower-writable directories" case at once: a symlinked generation, a
 * generation holding an extra file, or one whose dump is a symlink to something
 * outside are all refused, and the victim is left untouched.
 */
export async function assertSafeGenerationV1(backupRoot, generationId, { requireManifest = true, hashDump = true } = {}) {
  const paths = generationPathsV1(backupRoot, generationId);
  const walk = await assertNoSymlinkBelowV1(resolve(backupRoot, ".."), paths.final)
    .catch(error => { if (error?.code === "ENOENT") return null; throw error; });
  if (walk === null) return null;
  const entry = await lstat(paths.final);
  if (entry.isSymbolicLink()) throw updaterRefuseV1("updater_backup_generation_refused");
  if (!entry.isDirectory()) throw updaterRefuseV1("updater_backup_generation_refused");
  if (entry.nlink < 1) throw updaterRefuseV1("updater_backup_generation_refused");
  const names = [];
  for await (const item of await opendir(paths.final)) names.push(item.name);
  if (names.length > GENERATION_ENTRIES_MAX_V1) throw updaterRefuseV1("updater_backup_generation_refused");
  const allowed = new Set([MANIFEST_FILE_V1, DUMP_FILE_V1, `${DUMP_FILE_V1}.seal`]);
  for (const name of names) {
    if (!allowed.has(name)) throw updaterRefuseV1("updater_backup_generation_refused");
    const child = await lstat(join(paths.final, name));
    if (child.isSymbolicLink() || !child.isFile() || child.nlink !== 1)
      throw updaterRefuseV1("updater_backup_generation_refused");
    // The mode check: the dump is written by a CHILD PROCESS, so its mode is
    // whatever `pg_dump` chose under the updater's umask, and this is a real
    // constraint rather than a stylistic one — a group- or world-readable dump
    // on a root's disk is the thing the whole design is about. The port is
    // required to chmod the file it wrote, and the check below is what proves
    // it did. The manifest the port writes is 0400 already.
    if ((child.mode & 0o777) & 0o077) throw updaterRefuseV1("updater_backup_generation_refused");
  }
  if (!requireManifest) return Object.freeze({ ...paths, entries: names.sort() });
  if (!names.includes(MANIFEST_FILE_V1)) return null;
  if (!names.includes(DUMP_FILE_V1)) throw updaterRefuseV1("updater_backup_manifest_refused");
  const manifest = JSON.parse(await readBoundedV1(paths.manifest));
  if (manifest?.schema !== MANIFEST_SCHEMA_V1 || manifest.generationId !== generationId
      || typeof manifest.dumpSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(manifest.dumpSha256)
      || typeof manifest.fileSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(manifest.fileSha256))
    throw updaterRefuseV1("updater_backup_manifest_refused");
  const dump = await lstat(paths.dump);
  // WHICH digest the bytes on disk are checked against, and why the two differ.
  //
  // A SEALED generation's file holds the CIPHERTEXT, so its digest is
  // `fileSha256`. A plain generation's file holds the dump, so its digest is
  // `dumpSha256`. The first version of this check always compared against
  // `dumpSha256`, which means it refused EVERY sealed generation with
  // `updater_backup_manifest_refused` — a false refusal on exactly the case the
  // carry-forward cares about most (a backup on a drive with no ownership). The
  // size check follows the same choice, for the same reason: a sealed file is
  // larger than the dump it came from.
  const onDisk = manifest.encrypted === true;
  const expectedDigest = onDisk ? manifest.fileSha256 : manifest.dumpSha256;
  if (dump.size !== manifest.dumpBytes && !onDisk)
    throw updaterRefuseV1("updater_backup_manifest_refused");
  // `hashDump: false` is the sweep's cheap STRUCTURAL check, used only to decide
  // which generations fill the kept slots; a generation is never REMOVED without
  // the full digest check below.
  if (hashDump) {
    const actual = await sha256FileV1(paths.dump, onDisk ? undefined : manifest.dumpBytes);
    if (actual !== expectedDigest) throw updaterRefuseV1("updater_backup_manifest_refused");
  }
  return Object.freeze({ ...paths, entries: names.sort(), manifest });
}

async function readBoundedV1(path, maxBytes = 65_536) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > maxBytes)
      throw updaterRefuseV1("updater_backup_manifest_refused");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function sha256FileV1(path, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  let total = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (maxBytes !== undefined && total > maxBytes) throw updaterRefuseV1("updater_backup_dump_size_refused");
      hash.update(chunk);
    }
  } finally { await handle.close(); }
  return `sha256:${hash.digest("hex")}`;
}


/**
 * The nightly backup, as a class whose every effect goes through a port.
 *
 * The ports are not a testing convenience: the dump, the verify, the scratch
 * cluster and the sealing are all subprocess effects, and the production
 * implementation of each is `postgresBackupPortsV1` in ./backup-ports.mjs,
 * which `createNightlyBackupV1` composes and `startUpdaterV1` runs. What is NOT
 * ported is everything that decides: the order of operations, the lock, the
 * promotion rename, the retention arithmetic, the failure codes and the plain
 * words. Those live here, and that is where the guards and their mutation
 * entries point.
 *
 * EVERY FAILURE IS RECORDED (review backup19b H1). Each path that ends a run
 * without a verified generation — a held lock, an unconfigured or unsafe root,
 * a store error before the attempt row existed — writes a `failed` row with its
 * own code. The first version returned early on a held lock and on an
 * unconfigured root, so a lock somebody kept forever stopped every backup with
 * `consecutive_failures = 0` and nothing on the ledger.
 */
export class UpdaterBackupV1 {
  #running = false;
  constructor({ store, ports, clock = () => new Date(), policy, journal = null, onResult = () => {} }) {
    this.store = store; this.ports = ports; this.clock = clock; this.journal = journal; this.onResult = onResult;
    this.policy = policy ?? { installRoot: null, backupRoot: null, seal: true, freeSpaceFloorBytes: 256 * 1024 * 1024 };
  }

  /** The refusal codes are decided here so no port can invent a success. */
  static #refuse(code) { return updaterRefuseV1(code); }

  async #intent(record) { if (this.journal?.backupIntent) await this.journal.backupIntent(record); }
  async #done(record) { if (this.journal?.backupDone) await this.journal.backupDone(record); }

  #ownerUid() {
    return Number.isSafeInteger(this.policy.ownerUid) ? this.policy.ownerUid : currentUidV1();
  }

  /**
   * Record a failure that happened BEFORE this run's attempt row existed: a
   * fresh attempt row, settled at once with the real code. Best effort — if the
   * database itself is unreachable there is nowhere to record anything, and the
   * staleness bound is then the backstop.
   */
  async #recordStandaloneFailure(code, error = null) {
    try {
      const policy = await this.store.policy();
      const attempt = await this.store.beginAttempt({ policy });
      await this.store.failAttempt({ generationId: attempt.generationId, code, detail: boundedDetailV1(error) });
      return attempt.generationId;
    } catch { return null; }
  }

  /**
   * `manual` is the phone's "Backup now" (a risk-reducing owner request, so it
   * runs while self-update is Off) and skips the due-time check. Everything else
   * about it is identical, deliberately: a manual backup that took a different
   * path would be untested by every nightly run.
   * `scheduled` means the root-held worker has already claimed exactly one
   * 02:30 slot. That claim, rather than a completion-relative database time,
   * decides whether the slot runs: a slow backup must not push tomorrow's
   * fixed slot later.
   * @param {{manual?: boolean, scheduled?: boolean, signal?: AbortSignal | null}} [options]
   */
  async runOnce({ manual = false, scheduled = false, signal = null } = {}) {
    // An in-process second caller is NOT recorded: the first caller is running
    // and will record its own outcome, so this is not a backup that failed.
    if (this.#running) return Object.freeze({ status: "busy", code: "updater_backup_already_running",
      message: "A backup is already running on this Mac." });
    this.#running = true;
    let generationId = null, lockHeld = false, root = null;
    try {
      if (signal?.aborted) throw UpdaterBackupV1.#refuse("updater_backup_cancelled");
      if (!manual && !scheduled) {
        // The due check reads `next_due_at` — written from `pg_catalog.now()` —
        // and compares it with this process's clock. The two are different clocks,
        // and the design says "DB now() everywhere" for a reason: a Mac whose
        // clock jumps two hours either fires the backup twice in a row or skips a
        // night. A JIT caller passing `clock` (the tests do) is deliberate
        // injection; production passes the default. What is NOT done here is
        // writing a next-due time from the Mac's clock — every write goes
        // through `pg_catalog.now()` in the store — so a clock jump can at worst
        // shift when one run is admitted, and the freshness bound that actually
        // gates database plans is computed in the database.
        const freshness = await this.store.freshness();
        const due = !freshness.nextDueAt || new Date(freshness.nextDueAt).getTime() <= this.clock().getTime();
        if (!due) return Object.freeze({ status: "not_due", nextDueAt: freshness.nextDueAt,
          message: plainMessage.updater_backup_not_due });
      }
      // The lock is the row lock item 18 also takes for its pre-image dump, so a
      // database upgrade and tonight's backup can never dump one cluster at once,
      // and it is one a candidate release cannot take (see the store). A busy
      // lock IS recorded — as a failed attempt with its own code — and retried
      // within the quarter hour. The badge follows freshness, not this row, so a
      // backup postponed by a few minutes does not turn Home red while the last
      // one is still fresh; a lock held for hours, though, is on the ledger every
      // fifteen minutes instead of being invisible until the 26-hour bound.
      const lock = await this.store.acquireBackupLock();
      if (lock.status === "busy") {
        const recorded = await this.#recordStandaloneFailure("updater_backup_lock_busy");
        await this.store.scheduleNext(BACKUP_DEFERRED_SECONDS_V1).catch(() => {});
        const outcome = Object.freeze({ status: "busy", code: "updater_backup_lock_busy", generationId: recorded,
          message: plainMessage.updater_backup_lock_busy });
        this.onResult(outcome);
        return outcome;
      }
      lockHeld = true;
      const policy = await this.store.policy();
      const attempt = await this.store.beginAttempt({ policy });
      generationId = attempt.generationId;
      // The root is checked AFTER the attempt row exists, so an unconfigured or
      // unsafe root is a recorded failure like any other, and BEFORE any byte is
      // written or any directory is read.
      if (!this.policy.backupRoot) throw UpdaterBackupV1.#refuse("updater_backup_root_unconfigured");
      const rootPolicy = resolveBackupRootPolicyV1(this.policy); // Re-derived, never trusted from a field.
      root = await assertBackupRootOnDiskV1(this.policy.backupRoot, { ownerUid: this.#ownerUid() });
      // An outside-root dump has no ownership protection. Refuse before the
      // first dump byte when the production port has no sealing implementation.
      if (rootPolicy.sealRequired && this.ports.sealBound === false)
        throw UpdaterBackupV1.#refuse("updater_backup_seal_unbound");
      await this.#settleInterrupted(generationId);
      const paths = generationPathsV1(this.policy.backupRoot, generationId);
      await this.#intent({ generationId, phase: "begin" });
      const outcome = await this.#attempt(generationId, paths, policy, root, signal);
      await this.#done({ generationId, phase: "complete", state: outcome.status });
      this.onResult(outcome);
      return outcome;
    } catch (error) {
      const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/u.test(error.code)
        ? error.code : "updater_backup_failed";
      // A trace hook, off unless the environment asks. Set
      // CONTROL_ROOM_BACKUP_TRACE=1 to get one line per failure with the driver's
      // own message.
      if (process.env.CONTROL_ROOM_BACKUP_TRACE === "1")
        process.stderr.write(`BACKUP-TRACE ${code} :: ${error?.message ?? ""}`
          + `${typeof error?.evidence === "string" ? ` :: ${error.evidence}` : ""}\n`);
      if (generationId) {
        // The detail is a BOUNDED, sanitised slice of the driver's message: the
        // bound (200 chars, the column's own CHECK) and the fact that it is only
        // ever an error's own text — never a file content, a command line or an
        // argument — keep it from becoming a channel. It is stored, never
        // rendered to the owner: the plain words come from `plainMessage`.
        await this.store.failAttempt({ generationId, code, detail: boundedDetailV1(error) }).catch(() => {});
        await this.#done({ generationId, phase: "complete", state: "failed", code }).catch(() => {});
        // Only a root that passed its on-disk check is ever touched on the way
        // out: an unsafe root is exactly the one not to `rm` inside.
        if (root) await this.#discardInProgress(generationPathsV1(this.policy.backupRoot, generationId), root);
      } else {
        // Nothing was recorded yet (the lock or the store failed before the
        // attempt row existed). Record it now, so no failure is silent.
        generationId = await this.#recordStandaloneFailure(code, error);
      }
      const outcome = Object.freeze({ status: "failed", code, generationId,
        message: plainMessage[code] ?? "The nightly backup did not complete." });
      this.onResult(outcome);
      return outcome;
    } finally {
      await root?.handle.close().catch(() => {});
      if (lockHeld) await this.store.releaseBackupLock().catch(() => {});
      this.#running = false;
    }
  }

  /**
   * Settle every attempt a dead run left in flight (review backup19b M1).
   *
   * Called with the backup lock HELD, so every other `backup_in_progress` row
   * belongs to a run that is no longer alive. Each is settled to a REAL failure
   * code rather than left stuck forever:
   *   * `updater_backup_record_interrupted` when its `gen-` directory is a
   *     complete, digest-verified generation — the run died between the promote
   *     rename and the ledger write. The dump is KEPT (the sweep reports it as
   *     `unrecorded` and keeps it until enough newer verified generations
   *     exist); it is not adopted as `verified`, because its completion time
   *     would then be "now" and freshness would claim a dump newer than it is.
   *   * `updater_backup_interrupted` otherwise (the run died before promoting).
   */
  async #settleInterrupted(currentGenerationId) {
    for (const row of await this.store.inFlightGenerations()) {
      if (row.generationId === currentGenerationId) continue;
      let complete = false;
      try { complete = (await assertSafeGenerationV1(this.policy.backupRoot, row.generationId)) !== null; }
      catch { complete = false; }
      await this.store.failAttempt({ generationId: row.generationId,
        code: complete ? "updater_backup_record_interrupted" : "updater_backup_interrupted",
        detail: "settled by a later run: the process that began this attempt is gone" }).catch(() => {});
    }
  }

  /**
   * One attempt: space check, streamed dump, hash, restore-verify, seal, promote.
   *
   * The order is the safety property, and each step's failure is a distinct code
   * so a fixed problem is not re-diagnosed as a mystery:
   *   space -> dump -> verify -> seal -> validate -> promote -> record.
   * Every check the ledger would apply runs BEFORE the promote rename, so a
   * failure at any of those steps leaves an `.inprogress-` directory and a
   * `failed` row, and never a `gen-` directory.
   */
  async #attempt(generationId, paths, policy, root, signal) {
    if (signal?.aborted) throw UpdaterBackupV1.#refuse("updater_backup_cancelled");
    const floor = Number.isSafeInteger(this.policy.freeSpaceFloorBytes) ? this.policy.freeSpaceFloorBytes : 0;
    const free = await freeBytesAtV1(this.policy.backupRoot);
    if (Number.isFinite(free) && free < floor) throw UpdaterBackupV1.#refuse("updater_backup_disk_full");
    await assertBackupRootUnchangedV1(root);
    await mkdir(paths.inProgress, { recursive: false, mode: 0o700 });
    const dumpPath = join(paths.inProgress, DUMP_FILE_V1);
    // R17c: the dump is streamed, not staged. The dump port writes the bytes to
    // a file the ROOT created and owns; `_crdb` writes to a pipe and never has
    // a path under `backups/`.
    const dumped = await this.ports.dump({ path: dumpPath, generationId, signal });
    if (signal?.aborted) throw UpdaterBackupV1.#refuse("updater_backup_cancelled");
    if (!(dumped?.bytes > 0) || typeof dumped.sha256 !== "string"
        || !/^sha256:[a-f0-9]{64}$/u.test(dumped.sha256))
      throw UpdaterBackupV1.#refuse("updater_backup_dump_failed");
    // Re-read the bytes the root actually wrote, rather than trusting the port's
    // own hash of what it believes it wrote: the port is the part with a
    // subprocess in it, and this is a root-held file.
    const fileSha256 = await sha256FileV1(dumpPath, undefined);
    if (fileSha256 !== dumped.sha256) throw UpdaterBackupV1.#refuse("updater_backup_dump_digest_mismatch");
    // The evidence is the SHAPE digest and the row counts, not the release's
    // ownership-bearing schema digest; see backup-evidence.mjs for why.
    const source = dumped.evidence;
    if (!source || typeof source.shapeDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(source.shapeDigest)
        || !Array.isArray(source.rowCounts) || source.rowCounts.length < 1)
      throw UpdaterBackupV1.#refuse("updater_backup_evidence_refused");

    const verified = await this.ports.restoreVerify({ generationId, dumpPath, scratchId: generationId,
      expectedShapeDigest: source.shapeDigest, expectedRowCounts: source.rowCounts, signal });
    if (signal?.aborted) throw UpdaterBackupV1.#refuse("updater_backup_cancelled");
    // WHICH half disagreed, and by how much, is recorded: a schema digest
    // difference means the restore did not recreate the objects, while a
    // row-count difference means data was lost OR that the two sides counted
    // different table sets.
    if (verified?.shapeDigest !== source.shapeDigest) {
      const refusal = UpdaterBackupV1.#refuse("updater_backup_shape_digest_mismatch");
      refusal.evidence = `source=${source.shapeDigest} restored=${verified?.shapeDigest}`;
      throw refusal;
    }
    if (JSON.stringify(verified.rowCounts) !== JSON.stringify(source.rowCounts))
      throw UpdaterBackupV1.#refuse("updater_backup_row_counts_mismatch");
    const sealPolicy = resolveBackupRootPolicyV1(this.policy);
    const mustSeal = sealPolicy.sealRequired || sealPolicy.seal;
    const encrypted = mustSeal ? await this.ports.seal({ path: dumpPath, generationId, signal }) === true : false;
    if (sealPolicy.sealRequired && encrypted !== true)
      throw UpdaterBackupV1.#refuse("updater_backup_seal_refused");
    // The file digest AFTER sealing, so the manifest records the bytes that are
    // actually on disk. The plaintext digest above is what the source evidence
    // is compared against, which is why both exist.
    const sealedSha256 = encrypted ? await sha256FileV1(dumpPath, undefined) : fileSha256;
    // TIGHTEN THE MODE, HERE AND ONLY HERE — after the last write and after the
    // last read. `pg_dump` and `openssl` are both child processes and each chose
    // its own output mode under the updater's umask (a real 0644 was observed on
    // this Mac), so a group- or world-readable dump is possible unless root
    // tightens it itself. `assertSafeGenerationV1` refuses any generation whose
    // dump is still loose.
    await chmod(dumpPath, 0o400);
    const completion = { generationId, dumpSha256: dumped.sha256, dumpBytes: dumped.bytes,
      fileSha256: sealedSha256, shapeDigest: source.shapeDigest, rowCounts: source.rowCounts,
      snapshotXid: source.snapshotXid ?? null, encrypted };
    // Everything the completion UPDATE would refuse — the row counts' shape
    // included — refused BEFORE the rename, so such a refusal leaves no promoted
    // generation beside a failed row (review backup19b H1b: it used to be
    // raised only by `completeAttempt`, after the rename).
    assertCompletionV1(completion);
    const manifest = backupManifestV1({ generationId, createdAt: this.clock().toISOString(),
      dumpSha256: dumped.sha256, dumpBytes: dumped.bytes, fileSha256: sealedSha256,
      shapeDigest: source.shapeDigest, rowCounts: source.rowCounts, snapshotXid: source.snapshotXid ?? null,
      encrypted, pgVersion: "control-room.pg-version/v1", installRoot: this.policy.installRoot });
    await this.ports.writeManifest({ path: join(paths.inProgress, MANIFEST_FILE_V1), manifest, generationId });
    // PROMOTE, THEN RECORD — in that order, and the order is the recovery
    // property, not a detail.
    //
    // The rename is the atomic commit point: before it the generation is
    // invisible to retention and to any operator, and after it the generation is
    // real. There is no window in which a partial generation is countable.
    //
    // The ledger row is written AFTER the rename, deliberately. A crash between
    // the two leaves a complete directory beside an in-flight row. The next run
    // settles that row to `updater_backup_record_interrupted` and the sweep KEEPS
    // the directory (reported `unrecorded`) until enough newer verified
    // generations exist — it is never deleted as if it were surplus, which is
    // what the first version did (review backup19b M1, measured: the only good
    // dump of a first-ever backup was removed by the next run's sweep). The
    // reverse order would leave a `verified` row pointing at a directory that
    // does not exist, which is worse: the badge would read fresh because of a
    // dump that is gone.
    await assertBackupRootUnchangedV1(root);
    await rename(paths.inProgress, paths.final);
    await this.store.completeAttempt(completion);
    const retained = await this.#sweep(policy, root);
    return Object.freeze({ status: "verified", generationId, dumpBytes: dumped.bytes,
      retained: retained.retained, removed: retained.removed, message: "The nightly backup completed." });
  }

  /** An in-progress directory is never promoted, so it is simply removed. It is
   * removed with a name-rooted path (the id was checked) under a root that
   * passed its on-disk check, so a planted symlink at that name removes nothing
   * else. */
  async #discardInProgress(paths, root) {
    try {
      await assertBackupRootUnchangedV1(root);
      const entry = await lstat(paths.inProgress);
      if (entry.isSymbolicLink() || !entry.isDirectory()) return;
      await rm(paths.inProgress, { recursive: true, force: false, maxRetries: 1 });
    } catch {
      // A failure to clean up is NOT fatal: the directory is still named
      // `.inprogress-` so it is never counted, and the next sweep clears it.
    }
  }

  /**
   * Retention, called on its own (by an operator or a test). It takes the
   * backup lock first, because it removes `.inprogress-` directories, and a
   * sweep that ran beside a live backup would delete that backup's work. A busy
   * lock is answered `busy`, with nothing removed.
   */
  async sweep({ policy = null } = {}) {
    if (!this.policy.backupRoot) throw updaterRefuseV1("updater_backup_root_unconfigured");
    // This runner's own attempt holds the lock and is mid-flight: a sweep now
    // would clear that attempt's `.inprogress-` directory under it.
    const busy = Object.freeze({ status: "busy", retained: [], removed: [], unsafe: [], damaged: [], unrecorded: [] });
    if (this.#running) return busy;
    let acquired = false, root = null;
    if (!this.store.holdsBackupLock?.()) {
      const lock = await this.store.acquireBackupLock();
      if (lock.status !== "acquired") return busy;
      acquired = true;
    }
    try {
      root = await assertBackupRootOnDiskV1(this.policy.backupRoot, { ownerUid: this.#ownerUid() });
      return await this.#sweep(policy, root);
    } finally {
      await root?.handle.close().catch(() => {});
      if (acquired) await this.store.releaseBackupLock().catch(() => {});
    }
  }

  /**
   * Retention: keep the newest `kept_generations` VERIFIED generations THAT ARE
   * ACTUALLY ON DISK AND WHOLE, keep every pinned one, and remove the rest.
   *
   * The daemons4 findings are closed structurally here:
   *   * only `verified` rows can fill a kept slot, so a failed attempt never
   *     occupies one;
   *   * a slot is filled only by a generation whose directory passes the
   *     structural check — the first version filled the fourteen slots from
   *     LEDGER rows, so fourteen rows whose directories were missing or unsafe
   *     made every older, valid generation surplus (review backup19b L1);
   *   * a directory is removed only after the FULL check (manifest and dump
   *     digest), and by renaming it to `.removing-` first, so a sweep killed in
   *     the middle of an `rm` leaves a name the next sweep clears rather than a
   *     half-deleted `gen-` directory reported unsafe forever.
   *
   * A `failed` row whose directory is a complete generation (a run that died
   * between promote and record — review backup19b M1) is `unrecorded`: kept and
   * reported, never removed, until `kept_generations` valid verified
   * generations newer than it exist.
   *
   * The `unsafe` bucket is the interesting one: a generation directory that
   * cannot be validated (a symlink, an extra file, a dump that does not match
   * its manifest) is NEVER deleted automatically. An attacker who can plant
   * something in `backups/` could otherwise get a real dump deleted by making
   * it look unsafe. It is reported for the operator instead.
   */
  async #sweep(policy, root) {
    const effective = policy ?? await this.store.policy();
    const keep = effective.keptGenerations;
    const ledger = await this.store.ledgerRows();
    const pinned = new Set((await this.store.pinnedGenerations()).map(row => row.generationId));
    const removed = [], retained = [], unsafe = [], damaged = [], unrecorded = [], surplus = [];
    // Leftovers first: partial generations (never promoted, so never counted)
    // and interrupted removals. Cleared by the SHARED prefixes, and only when
    // the entry is a real directory rather than a symlink a lower-trust writer
    // planted at that name.
    await assertBackupRootUnchangedV1(root);
    for await (const item of await opendir(this.policy.backupRoot)) {
      if (!item.name.startsWith(IN_PROGRESS_PREFIX_V1) && !item.name.startsWith(REMOVING_PREFIX_V1)) continue;
      const stale = join(this.policy.backupRoot, item.name);
      const entry = await lstat(stale).catch(() => null);
      if (entry?.isDirectory() && !entry.isSymbolicLink())
        await rm(stale, { recursive: true, force: true, maxRetries: 1 }).catch(() => {});
    }
    // The ledger drives the sweep, NEWEST FIRST, forward from each generation id
    // to its leaf. A directory the ledger does not name is therefore never a
    // deletion candidate at all, which does not depend on parsing anything an
    // attacker could write.
    let keptValid = 0;
    for (const row of ledger) {
      const generationId = row.generationId;
      const paths = generationPathsV1(this.policy.backupRoot, generationId);
      const entry = await lstat(paths.final).catch(() => null);
      if (entry === null) continue; // Ledger row with no directory: nothing to keep or remove.
      let safe = null;
      try { safe = await assertSafeGenerationV1(this.policy.backupRoot, generationId, { hashDump: false }); }
      catch { unsafe.push(generationId); continue; }
      if (safe === null) { damaged.push(generationId); continue; }
      if (row.state === "verified") {
        if (keptValid < keep) { keptValid += 1; retained.push(generationId); }
        else if (pinned.has(generationId)) retained.push(generationId);
        else surplus.push(generationId);
      } else if (keptValid < keep) unrecorded.push(generationId);
      else surplus.push(generationId);
    }
    for (const generationId of surplus) {
      const paths = generationPathsV1(this.policy.backupRoot, generationId);
      try {
        // The full check, manifest digest and all, before anything is removed.
        await assertSafeGenerationV1(this.policy.backupRoot, generationId);
        await assertBackupRootUnchangedV1(root);
        const doomed = join(this.policy.backupRoot, `${REMOVING_PREFIX_V1}${generationLeafV1(generationId)}`);
        await rename(paths.final, doomed);
        await rm(doomed, { recursive: true, force: false, maxRetries: 1 });
        removed.push(generationId);
      } catch { unsafe.push(generationId); }
    }
    return Object.freeze({ retained: retained.sort(), removed: removed.sort(),
      unsafe: unsafe.sort(), damaged: damaged.sort(), unrecorded: unrecorded.sort() });
  }

  /**
   * The badge, the push and the plan refusal all read the freshness predicate.
   *
   * The badge ALSO looks at the disk (review backup19b L1): freshness is a fact
   * about the ledger, so a lost or emptied backup disk used to keep Home green.
   * When the newest verified generation's directory is missing or not whole,
   * the badge says so, even though the database still admits plans on the
   * ledger's word (item 18 takes its own pre-image dump before any migration).
   */
  async status() {
    const freshness = await this.store.freshness();
    const latest = await this.store.latestAttempt();
    let onDisk = null;
    if (freshness.fresh && this.policy.backupRoot && typeof this.store.verifiedGenerations === "function") {
      const newest = (await this.store.verifiedGenerations(1))[0];
      onDisk = false;
      if (newest) {
        try {
          onDisk = (await assertSafeGenerationV1(this.policy.backupRoot, newest.generationId,
            { hashDump: false })) !== null;
        } catch { onDisk = false; }
      }
    }
    return Object.freeze({
      fresh: freshness.fresh,
      state: latest?.state ?? "none",
      lastSuccessAt: freshness.lastSuccessAt,
      lastFailureCode: freshness.lastFailureCode,
      lastFailureAt: freshness.lastFailureAt,
      nextDueAt: freshness.nextDueAt,
      consecutiveFailures: freshness.consecutiveFailures,
      // Plain status words, for the Home red badge (§12).
      badge: freshness.fresh ? (onDisk === false ? "missing" : "ok") : (latest === null ? "never run" : "failed"),
    });
  }
}

const BACKUP_DEFERRED_SECONDS_V1 = 900;
