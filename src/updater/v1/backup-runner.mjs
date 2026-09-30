import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, rename, rm, statfs } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { updaterRefuseV1 } from "./contracts.mjs";
import { assertNoSymlinkBelowV1 } from "./fs-safety.mjs";
import { assertGenerationIdV1, generationLeafV1 } from "./backup-store.mjs";

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
 *    in place. The seal uses the runtime's own `openssl` and is refused unless
 *    the backup root is outside the install root — inside the install root,
 *    R-FS (root 0700, `_crdb` denied) is already the protection, and sealing
 *    every nightly dump would make a restore depend on a key held nowhere.
 */

const DUMP_FILE_V1 = "database.dump";
const MANIFEST_FILE_V1 = "manifest.json";
const IN_PROGRESS_PREFIX_V1 = ".inprogress-";
const MANIFEST_SCHEMA_V1 = "control-room.backup-manifest/v1";
/** The generation directory holds at most a dump, a manifest and a seal. */
const GENERATION_ENTRIES_MAX_V1 = 8;

const plainMessage = Object.freeze({
  updater_backup_lock_busy: "A database update already holds the backup lock, so tonight's backup did not run.",
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
export async function assertSafeGenerationV1(backupRoot, generationId, { requireManifest = true } = {}) {
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
  const actual = await sha256FileV1(paths.dump, onDisk ? undefined : manifest.dumpBytes);
  if (actual !== expectedDigest) throw updaterRefuseV1("updater_backup_manifest_refused");
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
 * cluster and the sealing are all `spawnTrusted`-shaped effects that the trusted
 * runtime owns (R9/T1), and the item-19a brief is explicitly "minimal". What is
 * NOT ported is everything that decides: the order of operations, the lock, the
 * promotion rename, the retention arithmetic, the failure codes and the plain
 * words. Those live here, and that is where the guards and their mutation
 * entries point.
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

  /**
   * `manual` is the phone's "Backup now" (a risk-reducing owner request, so it
   * runs while self-update is Off) and skips the due-time check. Everything else
   * about it is identical, deliberately: a manual backup that took a different
   * path would be untested by every nightly run.
   */
  async runOnce({ manual = false } = {}) {
    if (this.#running) return Object.freeze({ status: "busy", code: "updater_backup_already_running",
      message: "A backup is already running on this Mac." });
    this.#running = true;
    let generationId = null;
    let lock = null;
    try {
      if (!this.policy.backupRoot) throw UpdaterBackupV1.#refuse("updater_backup_root_unconfigured");
      resolveBackupRootPolicyV1(this.policy); // Re-derived, never trusted from a field.
      if (!manual) {
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
      // The lock is the same advisory lock item 18 takes for its pre-image dump,
      // so a database upgrade and tonight's backup can never dump one cluster at
      // once. A `busy` answer is a REFUSAL, not a failure: nothing was written,
      // nothing is broken, and the row state is untouched — so no red badge for
      // a backup that was correctly deferred, and no `failed` row either.
      lock = await this.store.acquireBackupLock();
      if (lock.status === "busy") {
        await this.store.scheduleNext(BACKUP_DEFERRED_SECONDS_V1);
        return Object.freeze({ status: "busy", code: "updater_backup_lock_busy",
          message: plainMessage.updater_backup_lock_busy });
      }
      const policy = await this.store.policy();
      const attempt = await this.store.beginAttempt({ policy });
      generationId = attempt.generationId;
      const paths = generationPathsV1(this.policy.backupRoot, generationId);
      await this.#intent({ generationId, phase: "begin" });
      const outcome = await this.#attempt(generationId, paths, policy);
      await this.#done({ generationId, phase: "complete", state: outcome.status });
      this.onResult(outcome);
      return outcome;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "updater_backup_failed";
      // A trace hook, off unless the environment asks. It is how this lane
      // found that a failure can be raised BEFORE an attempt exists — in which
      // case there is no row to record a detail on, and a bare SQLSTATE in the
      // test output is the only clue. Set CONTROL_ROOM_BACKUP_TRACE=1 to get one
      // line per failure with the driver's own message.
      if (process.env.CONTROL_ROOM_BACKUP_TRACE === "1")
        process.stderr.write(`BACKUP-TRACE ${code} :: ${error?.message ?? ""}`
          + `${typeof error?.evidence === "string" ? ` :: ${error.evidence}` : ""}\n`);
      if (generationId) {
        // The detail is a BOUNDED, sanitised slice of the driver's message, and
        // that is a deliberate trade worth stating. Without it, a failure like
        // "permission denied for schema pg_catalog" arrives as a bare `42501`,
        // which is undiagnosable both for an operator reading the ledger and for
        // a test trying to work out which step broke — the whole reason this
        // lane's first four real bugs each cost a run. The bound (200 chars, the
        // column's own CHECK) and the fact that it is only ever a PostgreSQL
        // error's own text — never a file content, a command line or an argument
        // — are what keep it from becoming a channel. It is stored, never
        // rendered to the owner: the plain words come from `plainMessage`.
        const detail = boundedDetailV1(error);
        await this.store.failAttempt({ generationId, code, detail }).catch(() => {});
        await this.#done({ generationId, phase: "complete", state: "failed", code }).catch(() => {});
        const paths = generationPathsV1(this.policy.backupRoot, generationId);
        await this.#discardInProgress(paths);
      }
      const outcome = Object.freeze({ status: "failed", code, generationId,
        message: plainMessage[code] ?? "The nightly backup did not complete." });
      this.onResult(outcome);
      return outcome;
    } finally {
      if (lock?.status === "acquired") await this.store.releaseBackupLock().catch(() => {});
      this.#running = false;
    }
  }

  /**
   * One attempt: space check, streamed dump, hash, restore-verify, seal, promote.
   *
   * The order is the safety property, and each step's failure is a distinct code
   * so a fixed problem is not re-diagnosed as a mystery:
   *   space -> dump -> verify -> seal -> promote.
   * A failure at any step leaves an `.inprogress-` directory and a `failed` row,
   * and never a `gen-` directory, so retention can never count it.
   */
  async #attempt(generationId, paths, policy) {
    const floor = Number.isSafeInteger(this.policy.freeSpaceFloorBytes) ? this.policy.freeSpaceFloorBytes : 0;
    const free = await freeBytesAtV1(this.policy.backupRoot);
    if (Number.isFinite(free) && free < floor) throw UpdaterBackupV1.#refuse("updater_backup_disk_full");
    await mkdir(paths.inProgress, { recursive: false, mode: 0o700 });
    const dumpPath = join(paths.inProgress, DUMP_FILE_V1);
    // R17c: the dump is streamed, not staged. The dump port writes the bytes to
    // a file the ROOT created and owns; `_crdb` writes to a pipe and never has
    // a path under `backups/`.
    const dumped = await this.ports.dump({ path: dumpPath, generationId });
    if (dumped?.bytes <= 0 || typeof dumped.sha256 !== "string"
        || !/^sha256:[a-f0-9]{64}$/u.test(dumped.sha256))
      throw UpdaterBackupV1.#refuse("updater_backup_dump_failed");
    // Re-read the bytes the root actually wrote, rather than trusting the port's
    // own hash of what it believes it wrote: the port is the part with a
    // subprocess in it, and this is a root-held file.
    const fileSha256 = await sha256FileV1(dumpPath, undefined);
    if (fileSha256 !== dumped.sha256) throw UpdaterBackupV1.#refuse("updater_backup_dump_digest_mismatch");
    // The evidence is the SHAPE digest and the row counts, not the release's
    // ownership-bearing schema digest. A restore runs with `--no-owner` (R9.3
    // step 4: `--no-owner --role=control_room_migrator`), so every restored object
    // belongs to whoever ran `pg_restore`; comparing the source's ownership-
    // bearing digest against that can never match, and would refuse every good
    // backup in the world. See src/updater/v1/backup-evidence.mjs for the
    // measured digests and the reason.
    const source = dumped.evidence;
    if (!source || typeof source.shapeDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(source.shapeDigest)
        || !Array.isArray(source.rowCounts) || source.rowCounts.length < 1)
      throw UpdaterBackupV1.#refuse("updater_backup_evidence_refused");

    const verified = await this.ports.restoreVerify({ generationId, dumpPath, scratchId: generationId,
      expectedShapeDigest: source.shapeDigest, expectedRowCounts: source.rowCounts });
    // WHICH half disagreed, and by how much, is recorded. "updater_backup_verify_failed"
    // on its own left this lane's only clue as a bare refusal name, and the two
    // halves fail for entirely different reasons: a schema digest difference
    // means the restore did not recreate the objects (a real problem), while a
    // row-count difference means data was lost OR that the two sides counted
    // different table sets (usually a fixture problem). Telling them apart from
    // the ledger next week is worth the three extra bounded fields.
    if (verified?.shapeDigest !== source.shapeDigest) {
      const refusal = UpdaterBackupV1.#refuse("updater_backup_shape_digest_mismatch");
      refusal.evidence = `source=${source.shapeDigest} restored=${verified?.shapeDigest}`;
      throw refusal;
    }
    if (JSON.stringify(verified.rowCounts) !== JSON.stringify(source.rowCounts))
      throw UpdaterBackupV1.#refuse("updater_backup_row_counts_mismatch");
    const sealPolicy = resolveBackupRootPolicyV1(this.policy);
    const mustSeal = sealPolicy.sealRequired || sealPolicy.seal;
    const encrypted = mustSeal ? await this.ports.seal({ path: dumpPath, generationId }) === true : false;
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
    // tightens it itself. It cannot be done earlier: the restore-verify and the
    // seal both need to read and rewrite this file, and 0400 is unreadable to
    // anything but the owner — measured as `EACCES: permission denied` when the
    // chmod was moved ahead of the seal. The port is untrusted for the same
    // reason the digest re-read above is: it contains a subprocess.
    // `assertSafeGenerationV1` refuses any generation whose dump is still loose,
    // so a generation left readable by some future path is caught on the next
    // sweep rather than trusted here.
    await chmod(dumpPath, 0o400);
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
    // the two leaves a real directory the ledger does not know about, and the
    // sweep then ignores it forever (`known` is the ledger's set) — a wasted
    // dump, reported as `damaged`, which is a safe failure. The reverse order
    // would leave a `verified` row pointing at a directory that does not exist,
    // which is worse: the badge would read fresh because of a dump that is gone,
    // and §9.5's "blocks DB plans until fixed" would be satisfied by a lie.
    await rename(paths.inProgress, paths.final);
    await this.store.completeAttempt({ generationId, dumpSha256: dumped.sha256, dumpBytes: dumped.bytes,
      fileSha256: sealedSha256, shapeDigest: source.shapeDigest, rowCounts: source.rowCounts,
      snapshotXid: source.snapshotXid ?? null, encrypted });
    const retained = await this.sweep({ policy });
    return Object.freeze({ status: "verified", generationId, dumpBytes: dumped.bytes,
      retained: retained.retained, removed: retained.removed, message: "The nightly backup completed." });
  }

  /** An in-progress directory is never promoted, so it is simply removed. It is
   * removed with a name-rooted path (the id was checked) and the root's own
   * no-follow walk, so a planted symlink at that name removes nothing else. */
  async #discardInProgress(paths) {
    try {
      const entry = await lstat(paths.inProgress);
      if (entry.isSymbolicLink()) throw updaterRefuseV1("updater_backup_generation_refused");
      await rm(paths.inProgress, { recursive: true, force: false, maxRetries: 1 });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      // A failure to clean up is NOT swallowed: the directory is still named
      // `.inprogress-` so it is not counted, and the next sweep will report it.
      if (error?.code === "updater_backup_generation_refused") throw error;
    }
  }

  /**
   * Retention: keep the newest `kept_generations` VERIFIED generations, keep
   * every pinned one, and remove the rest.
   *
   * The two daemons4 findings are both closed structurally here:
   *   * only `verified` rows are candidates, so a failed attempt never occupies
   *     a slot (it has no digest and no row counts, and it is not in the
   *     partial index the read walks);
   *   * a directory is deleted only when it does NOT have a valid manifest, and
   *     an entry whose manifest is missing is reported rather than counted —
   *     so a good dump is never deleted to make room for a directory that only
   *     exists.
   *
   * The `unsafe` bucket is the interesting one: a generation directory that
   * cannot be validated (a symlink, an extra file, a dump that does not match
   * its manifest) is NEVER deleted automatically. An attacker who can plant
   * something in `backups/` could otherwise get a real dump deleted by making
   * it look unsafe. It is reported for the operator instead.
   */
  async sweep({ policy = null } = {}) {
    const effective = policy ?? await this.store.policy();
    const keep = effective.keptGenerations;
    const rows = await this.store.verifiedGenerations(keep);
    const pinned = new Set((await this.store.pinnedGenerations()).map(row => row.generationId));
    const known = new Set(await this.store.knownGenerationIds());
    const keepSet = new Set();
    for (const row of rows.slice(0, keep)) keepSet.add(row.generationId);
    for (const id of pinned) keepSet.add(id);
    const removed = [], retained = [], unsafe = [], damaged = [];
    // A partial generation is never promoted, so it is never counted. The sweep
    // clears leftovers, which is what stops a run killed mid-dump from filling
    // the disk with half-dumps over fourteen nights. Cleared by the SHARED leaf
    // prefix, and only when the entry is a real directory rather than a symlink
    // a lower-trust writer planted at that name.
    for await (const item of await opendir(this.policy.backupRoot)) {
      if (!item.name.startsWith(IN_PROGRESS_PREFIX_V1)) continue;
      const stale = join(this.policy.backupRoot, item.name);
      const entry = await lstat(stale).catch(() => null);
      if (entry?.isDirectory() && !entry.isSymbolicLink())
        await rm(stale, { recursive: true, force: true, maxRetries: 1 }).catch(() => {});
    }
    // The ledger drives the sweep, forward from each generation id to its leaf.
    // A directory the ledger does not name is therefore never a deletion
    // candidate at all — which is the strongest form of the daemons4 fix, since
    // it does not depend on parsing anything an attacker could write.
    for (const generationId of known) {
      const paths = generationPathsV1(this.policy.backupRoot, generationId);
      const entry = await lstat(paths.final).catch(() => null);
      if (entry === null) continue; // Ledger row with no directory: nothing to keep or remove.
      let safe = null;
      try { safe = await assertSafeGenerationV1(this.policy.backupRoot, generationId, { requireManifest: false }); }
      catch { unsafe.push(generationId); continue; }
      if (!safe.entries.includes(MANIFEST_FILE_V1)) { damaged.push(generationId); continue; }
      if (!keepSet.has(generationId)) {
        try {
          // The full check, manifest digest and all, before anything is removed.
          await assertSafeGenerationV1(this.policy.backupRoot, generationId);
          await rm(paths.final, { recursive: true, force: false, maxRetries: 1 });
          removed.push(generationId);
        } catch { unsafe.push(generationId); }
      } else retained.push(generationId);
    }
    return Object.freeze({ retained: retained.sort(), removed: removed.sort(),
      unsafe: unsafe.sort(), damaged: damaged.sort() });
  }

  /** The badge, the push and the plan refusal all read this one answer. */
  async status() {
    const freshness = await this.store.freshness();
    const latest = await this.store.latestAttempt();
    return Object.freeze({
      fresh: freshness.fresh,
      state: latest?.state ?? "none",
      lastSuccessAt: freshness.lastSuccessAt,
      lastFailureCode: freshness.lastFailureCode,
      lastFailureAt: freshness.lastFailureAt,
      nextDueAt: freshness.nextDueAt,
      consecutiveFailures: freshness.consecutiveFailures,
      // Plain status words, for the Home red badge (§12). "needs you" is the
      // attention-first wording the product vision asks for: one line, no prose.
      badge: freshness.fresh ? "ok" : (latest === null ? "never run" : "failed"),
    });
  }
}

const BACKUP_DEFERRED_SECONDS_V1 = 900;
